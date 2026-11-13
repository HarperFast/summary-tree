import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { databases, lockCalls, modelState, resetTables, rows, transaction } from 'harper';
import { recordMemory } from '../dist/store.js';
import { partitionId } from '../dist/partition.js';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const opts = { now: NOW };
const memory = (overrides = {}) => ({
	id: 'mem-aaaaaaaaaaaaaaaa',
	title: 'T',
	content: 'body',
	scopes: ['customer:acme'],
	status: 'active',
	revision: 1,
	...overrides,
});
const ACME = partitionId(['customer:acme']);
const BETA = partitionId(['customer:beta']);
const changes = () => rows('SummaryChange').map(({ partition, revoke, memoryId }) => ({ partition, revoke, memoryId }));

beforeEach(() => {
	resetTables();
	modelState.generateCalls = 0;
});

test('the sink only enqueues: a member row and a change row, no model call', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	assert.equal(modelState.generateCalls, 0);
	const [member] = rows('SummaryMember');
	assert.equal(member.partition, ACME);
	assert.equal(member.eligible, true);
	assert.equal(member.revision, 1);
	assert.ok(!('text' in member) && !('content' in member), 'no memory text is copied');
	assert.deepEqual(changes(), [{ partition: ACME, revoke: false, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
	assert.ok(
		lockCalls.some((call) => call.table === 'SummaryMember' && call.inTransaction),
		'locks the member row',
	);
});

test("the sink's enqueue rolls back with an aborted memory write", async () => {
	await assert.rejects(
		transaction(async (txn) => {
			await recordMemory(memory(), txn, opts);
			throw new Error('a later sink rejected the memory');
		}),
		/rejected/,
	);
	assert.deepEqual(rows('SummaryMember'), []);
	assert.deepEqual(rows('SummaryChange'), []);
});

test('withdrawing a member revokes its old partition through the assignment row', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	await databases.memory.SummaryMember.put({ ...rows('SummaryMember')[0], leafId: 'leaf-1' });
	resetChanges();
	await transaction((txn) => recordMemory(memory({ status: 'withdrawn', revision: 2 }), txn, opts));
	assert.deepEqual(changes(), [{ partition: ACME, revoke: true, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
	const [member] = rows('SummaryMember');
	assert.equal(member.eligible, false);
	assert.equal(member.leafId, null);
});

test('superseding a member dirties its partition without hiding it', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	resetChanges();
	await transaction((txn) => recordMemory(memory({ status: 'superseded', revision: 2 }), txn, opts));
	assert.deepEqual(changes(), [{ partition: ACME, revoke: false, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
});

test('a label change revokes the old partition and dirties the new one', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	resetChanges();
	await transaction((txn) => recordMemory(memory({ scopes: ['customer:beta'], revision: 2 }), txn, opts));
	assert.deepEqual(
		changes().sort((a, b) => Number(b.revoke) - Number(a.revoke)),
		[
			{ partition: ACME, revoke: true, memoryId: 'mem-aaaaaaaaaaaaaaaa' },
			{ partition: BETA, revoke: false, memoryId: 'mem-aaaaaaaaaaaaaaaa' },
		],
	);
	assert.equal(rows('SummaryMember')[0].partition, BETA);
});

test('a withdrawal after a review flag still revokes: summaries may keep text from an ineligible member', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	await transaction((txn) => recordMemory(memory({ needsReview: { cause: 'withdrawn' }, revision: 2 }), txn, opts));
	resetChanges();
	await transaction((txn) =>
		recordMemory(memory({ status: 'withdrawn', needsReview: { cause: 'withdrawn' }, revision: 3 }), txn, opts),
	);
	assert.deepEqual(changes(), [{ partition: ACME, revoke: true, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
});

test('a content flag revokes; clearing it re-includes the memory', async () => {
	await transaction((txn) => recordMemory(memory(), txn, opts));
	resetChanges();
	await transaction((txn) => recordMemory(memory({ contentFlag: { kind: 'x' }, revision: 2 }), txn, opts));
	assert.deepEqual(changes(), [{ partition: ACME, revoke: true, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
	resetChanges();
	await transaction((txn) => recordMemory(memory({ contentFlag: null, revision: 3 }), txn, opts));
	assert.deepEqual(changes(), [{ partition: ACME, revoke: false, memoryId: 'mem-aaaaaaaaaaaaaaaa' }]);
	assert.equal(rows('SummaryMember')[0].eligible, true);
});

test('the startup walk skips a memory the sink already recorded at that revision or later', async () => {
	await transaction((txn) => recordMemory(memory({ revision: 3 }), txn, opts));
	resetChanges();
	const applied = await transaction((txn) =>
		recordMemory(memory({ revision: 2, status: 'active' }), txn, { ...opts, onlyIfNewer: true }),
	);
	assert.equal(applied, false);
	assert.deepEqual(rows('SummaryChange'), []);
	assert.equal(rows('SummaryMember')[0].revision, 3);
});

function resetChanges() {
	for (const row of rows('SummaryChange')) databases.memory.SummaryChange.delete(row.id);
}
