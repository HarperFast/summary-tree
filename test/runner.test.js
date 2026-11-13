import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { databases, modelState, resetTables, rows, transaction } from 'harper';
import { scanState } from '@harperfast/agent-memory';
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
	scanState.rows = [];
});
afterEach(() => runner?.stop());

async function startWith(memories) {
	scanState.rows = memories;
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
	assert.ok(rows('SummaryMember').every((member) => member.leafId === node.id && member.vector?.length));
	assert.equal(modelState.generateCalls, 1);
	assert.equal(rows('SummaryState')[0].leaseUntil, 0, 'the lease is released after the pass');
});

test('a revoking change committed during a rebuild survives it and keeps the partition hidden', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	modelState.onGenerate = async () => {
		modelState.onGenerate = undefined;
		await transaction((txn) =>
			recordMemory(memory(5, { status: 'withdrawn', revision: 3 }), txn, { memberChars: 2000, now: Date.now() }),
		);
	};
	runner.stop();
	runner = new Runner(settings, quiet);
	// a content change forces a model call, during which memory 5 is withdrawn
	for (const n of [1, 2]) {
		await transaction((txn) =>
			recordMemory(memory(n, { content: `changed ${n}`, revision: 2 }), txn, { memberChars: 2000, now: Date.now() }),
		);
	}
	scanState.rows = [];
	runner.start();
	await until('the first rebuild to publish', async () => modelState.generateCalls >= 2);
	await until('the second rebuild to absorb the withdrawal', async () => rows('SummaryChange').length === 0);
	const [node] = rows('SummaryNode');
	assert.ok(!node.sourceIds.includes(memory(5).id), 'the withdrawn memory is gone from the summary provenance');
	assert.ok(modelState.generateCalls >= 3, 'the withdrawal forced a rebuild');
});

test('a failed rebuild keeps its revoking changes, so the partition stays hidden', async () => {
	await startWith([1, 2, 3, 4, 5].map((n) => memory(n)));
	modelState.generate = async () => {
		throw new Error('model unavailable');
	};
	await transaction((txn) =>
		recordMemory(memory(3, { status: 'withdrawn', revision: 2 }), txn, { memberChars: 2000, now: Date.now() }),
	);
	await runner.tick();
	assert.ok(rows('SummaryChange').some((change) => change.revoke));
	assert.deepEqual(await readableTopNodes(acmeReader), []);
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
	await transaction((txn) =>
		recordMemory(memory(1, { content: 'changed', revision: 2 }), txn, { memberChars: 2000, now: Date.now() }),
	);
	await transaction((txn) =>
		recordMemory(memory(2, { content: 'changed', revision: 2 }), txn, { memberChars: 2000, now: Date.now() }),
	);
	await runner.tick();
	assert.deepEqual(rows('SummaryNode')[0].summary, before.summary);
	assert.equal(rows('SummaryChange').length, 2, 'its changes stay for the leaseholder');
});

test('an expired member leaves its summary without any change event', async () => {
	const soon = new Date(Date.now() + 300).toISOString();
	await startWith([1, 2, 3, 4].map((n) => memory(n)).concat(memory(5, { validUntil: soon })));
	assert.equal(rows('SummaryNode')[0].memberCount, 5);
	await until('expiry to rebuild the node', async () => rows('SummaryNode')[0]?.memberCount === 4, 5_000);
	const expired = rows('SummaryMember').find((member) => member.id === memory(5).id);
	assert.equal(expired.eligible, false);
	assert.equal(expired.text, null);
});
