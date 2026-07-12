'use strict';
/**
 * Load the Thread B docs corpus into the running summary-tree app through the
 * normal REST write path (so @embed runs server-side, end-to-end).
 *
 * Usage: node scripts/load-corpus.js [corpusJsonl] [baseUrl] [limit]
 */

const fs = require('node:fs');

const CORPUS = process.argv[2] || '/home/kzyp/dev/tmp/raptor-thread-b/corpus.jsonl';
const BASE = process.argv[3] || 'http://localhost:9926';
const LIMIT = parseInt(process.argv[4]) || Infinity;
const CONCURRENCY = 4;

async function main() {
	const chunks = fs
		.readFileSync(CORPUS, 'utf8')
		.trim()
		.split('\n')
		.map(JSON.parse)
		.slice(0, LIMIT);
	console.log(`loading ${chunks.length} chunks -> ${BASE}/Chunk/`);
	let done = 0;
	let failed = 0;
	const queue = [...chunks];
	const t0 = Date.now();
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (queue.length) {
				const c = queue.shift();
				const res = await fetch(`${BASE}/Chunk/${c.id}`, {
					method: 'PUT',
					headers: {
						'content-type': 'application/json',
						authorization: 'Basic ' + Buffer.from(process.env.HDB_AUTH || 'admin:password').toString('base64'),
					},
					body: JSON.stringify({ text: c.text, source: c.file, title: `${c.title} — ${c.heading}` }),
				});
				if (!res.ok) {
					failed++;
					if (failed < 5) console.error(`\n${c.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
				}
				if (++done % 25 === 0) process.stdout.write(`\r${done}/${chunks.length}`);
			}
		})
	);
	console.log(`\ndone: ${done - failed} ok, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
