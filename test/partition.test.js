import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEligible, memberText, partitionId, partitionLabels, revokesFrom } from '../dist/partition.js';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const active = { status: 'active', scopes: ['global'] };

test('partitionLabels: any set containing global is the global partition', () => {
	assert.deepEqual(partitionLabels(['customer:acme', 'global']), ['global']);
	assert.deepEqual(partitionLabels(['global', 'team:x', 'global']), ['global']);
	assert.equal(partitionId(partitionLabels(['global', 'team:x'])), partitionId(['global']));
});

test('partitionLabels: sorted, deduplicated exact label sets; order and repeats do not matter', () => {
	assert.deepEqual(partitionLabels(['team:b', 'customer:acme', 'team:b']), ['customer:acme', 'team:b']);
	assert.equal(
		partitionId(partitionLabels(['team:b', 'customer:acme'])),
		partitionId(partitionLabels(['customer:acme', 'team:b'])),
	);
	assert.notEqual(partitionId(['customer:acme']), partitionId(['customer:acme', 'team:b']));
	assert.notEqual(partitionId(['customer:acme']), partitionId(['customer:beta']));
	assert.deepEqual(partitionLabels(['customer:acme', 7, null]), ['customer:acme']);
	assert.deepEqual(partitionLabels(undefined), []);
});

test('isEligible: excludes withdrawn, superseded, expired, needsReview and content-flagged memories', () => {
	assert.equal(isEligible(active, NOW), true);
	assert.equal(isEligible({ ...active, status: 'withdrawn' }, NOW), false);
	assert.equal(isEligible({ ...active, status: 'superseded' }, NOW), false);
	assert.equal(isEligible({ ...active, validUntil: '2026-11-11T00:00:00Z' }, NOW), false);
	assert.equal(isEligible({ ...active, validUntil: '2026-11-13T00:00:00Z' }, NOW), true);
	assert.equal(isEligible({ ...active, needsReview: { cause: 'withdrawn' } }, NOW), false);
	assert.equal(isEligible({ ...active, contentFlag: { kind: 'possible-customer-detail' } }, NOW), false);
});

test('isEligible: a memory is included again once its flag or review is cleared', () => {
	assert.equal(isEligible({ ...active, needsReview: null, contentFlag: null, confirmed: { by: 'x' } }, NOW), true);
});

test('revokesFrom: withdrawal, a new flag or a move revokes, whatever the stored eligibility', () => {
	const stored = { partition: 'p', status: 'active', flagged: false };
	assert.equal(revokesFrom(stored, { status: 'withdrawn' }, 'p'), true);
	assert.equal(revokesFrom(stored, { status: 'active', contentFlag: { kind: 'x' } }, 'p'), true);
	assert.equal(revokesFrom(stored, { status: 'active' }, 'q'), true);
	assert.equal(revokesFrom(stored, { status: 'superseded' }, 'p'), false);
	assert.equal(revokesFrom(stored, { status: 'active', needsReview: { cause: 'x' } }, 'p'), false);
	// already ineligible for review, but its text may still be in a summary
	assert.equal(
		revokesFrom({ partition: 'p', status: 'active', flagged: false }, { status: 'withdrawn', needsReview: {} }, 'p'),
		true,
	);
	assert.equal(revokesFrom({ partition: 'p', status: 'withdrawn' }, { status: 'withdrawn' }, 'p'), false);
});

test('memberText: title and content, cut at a code point boundary', () => {
	assert.equal(memberText({ title: 'T', content: 'body' }, 100), 'T: body');
	assert.equal(memberText({ content: 'body' }, 100), 'body');
	const cut = memberText({ content: `ab${'😀'}` }, 3);
	assert.equal(cut, 'ab');
});
