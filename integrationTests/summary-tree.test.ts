// Needs `npm run install:fixtures` first (`npm run test:integration` runs it): agent-memory runs as its own app
// (memory-service) and the summary-tree plugin runs in summary-app with its own copy of agent-memory.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { killHarper, startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const PASSWORD = 'Summary-test-1!';

const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

// Three global topics (a tree of 4 leaves under 2 interior nodes with this fixture's sizes), and one flat node each
// for two customers. Each customer's words never appear elsewhere, so a summary that leaks one is detectable.
const GLOBAL_TOPICS: Record<string, string[]> = {
	replication: [
		'replication lag between nodes',
		'replication conflict resolution',
		'replication catch up after restart',
		'replication topology changes',
		'replication backpressure tuning',
	],
	indexing: [
		'indexing vector hnsw graph',
		'indexing fulltext analyzer',
		'indexing secondary attributes',
		'indexing rebuild after schema change',
		'indexing memory budget',
	],
	billing: [
		'billing invoice generation',
		'billing usage metering',
		'billing plan upgrades',
		'billing refunds process',
		'billing tax calculation',
	],
};
const ACME = [
	'acme walrus migration plan',
	'acme walrus outage report',
	'acme walrus contract renewal',
	'acme walrus support escalation',
];
const BETA = [
	'beta pelican onboarding notes',
	'beta pelican latency complaint',
	'beta pelican data export',
	'beta pelican sso setup',
];

