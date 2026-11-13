import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { models, transaction } from 'harper';
import { getMemories, scanMemories } from '@harperfast/agent-memory';
import { normalize, type Vector } from './kmeans.ts';
import { isEligible, isExpired, memberText, partitionId, partitionLabels } from './partition.ts';
import { memberRef, planPartition, type ExistingNode, type PlanMember } from './plan.ts';
import { promptInputChars, type Settings } from './settings.ts';
import { lockRow, recordMemory, summaryTables } from './store.ts';
import { summarize } from './summarize.ts';

const RUNNER_ID = 'runner';
const SCAN_BATCH = 100;
const EMBED_BATCH = 32;
const MAX_BACKOFF_MS = 30 * 60_000;
// setTimeout's ceiling; a later expiry is re-armed when this fires
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Log {
	error?(...args: unknown[]): void;
	warn?(...args: unknown[]): void;
	info?(...args: unknown[]): void;
	debug?(...args: unknown[]): void;
	trace?(...args: unknown[]): void;
}

class LeaseLostError extends Error {
	constructor() {
		super('@harperfast/summary-tree: the runner lease moved to another worker');
	}
}

async function collect<T>(iterable: AsyncIterable<T> | Iterable<T> | Promise<AsyncIterable<T>>): Promise<T[]> {
	const rows: T[] = [];
	for await (const row of await iterable) rows.push(row);
	return rows;
}

/**
 * Debounced, dirty-only maintenance of every partition's tree, run by one leaseholder at a time. Everything it
 * learns about memories arrives through `SummaryMember` and `SummaryChange`, which the sink and the startup walk
 * write; it never reads agent-memory's tables.
 */
export class Runner {
	settings: Settings;
	readonly holderId = `${hostname()}:${process.pid}:${threadId}:${randomUUID().slice(0, 8)}`;
	#log: Log;
	#ready = false;
	#stopped = false;
	#running = false;
	#timer: NodeJS.Timeout | undefined;
	#timerAt = Infinity;
	#expiryTimer: NodeJS.Timeout | undefined;
	#backoff = 0;
	#subscription: AsyncIterator<unknown> | undefined;
	/** model calls made by this worker, for tests and logs */
	modelCalls = 0;

	constructor(settings: Settings, log: Log) {
		this.settings = settings;
		this.#log = log;
	}

	/** True once this worker's startup walk has recorded every change its sink could have missed. */
	get ready(): boolean {
		return this.#ready;
	}

	start(): void {
		void this.#catchUp();
		void this.#subscribe();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#expiryTimer);
		void this.#subscription?.return?.();
	}

