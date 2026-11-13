import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { databases, resetTables } from 'harper';
import { annotateHits, expandNode, orientation, readableTopNodes } from '../dist/serve.js';
import { partitionId, partitionLabels } from '../dist/partition.js';

const { SummaryMember, SummaryNode, SummaryChange } = databases.memory;

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
		await SummaryMember.put({
			id,
			partition: partitionId(partitionLabels(scopes)),
			labels: scopes,
			eligible: true,
			leafId,
			title: `${id} title`,
		});
	}
});

test('a caller sees exactly the top nodes canReadLabels allows, largest first', async () => {
	assert.deepEqual(
		(await readableTopNodes(acmeReader)).map((n) => n.id),
		['global-1', 'acme-1', 'acme-beta-1'],
	);
	assert.deepEqual(
		(await readableTopNodes(globalReader)).map((n) => n.id),
		['global-1'],
	);
	assert.deepEqual(
		(await readableTopNodes(admin)).map((n) => n.id),
		['global-1', 'beta-1', 'acme-1', 'acme-beta-1'],
	);
});

test("a reader of one customer label never sees another customer's partition", async () => {
	const ids = (await readableTopNodes(acmeReader)).map((n) => n.id);
	assert.ok(!ids.includes('beta-1'));
	assert.notEqual(partitionId(['customer:acme']), partitionId(['customer:beta']));
	await assert.rejects(expandNode(acmeReader, 'beta-1'), { statusCode: 404 });
	const annotations = await annotateHits(acmeReader, [{ id: 'm-beta' }, { id: 'm-acme' }]);
	assert.deepEqual([...annotations.keys()], ['m-acme']);
});

test('a pending revoking change hides its whole partition from every surface until absorbed', async () => {
	await SummaryChange.put({ id: 'c1', partition: partitionId(['customer:acme']), revoke: true, memoryId: 'm-x' });
	assert.ok(!(await readableTopNodes(acmeReader)).some((n) => n.id === 'acme-1'));
	assert.deepEqual([...(await annotateHits(acmeReader, [{ id: 'm-acme' }])).keys()], []);
	await assert.rejects(expandNode(acmeReader, 'acme-1'), { statusCode: 404 });
	// a non-revoking change only marks work
	await SummaryChange.put({ id: 'c2', partition: partitionId(['customer:beta']), revoke: false, memoryId: 'm-y' });
	assert.ok((await readableTopNodes(admin)).some((n) => n.id === 'beta-1'));
});

test('orientation fills the budget breadth first: top nodes largest first, then their children', async () => {
	const all = await orientation(acmeReader, 100_000);
	assert.deepEqual(
		all.map((item) => item.title),
		['global-1 title', 'acme-1 title', 'acme-beta-1 title', 'global-1a title'],
	);
	assert.match(all[0].content, /\(40 memories; summary node global-1\)$/);
	const size = all[0].title.length + all[0].content.length;
	const tight = await orientation(acmeReader, size + 5);
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
	await assert.rejects(expandNode(globalReader, 'acme-1'), { statusCode: 404 });
	await assert.rejects(expandNode(globalReader, 'missing'), { statusCode: 404 });
});
