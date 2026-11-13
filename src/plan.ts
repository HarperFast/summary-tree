import { centroidOf, dot, kmeans, nearestCentroid, normalize, type Vector } from './kmeans.ts';
import type { Settings } from './settings.ts';

export interface PlanMember {
	readonly id: string;
	readonly revision: number;
	/** `contentHash` of the text summarized, so equal revisions with different text differ */
	readonly hash?: string;
	readonly vector: Float32Array;
	readonly leafId: string | null;
}

export interface ExistingNode {
	readonly id: string;
	readonly level: number;
	readonly parentId: string | null;
	readonly centroid: readonly number[] | null;
	readonly builtFrom: readonly string[];
	readonly sourceIds: readonly string[];
	readonly summary: string | null;
}

export interface PlannedNode {
	id: string;
	level: number;
	parentId: string | null;
	/** leaf: member ids, most central first */
	memberIds: string[];
	/** interior: child node ids, most central first */
	childIds: string[];
	centroid: Float32Array;
	regenerate: boolean;
	existing: ExistingNode | undefined;
}

export interface Plan {
	/** ordered by level, leaves first, so a parent is planned after its children */
	nodes: PlannedNode[];
	deleteIds: string[];
	leafOf: Map<string, string | null>;
	/** partition size at the last re-cluster, or null when the partition is not a tree */
	clusteredSize: number | null;
}

export type PlanSettings = Pick<
	Settings,
	| 'leafClusterSize'
	| 'fanout'
	| 'topFloor'
	| 'treeMinMembers'
	| 'flatMinMembers'
	| 'dirtyMin'
	| 'dirtyFraction'
	| 'rebuildGrowth'
>;

export interface PlanInput {
	members: readonly PlanMember[];
	nodes: readonly ExistingNode[];
	clusteredSize: number | null;
	/** memories withdrawn, flagged or moved out since the last pass: every node built from one is rebuilt */
	revoked: ReadonlySet<string>;
	/** `memberRef` of every eligible member now; a leaf built from any other ref is rebuilt */
	current: ReadonlySet<string>;
	settings: PlanSettings;
	newId: () => string;
}

export function memberRef(member: Pick<PlanMember, 'id' | 'revision' | 'hash'>): string {
	return member.hash ? `${member.id}@${member.revision}:${member.hash}` : `${member.id}@${member.revision}`;
}

function refId(ref: string): string {
	const at = ref.lastIndexOf('@');
	return at < 0 ? ref : ref.slice(0, at);
}

export function membershipDelta(before: readonly string[], after: readonly string[]): number {
	const previous = new Map(before.map((ref) => [refId(ref), ref]));
	let delta = 0;
	for (const ref of after) {
		const old = previous.get(refId(ref));
		if (old !== ref) delta++;
		previous.delete(refId(ref));
	}
	return delta + previous.size;
}

export function dirtyThreshold(size: number, settings: PlanSettings): number {
	return Math.max(settings.dirtyMin, Math.ceil(size * settings.dirtyFraction));
}

function builtFromRevoked(node: ExistingNode | undefined, revoked: ReadonlySet<string>): boolean {
	return node !== undefined && node.sourceIds.some((id) => revoked.has(id));
}

/**
 * Pairs each new group with the old node sharing the most ids with it (greedy, largest overlap first), so a node
 * keeps its id across a re-cluster when it keeps most of its members.
 */
export function matchByOverlap(
	groups: readonly (readonly string[])[],
	candidates: readonly { id: string; ids: readonly string[] }[],
): (string | undefined)[] {
	const owner = new Map<string, number>();
	candidates.forEach((candidate, index) => {
		for (const id of candidate.ids) owner.set(id, index);
	});
	const pairs: { group: number; candidate: number; overlap: number }[] = [];
	groups.forEach((group, groupIndex) => {
		const counts = new Map<number, number>();
		for (const id of group) {
			const candidate = owner.get(id);
			if (candidate !== undefined) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
		}
		for (const [candidate, overlap] of counts) pairs.push({ group: groupIndex, candidate, overlap });
	});
	pairs.sort((a, b) => b.overlap - a.overlap || a.group - b.group || a.candidate - b.candidate);
	const matched: (string | undefined)[] = groups.map(() => undefined);
	const taken = new Set<number>();
	for (const { group, candidate } of pairs) {
		if (matched[group] !== undefined || taken.has(candidate)) continue;
		matched[group] = candidates[candidate].id;
		taken.add(candidate);
	}
	return matched;
}

function byCentrality<T>(items: readonly T[], vectorOf: (item: T) => Vector, centroid: Vector): T[] {
	return [...items].sort((a, b) => dot(vectorOf(b), centroid) - dot(vectorOf(a), centroid));
}

function leafNode(
	id: string,
	members: readonly PlanMember[],
	existing: ExistingNode | undefined,
	input: PlanInput,
): PlannedNode {
	const centroid = centroidOf(members.map((member) => member.vector));
	const ordered = byCentrality(members, (member) => member.vector, centroid);
	// Text never outlives its sources: a member removed or revised since the summary forces a rebuild, while members
	// that only joined wait for the dirty threshold.
	const regenerate =
		!existing?.summary ||
		builtFromRevoked(existing, input.revoked) ||
		existing.builtFrom.some((ref) => !input.current.has(ref)) ||
		membershipDelta(existing.builtFrom, ordered.map(memberRef)) >= dirtyThreshold(members.length, input.settings);
	return {
		id,
		level: 1,
		parentId: null,
		memberIds: ordered.map((member) => member.id),
		childIds: [],
		centroid,
		regenerate,
		existing,
	};
}

