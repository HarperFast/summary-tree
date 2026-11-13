import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { models, transaction } from 'harper';
import * as agentMemory from '@harperfast/agent-memory';
import { normalize, type Vector } from './kmeans.ts';
import { contentHash, isEligible, isExpired, memberText, partitionId, partitionLabels } from './partition.ts';
import { memberRef, planPartition, type ExistingNode, type PlanMember } from './plan.ts';
import { promptInputChars, type Settings } from './settings.ts';
import { lockRow, recordMemory, summaryTables } from './store.ts';
import { summarize } from './summarize.ts';

const RUNNER_ID = 'runner';
const EMBED_BATCH = 32;
const VECTOR_CACHE_LIMIT = 50_000;
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
	#rerun = false;
	#subscription: AsyncIterator<unknown> | undefined;
	#vectorCache = new Map<string, Vector>();

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
		this.#ready = false;
		clearTimeout(this.#timer);
		clearTimeout(this.#expiryTimer);
		this.#closeSubscription();
	}

	#closeSubscription(): void {
		Promise.resolve(this.#subscription?.return?.()).catch(() => {});
		this.#subscription = undefined;
	}

	schedule(delayMs: number): void {
		if (this.#stopped) return;
		const at = Date.now() + delayMs;
		if (this.#timer !== undefined && this.#timerAt <= at) return;
		clearTimeout(this.#timer);
		this.#timerAt = at;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#timerAt = Infinity;
			if (this.#running) this.#rerun = true;
			else void this.tick();
		}, delayMs);
		this.#timer.unref?.();
	}

	async #catchUp(retryMs = 1_000): Promise<void> {
		if (this.#stopped) return;
		try {
			for await (const row of agentMemory.scanMemories({ includeInactive: true })) {
				if (this.#stopped) return;
				// one member lock per transaction: the sink may hold several, so holding more here could deadlock
				await transaction((txn: object) => recordMemory(row, txn, { now: Date.now(), onlyIfNewer: true }));
			}
			if (this.#stopped) return;
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
		while (!this.#stopped) {
			try {
				const events = await summaryTables().SummaryChange.subscribe({});
				this.#subscription = events[Symbol.asyncIterator]();
				if (this.#stopped) break;
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
		this.#closeSubscription();
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
		if (this.#running || this.#stopped || !this.#ready || !this.settings.runner) return;
		this.#running = true;
		this.#rerun = false;
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
			if (this.#stopped) return;
			this.#backoff = Math.min(MAX_BACKOFF_MS, Math.max(this.settings.debounceMs, 5_000, this.#backoff * 2));
			this.#log.error?.(`@harperfast/summary-tree: maintenance failed; retrying in ${this.#backoff} ms`, error);
			this.schedule(this.#backoff);
		} finally {
			this.#running = false;
			if (this.#rerun && !this.#stopped) this.schedule(0);
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
		this.#expiryTimer = setTimeout(() => this.schedule(0), delay);
		this.#expiryTimer.unref?.();
	}

	/** True when this worker holds the lease, else when the current holder's lease ends. */
	async #acquireLease(renew = false): Promise<true | number> {
		const { SummaryState } = summaryTables();
		return transaction(async (txn: object) => {
			try {
				await lockRunner(txn);
			} catch (error: any) {
				if (error?.statusCode === 423) return Date.now() + 10_000;
				throw error;
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

	/**
	 * Inside a publish transaction: fails unless this worker still holds the lease. It renews the lease through the
	 * runner lock, so the commit is refused if that lock expired before it, and a successor cannot have taken over.
	 */
	async #assertLease(txn: object): Promise<void> {
		const { SummaryState } = summaryTables();
		await lockRunner(txn);
		const state = await SummaryState.get(RUNNER_ID, txn);
		if (this.#stopped || state?.leaseHolder !== this.holderId || !(state.leaseUntil > Date.now())) {
			throw new LeaseLostError();
		}
		await SummaryState.put({ ...state, leaseUntil: Date.now() + this.settings.leaseMs }, txn);
	}

	async #releaseLease(): Promise<void> {
		const { SummaryState } = summaryTables();
		await transaction(async (txn: object) => {
			await lockRunner(txn);
			const state = await SummaryState.get(RUNNER_ID, txn);
			if (state?.leaseHolder === this.holderId) await SummaryState.put({ ...state, leaseUntil: 0 }, txn);
		});
	}

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
	 * this pass and keeps the partition hidden (if it revokes) until the next one. The changes read here are deleted
	 * last, in their own lease-fenced transaction, after every node they require is published.
	 */
	async rebuildPartition(partition: string, labels: readonly string[]): Promise<void> {
		const { SummaryChange, SummaryMember, SummaryNode, SummaryPartition } = summaryTables();
		const settings = this.settings;
		const changes = await collect<any>(
			SummaryChange.search({ conditions: [{ attribute: 'partition', value: partition }] }),
		);
		const revoked = new Set<string>(changes.filter((change) => change.revoke).map((change) => change.memoryId));
		const orphaned = await this.#orphanedPartitions(changes, partition);
		if (orphaned.size) {
			// before any model call, so a failing rebuild here cannot leave the other partitions served
			await transaction(async (txn: object) => {
				await this.#assertLease(txn);
				for (const [other, row] of orphaned) {
					await SummaryChange.put(
						{
							id: randomUUID(),
							partition: other,
							labels: row.labels,
							memoryId: row.memoryId,
							revision: row.revision,
							revoke: true,
							createdAt: new Date(),
						},
						txn,
					);
				}
			});
		}
		const now = Date.now();
		const rows = (
			await collect<any>(SummaryMember.search({ conditions: [{ attribute: 'partition', value: partition }] }))
		).map((row) => ({ ...row }));
		const expired = rows.filter((row) => row.eligible && isExpired(row.validUntil, now));
		const recorded = new Map<string, string>(
			rows.filter((row) => row.eligible).map((row) => [row.id, `${row.revision}:${row.contentHash}`]),
		);
		const stateOf = (memory: Record<string, unknown>) => `${memory.revision}:${contentHash(memory)}`;
		const storedLeaf = new Map<string, string | null>(rows.map((row) => [row.id, row.leafId ?? null]));
		const current = (await agentMemory.getMemories([...recorded.keys()])).filter(
			(memory) => isEligible(memory, now) && partitionId(partitionLabels(memory.scopes)) === partition,
		);
		// A state newer than the member row read above committed together with its member row, so the row is re-read.
		// Once the member row is at or past the state read here, any later change is still pending and will rebuild
		// what this pass builds from it.
		for (const memory of current) {
			if (stateOf(memory) === recorded.get(memory.id as string)) continue;
			const stored = await SummaryMember.get(memory.id);
			if (stored?.partition !== partition) continue;
			const caughtUp =
				stored.revision > (memory.revision as number) ||
				(stored.revision === memory.revision && stored.contentHash === contentHash(memory));
			if (caughtUp) recorded.set(memory.id as string, stateOf(memory));
			// another node's write at the same revision: building now would drop the memory with no change left to add it
			else if (stored.revision === memory.revision) {
				throw new Error(`@harperfast/summary-tree: memory ${memory.id} changed during the rebuild; retrying`);
			}
		}
		const eligible = current.filter((memory) => stateOf(memory) === recorded.get(memory.id as string));
		const textOf = new Map<string, string>(
			eligible.map((memory) => [memory.id as string, memberText(memory, settings.memberChars)]),
		);
		const vectors = await this.#vectorsOf(eligible, textOf, settings.embeddingModel);
		const members: PlanMember[] = eligible.map((memory) => ({
			id: memory.id as string,
			revision: memory.revision as number,
			hash: contentHash(memory),
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
			// centroids from another embedding model are in another vector space
			clusteredSize: meta?.embeddingModel === settings.embeddingModel ? (meta?.clusteredSize ?? null) : null,
			revoked,
			current: new Set(members.map(memberRef)),
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
				if (this.#stopped) throw new LeaseLostError();
				const { title, summary } = await summarize(models, texts, node.level, {
					model: settings.generativeModel,
					maxTokens: settings.maxSummaryTokens,
					maxInputChars,
				});
				if (this.#stopped) throw new LeaseLostError();
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

		if (this.#stopped) throw new LeaseLostError();
		await transaction(async (txn: object) => {
			await this.#assertLease(txn);
			for (const node of written.values()) await SummaryNode.put(node, txn);
			for (const id of plan.deleteIds) await SummaryNode.delete(id, txn);
			if (written.size) {
				await SummaryPartition.put(
					{
						id: partition,
						labels,
						clusteredSize: plan.clusteredSize,
						embeddingModel: settings.embeddingModel,
						clusteredAt: new Date(),
					},
					txn,
				);
			} else if (meta) {
				await SummaryPartition.delete(partition, txn);
			}
		});

		// One member lock per transaction, like every writer but the sink. The changes are deleted after these, so a crash
		// in between leaves them for the next pass.
		const updates = [...plan.leafOf.entries()]
			.filter(([id, leafId]) => storedLeaf.get(id) !== leafId)
			.map(([id, leafId]) => ({ id, leafId, expire: false }))
			.concat(expired.map((row) => ({ id: row.id, leafId: null, expire: true })));
		for (const update of updates) {
			if (this.#stopped) throw new LeaseLostError();
			await transaction(async (txn: object) => {
				await this.#assertLease(txn);
				await lockRow(SummaryMember, update.id, txn);
				const stored = await SummaryMember.get(update.id, txn);
				if (!stored || stored.partition !== partition) return;
				const expire = update.expire && stored.eligible && isExpired(stored.validUntil, Date.now());
				await SummaryMember.put(
					expire
						? { ...stored, eligible: false, leafId: null, validUntil: null }
						: { ...stored, leafId: update.leafId },
					txn,
				);
			});
		}

		await transaction(async (txn: object) => {
			await this.#assertLease(txn);
			for (const change of changes) await SummaryChange.delete(change.id, txn);
		});
	}

	/**
	 * Other partitions whose summaries still carry text from a memory changed here, though it is no longer an eligible
	 * member of them. A sink revokes only the partition its own node saw the memory leave; two nodes moving one memory
	 * to different label sets at once can leave text in a partition no sink revoked.
	 */
	async #orphanedPartitions(changes: readonly any[], partition: string): Promise<Map<string, any>> {
		const { SummaryMember, SummaryNode } = summaryTables();
		const orphaned = new Map<string, any>();
		for (const memoryId of new Set<string>(changes.map((change) => change.memoryId))) {
			const member = await SummaryMember.get(memoryId);
			for await (const node of await SummaryNode.search({
				conditions: [{ attribute: 'sourceIds', value: memoryId }],
				select: ['partition', 'labels'],
			})) {
				if (node.partition === partition || orphaned.has(node.partition)) continue;
				if (member?.eligible && member.partition === node.partition) continue;
				orphaned.set(node.partition, { labels: node.labels, memoryId, revision: member?.revision ?? 0 });
			}
		}
		return orphaned;
	}

	/** agent-memory's stored vectors when they come from this plugin's embedding model; others are embedded once. */
	async #vectorsOf(
		memories: readonly Record<string, unknown>[],
		textOf: ReadonlyMap<string, string>,
		model: string,
	): Promise<Map<string, Vector>> {
		const vectors = new Map<string, Vector>();
		const missing: { id: string; key: string }[] = [];
		for (const memory of memories) {
			const id = memory.id as string;
			const embedding = memory.embedding as readonly number[] | undefined;
			const key = `${model}\0${id}@${memory.revision}:${contentHash(memory)}`;
			const cached = this.#vectorCache.get(key);
			if (memory.embeddingModel === model && embedding?.length) vectors.set(id, embedding);
			else if (cached) vectors.set(id, cached);
			else missing.push({ id, key });
		}
		for (let start = 0; start < missing.length; start += EMBED_BATCH) {
			if (this.#stopped) throw new LeaseLostError();
			const batch = missing.slice(start, start + EMBED_BATCH);
			const embedded = await models.embed(
				batch.map(({ id }) => textOf.get(id)!),
				{ model },
			);
			batch.forEach(({ id, key }, index) => {
				vectors.set(id, embedded[index]);
				if (this.#vectorCache.size >= VECTOR_CACHE_LIMIT) this.#vectorCache.clear();
				this.#vectorCache.set(key, embedded[index]);
			});
		}
		return vectors;
	}
}

/** Cluster-exclusive when Harper has record-lock replication configured, node-exclusive otherwise. */
function lockRunner(txn: object): Promise<unknown> {
	return summaryTables().SummaryState.lock(RUNNER_ID, { lease: 10_000, timeout: 10_000 }, txn);
}
