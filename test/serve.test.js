import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { databases, resetTables } from 'harper';
import { memoryStore } from '@harperfast/agent-memory';
import { annotateHits, expandNode, orientation, readableTopNodes } from '../dist/serve.js';
import { partitionId, partitionLabels } from '../dist/partition.js';

const { SummaryAssignment, SummaryMember, SummaryNode, SummaryChange } = databases.memory;

const acmeReader = { id: 'bob', superUser: false, read: ['user:bob', 'global', 'customer:acme'] };
const globalReader = { id: 'alice', superUser: false, read: ['user:alice', 'global'] };
const admin = { id: 'admin', superUser: true, read: [] };

async function node(id, scopes, fields = {}) {
	const labels = partitionLabels(scopes);
	await SummaryNode.put({
		id,
		partition: partitionId(labels),
		labels,
		level: 1,
		parentId: null,
		top: true,
		title: `${id} title`,
		summary: `${id} summary`,
		memberCount: 3,
		sourceIds: [],
		...fields,
	});
}

beforeEach(async () => {
	resetTables();
	memoryStore.clear();
	await node('global-1', ['global'], { memberCount: 40, level: 2 });
	await node('global-1a', ['global'], { memberCount: 15, parentId: 'global-1', top: false });
	await node('acme-1', ['customer:acme'], { memberCount: 5 });
	await node('beta-1', ['customer:beta'], { memberCount: 9 });
	await node('acme-beta-1', ['customer:acme', 'customer:beta'], { memberCount: 4 });
	for (const [id, scopes, leafId] of [
		['m-acme', ['customer:acme'], 'acme-1'],
		['m-beta', ['customer:beta'], 'beta-1'],
		['m-global', ['global'], 'global-1a'],
	]) {
		const partition = partitionId(partitionLabels(scopes));
		await SummaryMember.put({ id, partition, labels: scopes, eligible: true, revision: 1 });
		await SummaryAssignment.put({ id, partition, leafId });
		memoryStore.set(id, { id, title: `${id} title`, content: 'c', scopes, status: 'active', revision: 1 });
	}
});

test('a caller sees exactly the top nodes canReadLabels allows, largest first', async () => {
	assert.deepEqual(
		(await readableTopNodes(acmeReader)).nodes.map((n) => n.id),
		['global-1', 'acme-1', 'acme-beta-1'],
	);
	assert.deepEqual(
		(await readableTopNodes(globalReader)).nodes.map((n) => n.id),
		['global-1'],
	);
	assert.deepEqual(
		(await readableTopNodes(admin)).nodes.map((n) => n.id),
		['global-1', 'beta-1', 'acme-1', 'acme-beta-1'],
	);
});

test("a reader of one customer label never sees another customer's partition", async () => {
	const ids = (await readableTopNodes(acmeReader)).nodes.map((n) => n.id);
	assert.ok(!ids.includes('beta-1'));
	assert.notEqual(partitionId(['customer:acme']), partitionId(['customer:beta']));
	await assert.rejects(expandNode(acmeReader, 'beta-1'), { statusCode: 404 });
	const annotations = await annotateHits(acmeReader, [{ id: 'm-beta' }, { id: 'm-acme' }]);
	assert.deepEqual([...annotations.keys()], ['m-acme']);
});

test('a pending revoking change hides its whole partition from every surface until absorbed', async () => {
	await SummaryChange.put({
		id: 'c1',
		partition: partitionId(['customer:acme']),
		revokePartition: partitionId(['customer:acme']),
		revoke: true,
		memoryId: 'm-x',
	});
	assert.ok(!(await readableTopNodes(acmeReader)).nodes.some((n) => n.id === 'acme-1'));
	assert.deepEqual([...(await annotateHits(acmeReader, [{ id: 'm-acme' }])).keys()], []);
	await assert.rejects(expandNode(acmeReader, 'acme-1'), { statusCode: 404 });
	await SummaryChange.put({ id: 'c2', partition: partitionId(['customer:beta']), revoke: false, memoryId: 'm-y' });
	assert.ok((await readableTopNodes(admin)).nodes.some((n) => n.id === 'beta-1'));
});

test('orientation fills the budget breadth first: top nodes largest first, then their children', async () => {
	const all = await orientation(acmeReader, 100_000, 1);
	assert.deepEqual(
		all.map((item) => item.title),
		['global-1 title', 'acme-1 title', 'acme-beta-1 title', 'global-1a title'],
	);
	assert.match(all[0].content, /\(40 memories; summary node global-1\)$/);
	const size = all[0].title.length + all[0].content.length;
	const tight = await orientation(acmeReader, size + 5, 1);
	assert.deepEqual(
		tight.map((item) => item.title),
		['global-1 title'],
	);
});

test('search annotations carry the leaf summary of each readable hit', async () => {
	const annotations = await annotateHits(globalReader, [{ id: 'm-global' }, { id: 'm-acme' }, { id: 'unknown' }]);
	assert.deepEqual([...annotations.keys()], ['m-global']);
	assert.equal(annotations.get('m-global').id, 'global-1a');
	assert.equal(annotations.get('m-global').parentId, 'global-1');
});

test('expanding returns children of an interior node and member ids of a leaf; unreadable is 404', async () => {
	const interior = await expandNode(globalReader, 'global-1');
	assert.deepEqual(
		interior.children.map((c) => c.id),
		['global-1a'],
	);
	const leaf = await expandNode(acmeReader, 'acme-1');
	assert.deepEqual(leaf.members, [{ id: 'm-acme', title: 'm-acme title' }]);
	memoryStore.set('m-acme', { ...memoryStore.get('m-acme'), status: 'withdrawn', revision: 2 });
	assert.deepEqual((await expandNode(acmeReader, 'acme-1')).members, [], 'current state wins over the assignment');
	await assert.rejects(expandNode(globalReader, 'acme-1'), { statusCode: 404 });
	await assert.rejects(expandNode(globalReader, 'missing'), { statusCode: 404 });
});

