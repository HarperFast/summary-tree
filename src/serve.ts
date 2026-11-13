import { canReadLabels, type Principal } from '@harperfast/agent-memory';
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

/** Partitions hidden by a pending revoking change: a member left, was withdrawn or flagged since the last rebuild. */
export async function blockedPartitions(): Promise<Set<string>> {
	const { SummaryChange } = summaryTables();
	const rows = await collect(
		SummaryChange.search({ conditions: [{ attribute: 'revoke', value: true }], select: ['partition'] }),
	);
	return new Set(rows.map((row) => row.partition));
}

/**
 * A node a principal may see: every member it was built from carries exactly the node's labels, and withdrawn or
 * flagged members are never summarized, so the label test decides; a pending revocation hides the partition.
 */
function servable(node: any, principal: Principal, blocked: ReadonlySet<string>): boolean {
	return Boolean(node?.summary) && !blocked.has(node.partition) && canReadLabels(principal, node.labels);
}

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

/** Top nodes of every partition the principal can read, largest first. */
export async function readableTopNodes(principal: Principal, blocked?: ReadonlySet<string>): Promise<NodeView[]> {
	const { SummaryNode } = summaryTables();
	blocked ??= await blockedPartitions();
	const tops = await collect(SummaryNode.search({ conditions: [{ attribute: 'top', value: true }] }));
	return tops
		.filter((node) => servable(node, principal, blocked!))
		.sort((a, b) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1))
		.map(view);
}

/** Whether a partition the principal can read has changes the runner has not applied yet. */
export async function hasPendingWork(principal: Principal): Promise<boolean> {
	const { SummaryChange } = summaryTables();
	for await (const change of await SummaryChange.search({ select: ['labels'] })) {
		if (canReadLabels(principal, change.labels)) return true;
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
	const blocked = await blockedPartitions();
	const items: { title: string; content: string }[] = [];
	let remaining = budgetChars;
	let level: NodeView[] = await readableTopNodes(principal, blocked);
	while (level.length && items.length < MAX_ORIENTATION_ITEMS) {
		const next: any[] = [];
		for (const node of level) {
			if (items.length >= MAX_ORIENTATION_ITEMS) break;
			const item = orientationItem(node);
			const size = item.title.length + item.content.length;
			if (size > remaining) continue;
			items.push(item);
			remaining -= size;
			if (node.level > 1) {
				const children = await collect(SummaryNode.search({ conditions: [{ attribute: 'parentId', value: node.id }] }));
				next.push(...children.filter((child) => servable(child, principal, blocked)));
			}
		}
		level = next.sort((a, b) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1)).map(view);
	}
	return items;
}

/** For each hit, the readable leaf summary it belongs to. */
export async function annotateHits(
	principal: Principal,
	hits: readonly Readonly<Record<string, unknown>>[],
): Promise<Map<string, NodeView>> {
	const { SummaryMember, SummaryNode } = summaryTables();
	const blocked = await blockedPartitions();
	const leaves = new Map<string, any>();
	const annotations = new Map<string, NodeView>();
	for (const hit of hits) {
		const id = hit.id as string;
		const member = await SummaryMember.get(id);
		if (!member?.eligible || !member.leafId) continue;
		if (!leaves.has(member.leafId)) leaves.set(member.leafId, await SummaryNode.get(member.leafId));
		const leaf = leaves.get(member.leafId);
		if (leaf?.partition !== member.partition || !servable(leaf, principal, blocked)) continue;
		annotations.set(id, view(leaf));
	}
	return annotations;
}

/** A node with its children (interior) or its member memories (leaf); 404 when missing or unreadable. */
export async function expandNode(principal: Principal, id: string) {
	const { SummaryMember, SummaryNode } = summaryTables();
	const blocked = await blockedPartitions();
	const node = await SummaryNode.get(id);
	if (!servable(node, principal, blocked)) throw notFound();
	if (node.level > 1) {
		const children = await collect(SummaryNode.search({ conditions: [{ attribute: 'parentId', value: id }] }));
		return {
			node: view(node),
			children: children
				.filter((child) => child.partition === node.partition && servable(child, principal, blocked))
				.sort((a, b) => b.memberCount - a.memberCount)
				.map(view),
		};
	}
	const members = await collect(SummaryMember.search({ conditions: [{ attribute: 'leafId', value: id }] }));
	return {
		node: view(node),
		members: members
			.filter((member) => member.eligible && member.partition === node.partition)
			.map((member) => ({ id: member.id, title: member.title ?? null })),
	};
}
