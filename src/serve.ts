import * as agentMemory from '@harperfast/agent-memory';
import type { Principal } from '@harperfast/agent-memory';
import { isEligible, partitionId, partitionLabels } from './partition.ts';
import { summaryTables } from './store.ts';

export class SummaryError extends Error {
	readonly statusCode: number;
	readonly code: string;
	constructor(message: string, statusCode: number, code: string) {
		super(message);
		this.statusCode = statusCode;
		this.code = code;
	}
}

export const notFound = () => new SummaryError('Summary node not found', 404, 'not_found');
export const notReady = () =>
	new SummaryError('Summaries are not available until this worker finishes its startup walk', 503, 'unavailable');

async function collect<T = any>(iterable: any): Promise<T[]> {
	const rows: T[] = [];
	for await (const row of await iterable) rows.push(row);
	return rows;
}

const BARRIER_PREFETCH = 64;
const PROBE_LIMIT = 64;
const META = ['id', 'partition', 'labels', 'level', 'parentId', 'top', 'memberCount'];

/**
 * Pending revoking changes for one request, consulted before any summary text is read: one query while at most
 * BARRIER_PREFETCH are pending, else an indexed probe per partition, at most PROBE_LIMIT of them; partitions past
 * that count as hidden.
 */
export class Barriers {
	#known: Promise<Set<string> | undefined> | undefined;
	#probed = new Map<string, Promise<boolean>>();

	prefetch(): Promise<Set<string> | undefined> {
		this.#known ??= collect(
			summaryTables().SummaryChange.search({
				conditions: [{ attribute: 'revoke', value: true }],
				select: ['partition'],
				limit: BARRIER_PREFETCH + 1,
			}),
		).then((rows) => (rows.length > BARRIER_PREFETCH ? undefined : new Set(rows.map((row) => row.partition))));
		return this.#known;
	}

	async isBlocked(partition: string): Promise<boolean> {
		const known = await this.prefetch();
		if (known) return known.has(partition);
		let blocked = this.#probed.get(partition);
		if (blocked === undefined) {
			blocked =
				this.#probed.size >= PROBE_LIMIT
					? Promise.resolve(true)
					: collect(
							summaryTables().SummaryChange.search({
								conditions: [
									{ attribute: 'partition', value: partition },
									{ attribute: 'revoke', value: true },
								],
								select: ['id'],
								limit: 1,
							}),
						).then((rows) => rows.length > 0);
			this.#probed.set(partition, blocked);
		}
		return blocked;
	}

	/**
	 * The node behind `meta` (a row read without its text), read only after its partition's barrier was checked;
	 * undefined when the principal may not see it. Every member carries the node's labels and withdrawn or flagged
	 * members are never summarized, so the label test decides.
	 */
	async read(meta: any, principal: Principal): Promise<any> {
		if (!meta || !agentMemory.canReadLabels(principal, meta.labels) || (await this.isBlocked(meta.partition))) return;
		const node = await summaryTables().SummaryNode.get(meta.id);
		if (node?.summary && node.partition === meta.partition) return node;
	}

	async readAll(metas: readonly any[], principal: Principal): Promise<any[]> {
		const nodes = await Promise.all(metas.map((meta) => this.read(meta, principal)));
		return nodes.filter((node) => node !== undefined);
	}
}

const bySize = (a: any, b: any) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1);

function metaSearch(conditions: object[]): Promise<any[]> {
	return collect(summaryTables().SummaryNode.search({ conditions, select: META }));
}

const readableMeta = (principal: Principal) => (meta: any) => agentMemory.canReadLabels(principal, meta.labels);

export interface NodeView {
	id: string;
	title: string;
	summary: string;
	level: number;
	memberCount: number;
	parentId: string | null;
}

function view(node: any): NodeView {
	return {
		id: node.id,
		title: node.title,
		summary: node.summary,
		level: node.level,
		memberCount: node.memberCount,
		parentId: node.parentId ?? null,
	};
}

export async function readableTopNodes(principal: Principal): Promise<NodeView[]> {
	const barriers = new Barriers();
	await barriers.prefetch();
	const tops = (await metaSearch([{ attribute: 'top', value: true }])).filter(readableMeta(principal)).sort(bySize);
	return (await barriers.readAll(tops, principal)).map(view);
}

