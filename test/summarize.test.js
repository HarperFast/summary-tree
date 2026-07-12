import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseResponse } from '../lib/summarize.js';

test('buildPrompt: level 1 vs higher use different instructions and the right member label', () => {
	const l1 = buildPrompt(['chunk a', 'chunk b'], 1);
	assert.match(l1, /document chunks/i);
	assert.match(l1, /chunk 1/);
	assert.match(l1, /TITLE:/);
	assert.ok(l1.trimEnd().endsWith('TITLE:'), 'prompt ends with TITLE: so the completion starts with the title');

	const l2 = buildPrompt(['summary a', 'summary b'], 2);
	assert.match(l2, /HIGHER-LEVEL summary/i);
	assert.match(l2, /summary 1/);
});

test('buildPrompt: caps input size but always keeps at least one member', () => {
	const huge = 'x'.repeat(40_000);
	const p = buildPrompt([huge, huge, huge], 1);
	// exactly one member fits under the cap
	assert.equal(p.match(/--- chunk \d+ ---/g).length, 1);
});

test('parseResponse: title on first line (prompt-primed form)', () => {
	const { title, summary } = parseResponse('Distributed Replication\n\nHarper replicates data across nodes.');
	assert.equal(title, 'Distributed Replication');
	assert.equal(summary, 'Harper replicates data across nodes.');
});

test('parseResponse: strips a repeated TITLE: label and markdown', () => {
	const { title, summary } = parseResponse('TITLE: **Vector Search**\n\nHNSW indexes power similarity search.');
	assert.equal(title, 'Vector Search');
	assert.equal(summary, 'HNSW indexes power similarity search.');
});

test('parseResponse: falls back to leading words when the model skips the title line', () => {
	const prose = 'Harper provides a full operations API for cluster management and more details follow here.';
	const { title, summary } = parseResponse(prose);
	assert.equal(summary, prose);
	assert.equal(title, 'Harper provides a full operations API');
});
