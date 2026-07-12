/**
 * Spherical k-means (k-means++ init, deterministic seed) for the summary-tree
 * build loop. Pure module — no Harper imports — so it is unit-testable.
 *
 * Works on unit-normalized vectors with cosine similarity. Small corpora
 * (up to low hundreds of thousands of vectors) cluster fine in-process;
 * beyond that, sample-based k-means over a subset is the intended pattern.
 */

/** Deterministic PRNG (mulberry32) so rebuilds are reproducible. */
function rng(seed) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function normalize(v) {
	let s = 0;
	for (let d = 0; d < v.length; d++) s += v[d] * v[d];
	s = 1 / Math.sqrt(s || 1);
	const out = new Float32Array(v.length);
	for (let d = 0; d < v.length; d++) out[d] = v[d] * s;
	return out;
}

export function dot(a, b) {
	let s = 0;
	for (let d = 0; d < a.length; d++) s += a[d] * b[d];
	return s;
}

/** Index of the nearest centroid (cosine) — also the incremental-assignment primitive. */
export function nearestCentroid(vec, centroids) {
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

/**
 * @param vectors  array of (already normalized) Float32Array/number[]
 * @param k        cluster count
 * @param opts     { seed, iterations, minClusterSize } — tiny clusters are merged
 *                 into their nearest surviving neighbor
 * @returns { assignments: Int32Array, centroids: Float32Array[] } — centroids of
 *          emptied (merged-away) clusters are removed and assignments compacted.
 */
export function kmeans(vectors, k, { seed = 1244, iterations = 40, minClusterSize = 4 } = {}) {
	const n = vectors.length;
	const dims = vectors[0].length;
	k = Math.min(k, n);
	const rand = rng(seed);

	// k-means++ init on cosine distance
	const centroids = [vectors[(rand() * n) | 0]];
	const d2 = new Float64Array(n).fill(Infinity);
	while (centroids.length < k) {
		const c = centroids[centroids.length - 1];
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const d = 1 - dot(vectors[i], c);
			if (d * d < d2[i]) d2[i] = d * d;
			sum += d2[i];
		}
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
		}
		if (!moved && iter > 0) break;
		// recompute + renormalize; respawn empty clusters on the worst-fit point
		const sums = Array.from({ length: k }, () => new Float64Array(dims));
		const counts = new Int32Array(k);
		for (let i = 0; i < n; i++) {
			counts[assignments[i]]++;
			const s = sums[assignments[i]];
			for (let d = 0; d < dims; d++) s[d] += vectors[i][d];
		}
		for (let c = 0; c < k; c++) {
			if (!counts[c]) {
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

	// merge tiny clusters into nearest surviving centroid
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

	// compact away empty/merged slots
	const remap = new Int32Array(k).fill(-1);
	const outCentroids = [];
	const finalCounts = new Int32Array(k);
	for (let i = 0; i < n; i++) finalCounts[assignments[i]]++;
	for (let c = 0; c < k; c++) {
		if (finalCounts[c]) {
			remap[c] = outCentroids.length;
			outCentroids.push(centroids[c]);
		}
	}
	// recompute means for merged clusters so stored centroids match final membership
	const dims2 = vectors[0].length;
	const sums = outCentroids.map(() => new Float64Array(dims2));
	const cnts = new Int32Array(outCentroids.length);
	for (let i = 0; i < n; i++) {
		assignments[i] = remap[assignments[i]];
		cnts[assignments[i]]++;
		const s = sums[assignments[i]];
		for (let d = 0; d < dims2; d++) s[d] += vectors[i][d];
	}
	for (let c = 0; c < outCentroids.length; c++) {
		const cf = new Float32Array(dims2);
		for (let d = 0; d < dims2; d++) cf[d] = sums[c][d] / cnts[c];
		outCentroids[c] = normalize(cf);
	}
	return { assignments, centroids: outCentroids };
}