const PENDING_SCAN_LIMIT = 1000;

/**
 * Whether a partition the principal can read has changes not yet applied. Reads at most PENDING_SCAN_LIMIT changes,
 * so behind a larger backlog of other partitions' changes it can answer false.
 */
export async function hasPendingWork(principal: Principal): Promise<boolean> {
	const { SummaryChange } = summaryTables();
	for await (const change of await SummaryChange.search({ select: ['labels'], limit: PENDING_SCAN_LIMIT })) {
		if (agentMemory.canReadLabels(principal, change.labels)) return true;
	}
	return false;
}

export function orientationItem(node: NodeView): { title: string; content: string } {
	return {
		title: node.title,
		content: `${node.summary}\n(${node.memberCount} memories; summary node ${node.id})`,
	};
}

const MAX_ORIENTATION_ITEMS = 64;

/**
 * The orientation section: the top levels of every readable tree, breadth first and largest first within a level,
 * packed into the budget agent-memory left. A node that does not fit is skipped along with its subtree.
 */
export async function orientation(principal: Principal, budgetChars: number) {
	const barriers = new Barriers();
	await barriers.prefetch();
	const items: { title: string; content: string }[] = [];
	let remaining = budgetChars;
	let level = (await metaSearch([{ attribute: 'top', value: true }])).filter(readableMeta(principal)).sort(bySize);
	while (level.length && items.length < MAX_ORIENTATION_ITEMS) {
		const next: any[] = [];
		for (const meta of level) {
			if (items.length >= MAX_ORIENTATION_ITEMS) break;
			const node = await barriers.read(meta, principal);
			if (!node) continue;
			const item = orientationItem(view(node));
			const size = item.title.length + item.content.length;
			if (size > remaining) continue;
			items.push(item);
			remaining -= size;
			if (node.level > 1) {
				next.push(...(await metaSearch([{ attribute: 'parentId', value: node.id }])).filter(readableMeta(principal)));
			}
		}
		level = next.sort(bySize);
	}
	return items;
}

export async function annotateHits(
	principal: Principal,
	hits: readonly Readonly<Record<string, unknown>>[],
): Promise<Map<string, NodeView>> {
	const { SummaryMember } = summaryTables();
	const barriers = new Barriers();
	await barriers.prefetch();
	const members = await Promise.all(hits.map((hit) => SummaryMember.get(hit.id as string)));
	const leafIds = [...new Set(members.filter((member) => member?.eligible && member.leafId).map((m) => m.leafId))];
	const leaves = new Map<string, any>();
	for (const id of leafIds) {
		const [meta] = await metaSearch([{ attribute: 'id', value: id }]);
		leaves.set(id, await barriers.read(meta, principal));
	}
	const annotations = new Map<string, NodeView>();
	for (const [index, member] of members.entries()) {
		const leaf = member?.eligible && member.leafId ? leaves.get(member.leafId) : undefined;
		if (leaf && leaf.partition === member.partition) annotations.set(hits[index].id as string, view(leaf));
	}
	return annotations;
}

export async function expandNode(principal: Principal, id: string) {
	const { SummaryMember } = summaryTables();
	const barriers = new Barriers();
	const [meta] = await metaSearch([{ attribute: 'id', value: id }]);
	const node = await barriers.read(meta, principal);
	if (!node) throw notFound();
	if (node.level > 1) {
		const children = (await metaSearch([{ attribute: 'parentId', value: id }])).filter(
			(child) => child.partition === node.partition,
		);
		return { node: view(node), children: (await barriers.readAll(children, principal)).sort(bySize).map(view) };
	}
	const assigned = await collect(SummaryMember.search({ conditions: [{ attribute: 'leafId', value: id }] }));
	const ids = assigned.filter((member) => member.eligible && member.partition === node.partition).map((m) => m.id);
	const now = Date.now();
	const members = (await agentMemory.getMemories(ids)).filter(
		(memory) => isEligible(memory, now) && partitionId(partitionLabels(memory.scopes)) === node.partition,
	);
	return {
		node: view(node),
		members: members.map((memory) => ({ id: memory.id as string, title: (memory.title as string) ?? null })),
	};
}