	/** Runs a tick after `delayMs` unless one is already due sooner. */
	schedule(delayMs: number): void {
		if (this.#stopped) return;
		const at = Date.now() + delayMs;
		if (this.#timer !== undefined && this.#timerAt <= at) return;
		clearTimeout(this.#timer);
		this.#timerAt = at;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#timerAt = Infinity;
			void this.tick();
		}, delayMs);
		this.#timer.unref?.();
	}

	async #catchUp(retryMs = 1_000): Promise<void> {
		try {
			let batch: Record<string, unknown>[] = [];
			const flush = async () => {
				const rows = batch;
				batch = [];
				const now = Date.now();
				await transaction(async (txn: object) => {
					for (const row of rows) await recordMemory(row, txn, { now, onlyIfNewer: true });
				});
			};
			for await (const row of scanMemories({ includeInactive: true })) {
				if (this.#stopped) return;
				batch.push(row);
				if (batch.length >= SCAN_BATCH) await flush();
			}
			if (batch.length) await flush();
			this.#ready = true;
			this.schedule(0);
		} catch (error) {
			// agent-memory may run in an app that loads after this one, so early failures are expected
			const log = retryMs >= 16_000 ? this.#log.error : this.#log.debug;
			log?.call(this.#log, `@harperfast/summary-tree: startup walk failed; retrying in ${retryMs} ms`, error);
			if (!this.#stopped) setTimeout(() => void this.#catchUp(Math.min(retryMs * 2, 60_000)), retryMs).unref?.();
		}
	}

	async #subscribe(): Promise<void> {
		const { SummaryChange } = summaryTables();
		while (!this.#stopped) {
			try {
				const events = await SummaryChange.subscribe({});
				this.#subscription = events[Symbol.asyncIterator]();
				// a change committed while unsubscribed is caught by the tick this schedules
				this.schedule(this.settings.debounceMs);
				for (;;) {
					const { done } = await this.#subscription!.next();
					if (done || this.#stopped) break;
					this.schedule(this.settings.debounceMs);
				}
			} catch (error) {
				this.#log.warn?.('@harperfast/summary-tree: change subscription ended; resubscribing', error);
			}
			if (!this.#stopped) await new Promise((resolve) => setTimeout(resolve, 5_000).unref?.());
		}
	}

	async #hasWork(): Promise<boolean> {
		const { SummaryChange } = summaryTables();
		if ((await collect(SummaryChange.search({ select: ['id'], limit: 1 }))).length) return true;
		return (await this.#expiredMembers(1)).length > 0;
	}

	#expiredMembers(limit?: number): Promise<any[]> {
		const { SummaryMember } = summaryTables();
		return collect(
			SummaryMember.search({
				conditions: [{ attribute: 'validUntil', comparator: 'less_than_equal', value: new Date() }],
				select: ['id', 'partition', 'labels', 'eligible'],
				...(limit ? { limit } : {}),
			}),
		);
	}

	async tick(): Promise<void> {
		if (this.#running || this.#stopped || !this.#ready) return;
		this.#running = true;
		try {
			if (!(await this.#hasWork())) {
				await this.#armExpiry();
				return;
			}
			const held = await this.#acquireLease();
			if (held !== true) {
				this.schedule(Math.max(1_000, held - Date.now()) + Math.floor(Math.random() * 1_000));
				return;
			}
			let failures = 0;
			try {
				failures = await this.#pass();
			} finally {
				await this.#releaseLease().catch((error) =>
					this.#log.warn?.('@harperfast/summary-tree: could not release the runner lease', error),
				);
			}
			if (failures > 0) throw new Error(`@harperfast/summary-tree: ${failures} partition(s) failed to rebuild`);
			this.#backoff = 0;
			if (await this.#hasWork()) this.schedule(this.settings.debounceMs);
			else await this.#armExpiry();
		} catch (error) {
			this.#backoff = Math.min(MAX_BACKOFF_MS, Math.max(this.settings.debounceMs, 5_000, this.#backoff * 2));
			this.#log.error?.(`@harperfast/summary-tree: maintenance failed; retrying in ${this.#backoff} ms`, error);
			this.schedule(this.#backoff);
		} finally {
			this.#running = false;
		}
	}

	/** Expiry has no event, so the earliest `validUntil` of an eligible member gets a timer. */
	async #armExpiry(): Promise<void> {
		const { SummaryMember } = summaryTables();
		clearTimeout(this.#expiryTimer);
		const [next] = await collect<any>(
			SummaryMember.search({
				conditions: [{ attribute: 'validUntil', comparator: 'greater_than', value: new Date() }],
				sort: { attribute: 'validUntil' },
				select: ['validUntil'],
				limit: 1,
			}),
		);
		if (!next?.validUntil || this.#stopped) return;
		const delay = Math.min(MAX_TIMER_MS, Math.max(0, new Date(next.validUntil).getTime() - Date.now()) + 1_000);
		this.#expiryTimer = setTimeout(() => void this.tick(), delay);
		this.#expiryTimer.unref?.();
	}

	/** True when this worker holds the lease, else when the current holder's lease ends. */
	async #acquireLease(renew = false): Promise<true | number> {
		const { SummaryState } = summaryTables();
		return transaction(async (txn: object) => {
			try {
				// cluster-exclusive when record-lock transport is configured, exclusive within this node otherwise
				await SummaryState.lock(RUNNER_ID, { lease: 10_000, timeout: 10_000 }, txn);
			} catch (error: any) {
				if (error?.statusCode === 423) return Date.now() + 10_000;
				if (error?.statusCode !== 501) throw error;
			}
			const state = await SummaryState.get(RUNNER_ID, txn);
			const now = Date.now();
			const heldElsewhere = state?.leaseHolder && state.leaseHolder !== this.holderId && state.leaseUntil > now;
			if (heldElsewhere) {
				if (renew) throw new LeaseLostError();
				return state.leaseUntil as number;
			}
			if (renew && state?.leaseHolder !== this.holderId) throw new LeaseLostError();
			await SummaryState.put(
				{ id: RUNNER_ID, leaseHolder: this.holderId, leaseUntil: now + this.settings.leaseMs },
				txn,
			);
			return true;
		});
	}

	async #renewLease(): Promise<void> {
		await this.#acquireLease(true);
	}

	async #assertLease(txn: object): Promise<void> {
		const state = await summaryTables().SummaryState.get(RUNNER_ID, txn);
		if (state?.leaseHolder !== this.holderId || !(state.leaseUntil > Date.now())) throw new LeaseLostError();
	}

	async #releaseLease(): Promise<void> {
		const { SummaryState } = summaryTables();
		await transaction(async (txn: object) => {
			const state = await SummaryState.get(RUNNER_ID, txn);
			if (state?.leaseHolder === this.holderId) await SummaryState.put({ ...state, leaseUntil: 0 }, txn);
		});
	}

	/** Rebuilds every partition with pending changes or expired members; returns how many failed. */
	async #pass(): Promise<number> {
		const { SummaryChange } = summaryTables();
		const partitions = new Map<string, readonly string[]>();
		for (const row of await collect<any>(SummaryChange.search({ select: ['partition', 'labels'] }))) {
			partitions.set(row.partition, row.labels ?? []);
		}
		for (const member of await this.#expiredMembers()) {
			if (member.eligible) partitions.set(member.partition, member.labels ?? []);
		}
		let failures = 0;
		for (const [partition, labels] of partitions) {
			if (this.#stopped) break;
			try {
				await this.#renewLease();
				await this.rebuildPartition(partition, labels);
			} catch (error) {
				if (error instanceof LeaseLostError) throw error;
				failures++;
				this.#log.error?.(`@harperfast/summary-tree: rebuilding partition ${partition} failed`, error);
			}
		}
		return failures;
	}

	/**
	 * Reads the partition's pending changes before its members, so a change committed after the member read survives
	 * this pass and keeps the partition hidden (if it revokes) until the next one. The publish transaction deletes
	 * exactly the changes read here, and only after every node they require has been rebuilt.
	 */
	async rebuildPartition(partition: string, labels: readonly string[]): Promise<void> {
		const { SummaryChange, SummaryMember, SummaryNode, SummaryPartition } = summaryTables();
		const settings = this.settings;
		const changes = await collect<any>(
			SummaryChange.search({ conditions: [{ attribute: 'partition', value: partition }] }),
		);
		const revoked = new Set<string>(changes.filter((change) => change.revoke).map((change) => change.memoryId));
		const now = Date.now();
		const rows = (
			await collect<any>(SummaryMember.search({ conditions: [{ attribute: 'partition', value: partition }] }))
		).map((row) => ({ ...row }));
		const expired = rows.filter((row) => row.eligible && isExpired(row.validUntil, now));
		// Current memory state, read after the changes above: a memory that changed since its member row was written
		// has a change row of its own (not in `changes`), so it is left out here and picked up by the next pass.
		const recorded = new Map<string, number>(rows.filter((row) => row.eligible).map((row) => [row.id, row.revision]));
		const current = await getMemories([...recorded.keys()]);
		const eligible = current.filter(
			(memory) =>
				isEligible(memory, now) &&
				partitionId(partitionLabels(memory.scopes)) === partition &&
				memory.revision === recorded.get(memory.id as string),
		);
		const textOf = new Map<string, string>(
			eligible.map((memory) => [memory.id as string, memberText(memory, settings.memberChars)]),
		);
		const vectors = await this.#vectorsOf(eligible, textOf);
		const storedLeaf = new Map<string, string | null>(rows.map((row) => [row.id, row.leafId ?? null]));
		const members: PlanMember[] = eligible.map((memory) => ({
			id: memory.id as string,
			revision: memory.revision as number,
			vector: normalize(vectors.get(memory.id as string)!),
			leafId: storedLeaf.get(memory.id as string) ?? null,
		}));
		const existing = await collect<any>(
			SummaryNode.search({ conditions: [{ attribute: 'partition', value: partition }] }),
		);
		const existingById = new Map<string, any>(existing.map((row) => [row.id, row]));
		const meta = await SummaryPartition.get(partition);
		const plan = await planPartition({
			members,
			nodes: existing.map((node): ExistingNode => ({
				id: node.id,
				level: node.level ?? 1,
				parentId: node.parentId ?? null,
				centroid: node.centroid ?? null,
				builtFrom: node.builtFrom ?? [],
				sourceIds: node.sourceIds ?? [],
				summary: node.summary ?? null,
			})),
			clusteredSize: meta?.clusteredSize ?? null,
			revoked,
			settings,
			newId: () => `${partition.slice(0, 12)}-${randomUUID().slice(0, 13)}`,
		});

		const revisionOf = new Map(members.map((member) => [member.id, member]));
		const written = new Map<string, Record<string, unknown>>();
		const maxInputChars = promptInputChars(settings);
		for (const node of plan.nodes) {
			const leaf = node.level === 1;
			const children = node.childIds.map((id) => written.get(id)!);
			let content: Record<string, unknown>;
			if (node.regenerate) {
				const texts = leaf
					? node.memberIds.map((id) => textOf.get(id)!)
					: children.map((child) => `${child.title}: ${child.summary}`);
				await this.#renewLease();
				this.modelCalls++;
				const { title, summary } = await summarize(models, texts, node.level, {
					model: settings.generativeModel,
					maxTokens: settings.maxSummaryTokens,
					maxInputChars,
				});
				content = {
					title,
					summary,
					builtFrom: leaf ? node.memberIds.map((id) => memberRef(revisionOf.get(id)!)) : node.childIds,
					sourceIds: leaf ? node.memberIds : [...new Set(children.flatMap((child) => child.sourceIds as string[]))],
					summarizedAt: new Date(),
				};
			} else {
				const kept = existingById.get(node.id);
				content = {
					title: kept.title,
					summary: kept.summary,
					builtFrom: kept.builtFrom,
					sourceIds: kept.sourceIds,
					summarizedAt: kept.summarizedAt,
				};
			}
			written.set(node.id, {
				id: node.id,
				partition,
				labels,
				level: node.level,
				parentId: node.parentId,
				top: node.parentId === null,
				memberCount: leaf
					? node.memberIds.length
					: children.reduce((sum, child) => sum + (child.memberCount as number), 0),
				centroid: Array.from(node.centroid),
				...content,
			});
		}

		await transaction(async (txn: object) => {
			await this.#assertLease(txn);
			for (const node of written.values()) await SummaryNode.put(node, txn);
			for (const id of plan.deleteIds) await SummaryNode.delete(id, txn);
			const memberUpdates = [...plan.leafOf.entries()]
				.filter(([id, leafId]) => storedLeaf.get(id) !== leafId)
				.map(([id, leafId]) => ({ id, leafId, expire: false }))
				.concat(expired.map((row) => ({ id: row.id, leafId: null, expire: true })))
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			for (const update of memberUpdates) {
				await lockRow(SummaryMember, update.id, txn);
				const current = await SummaryMember.get(update.id, txn);
				if (!current || current.partition !== partition) continue;
				const expire = update.expire && current.eligible && isExpired(current.validUntil, Date.now());
				await SummaryMember.put(
					expire
						? { ...current, eligible: false, leafId: null, validUntil: null }
						: { ...current, leafId: update.leafId },
					txn,
				);
			}
			if (written.size) {
				await SummaryPartition.put(
					{ id: partition, labels, clusteredSize: plan.clusteredSize, clusteredAt: new Date() },
					txn,
				);
			} else if (meta) {
				await SummaryPartition.delete(partition, txn);
			}
			for (const change of changes) await SummaryChange.delete(change.id, txn);
		});
	}

	/** agent-memory's stored vectors when they come from this plugin's embedding model; others are embedded now. */
	async #vectorsOf(
		memories: readonly Record<string, unknown>[],
		textOf: ReadonlyMap<string, string>,
	): Promise<Map<string, Vector>> {
		const vectors = new Map<string, Vector>();
		const missing: string[] = [];
		for (const memory of memories) {
			const id = memory.id as string;
			const embedding = memory.embedding as readonly number[] | undefined;
			if (memory.embeddingModel === this.settings.embeddingModel && embedding?.length) vectors.set(id, embedding);
			else missing.push(id);
		}
		for (let start = 0; start < missing.length; start += EMBED_BATCH) {
			const batch = missing.slice(start, start + EMBED_BATCH);
			const embedded = await models.embed(
				batch.map((id) => textOf.get(id)!),
				{ model: this.settings.embeddingModel },
			);
			batch.forEach((id, index) => vectors.set(id, embedded[index]));
		}
		return vectors;
	}
}
