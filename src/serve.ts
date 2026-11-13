import * as agentMemory from '@harperfast/agent-memory';
import type { Principal } from '@harperfast/agent-memory';
import { isEligible, partitionId, partitionLabels } from './partition.ts';
import { transaction } from 'harper';
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

const META = ['id', 'partition', 'labels', 'level', 'parentId', 'top', 'memberCount', 'textChars'];

/**
 * Pending revoking changes for one request: an indexed probe per partition the request is about to serve, memoized,
 * consulted before that partition's summary text is read.
 */
export class Barriers {
	#probed = new Map<string, Promise<boolean>>();
	readonly txn: object;

	/** `txn` is the request's read transaction: barriers and node text come from its one snapshot. */
	constructor(txn: object) {
		this.txn = txn;
	}

	isBlocked(partition: string): Promise<boolean> {
		let blocked = this.#probed.get(partition);
		if (blocked === undefined) {
			blocked = collect(
				summaryTables().SummaryChange.search(
					{
						conditions: [
							{ attribute: 'partition', value: partition },
							{ attribute: 'revoke', value: true },
						],
						select: ['id'],
						limit: 1,
					},
					this.txn,
				),
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
		const node = await summaryTables().SummaryNode.get(meta.id, this.txn);
		if (node?.summary && node.partition === meta.partition) return node;
	}

	async readAll(metas: readonly any[], principal: Principal): Promise<any[]> {
		const nodes = await Promise.all(metas.map((meta) => this.read(meta, principal)));
		return nodes.filter((node) => node !== undefined);
	}
}

const bySize = (a: any, b: any) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1);

function metaSearch(conditions: object[], txn: object): Promise<any[]> {
	return collect(summaryTables().SummaryNode.search({ conditions, select: META }, txn));
}

/** Runs `read` in one read transaction: its barrier decisions and the summary text it returns share a snapshot. */
function inSnapshot<T>(read: (barriers: Barriers) => Promise<T>): Promise<T> {
	return transaction((txn: object) => read(new Barriers(txn)));
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

const MAX_LISTED = 200;

/** Readable top nodes, largest first; at most MAX_LISTED are checked and returned. */
export function readableTopNodes(principal: Principal): Promise<{ nodes: NodeView[]; truncated: boolean }> {
	return inSnapshot(async (barriers) => {
		const tops = (await metaSearch([{ attribute: 'top', value: true }], barriers.txn))
			.filter(readableMeta(principal))
			.sort(bySize);
		const nodes = (await barriers.readAll(tops.slice(0, MAX_LISTED), principal)).map(view);
		return { nodes, truncated: tops.length > MAX_LISTED };
	});
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

function itemSuffix(node: { memberCount: number; id: string }): string {
	return `\n(${node.memberCount} memories; summary node ${node.id})`;
}

export function orientationItem(node: NodeView): { title: string; content: string } {
	return { title: node.title, content: `${node.summary}${itemSuffix(node)}` };
}

const MAX_ORIENTATION_ITEMS = 64;
// candidates probed per request, served or not, so a burst of blocked partitions bounds the work
const MAX_ORIENTATION_ATTEMPTS = 128;

/**
 * The orientation section: the top levels of every readable tree, breadth first and largest first within a level,
 * packed into the budget agent-memory left. A node that does not fit is skipped along with its subtree.
 */
export function orientation(principal: Principal, budgetChars: number) {
	return inSnapshot((barriers) => orientationIn(barriers, principal, budgetChars));
}

async function orientationIn(barriers: Barriers, principal: Principal, budgetChars: number) {
	const items: { title: string; content: string }[] = [];
	let remaining = budgetChars;
	let level = (await metaSearch([{ attribute: 'top', value: true }], barriers.txn))
		.filter(readableMeta(principal))
		.sort(bySize);
	let attempts = 0;
	while (level.length && items.length < MAX_ORIENTATION_ITEMS && attempts < MAX_ORIENTATION_ATTEMPTS) {
		const next: any[] = [];
		for (const meta of level) {
			if (items.length >= MAX_ORIENTATION_ITEMS || attempts >= MAX_ORIENTATION_ATTEMPTS) break;
			if ((meta.textChars ?? 0) + itemSuffix(meta).length > remaining) continue;
			attempts++;
			const node = await barriers.read(meta, principal);
			if (!node) continue;
			const item = orientationItem(view(node));
			const size = item.title.length + item.content.length;
			if (size > remaining) continue;
			items.push(item);
			remaining -= size;
			if (node.level > 1) {
				const children = await metaSearch([{ attribute: 'parentId', value: node.id }], barriers.txn);
				next.push(...children.filter(readableMeta(principal)));
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
	return inSnapshot((barriers) => annotateIn(barriers, principal, hits));
}

async function annotateIn(
	barriers: Barriers,
	principal: Principal,
	hits: readonly Readonly<Record<string, unknown>>[],
): Promise<Map<string, NodeView>> {
	const { SummaryAssignment, SummaryMember } = summaryTables();
	const members = await Promise.all(hits.map((hit) => SummaryMember.get(hit.id as string, barriers.txn)));
	const assignments = await Promise.all(hits.map((hit) => SummaryAssignment.get(hit.id as string, barriers.txn)));
	const leafOf = (index: number) => {
		const member = members[index];
		const assignment = assignments[index];
		return member?.eligible && assignment?.partition === member.partition ? assignment.leafId : undefined;
	};
	const leafIds = [...new Set(hits.map((_, index) => leafOf(index)).filter((id) => id))];
	const leaves = new Map<string, any>();
	for (const id of leafIds) {
		const [meta] = await metaSearch([{ attribute: 'id', value: id }], barriers.txn);
		leaves.set(id, await barriers.read(meta, principal));
	}
	const annotations = new Map<string, NodeView>();
	for (const [index, member] of members.entries()) {
		const leafId = leafOf(index);
		const leaf = leafId ? leaves.get(leafId) : undefined;
		if (leaf && leaf.partition === member.partition) annotations.set(hits[index].id as string, view(leaf));
	}
	return annotations;
}

export function expandNode(principal: Principal, id: string) {
	return inSnapshot((barriers) => expandIn(barriers, principal, id));
}

async function expandIn(barriers: Barriers, principal: Principal, id: string) {
	const { SummaryAssignment } = summaryTables();
	const [meta] = await metaSearch([{ attribute: 'id', value: id }], barriers.txn);
	const node = await barriers.read(meta, principal);
	if (!node) throw notFound();
	if (node.level > 1) {
		const children = (await metaSearch([{ attribute: 'parentId', value: id }], barriers.txn)).filter(
			(child) => child.partition === node.partition,
		);
		return { node: view(node), children: (await barriers.readAll(children, principal)).sort(bySize).map(view) };
	}
	const assigned = await collect(
		SummaryAssignment.search({ conditions: [{ attribute: 'leafId', value: id }] }, barriers.txn),
	);
	const ids = assigned.filter((row) => row.partition === node.partition).map((row) => row.id);
	const now = Date.now();
	const members = (await agentMemory.getMemories(ids)).filter(
		(memory) => isEligible(memory, now) && partitionId(partitionLabels(memory.scopes)) === node.partition,
	);
	return {
		node: view(node),
		members: members.map((memory) => ({ id: memory.id as string, title: (memory.title as string) ?? null })),
	};
}
