/**
 * Spherical k-means (k-means++ init, deterministic seed) over unit-normalized vectors with cosine similarity.
 * It yields to the event loop every `YIELD_EVERY` vector comparisons, so clustering a large partition does not
 * stall the Harper worker that runs it.
 */

export type Vector = Float32Array | readonly number[];

const YIELD_EVERY = 2_000_000;

function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function normalize(v: Vector): Float32Array {
	let s = 0;
	for (let d = 0; d < v.length; d++) s += v[d] * v[d];
	s = 1 / Math.sqrt(s || 1);
	const out = new Float32Array(v.length);
	for (let d = 0; d < v.length; d++) out[d] = v[d] * s;
	return out;
}

export function dot(a: Vector, b: Vector): number {
	let s = 0;
	for (let d = 0; d < a.length; d++) s += a[d] * b[d];
	return s;
}

export function nearestCentroid(vec: Vector, centroids: readonly Vector[]): { index: number; similarity: number } {
	let best = 0;
	let bestSim = -2;
	for (let c = 0; c < centroids.length; c++) {
		const s = dot(vec, centroids[c]);
		if (s > bestSim) {
			bestSim = s;
			best = c;
		}
	}
	return { index: best, similarity: bestSim };
}

export function centroidOf(vectors: readonly Vector[]): Float32Array {
	const dims = vectors[0].length;
	const sum = new Float64Array(dims);
	for (const v of vectors) for (let d = 0; d < dims; d++) sum[d] += v[d];
	return normalize(Array.from(sum, (x) => x / vectors.length));
}

class Yielder {
	#work = 0;
	async add(units: number): Promise<void> {
		this.#work += units;
		if (this.#work < YIELD_EVERY) return;
		this.#work = 0;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

export interface KmeansOptions {
	seed?: number;
	iterations?: number;
	/** clusters smaller than this are merged into their nearest surviving neighbor */
	minClusterSize?: number;
}

/**
 * @param vectors already-normalized vectors
 * @returns assignments into the returned centroids; emptied (merged-away) clusters are removed and compacted
 */
export async function kmeans(
	vectors: readonly Vector[],
	k: number,
	{ seed = 1244, iterations = 40, minClusterSize = 4 }: KmeansOptions = {},
): Promise<{ assignments: Int32Array; centroids: Float32Array[] }> {
	const n = vectors.length;
	const dims = vectors[0].length;
	k = Math.max(1, Math.min(k, n));
	const rand = rng(seed);
	const yielder = new Yielder();

	const centroids: Vector[] = [vectors[(rand() * n) | 0]];
	const d2 = new Float64Array(n).fill(Infinity);
	while (centroids.length < k) {
		const c = centroids[centroids.length - 1];
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const d = 1 - dot(vectors[i], c);
			if (d * d < d2[i]) d2[i] = d * d;
			sum += d2[i];
		}
		await yielder.add(n * dims);
		let r = rand() * sum;
		let pick = 0;
		for (let i = 0; i < n; i++) {
			r -= d2[i];
			if (r <= 0) {
				pick = i;
				break;
			}
		}
		centroids.push(vectors[pick]);
	}

	const assignments = new Int32Array(n).fill(-1);
	for (let iter = 0; iter < iterations; iter++) {
		let moved = 0;
		for (let i = 0; i < n; i++) {
			const { index } = nearestCentroid(vectors[i], centroids);
			if (assignments[i] !== index) {
				assignments[i] = index;
				moved++;
			}
			await yielder.add(k * dims);
		}
		if (!moved && iter > 0) break;
		const sums = Array.from({ length: k }, () => new Float64Array(dims));
		const counts = new Int32Array(k);
		for (let i = 0; i < n; i++) {
			counts[assignments[i]]++;
			const s = sums[assignments[i]];
			for (let d = 0; d < dims; d++) s[d] += vectors[i][d];
		}
		for (let c = 0; c < k; c++) {
			if (!counts[c]) {
				// respawn an empty cluster on the worst-fit point
				let worst = 0;
				let worstSim = 2;
				for (let i = 0; i < n; i++) {
					const s = dot(vectors[i], centroids[assignments[i]]);
					if (s < worstSim) {
						worstSim = s;
						worst = i;
					}
				}
				centroids[c] = vectors[worst];
				continue;
			}
			const cf = new Float32Array(dims);
			for (let d = 0; d < dims; d++) cf[d] = sums[c][d] / counts[c];
			centroids[c] = normalize(cf);
		}
	}

	const counts = new Int32Array(k);
	for (let i = 0; i < n; i++) counts[assignments[i]]++;
	const tiny = new Set([...counts.keys()].filter((c) => counts[c] > 0 && counts[c] < minClusterSize));
	if (tiny.size && tiny.size < k) {
		for (let i = 0; i < n; i++) {
			if (!tiny.has(assignments[i])) continue;
			let best = -1;
			let bestSim = -2;
			for (let c = 0; c < k; c++) {
				if (tiny.has(c) || !counts[c]) continue;
				const s = dot(vectors[i], centroids[c]);
				if (s > bestSim) {
					bestSim = s;
					best = c;
				}
			}
			assignments[i] = best;
		}
	}

	const remap = new Int32Array(k).fill(-1);
	let survivors = 0;
	const finalCounts = new Int32Array(k);
	for (let i = 0; i < n; i++) finalCounts[assignments[i]]++;
	for (let c = 0; c < k; c++) if (finalCounts[c]) remap[c] = survivors++;
	const members: Vector[][] = Array.from({ length: survivors }, () => []);
	for (let i = 0; i < n; i++) {
		assignments[i] = remap[assignments[i]];
		members[assignments[i]].push(vectors[i]);
	}
	return { assignments, centroids: members.map(centroidOf) };
}
