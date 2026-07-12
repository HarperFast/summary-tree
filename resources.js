/**
 * Summary-tree reference component (harper#1244 Thread B).
 *
 * RAPTOR-style hierarchical retrieval as a pure Harper application:
 *  - Chunk rows are written by the app; `@embed` embeds + HNSW-indexes them.
 *  - A maintenance loop clusters chunk embeddings (spherical k-means), LLM-
 *    summarizes each cluster via `models.generate`, and inserts Summary rows
 *    (auto-embedded by `@embed`), recursing to higher levels.
 *  - The tree is LIVE, not batch: a table subscription assigns new/updated
 *    chunks to the nearest cluster centroid and dirty-marks the cluster; the
 *    periodic pass re-summarizes only dirty clusters (dirtiness propagates to
 *    parents). A full re-cluster happens only after ~2x corpus growth.
 *  - RagSearch merges Chunk + Summary vector searches by exact cosine distance
 *    (the pre-gate showed this two-table merge matches a single shared table
 *    metric-for-metric).
 */

import { kmeans, normalize, nearestCentroid, dot } from './lib/kmeans.js';
import { summarizeCluster } from './lib/summarize.js';

const EMBED_MODEL = 'embedder'; // logical model names from harperdb-config.yaml `models:` block
const GEN_MODEL = 'summarizer';

const TARGET_CLUSTER_SIZE = 15; // aim for ~15 chunks per level-1 cluster
const HIGHER_FANOUT = 10; // ~10 summaries per higher-level cluster
const TOP_FLOOR = 6; // stop recursing when a level has <= this many summaries
const MIN_CHUNKS_FOR_TREE = 40; // below this, flat retrieval is fine — no tree
const DIRTY_MIN = 2; // re-summarize after >= max(DIRTY_MIN, fraction*members) changes
const DIRTY_FRACTION = 0.15;
const REBUILD_GROWTH = 2; // full re-cluster after corpus doubles
const MAINTENANCE_INTERVAL_MS = 30_000;
const LEASE_MS = 90_000; // maintenance-leader lease (no scheduler primitive yet)
const STATE_ID = 'tree';