function interiorNode(
	id: string,
	level: number,
	children: readonly PlannedNode[],
	existing: ExistingNode | undefined,
	revoked: ReadonlySet<string>,
): PlannedNode {
	const centroid = centroidOf(children.map((child) => child.centroid));
	const ordered = byCentrality(children, (child) => child.centroid, centroid);
	const childIds = ordered.map((child) => child.id);
	const sameChildren =
		existing !== undefined &&
		existing.builtFrom.length === childIds.length &&
		childIds.every((childId) => existing.builtFrom.includes(childId));
	const regenerate =
		!existing?.summary ||
		!sameChildren ||
		children.some((child) => child.regenerate) ||
		builtFromRevoked(existing, revoked);
	for (const child of children) child.parentId = id;
	return { id, level, parentId: null, memberIds: [], childIds, centroid, regenerate, existing };
}

async function recluster(input: PlanInput, byId: Map<string, ExistingNode>): Promise<PlannedNode[]> {
	const { members, settings } = input;
	const vectors = members.map((member) => member.vector);
	const k = Math.max(1, Math.round(members.length / settings.leafClusterSize));
	const { assignments } = await kmeans(vectors, k);
	const groups: PlanMember[][] = [];
	members.forEach((member, index) => (groups[assignments[index]] ??= []).push(member));

	const oldLeaves = input.nodes
		.filter((node) => node.level === 1)
		.map((node) => ({ id: node.id, ids: node.builtFrom.map(refId) }));
	const leafIds = matchByOverlap(
		groups.map((group) => group.map((member) => member.id)),
		oldLeaves,
	);
	let level: PlannedNode[] = groups.map((group, index) => {
		const id = leafIds[index] ?? input.newId();
		return leafNode(id, group, byId.get(id), input);
	});
	const planned = [...level];

	for (let depth = 2; level.length > settings.topFloor; depth++) {
		const up = await kmeans(
			level.map((node) => node.centroid),
			Math.max(1, Math.round(level.length / settings.fanout)),
			{ minClusterSize: 2 },
		);
		const childGroups: PlannedNode[][] = [];
		level.forEach((node, index) => (childGroups[up.assignments[index]] ??= []).push(node));
		const oldAtDepth = input.nodes
			.filter((node) => node.level === depth)
			.map((node) => ({ id: node.id, ids: node.builtFrom }));
		const ids = matchByOverlap(
			childGroups.map((group) => group.map((node) => node.id)),
			oldAtDepth,
		);
		level = childGroups.map((group, index) => {
			const id = ids[index] ?? input.newId();
			return interiorNode(id, depth, group, byId.get(id), input.revoked);
		});
		planned.push(...level);
		if (childGroups.length === 1) break;
	}
	return planned;
}

function incremental(input: PlanInput, byId: Map<string, ExistingNode>): PlannedNode[] {
	const leaves = input.nodes.filter((node) => node.level === 1 && node.centroid?.length);
	const leafIndex = new Map(leaves.map((leaf, index) => [leaf.id, index]));
	const centroids = leaves.map((leaf) => normalize(leaf.centroid!));
	const groups: PlanMember[][] = leaves.map(() => []);
	for (const member of input.members) {
		const index =
			(member.leafId !== null ? leafIndex.get(member.leafId) : undefined) ??
			nearestCentroid(member.vector, centroids).index;
		groups[index].push(member);
	}
	const planned = new Map<string, PlannedNode>();
	leaves.forEach((leaf, index) => {
		if (groups[index].length > 0) planned.set(leaf.id, leafNode(leaf.id, groups[index], leaf, input));
	});
	const maxLevel = Math.max(1, ...input.nodes.map((node) => node.level));
	for (let depth = 2; depth <= maxLevel; depth++) {
		for (const node of input.nodes) {
			if (node.level !== depth) continue;
			const children = [...planned.values()].filter(
				(child) => child.level === depth - 1 && byId.get(child.id)?.parentId === node.id,
			);
			if (children.length > 0) planned.set(node.id, interiorNode(node.id, depth, children, node, input.revoked));
		}
	}
	return [...planned.values()];
}

export async function planPartition(input: PlanInput): Promise<Plan> {
	const { members, nodes, settings } = input;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const n = members.length;
	let planned: PlannedNode[] = [];
	let clusteredSize: number | null = null;

	if (n >= settings.treeMinMembers) {
		const isTree = input.clusteredSize !== null && nodes.some((node) => node.level === 1 && node.centroid?.length);
		const grew = isTree && n >= input.clusteredSize! * settings.rebuildGrowth;
		const shrank = isTree && n * settings.rebuildGrowth <= input.clusteredSize!;
		if (!isTree || grew || shrank) {
			planned = await recluster(input, byId);
			clusteredSize = n;
		} else {
			planned = incremental(input, byId);
			clusteredSize = input.clusteredSize;
		}
	} else if (n >= settings.flatMinMembers) {
		const [id] = matchByOverlap(
			[members.map((member) => member.id)],
			nodes.map((node) => ({ id: node.id, ids: node.level === 1 ? node.builtFrom.map(refId) : [] })),
		);
		const existing = id === undefined ? undefined : byId.get(id);
		// a former tree's leaf summarizes only part of the members
		const reuse = existing && input.clusteredSize === null ? existing : undefined;
		planned = [leafNode(id ?? input.newId(), members, reuse, input)];
	}

	planned.sort((a, b) => a.level - b.level);
	const kept = new Set(planned.map((node) => node.id));
	const leafOf = new Map<string, string | null>(members.map((member) => [member.id, null]));
	for (const node of planned) for (const memberId of node.memberIds) leafOf.set(memberId, node.id);
	return {
		nodes: planned,
		deleteIds: nodes.filter((node) => !kept.has(node.id)).map((node) => node.id),
		leafOf,
		clusteredSize,
	};
}
