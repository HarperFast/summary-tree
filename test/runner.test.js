import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { databases, lockCalls, modelState, resetTables, rows, transaction } from 'harper';
import { memoryStore } from '@harperfast/agent-memory';
import { Runner } from '../dist/runner.js';
import { DEFAULT_SETTINGS } from '../dist/settings.js';
import { recordMemory } from '../dist/store.js';
import { readableTopNodes } from '../dist/serve.js';
import { partitionId } from '../dist/partition.js';

const settings = { ...DEFAULT_SETTINGS, debounceMs: 0, treeMinMembers: 12, leafClusterSize: 4, fanout: 2, topFloor: 2 };
const acmeReader = { id: 'bob', superUser: false, read: ['customer:acme'] };
const ACME = partitionId(['customer:acme']);
const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

const memory = (n, overrides = {}) => ({
	id: `mem-${String(n).padStart(12, '0')}`,
	title: `acme topic ${n}`,
	content: `acme walrus note number ${n}`,
	scopes: ['customer:acme'],
	status: 'active',
	revision: 1,
	createdAt: '2026-11-01T00:00:00Z',
	...overrides,
});

async function until(what, probe, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let runner;
beforeEach(() => {
	resetTables();
	Object.assign(modelState, { generateCalls: 0, onGenerate: undefined, generate: undefined, embed: undefined });
	memoryStore.clear();
});

/** What agent-memory does on a write: store the row, then call the sink in the same transaction. */
async function write(row) {
	memoryStore.set(row.id, row);
	await transaction((txn) => recordMemory(row, txn, { now: Date.now() }));
}
afterEach(() => runner?.stop());

async function startWith(memories) {
	for (const row of memories) memoryStore.set(row.id, row);
	runner = new Runner(settings, quiet);
	runner.start();
	await until(
		'the first pass',
		async () => runner.ready && rows('SummaryChange').length === 0 && rows('SummaryNode').length > 0,
	);
}

test('the startup walk records memories its sink missed, then a pass builds and publishes the partition', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const [node] = rows('SummaryNode');
	assert.equal(node.partition, ACME);
	assert.equal(node.memberCount, 5);
	assert.equal(node.top, true);
	assert.deepEqual([...node.sourceIds].sort(), [1, 2, 3, 4, 5].map((n) => memory(n).id).sort());
	assert.deepEqual(
		rows('SummaryAssignment').map((row) => row.leafId),
		[node.id, node.id, node.id, node.id, node.id],
	);
	assert.equal(modelState.generateCalls, 1);
	assert.equal(rows('SummaryState')[0].leaseUntil, 0, 'the lease is released after the pass');
});

test('a revoking change committed during a rebuild survives it and keeps the partition hidden', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	modelState.onGenerate = async () => {
		modelState.onGenerate = undefined;
		await write(memory(5, { status: 'withdrawn', revision: 3 }));
	};
	runner.stop();
	runner = new Runner(settings, quiet);
	// a content change forces a model call, during which memory 5 is withdrawn
	for (const n of [1, 2]) {
		await write(memory(n, { content: `changed ${n}`, revision: 2 }));
	}
	runner.start();
	await until('the first rebuild to publish', async () => modelState.generateCalls >= 2);
	await until('the second rebuild to absorb the withdrawal', async () => rows('SummaryChange').length === 0);
	const [node] = rows('SummaryNode');
	assert.ok(!node.sourceIds.includes(memory(5).id), 'the withdrawn memory is gone from the summary provenance');
	assert.ok(modelState.generateCalls >= 3, 'the withdrawal forced a rebuild');
});

test('a memory changed after its member row was read is left out until its own change is processed', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	// agent-memory has revision 2 but the sink has not run yet: the runner must not summarize the newer text
	memoryStore.set(memory(4).id, memory(4, { content: 'acme secret draft', revision: 2 }));
	const prompts = [];
	modelState.onGenerate = (input) => prompts.push(input.messages.at(-1).content);
	await write(memory(1, { content: 'changed 1', revision: 2 }));
	await write(memory(2, { content: 'changed 2', revision: 2 }));
	await runner.tick();
	assert.ok(prompts.length > 0);
	assert.ok(prompts.every((prompt) => !prompt.includes('secret draft')));
});

test('a failed rebuild keeps its revoking changes, so the partition stays hidden', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	modelState.generate = async () => {
		throw new Error('model unavailable');
	};
	await write(memory(3, { status: 'withdrawn', revision: 2 }));
	await runner.tick();
	assert.ok(rows('SummaryChange').some((change) => change.revoke));
	assert.deepEqual((await readableTopNodes(acmeReader)).nodes, []);
	assert.equal(rows('SummaryNode')[0].sourceIds.includes(memory(3).id), true, 'old text kept but not served');
});

test('a rebuild whose lease moved to another worker publishes nothing', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const before = rows('SummaryNode')[0];
	modelState.onGenerate = async () => {
		await databases.memory.SummaryState.put({
			id: 'runner',
			leaseHolder: 'someone-else',
			leaseUntil: Date.now() + 60_000,
		});
	};
	await write(memory(1, { content: 'changed', revision: 2 }));
	await write(memory(2, { content: 'changed', revision: 2 }));
	await runner.tick();
	assert.deepEqual(rows('SummaryNode')[0].summary, before.summary);
	assert.equal(rows('SummaryChange').length, 2, 'its changes stay for the leaseholder');
});

