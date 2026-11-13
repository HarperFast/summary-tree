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

/**
 * Partitions hidden by a pending revoking change, for one request: one query while at most BARRIER_PREFETCH are
 * pending, else an indexed probe per partition asked about, memoized.
 */
export class Barriers {
	#known: Promise<Set<string> | undefined> | undefined;
	#probed = new Map<string, Promise<boolean>>();

	/** Reads the pending set; call before reading the node text it will guard. */
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
		return known ? known.has(partition) : this.probe(partition);
	}

	probe(partition: string): Promise<boolean> {
		let blocked = this.#probed.get(partition);
		if (blocked === undefined) {
			blocked = collect(
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
}

/**
 * A node a principal may see: every member it was built from carries exactly the node's labels, and withdrawn or
 * flagged members are never summarized, so the label test decides; a pending revocation hides the partition.
 */
async function servable(node: any, principal: Principal, barriers: Barriers): Promise<boolean> {
	return readable(node, principal) && !(await barriers.isBlocked(node.partition));
}

function readable(node: any, principal: Principal): boolean {
	return Boolean(node?.summary) && agentMemory.canReadLabels(principal, node.labels);
}

async function filterServable(nodes: any[], principal: Principal, barriers: Barriers): Promise<any[]> {
	const keep = await Promise.all(nodes.map((node) => servable(node, principal, barriers)));
	return nodes.filter((_, index) => keep[index]);
}

const bySize = (a: any, b: any) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1);

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

export async function readableTopNodes(principal: Principal, barriers = new Barriers()): Promise<NodeView[]> {
	const { SummaryNode } = summaryTables();
	await barriers.prefetch();
	const tops = await collect(SummaryNode.search({ conditions: [{ attribute: 'top', value: true }] }));
	return (await filterServable(tops, principal, barriers)).sort(bySize).map(view);
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
	const { SummaryNode } = summaryTables();
	const barriers = new Barriers();
	await barriers.prefetch();
	const items: { title: string; content: string }[] = [];
	let remaining = budgetChars;
	const tops = await collect(SummaryNode.search({ conditions: [{ attribute: 'top', value: true }] }));
	let level: any[] = tops.filter((node) => readable(node, principal)).sort(bySize);
	while (level.length && items.length < MAX_ORIENTATION_ITEMS) {
		const next: any[] = [];
		for (const node of level) {
			if (items.length >= MAX_ORIENTATION_ITEMS) break;
			const item = orientationItem(view(node));
			const size = item.title.length + item.content.length;
			if (size > remaining || (await barriers.isBlocked(node.partition))) continue;
			items.push(item);
			remaining -= size;
			if (node.level > 1) {
				const children = await collect(SummaryNode.search({ conditions: [{ attribute: 'parentId', value: node.id }] }));
				next.push(...children.filter((child) => readable(child, principal)));
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
	const { SummaryMember, SummaryNode } = summaryTables();
	const barriers = new Barriers();
	await barriers.prefetch();
	const members = await Promise.all(hits.map((hit) => SummaryMember.get(hit.id as string)));
	const leafIds = [...new Set(members.filter((member) => member?.eligible && member.leafId).map((m) => m.leafId))];
	const leaves = new Map<string, any>(
		await Promise.all(leafIds.map(async (id): Promise<[string, any]> => [id, await SummaryNode.get(id)])),
	);
	const annotations = new Map<string, NodeView>();
	for (const [index, member] of members.entries()) {
		if (!member?.eligible || !member.leafId) continue;
		const leaf = leaves.get(member.leafId);
		if (leaf?.partition !== member.partition || !(await servable(leaf, principal, barriers))) continue;
		annotations.set(hits[index].id as string, view(leaf));
	}
	return annotations;
}

export async function expandNode(principal: Principal, id: string) {
	const { SummaryMember, SummaryNode } = summaryTables();
	const barriers = new Barriers();
	const located = await SummaryNode.get(id);
	if (!readable(located, principal) || (await barriers.probe(located.partition))) throw notFound();
	// the text served is read after the barrier check
	const node = await SummaryNode.get(id);
	if (!readable(node, principal) || node.partition !== located.partition) throw notFound();
	if (node.level > 1) {
		const children = await collect(SummaryNode.search({ conditions: [{ attribute: 'parentId', value: id }] }));
		const sameTree = children.filter((child) => child.partition === node.partition && readable(child, principal));
		return { node: view(node), children: sameTree.sort(bySize).map(view) };
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