test('barriers are probed per partition', async () => {
	for (let i = 0; i < 70; i++) {
		await SummaryChange.put({
			id: `other-${i}`,
			partition: `p${i}`,
			revokePartition: `p${i}`,
			revoke: true,
			memoryId: `m${i}`,
		});
	}
	assert.deepEqual(
		(await readableTopNodes(acmeReader)).nodes.map((n) => n.id),
		['global-1', 'acme-1', 'acme-beta-1'],
	);
	await SummaryChange.put({
		id: 'acme-r',
		partition: partitionId(['customer:acme']),
		revokePartition: partitionId(['customer:acme']),
		revoke: true,
		memoryId: 'm-x',
	});
	assert.ok(!(await readableTopNodes(acmeReader)).nodes.some((n) => n.id === 'acme-1'));
	await assert.rejects(expandNode(acmeReader, 'acme-1'), { statusCode: 404 });
});

test("a burst of revocations in other partitions never hides a reader's healthy partitions", async () => {
	for (let i = 0; i < 70; i++) {
		await SummaryChange.put({
			id: `other-${i}`,
			partition: `p${i}`,
			revokePartition: `p${i}`,
			revoke: true,
			memoryId: `m${i}`,
		});
		await node(`n${i}`, [`team:t${i}`], { memberCount: 100 + i });
	}
	const served = (await readableTopNodes(admin)).nodes;
	assert.equal(served.length, 74, 'every healthy partition is served');
});

test('a node past the earliest validUntil of its sources is not served, even before a rebuild', async () => {
	await node('acme-1', ['customer:acme'], { memberCount: 5, expiresAt: new Date(Date.now() - 1000) });
	assert.ok(!(await readableTopNodes(acmeReader)).nodes.some((n) => n.id === 'acme-1'));
	await assert.rejects(expandNode(acmeReader, 'acme-1'), { statusCode: 404 });
});

test('orientation stops after 128 probed candidates, served or not', async () => {
	for (let i = 0; i < 130; i++) {
		const scopes = [`team:b${i}`];
		const partition = partitionId(partitionLabels(scopes));
		await node(`blocked-${i}`, scopes, { memberCount: 1000 + i });
		await SummaryChange.put({ id: `b${i}`, partition, revokePartition: partition, revoke: true, memoryId: `m${i}` });
	}
	const items = await orientation(admin, 100_000, 1);
	assert.deepEqual(items, [], 'the healthy, smaller nodes lie past the attempt budget');
});

const LONG_SUMMARY =
	'Replication streams committed transactions to every peer and resolves conflicts by timestamp. ' +
	'Catch-up after a restart replays the audit log from the last acknowledged position. '.repeat(12);

async function manyTopics(count) {
	for (let i = 0; i < count; i++) {
		await node(`t${i}`, [`team:t${i}`], {
			memberCount: 100 - i,
			summary: LONG_SUMMARY,
			textChars: 12 + LONG_SUMMARY.length,
		});
	}
}

test('orientation takes at most its share of the budget, leaving the rest for the sections packed after it', async () => {
	await manyTopics(30);
	const items = await orientation(admin, 4000, 0.5);
	const used = items.reduce((sum, item) => sum + item.title.length + item.content.length, 0);
	assert.ok(items.length >= 5, `${items.length} items`);
	assert.ok(used <= 2000, `used ${used} of a 2000-char share`);
	assert.deepEqual(await orientation(admin, 4000, 0), []);
});

test('an orientation item is the title, a gist ending at a boundary, and the node reference', async () => {
	await manyTopics(3);
	const [item] = await orientation(admin, 100_000, 1);
	const [gist, reference] = item.content.split('\n');
	assert.equal(gist, 'Replication streams committed transactions to every peer and resolves conflicts by timestamp.');
	assert.equal(reference, '(100 memories; summary node t0)');

	// the gist shrinks to the room left, cut after a whole word
	const fixed = item.title.length + reference.length + 1;
	const [tight] = await orientation(admin, fixed + 70, 1);
	const tightGist = tight.content.split('\n')[0];
	assert.ok(tightGist.length <= 70 && tightGist.length >= 60, tightGist);
	assert.match(tightGist, /^Replication streams committed transactions to every peer( \w+)*…$/);
	const below = await orientation(admin, fixed + 59, 1);
	assert.ok(!below.some((entry) => entry.title === 't0 title'), 'below the gist floor the node is skipped');
});

test("each item after the first is charged the client's framing overhead when agent-memory reports it", async () => {
	await manyTopics(30);
	const size = (items) => items.reduce((sum, item) => sum + item.title.length + item.content.length, 0);
	const plain = await orientation(admin, 4000, 0.5);
	assert.deepEqual(await orientation(admin, 4000, 0.5, 0), plain, 'no overhead reported: unchanged');
	const framed = await orientation(admin, 4000, 0.5, 40);
	assert.ok(framed.length < plain.length, `${framed.length} of ${plain.length} items fit`);
	assert.ok(size(framed) + 40 * (framed.length - 1) <= 2000);
	assert.deepEqual(
		framed.map((item) => item.title),
		plain.slice(0, framed.length).map((item) => item.title),
	);
});