suite('summary-tree over agent-memory running as a separate app', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: basic(ctx.harper.admin.username, ctx.harper.admin.password),
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${text}`);
		return JSON.parse(text);
	}

	async function call(user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization:
					user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, body: parsed };
	}

	async function mcp(user: string, method: string, params: object, sessionId?: string) {
		const response = await fetch(`${ctx.harper.httpURL}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: basic(user, PASSWORD),
				...(sessionId ? { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		return { sessionId: response.headers.get('mcp-session-id') ?? sessionId, body: JSON.parse(await response.text()) };
	}

	async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await probe();
			if (value !== undefined) return value;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const orientation = async (user: string) => {
		const response = await call(user, 'GET', 'Memory/bootstrap?budget=20000');
		strictEqual(response.status, 200, JSON.stringify(response.body));
		return (response.body.memories as any[]).filter((entry) => entry.section === 'orientation');
	};
	const text = (entries: any[]) => entries.map((entry) => `${entry.title} ${entry.content}`).join('\n');
	const nodeIdOf = (entry: any) => /summary node (\S+)\)/.exec(entry.content)![1];

	const ids: Record<string, string> = {};

	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-'),
		);
		for (const app of ['memory-service', 'summary-app']) {
			await cp(join(import.meta.dirname, 'fixtures', app), join(dataRootDir, 'components', app), {
				recursive: true,
				dereference: true,
			});
		}
		(ctx as any).harper = { dataRootDir };
		await startHarper(ctx, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: {
				threads: { count: 1 },
				logging: { stdStreams: true },
				// Harper otherwise treats a credential-less loopback request as super_user.
				authentication: { authorizeLocal: false },
				mcp: { application: { mountPath: '/mcp' } },
			},
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['alice', 'bob', 'carol']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				{ id: 'role:member', read: ['global'], write: ['global'] },
				{ id: 'user:bob', read: ['customer:acme'], write: [] },
				{ id: 'user:carol', read: ['customer:beta'], write: [] },
			],
		});
		const writes: [string, string, string[]][] = [];
		for (const [topic, contents] of Object.entries(GLOBAL_TOPICS)) {
			contents.forEach((content, index) => writes.push([`${topic}${index}`, content, ['global']]));
		}
		ACME.forEach((content, index) => writes.push([`acme${index}`, content, ['customer:acme']]));
		BETA.forEach((content, index) => writes.push([`beta${index}`, content, ['customer:beta']]));
		for (const [tag, content, scopes] of writes) {
			ids[tag] = memId(tag);
			const response = await call('admin', 'PUT', `Memory/${ids[tag]}`, { title: content, content, scopes });
			strictEqual(response.status, 201, JSON.stringify(response.body));
		}
		await until('every partition to have a summary', async () => {
			const response = await call('admin', 'GET', 'SummaryTree/');
			const all = text((response.body?.nodes ?? []).map((node: any) => ({ title: node.title, content: node.summary })));
			return response.status === 200 && /walrus/.test(all) && /pelican/.test(all) && /billing/.test(all)
				? true
				: undefined;
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('bootstrap orientation shows each principal only the partitions it can read', async () => {
		const alice = text(await orientation('alice'));
		ok(/replication|indexing|billing/.test(alice), alice);
		ok(!/walrus|pelican/.test(alice), alice);

		const bob = text(await orientation('bob'));
		ok(/walrus/.test(bob), bob);
		ok(!/pelican/.test(bob), bob);

		const carol = text(await orientation('carol'));
		ok(/pelican/.test(carol), carol);
		ok(!/walrus/.test(carol), carol);
	});

	test('orientation lists top nodes largest first, then their subtopics', async () => {
		const entries = await orientation('bob');
		const tops = (await call('bob', 'GET', 'SummaryTree/')).body.nodes;
		const topIds = tops.map((node: any) => node.id);
		deepStrictEqual(entries.slice(0, tops.length).map(nodeIdOf), topIds);
		const counts = tops.map((node: any) => node.memberCount);
		deepStrictEqual(
			counts,
			[...counts].sort((a: number, b: number) => b - a),
		);
		ok(entries.length > tops.length, 'subtopics fill the rest of the budget');
	});

	// agent-memory answers 503 while a new table's vector and full-text indexes build
	const search = (user: string, q: string) =>
		until(`search for ${q}`, async () => {
			const response = await call(user, 'GET', `Memory/?q=${encodeURIComponent(q)}`);
			return response.status === 503 ? undefined : response;
		});

	test('search hits carry the readable summary they belong to', async () => {
		const acmeSearch = await search('bob', 'walrus outage');
		strictEqual(acmeSearch.status, 200, JSON.stringify(acmeSearch.body));
		const hit = acmeSearch.body.memories.find((result: any) => result.id === ids.acme1);
		ok(hit?.summaryTree, JSON.stringify(acmeSearch.body));
		ok(/walrus/.test(hit.summaryTree.summary));
		strictEqual(hit.summaryTree.memberCount, 4);

		const globalSearch = await search('alice', 'billing refunds');
		const globalHit = globalSearch.body.memories.find((result: any) => result.id === ids.billing3);
		ok(globalHit?.summaryTree?.id, JSON.stringify(globalSearch.body));
		ok(!/walrus|pelican/.test(JSON.stringify(globalSearch.body)));
	});

	test('expanding a node the caller cannot read is a 404, over REST and MCP', async () => {
		const [acmeEntry] = (await orientation('bob')).filter((entry) => /walrus/.test(entry.content));
		const acmeNode = nodeIdOf(acmeEntry);

		const forBob = await call('bob', 'GET', `SummaryTree/${acmeNode}`);
		strictEqual(forBob.status, 200, JSON.stringify(forBob.body));
		deepStrictEqual(
			forBob.body.members.map((member: any) => member.id).sort(),
			ACME.map((_, i) => ids[`acme${i}`]).sort(),
		);

		const forAlice = await call('alice', 'GET', `SummaryTree/${acmeNode}`);
		strictEqual(forAlice.status, 404);
		const missing = await call('alice', 'GET', 'SummaryTree/no-such-node');
		deepStrictEqual(forAlice.body, missing.body);

		let session = (
			await mcp('alice', 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'summary-tree-test', version: '1' },
			})
		).sessionId;
		const tools = await mcp('alice', 'tools/list', {}, session);
		ok(
			tools.body.result.tools.some((tool: any) => tool.name === 'expand_summary'),
			JSON.stringify(tools.body),
		);
		const denied = await mcp('alice', 'tools/call', { name: 'expand_summary', arguments: { id: acmeNode } }, session);
		ok(denied.body.error || denied.body.result?.isError, JSON.stringify(denied.body));
		ok(!/walrus/.test(JSON.stringify(denied.body)), JSON.stringify(denied.body));

		session = (
			await mcp('bob', 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'summary-tree-test', version: '1' },
			})
		).sessionId;
		const allowed = await mcp('bob', 'tools/call', { name: 'expand_summary', arguments: { id: acmeNode } }, session);
		ok(/walrus/.test(JSON.stringify(allowed.body)), JSON.stringify(allowed.body));
	});

	test('interior nodes list readable children', async () => {
		const tops = await call('alice', 'GET', 'SummaryTree/');
		const interior = tops.body.nodes.find((node: any) => node.level > 1);
		ok(interior, JSON.stringify(tops.body));
		const opened = await call('alice', 'GET', `SummaryTree/${interior.id}`);
		strictEqual(opened.status, 200);
		ok(opened.body.children.length >= 1);
		for (const child of opened.body.children) strictEqual(child.parentId, interior.id);
	});

	test('a withdrawn member hides its partition at once, and the rebuilt summary no longer carries it', async () => {
		const unique = 'zeppelin';
		const tag = 'acme-extra';
		ids[tag] = memId(tag);
		strictEqual(
			(
				await call('admin', 'PUT', `Memory/${ids[tag]}`, {
					title: `acme walrus ${unique}`,
					content: `acme walrus ${unique} rollout`,
					scopes: ['customer:acme'],
				})
			).status,
			201,
		);
		await until('the acme summary to include the new memory', async () =>
			/zeppelin/.test(text(await orientation('bob'))) ? true : undefined,
		);

		const withdrawn = await call('admin', 'DELETE', `Memory/${ids[tag]}?reason=test`, undefined, { 'If-Match': '*' });
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		const immediately = text(await orientation('bob'));
		ok(!/walrus/.test(immediately), immediately);

		await until('the acme summary to come back without the withdrawn memory', async () => {
			const now = text(await orientation('bob'));
			return /walrus/.test(now) && !/zeppelin/.test(now) ? true : undefined;
		});
	});

	test('a rescoped member leaves the old partition and joins the new one', async () => {
		const moved = ids.beta3;
		const current = await call('admin', 'GET', `Memory/${moved}`);
		const revised = await call(
			'admin',
			'PUT',
			`Memory/${moved}`,
			{ title: current.body.memory.title, content: current.body.memory.content, scopes: ['customer:acme'] },
			{ 'If-Match': `"${current.body.memory.revision}"` },
		);
		strictEqual(revised.status, 200, JSON.stringify(revised.body));
		ok(!/pelican/.test(text(await orientation('carol'))), 'beta partition hidden until rebuilt');
		await until('beta to be rebuilt without the moved memory', async () => {
			const carol = text(await orientation('carol'));
			return /pelican/.test(carol) && !/sso/.test(carol) ? true : undefined;
		});
		await until('acme to be rebuilt with the moved memory', async () =>
			/sso/.test(text(await orientation('bob'))) ? true : undefined,
		);
	});
});