test('an expired member leaves its summary without any change event', async () => {
	const soon = new Date(Date.now() + 300).toISOString();
	await startWith([1, 2, 3, 4].map((n) => memory(n)).concat(memory(5, { validUntil: soon })));
	assert.equal(rows('SummaryNode')[0].memberCount, 5);
	await until('expiry to rebuild the node', async () => rows('SummaryNode')[0]?.memberCount === 4, 5_000);
	assert.ok(!rows('SummaryAssignment').some((row) => row.id === memory(5).id), 'its assignment is removed');
	assert.ok(
		rows('SummaryState').some((row) => row.id === 'expiry'),
		'the runner keeps its own expiry bookkeeping',
	);
});

test('a worker with runner: false serves but never rebuilds', async () => {
	for (const n of [1, 2, 3, 4]) memoryStore.set(memory(n).id, memory(n));
	runner = new Runner({ ...settings, runner: false }, quiet);
	runner.start();
	await until('the startup walk', async () => runner.ready);
	await runner.tick();
	assert.equal(rows('SummaryNode').length, 0);
	assert.ok(rows('SummaryChange').length > 0, 'its work waits for a runner node');
});

test('the publish transaction takes the runner lock before checking the lease', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const locks = lockCalls.filter((call) => call.table === 'SummaryState' && call.id === 'runner');
	assert.ok(locks.length >= 3, 'acquire, renew and publish');
	assert.ok(locks.every((call) => call.inTransaction));
});

test('a memory moved to another label set on another node revokes the partition that still holds its text', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const acmeNode = rows('SummaryNode')[0];
	// what replication leaves when another node moved memory 5 to customer:beta: no sink here revoked customer:acme
	const moved = memory(5, { scopes: ['customer:beta'], revision: 2 });
	memoryStore.set(moved.id, moved);
	const BETA = partitionId(['customer:beta']);
	await databases.memory.SummaryMember.put({
		...rows('SummaryMember').find((m) => m.id === moved.id),
		partition: BETA,
		labels: ['customer:beta'],
		revision: 2,
	});
	await databases.memory.SummaryChange.put({
		id: 'replicated',
		partition: BETA,
		labels: ['customer:beta'],
		memoryId: moved.id,
		revision: 2,
		revoke: false,
	});
	modelState.generate = async () => {
		throw new Error('model unavailable');
	};
	await runner.tick();
	assert.ok(acmeNode.sourceIds.includes(moved.id));
	assert.ok(
		rows('SummaryChange').some((change) => change.partition === ACME && change.revoke),
		'the revoke lands even though the rebuild failed',
	);
	assert.deepEqual((await readableTopNodes(acmeReader)).nodes, []);
	modelState.generate = undefined;
	await runner.tick();
	await until('customer:acme to be rebuilt without the moved memory', async () => {
		const node = rows('SummaryNode').find((n) => n.partition === ACME);
		return node && !node.sourceIds.includes(moved.id) && rows('SummaryChange').length === 0;
	});
});

test('on startup a partition whose only top node sits above the leaves is re-planned without it', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const leaf = rows('SummaryNode')[0];
	const calls = modelState.generateCalls;
	runner.stop();
	// the shape 0.2.0 stored when a level got one parent
	await databases.memory.SummaryNode.put({
		...leaf,
		id: 'legacy-root',
		level: 2,
		parentId: null,
		top: true,
		builtFrom: [leaf.id],
		title: 'Generic root',
	});
	await databases.memory.SummaryNode.put({ ...leaf, parentId: 'legacy-root', top: false });

	runner = new Runner(settings, quiet);
	runner.start();
	await until('the legacy root to be removed', async () => !rows('SummaryNode').some((n) => n.id === 'legacy-root'));
	await until('its change to be absorbed', async () => rows('SummaryChange').length === 0);
	const [promoted] = rows('SummaryNode');
	assert.equal(promoted.id, leaf.id);
	assert.equal(promoted.top, true);
	assert.equal(promoted.parentId, null);
	assert.equal(modelState.generateCalls, calls, 'no model call');
});

test('a runner stopped while it looks for lone top nodes stays stopped and queues nothing', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	const leaf = rows('SummaryNode')[0];
	runner.stop();
	await databases.memory.SummaryNode.put({ ...leaf, id: 'legacy-root', level: 2, parentId: null, top: true });
	await databases.memory.SummaryNode.put({ ...leaf, parentId: 'legacy-root', top: false });

	const { SummaryNode } = databases.memory;
	const search = SummaryNode.search;
	let release;
	let entered = false;
	const gate = new Promise((resolve) => (release = resolve));
	SummaryNode.search = async function (query, ...rest) {
		if (query?.conditions?.some((condition) => condition.attribute === 'top')) {
			entered = true;
			await gate;
		}
		return search.call(this, query, ...rest);
	};
	try {
		runner = new Runner(settings, quiet);
		runner.start();
		await until('the lone-top search', async () => entered);
		runner.stop();
		release();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(runner.ready, false);
		assert.ok(!rows('SummaryChange').some((change) => change.id.startsWith('reshape:')));
	} finally {
		SummaryNode.search = search;
	}
});
