#!/usr/bin/env node
// Topic coverage of agent-memory's session bootstrap with and without the summary-tree orientation, at a fixed
// character budget, over a seeded synthetic corpus. Starts a local Harper with agent-memory (one app) and this plugin
// (another), using the generative and embedding models named below, so the numbers reflect a real model.
//
//   npm run install:fixtures
//   node scripts/eval-orientation.mjs [--topics 30] [--budget 2000,4000,8000] [--seed 7]
//     [--embed-backend ollama --embed-model nomic-embed-text:latest]
//     [--gen-backend ollama --gen-model llama3.2:3b-ctx8k --context-tokens 8192] [--host localhost:11434]
//
// Without orientation, bootstrap's whole-memory sections fill the budget (this corpus has no pins or review flags,
// so that is the caller's `recent` memories, packed in order and skipped when one does not fit — agent-memory's
// packing). With it, the orientation section packs first and `recent` fills what is left. A topic counts as covered
// when its name appears in the packed text.
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHarperContext, startHarper, teardownHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
	options: {
		topics: { type: 'string', default: '30' },
		budget: { type: 'string', default: '2000,4000,8000' },
		seed: { type: 'string', default: '7' },
		host: { type: 'string', default: 'localhost:11434' },
		'embed-backend': { type: 'string', default: 'ollama' },
		'embed-model': { type: 'string', default: 'nomic-embed-text:latest' },
		'gen-backend': { type: 'string', default: 'ollama' },
		'gen-model': { type: 'string', default: 'llama3.2:3b-ctx8k' },
		'context-tokens': { type: 'string', default: '8192' },
		'timeout-min': { type: 'string', default: '30' },
	},
});

const TOPIC_NAMES = [
	'osprey',
	'glacier',
	'lantern',
	'quarry',
	'saffron',
	'turbine',
	'meadow',
	'harbor',
	'falcon',
	'canyon',
	'orchard',
	'beacon',
	'tundra',
	'mosaic',
	'compass',
	'citadel',
	'lagoon',
	'ember',
	'prairie',
	'summit',
	'cobalt',
	'violet',
	'marble',
	'thistle',
	'juniper',
	'raven',
	'coral',
	'basalt',
	'willow',
	'zephyr',
	'nectar',
	'pylon',
	'garnet',
	'heron',
	'vortex',
	'cedar',
	'sable',
	'quill',
	'onyx',
	'dune',
];
const DOMAINS = [
	['deploy', 'rollback', 'canary', 'pipeline', 'release', 'artifact'],
	['schema', 'migration', 'index', 'column', 'backfill', 'constraint'],
	['latency', 'timeout', 'retry', 'throughput', 'queue', 'backpressure'],
	['invoice', 'pricing', 'contract', 'renewal', 'discount', 'billing'],
	['oncall', 'incident', 'pager', 'runbook', 'escalation', 'postmortem'],
	['token', 'oauth', 'session', 'credential', 'rotation', 'permission'],
];
const VERBS = ['documented', 'changed', 'investigated', 'decided', 'reverted', 'measured', 'reviewed', 'planned'];

function rng(seed) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function corpus(topicCount, seed) {
	const rand = rng(seed);
	const pick = (list) => list[Math.floor(rand() * list.length)];
	const memories = [];
	const topics = TOPIC_NAMES.slice(0, topicCount);
	topics.forEach((name, t) => {
		const domain = DOMAINS[t % DOMAINS.length];
		// skewed sizes, like a real store: a few large topics, many small ones
		const size = 3 + Math.floor(22 * rand() ** 2);
		for (let i = 0; i < size; i++) {
			const [a, b, c] = [pick(domain), pick(domain), pick(domain)];
			const title = `${name} ${a} ${b}`;
			const content =
				`Project ${name}: the team ${pick(VERBS)} the ${a} and ${b} work after the ${c} review. ` +
				`Next step for ${name} is to ${pick(VERBS).replace(/ed$/, '')} the ${pick(domain)} ${pick(domain)} plan ` +
				`and record the outcome (item ${i + 1}).`;
			memories.push({ topic: name, title, content });
		}
	});
	// interleave topics in time so `recent` is not one topic
	for (let i = memories.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[memories[i], memories[j]] = [memories[j], memories[i]];
	}
	return { topics, memories };
}

function coverage(text, topics) {
	const lower = text.toLowerCase();
	return topics.filter((topic) => lower.includes(topic)).length;
}

function pack(entries, budget) {
	const packed = [];
	let remaining = budget;
	for (const entry of entries) {
		const size = (entry.title ?? '').length + entry.content.length;
		if (size > remaining) continue;
		packed.push(entry);
		remaining -= size;
	}
	return packed;
}

