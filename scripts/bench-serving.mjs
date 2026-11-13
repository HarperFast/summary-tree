#!/usr/bin/env node
// Serving cost against deployment size: bootstrap and search latency when the store holds `--partitions` small
// label sets (3 memories each, one flat summary per set) besides a 40-memory global tree. Uses the integration
// fixtures' deterministic models, so it measures Harper and the plugin, not a model.
//
//   npm run install:fixtures
//   node scripts/bench-serving.mjs --partitions 1000 [--requests 200] [--without-plugin]
//
// --without-plugin runs agent-memory alone, for the write-path baseline (memory PUT latency).
import { cp, mkdtemp } from 'node:fs/promises';
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
		partitions: { type: 'string', default: '1000' },
		requests: { type: 'string', default: '200' },
		'without-plugin': { type: 'boolean', default: false },
	},
});
const PASSWORD = 'Bench-serving-1!';

function percentile(sorted, p) {
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
	const partitions = Number(args.partitions);
	const requests = Number(args.requests);
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'summary-tree-bench-'),
	);
	const withPlugin = !args['without-plugin'];
	for (const app of withPlugin ? ['memory-service', 'summary-app'] : ['memory-service']) {
		await cp(join(repoRoot, 'integrationTests', 'fixtures', app), join(dataRootDir, 'components', app), {
			recursive: true,
			dereference: true,
		});
	}
	const ctx = createHarperContext('summary-tree-bench');
	ctx.harper = { dataRootDir };
	await startHarper(ctx, {
		harperBinPath: join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
		config: { threads: { count: 1 }, authentication: { authorizeLocal: false } },
	});
	const basic = (user, password) => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
	const admin = basic(ctx.harper.admin.username, ctx.harper.admin.password);
	const call = async (auth, method, path, body) => {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	};
	const operation = (body) =>
		fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: admin },
			body: JSON.stringify(body),
		});
	try {
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		await operation({ operation: 'add_user', username: 'alice', password: PASSWORD, role: 'member', active: true });
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [{ id: 'role:member', read: ['global', 'team:p0'], write: [] }],
		});
		const writes = [];
		for (let i = 0; i < 40; i++) writes.push([`g${i}`, `global topic ${i % 4} item ${i}`, ['global']]);
		for (let p = 0; p < partitions; p++) {
			for (let i = 0; i < 3; i++) writes.push([`p${p}m${i}`, `team ${p} note ${i} word${p % 50}`, [`team:p${p}`]]);
		}
		let seeded = 0;
		const queue = [...writes];
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				while (queue.length) {
					const [tag, content, scopes] = queue.shift();
					const response = await call(admin, 'PUT', `Memory/${`bench-${tag}`.padEnd(16, '_')}`, {
						title: content,
						content,
						scopes,
					});
					if (response.status !== 201) throw new Error(`${tag}: ${response.status} ${JSON.stringify(response.body)}`);
					seeded++;
				}
			}),
		);
		const built = Date.now();
		for (; withPlugin;) {
			const tree = await call(admin, 'GET', 'SummaryTree/');
			if (tree.status === 200 && !tree.body.pending && tree.body.nodes.length >= partitions + 1) break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		const buildSeconds = Math.round((Date.now() - built) / 1000);
		const alice = basic('alice', PASSWORD);
		const writeTimes = [];
		for (let i = 0; i < requests; i++) {
			const content = `write latency probe ${i}`;
			const start = performance.now();
			const response = await call(admin, 'PUT', `Memory/${`bench-w${i}`.padEnd(16, '_')}`, {
				title: content,
				content,
				scopes: [`team:p${i % Math.max(1, partitions)}`],
			});
			writeTimes.push(performance.now() - start);
			if (response.status !== 201) throw new Error(`write ${i}: ${response.status}`);
		}
		writeTimes.sort((a, b) => a - b);
		const writeMs = { p50: +percentile(writeTimes, 50).toFixed(2), p95: +percentile(writeTimes, 95).toFixed(2) };
		if (!withPlugin) {
			console.log(JSON.stringify({ partitions, plugin: false, memories: seeded, writeMs }, null, 2));
			return;
		}
		const measure = async (auth, path) => {
			for (let i = 0; i < 20; i++) await call(auth, 'GET', path);
			const times = [];
			for (let i = 0; i < requests; i++) {
				const start = performance.now();
				const response = await call(auth, 'GET', path);
				times.push(performance.now() - start);
				if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
			}
			times.sort((a, b) => a - b);
			return { p50: +percentile(times, 50).toFixed(2), p95: +percentile(times, 95).toFixed(2) };
		};
		console.log(
			JSON.stringify(
				{
					partitions,
					memories: seeded,
					buildSeconds,
					writeMs,
					bootstrapMs: {
						narrowReader: await measure(alice, 'Memory/bootstrap?budget=4000'),
						superUser: await measure(admin, 'Memory/bootstrap?budget=4000'),
					},
					searchMs: { narrowReader: await measure(alice, 'Memory/?q=global%20topic') },
				},
				null,
				2,
			),
		);
	} finally {
		await teardownHarper(ctx);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
