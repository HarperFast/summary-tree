import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../dist/kmeans.js';
import { matchByOverlap, memberRef, membershipDelta, planPartition as planPartitionRaw } from '../dist/plan.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';

const settings = { ...DEFAULT_SETTINGS, treeMinMembers: 12, leafClusterSize: 4, fanout: 2, topFloor: 2, dirtyMin: 2 };

// `groups` well-separated topics of `size` members each
function members(groups, size, revision = 1, firstGroup = 0) {
	const out = [];
	for (let g = firstGroup; g < firstGroup + groups; g++) {
		for (let i = 0; i < size; i++) {
			const v = new Array(8).fill(0.01);
			v[g] = 1;
			v[7] = 0.02 * i;
			out.push({ id: `g${g}-m${i}`, revision, vector: normalize(v), leafId: null });
		}
	}
	return out;
}

let counter = 0;
const newId = () => `new-${++counter}`;
const planPartition = (input) => planPartitionRaw({ current: new Set(input.members.map(memberRef)), ...input });

function asExisting(plan, summaries = true) {
	return plan.nodes.map((node) => ({
		id: node.id,
		level: node.level,
		parentId: node.parentId,
		centroid: Array.from(node.centroid),
		builtFrom: node.level === 1 ? node.memberIds.map((id) => `${id}@1`) : node.childIds,
		sourceIds:
			node.level === 1 ? node.memberIds : plan.nodes.filter((c) => c.parentId === node.id).flatMap((c) => c.memberIds),
		summary: summaries ? 'text' : null,
	}));
}

test('membershipDelta counts members added, removed or revised', () => {
	assert.equal(membershipDelta(['a@1', 'b@1'], ['a@1', 'b@1']), 0);
	assert.equal(membershipDelta(['a@1', 'b@1'], ['a@2', 'b@1']), 1);
	assert.equal(membershipDelta(['a@1', 'b@1'], ['a@1', 'c@1']), 2);
	assert.equal(memberRef({ id: 'x', revision: 3 }), 'x@3');
});

test('matchByOverlap keeps the old id for the group sharing most members, each old id once', () => {
	const matched = matchByOverlap(
		[['a', 'b', 'c'], ['d', 'e'], ['f']],
		[
			{ id: 'old-1', ids: ['d', 'e', 'a'] },
			{ id: 'old-2', ids: ['a', 'b'] },
		],
	);
	assert.deepEqual(matched, ['old-2', 'old-1', undefined]);
});

test('partition size decides the shape: none below the flat minimum, one flat node, then a tree', async () => {
	const tiny = await planPartition({
		members: members(1, 2),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.equal(tiny.nodes.length, 0);

	const flat = await planPartition({
		members: members(1, 5),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.equal(flat.nodes.length, 1);
	assert.equal(flat.nodes[0].parentId, null);
	assert.equal(flat.clusteredSize, null);

	const tree = await planPartition({
		members: members(3, 8),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.equal(tree.clusteredSize, 24);
	const leaves = tree.nodes.filter((n) => n.level === 1);
	assert.ok(leaves.length >= 4);
	assert.ok(
		tree.nodes.some((n) => n.level > 1),
		'interior levels above topFloor leaves',
	);
	assert.ok(
		tree.nodes.every((n) => n.regenerate),
		'a first build summarizes every node',
	);
	for (const leaf of leaves)
		assert.ok(new Set(leaf.memberIds.map((id) => id.split('-')[0])).size === 1, 'clusters stay within a topic');
});

test('a re-cluster keeps node ids by member overlap and keeps text below the dirty threshold', async () => {
	const first = await planPartition({
		members: members(3, 8),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	const existing = asExisting(first);
	// doubling forces a re-cluster: same 24 members plus 24 in a new topic
	const grown = [...members(3, 8), ...members(1, 24, 1, 3)];
	const second = await planPartition({
		members: grown,
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.equal(second.clusteredSize, grown.length);
	const oldLeafIds = new Set(first.nodes.filter((n) => n.level === 1).map((n) => n.id));
	const kept = second.nodes.filter((n) => n.level === 1 && oldLeafIds.has(n.id));
	assert.ok(kept.length >= oldLeafIds.size - 1, `kept ${kept.length} of ${oldLeafIds.size} leaf ids`);
	assert.ok(
		kept.some((n) => !n.regenerate),
		'an unchanged cluster keeps its text with no model call',
	);
	assert.ok(second.nodes.filter((n) => n.level === 1 && !oldLeafIds.has(n.id)).every((n) => n.regenerate));
});

test('incremental: a new member below the threshold keeps text; a removed, revised or revoked source forces a rebuild', async () => {
	const first = await planPartition({
		members: members(3, 8),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	const existing = asExisting(first);
	const leafOf = first.leafOf;
	const withLeaves = members(3, 8).map((m) => ({ ...m, leafId: leafOf.get(m.id) }));

	const unchanged = await planPartition({
		members: withLeaves,
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.ok(unchanged.nodes.every((n) => !n.regenerate));
	assert.deepEqual(unchanged.deleteIds, []);

	const joined = { id: 'g0-new', revision: 1, vector: withLeaves[0].vector, leafId: null };
	const belowThreshold = await planPartition({
		members: [...withLeaves, joined],
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.ok(
		belowThreshold.nodes.every((n) => !n.regenerate),
		'one new member stays below dirtyMin 2',
	);

	const victim = withLeaves[0];
	const rest = withLeaves.slice(1);
	const removed = await planPartition({
		members: rest,
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.ok(
		removed.nodes.find((n) => n.id === leafOf.get(victim.id)).regenerate,
		'a removed source forces its leaf to rebuild: text never outlives its sources',
	);
	const revised = await planPartition({
		members: [{ ...victim, revision: 2 }, ...rest],
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.ok(revised.nodes.find((n) => n.id === leafOf.get(victim.id)).regenerate, 'so does a revised one');

	const revoked = await planPartition({
		members: rest,
		nodes: existing,
		clusteredSize: 24,
		revoked: new Set([victim.id]),
		settings,
		newId,
	});
	const rebuilt = new Set(revoked.nodes.filter((n) => n.regenerate).map((n) => n.id));
	const victimLeaf = leafOf.get(victim.id);
	assert.ok(rebuilt.has(victimLeaf), 'its leaf');
	let parent = existing.find((n) => n.id === victimLeaf).parentId;
	while (parent) {
		assert.ok(rebuilt.has(parent), `its ancestor ${parent}`);
		parent = existing.find((n) => n.id === parent).parentId;
	}
	const untouched = revoked.nodes.filter((n) => n.level === 1 && n.id !== victimLeaf);
	assert.ok(
		untouched.every((n) => !n.regenerate),
		'other leaves keep their text',
	);
});

test('a flat node that falls below the flat minimum is deleted', async () => {
	const flat = await planPartition({
		members: members(1, 4),
		nodes: [],
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	const shrunk = await planPartition({
		members: members(1, 2),
		nodes: asExisting(flat),
		clusteredSize: null,
		revoked: new Set(),
		settings,
		newId,
	});
	assert.deepEqual(shrunk.nodes, []);
	assert.deepEqual(shrunk.deleteIds, [flat.nodes[0].id]);
	assert.ok([...shrunk.leafOf.values()].every((leaf) => leaf === null));
});