suite('summary-tree installed after memories already exist', (ctx: ContextWithHarper) => {
	const harperOptions = () => ({
		harperBinPath:
			process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
			join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
		config: { threads: { count: 1 }, logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
	});
	const admin = () =>
		'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: admin(), ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	};

	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-'),
		);
		await cp(
			join(import.meta.dirname, 'fixtures', 'memory-service'),
			join(dataRootDir, 'components', 'memory-service'),
			{
				recursive: true,
				dereference: true,
			},
		);
		(ctx as any).harper = { dataRootDir };
		await startHarper(ctx, harperOptions());
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the startup walk summarizes existing memories and leaves out ones withdrawn before it ran', async () => {
		for (let i = 0; i < 5; i++) {
			const response = await call('PUT', `Memory/${memId(`walk${i}`)}`, {
				title: `heron note ${i}`,
				content: i === 4 ? 'heron marsh flamingo secret' : `heron marsh survey ${i}`,
				scopes: ['global'],
			});
			strictEqual(response.status, 201, JSON.stringify(response.body));
		}
		const withdrawn = await call('DELETE', `Memory/${memId('walk4')}?reason=test`, undefined, { 'If-Match': '*' });
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));

		await killHarper(ctx);
		await cp(
			join(import.meta.dirname, 'fixtures', 'summary-app'),
			join(ctx.harper.dataRootDir, 'components', 'summary-app'),
			{
				recursive: true,
				dereference: true,
			},
		);
		await startHarper(ctx, harperOptions());

		const deadline = Date.now() + 60_000;
		let nodes: any[] = [];
		while (Date.now() < deadline) {
			const response = await call('GET', 'SummaryTree/');
			if (response.status === 200 && !response.body.pending && response.body.nodes.length) {
				nodes = response.body.nodes;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		strictEqual(nodes.length, 1, 'one flat summary for the four live memories');
		strictEqual(nodes[0].memberCount, 4);
		ok(/heron/.test(nodes[0].summary), nodes[0].summary);
		ok(!/flamingo/.test(nodes[0].summary), nodes[0].summary);
	});
});