const workerId = `w${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function cosineDist(a, b) {
	let dp = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dp += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return 1 - dp / (Math.sqrt(na * nb) || 1);
}

// ---------------------------------------------------------------------------
// Retrieval: GET /RagSearch?q=...&limit=10&mode=mixed|chunks|summaries
// ---------------------------------------------------------------------------
export class RagSearch extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const q = target.get('q');
		if (!q) throw new Error('RagSearch requires ?q=<query text>');
		const limit = Math.min(50, parseInt(target.get('limit') ?? '10'));
		const mode = target.get('mode') ?? 'mixed';

		// friction (see README): there is no query-time embedding in the search
		// path yet — the app embeds the query text itself.
		const [qvec] = await models.embed(q, { model: EMBED_MODEL, inputType: 'query' });
		const targetVec = Array.from(qvec);

		const pools = [];
		if (mode !== 'summaries') pools.push({ table: tables.Chunk, type: 'chunk' });
		if (mode !== 'chunks') pools.push({ table: tables.Summary, type: 'summary' });

		const merged = [];
		for (const { table, type } of pools) {
			const results = await table.search({
				sort: { attribute: 'embedding', target: targetVec },
				limit,
			});
			for await (const record of results) {
				if (!record.embedding) continue;
				merged.push({
					type,
					id: record.id,
					title: record.title,
					level: record.level, // undefined for chunks
					source: record.source, // undefined for summaries
					text: record.text,
					distance: cosineDist(targetVec, record.embedding),
				});
			}
		}
		merged.sort((a, b) => a.distance - b.distance);
		return { query: q, results: merged.slice(0, limit) };
	}
}

// ---------------------------------------------------------------------------
// Tree status: GET /TreeStatus
// ---------------------------------------------------------------------------
export class TreeStatus extends Resource {
	static loadAsInstance = false;

	async get() {
		const state = await tables.TreeState.get(STATE_ID);
		const levels = {};
		let dirty = 0;
		for await (const s of tables.Summary.search({ select: ['id', 'level', 'dirtyCount', 'memberCount'] })) {
			levels[s.level] = (levels[s.level] || 0) + 1;
			if (isDirty(s)) dirty++;
		}
		let chunks = 0;
		let unassigned = 0;
		for await (const c of tables.Chunk.search({ select: ['id', 'summaryId'] })) {
			chunks++;
			if (!c.summaryId) unassigned++;
		}
		return {
			chunks,
			unassignedChunks: unassigned,
			summariesByLevel: levels,
			dirtySummaries: dirty,
			builtChunkCount: state?.builtChunkCount ?? 0,
			builtAt: state?.builtAt ?? null,
			leaseHolder: state?.leaseHolder ?? null,
			maintenanceWorker: workerId,
		};
	}
}

function isDirty(s) {
	const threshold = s.level > 1 ? 1 : Math.max(DIRTY_MIN, Math.ceil((s.memberCount || 0) * DIRTY_FRACTION));
	return (s.dirtyCount || 0) >= threshold;
}

// ---------------------------------------------------------------------------
// Build loop
// ---------------------------------------------------------------------------

/** Load id + normalized embedding for every chunk (records-iterate path; the
 * bulk vector-scan friction in the README — fine to low hundreds of thousands). */
async function loadChunkVectors() {
	const items = [];
	for await (const c of tables.Chunk.search({ select: ['id', 'embedding'] })) {
		if (c.embedding) items.push({ id: c.id, vec: normalize(c.embedding) });
	}
	return items;
}

async function summarizeMembers(memberRows, level) {
	// most-central-first so prompt truncation drops the least representative
	const texts = memberRows.map((m) => m.text);
	return summarizeCluster(models, texts, level, { model: GEN_MODEL });
}

async function fullBuild() {
	const items = await loadChunkVectors();
	if (items.length < MIN_CHUNKS_FOR_TREE) return false;
	logger.info(`summary-tree: full build over ${items.length} chunks`);

	// clear any previous tree
	for await (const s of tables.Summary.search({ select: ['id'] })) await tables.Summary.delete(s.id);

	// ---- level 1: cluster chunks ------------------------------------------------
	const k = Math.max(2, Math.round(items.length / TARGET_CLUSTER_SIZE));
	const vecs = items.map((i) => i.vec);
	const { assignments, centroids } = kmeans(vecs, k);
	let levelRows = []; // rows of the level being built, for the next level up
	for (let c = 0; c < centroids.length; c++) {
		const memberIdx = [];
		for (let i = 0; i < items.length; i++) if (assignments[i] === c) memberIdx.push(i);
		memberIdx.sort((a, b) => dot(vecs[b], centroids[c]) - dot(vecs[a], centroids[c]));
		const members = [];
		for (const i of memberIdx) members.push(await tables.Chunk.get(items[i].id));
		const { title, summary } = await summarizeMembers(members, 1);
		const id = `s1-${c}`;
		await tables.Summary.put({
			id,
			title,
			text: `${title}\n\n${summary}`,
			level: 1,
			centroid: Array.from(centroids[c]),
			memberCount: memberIdx.length,
			dirtyCount: 0,
			summarizedAt: new Date(),
		});
		for (const i of memberIdx) await tables.Chunk.patch(items[i].id, { summaryId: id });
		levelRows.push({ id, centroid: centroids[c] });
		logger.info(`summary-tree: level 1 ${id} "${title}" (${memberIdx.length} members)`);
	}

	// ---- higher levels: cluster the previous level's summary embeddings ---------
	let level = 2;
	while (levelRows.length > TOP_FLOOR) {
		const rows = [];
		for (const r of levelRows) rows.push(await tables.Summary.get(r.id)); // re-read: @embed has run
		const lvVecs = rows.map((r) => normalize(r.embedding));
		const kUp = Math.max(2, Math.round(rows.length / HIGHER_FANOUT));
		const up = kmeans(lvVecs, kUp, { minClusterSize: 2 });
		const nextRows = [];
		for (let c = 0; c < up.centroids.length; c++) {
			const memberIdx = [];
			for (let i = 0; i < rows.length; i++) if (up.assignments[i] === c) memberIdx.push(i);
			memberIdx.sort((a, b) => dot(lvVecs[b], up.centroids[c]) - dot(lvVecs[a], up.centroids[c]));
			const members = memberIdx.map((i) => rows[i]);
			const { title, summary } = await summarizeMembers(members, level);
			const id = `s${level}-${c}`;
			await tables.Summary.put({
				id,
				title,
				text: `${title}\n\n${summary}`,
				level,
				centroid: Array.from(up.centroids[c]),
				memberCount: memberIdx.length,
				dirtyCount: 0,
				summarizedAt: new Date(),
			});
			for (const i of memberIdx) await tables.Summary.patch(rows[i].id, { parentId: id });
			nextRows.push({ id, centroid: up.centroids[c] });
			logger.info(`summary-tree: level ${level} ${id} "${title}" (${memberIdx.length} members)`);
		}
		levelRows = nextRows;
		level++;
	}

	// clear any dirtiness accumulated while the build itself was writing
	for await (const s of tables.Summary.search({ select: ['id', 'dirtyCount'] }))
		if (s.dirtyCount) await tables.Summary.patch(s.id, { dirtyCount: 0 });

	await tables.TreeState.put({
		id: STATE_ID,
		builtChunkCount: items.length,
		builtAt: new Date(),
		leaseHolder: workerId,
		leaseUntil: Date.now() + LEASE_MS,
	});
	invalidateCentroidCache();
	logger.info(`summary-tree: full build complete`);
	return true;
}

// ---- incremental assignment ---------------------------------------------------

let centroidCache = null; // { rows: [{id}], vecs: [Float32Array] }
function invalidateCentroidCache() {
	centroidCache = null;
}
async function levelOneCentroids() {
	if (centroidCache) return centroidCache;
	const rows = [];
	const vecs = [];
	for await (const s of tables.Summary.search({
		conditions: [{ attribute: 'level', value: 1 }],
		select: ['id', 'centroid'],
	})) {
		if (!s.centroid) continue;
		rows.push({ id: s.id });
		vecs.push(normalize(s.centroid));
	}
	centroidCache = { rows, vecs };
	return centroidCache;
}

/** Assign one chunk to its nearest cluster; dirty-mark on membership change. */
async function assignChunk(chunk) {
	if (!chunk?.embedding) return;
	const { rows, vecs } = await levelOneCentroids();
	if (!rows.length) return; // no tree yet — the periodic pass will build one
	const { index } = nearestCentroid(normalize(chunk.embedding), vecs);
	const targetId = rows[index].id;
	if (chunk.summaryId === targetId) return; // idempotent (also breaks self-trigger)
	const prevId = chunk.summaryId;
	await tables.Chunk.patch(chunk.id, { summaryId: targetId });
	await bumpDirty(targetId, +1, +1);
	if (prevId) await bumpDirty(prevId, +1, -1);
}

async function bumpDirty(summaryId, dirtyDelta, memberDelta = 0) {
	const s = await tables.Summary.get(summaryId);
	if (!s) return;
	await tables.Summary.patch(summaryId, {
		dirtyCount: (s.dirtyCount || 0) + dirtyDelta,
		memberCount: (s.memberCount || 0) + memberDelta,
	});
}

/** Catch chunks that predate the tree, arrived while unwatched, or whose
 * events were missed — the sweep makes assignment self-healing. */
async function sweepUnassigned() {
	let n = 0;
	for await (const c of tables.Chunk.search({ conditions: [{ attribute: 'summaryId', value: null }] })) {
		await assignChunk(c);
		if (++n >= 500) break; // bounded per tick
	}
	return n;
}

// ---- dirty re-summarization -----------------------------------------------------

async function resummarize(s) {
	const memberTable = s.level > 1 ? tables.Summary : tables.Chunk;
	const linkAttr = s.level > 1 ? 'parentId' : 'summaryId';
	const members = [];
	for await (const m of memberTable.search({ conditions: [{ attribute: linkAttr, value: s.id }] })) members.push(m);
	if (!members.length) {
		logger.info(`summary-tree: ${s.id} emptied — deleting`);
		await tables.Summary.delete(s.id);
		if (s.parentId) await bumpDirty(s.parentId, +1, -1);
		invalidateCentroidCache();
		return;
	}
	// recompute centroid from live membership
	const vecs = members.map((m) => normalize(m.embedding)).filter(Boolean);
	const dims = vecs[0].length;
	const mean = new Float64Array(dims);
	for (const v of vecs) for (let d = 0; d < dims; d++) mean[d] += v[d];
	const centroid = normalize(Array.from(mean, (x) => x / vecs.length));
	members.sort((a, b) => dot(normalize(b.embedding), centroid) - dot(normalize(a.embedding), centroid));

	const { title, summary } = await summarizeMembers(members, s.level);
	await tables.Summary.patch(s.id, {
		title,
		text: `${title}\n\n${summary}`, // @embed re-embeds since `text` is in the payload
		centroid: Array.from(centroid),
		memberCount: members.length,
		dirtyCount: 0,
		summarizedAt: new Date(),
	});
	if (s.parentId) await bumpDirty(s.parentId, +1);
	invalidateCentroidCache();
	logger.info(`summary-tree: re-summarized ${s.id} "${title}" (${members.length} members)`);
}

// ---- maintenance loop -----------------------------------------------------------

/** Cheap leader lease over the TreeState row (no scheduler primitive yet). */
async function acquireLease() {
	const state = (await tables.TreeState.get(STATE_ID)) ?? { id: STATE_ID };
	if (state.leaseHolder && state.leaseHolder !== workerId && (state.leaseUntil || 0) > Date.now()) return false;
	await tables.TreeState.put({ ...state, id: STATE_ID, leaseHolder: workerId, leaseUntil: Date.now() + LEASE_MS });
	return true;
}

let maintaining = false;
async function maintenanceTick() {
	if (maintaining) return;
	maintaining = true;
	try {
		if (!(await acquireLease())) return;

		const state = await tables.TreeState.get(STATE_ID);
		let chunkCount = 0;
		for await (const _ of tables.Chunk.search({ select: ['id'] })) chunkCount++;

		// (re)build when: no COMPLETED build exists (builtAt is stamped only at the end,
		// so an interrupted build — e.g. a dev-mode restart mid-pass — is rebuilt, not
		// mistaken for a live tree), or the corpus has grown past the rebuild threshold
		if (!state?.builtAt || (state.builtChunkCount && chunkCount >= state.builtChunkCount * REBUILD_GROWTH)) {
			await fullBuild();
			return;
		}

		await sweepUnassigned();

		// re-summarize dirty clusters, leaves first so parent updates see fresh children
		const dirty = [];
		for await (const s of tables.Summary.search({})) if (isDirty(s)) dirty.push(s);
		dirty.sort((a, b) => a.level - b.level);
		for (const s of dirty) await resummarize(s);
	} catch (err) {
		logger.error(`summary-tree maintenance: ${err.stack || err}`);
	} finally {
		maintaining = false;
	}
}

async function watchChunks() {
	try {
		const events = await tables.Chunk.subscribe({});
		for await (const ev of events) {
			try {
				// invariant: the build/maintenance pass must not race its own writes —
				// its summaryId patches fire this same subscription (and boundary chunks
				// whose nearest merged-centroid differs from their k-means assignment
				// would ping-pong dirty counts). The sweep in the next tick catches
				// anything that arrives while a pass is running.
				if (maintaining) continue;
				if (ev.type === 'put') {
					const record = ev.value ?? (await tables.Chunk.get(ev.id));
					await assignChunk(record ? { ...record, id: ev.id } : null);
				} else if (ev.type === 'delete') {
					// membership shrank; the owning summary is found via the sweep-side
					// bookkeeping (we don't know the old summaryId from the event alone)
					invalidateCentroidCache();
				}
			} catch (err) {
				logger.error(`summary-tree subscription handler: ${err.stack || err}`);
			}
		}
	} catch (err) {
		logger.error(`summary-tree: chunk subscription unavailable (${err.message}) — relying on periodic sweep`);
	}
}

setInterval(maintenanceTick, MAINTENANCE_INTERVAL_MS).unref();
setTimeout(maintenanceTick, 60_000).unref(); // first tick after boot settles
watchChunks();
