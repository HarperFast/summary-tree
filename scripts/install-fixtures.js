#!/usr/bin/env node
// Installs packed (non-symlinked) copies into each integration fixture: Harper's module loader refuses a `file:`
// symlink that resolves outside the app. memory-service gets agent-memory; summary-app gets this plugin and its own
// agent-memory copy, which reaches the running plugin through agent-memory's per-worker registry. Pass a tarball path to
// install that exact plugin package; otherwise this packs the checkout.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(repoRoot, 'integrationTests', 'fixtures');
// The agent-memory this checkout was installed with, unless a tarball is named.
const agentMemory =
	process.env.AGENT_MEMORY_TARBALL ??
	`@harperfast/agent-memory@${JSON.parse(readFileSync(join(repoRoot, 'node_modules', '@harperfast', 'agent-memory', 'package.json'), 'utf8')).version}`;

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 300_000 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status})`);
}

const packDir = process.argv[2] ? undefined : mkdtempSync(join(tmpdir(), 'summary-tree-fixture-pack-'));
try {
	let plugin;
	if (packDir) {
		run('npm', ['pack', '--pack-destination', packDir], repoRoot);
		plugin = join(packDir, readdirSync(packDir)[0]);
	} else {
		plugin = resolve(process.argv[2]);
	}
	const installs = { 'memory-service': [agentMemory], 'summary-app': [plugin, agentMemory] };
	for (const [fixture, tarballs] of Object.entries(installs)) {
		const fixturePath = join(fixturesDir, fixture);
		rmSync(join(fixturePath, 'node_modules'), { recursive: true, force: true });
		rmSync(join(fixturePath, 'package-lock.json'), { force: true });
		run('npm', ['install', '--no-save', '--ignore-scripts', '--legacy-peer-deps', ...tarballs], fixturePath);
	}
} finally {
	if (packDir) rmSync(packDir, { recursive: true, force: true });
}