async function main() {
	const topicCount = Number(args.topics);
	const budgets = args.budget.split(',').map(Number);
	const { topics, memories } = corpus(topicCount, Number(args.seed));
	const host = args.host;

	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'summary-tree-eval-'),
	);
	for (const app of ['memory-service', 'summary-app']) {
		await cp(join(repoRoot, 'integrationTests', 'fixtures', app), join(dataRootDir, 'components', app), {
			recursive: true,
			dereference: true,
		});
	}
	// real models come from harper config, not the fixture's deterministic stand-ins
	await writeFile(join(dataRootDir, 'components', 'memory-service', 'resources.js'), '');
	await writeFile(
		join(dataRootDir, 'components', 'summary-app', 'config.yaml'),
		[
			'rest: true',
			"'@harperfast/summary-tree':",
			"  package: '@harperfast/summary-tree'",
			`  contextTokens: ${Number(args['context-tokens'])}`,
			'  debounceMs: 2000',
			'',
		].join('\n'),
	);
	const ctx = createHarperContext('summary-tree-eval');
	ctx.harper = { dataRootDir };
	await startHarper(ctx, {
		harperBinPath: join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
		config: {
			threads: { count: 1 },
			authentication: { authorizeLocal: false },
			models: {
				embedding: {
					default: { backend: args['embed-backend'], host, model: args['embed-model'], requestTimeoutMs: 120000 },
				},
				generative: {
					default: { backend: args['gen-backend'], host, model: args['gen-model'], requestTimeoutMs: 300000 },
				},
			},
		},
	});
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const call = async (method, path, body) => {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	};
	try {
		const started = Date.now();
		for (const [index, memory] of memories.entries()) {
			const id = `eval-${String(index).padStart(6, '0')}`.padEnd(16, '_');
			const response = await call('PUT', `Memory/${id}`, {
				title: memory.title,
				content: memory.content,
				scopes: ['global'],
			});
			if (response.status !== 201) throw new Error(`seed ${id}: ${response.status} ${JSON.stringify(response.body)}`);
		}
		console.error(`seeded ${memories.length} memories over ${topics.length} topics in ${Date.now() - started} ms`);

		const deadline = Date.now() + Number(args['timeout-min']) * 60_000;
		let built;
		for (;;) {
			const tree = await call('GET', 'SummaryTree/');
			if (tree.status === 200 && !tree.body.pending && tree.body.nodes.length > 0) {
				built = tree.body.nodes;
				break;
			}
			if (Date.now() > deadline) throw new Error('timed out waiting for the summary tree');
			await new Promise((r) => setTimeout(r, 3000));
		}
		const buildMs = Date.now() - started;
		const shape = await treeShape(built, call);

		const full = await call('GET', `Memory/bootstrap?budget=100000`);
		const recent = full.body.memories.filter((entry) => entry.section === 'recent');
		const join2 = (entries) => entries.map((entry) => `${entry.title ?? ''} ${entry.content}`).join('\n');
		const byBudget = [];
		for (const budget of budgets) {
			const withOrientation = (await call('GET', `Memory/bootstrap?budget=${budget}`)).body.memories;
			const baseline = pack(recent, budget);
			const orientationEntries = withOrientation.filter((entry) => entry.section === 'orientation');
			byBudget.push({
				budgetChars: budget,
				withoutOrientation: { entries: baseline.length, topicsCovered: coverage(join2(baseline), topics) },
				withOrientation: {
					entries: withOrientation.length,
					orientationEntries: orientationEntries.length,
					topicsCovered: coverage(join2(withOrientation), topics),
					topicsCoveredByOrientationAlone: coverage(join2(orientationEntries), topics),
				},
			});
		}
		const result = {
			model: {
				generative: `${args['gen-backend']}:${args['gen-model']}`,
				embedding: `${args['embed-backend']}:${args['embed-model']}`,
			},
			corpus: { memories: memories.length, topics: topics.length, seed: Number(args.seed) },
			byBudget,
			tree: {
				topNodes: built.length,
				nodes: shape.nodes,
				levels: shape.levels,
				buildSeconds: Math.round(buildMs / 1000),
			},
		};
		console.log(JSON.stringify(result, null, 2));
	} finally {
		await teardownHarper(ctx);
	}
}

async function treeShape(tops, call) {
	const levels = {};
	let nodes = 0;
	const queue = tops.map((node) => node.id);
	while (queue.length) {
		const id = queue.shift();
		const opened = (await call('GET', `SummaryTree/${id}`)).body;
		nodes++;
		levels[opened.node.level] = (levels[opened.node.level] ?? 0) + 1;
		for (const child of opened.children ?? []) queue.push(child.id);
	}
	return { nodes, levels };
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
