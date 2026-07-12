import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmeans, normalize, dot, nearestCentroid } from '../lib/kmeans.js';

// three well-separated blobs in 8-D; deterministic pseudo-random jitter
function blobCorpus() {
	const centers = [
		[1, 0, 0, 0, 0, 0, 0, 0],
		[0, 1, 0, 0, 0, 0, 0, 0],
		[0, 0, 1, 0, 0, 0, 0, 0],
	];
	const vecs = [];
	const truth = [];
	let s = 42;
	const rand = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff - 0.5;
	};
	for (let c = 0; c < 3; c++) {
		for (let i = 0; i < 20; i++) {
			const v = centers[c].map((x) => x + 0.05 * rand());
			vecs.push(normalize(v));
			truth.push(c);
		}
	}
	return { vecs, truth };
}

test('kmeans: recovers well-separated blobs (permutation-invariant purity)', () => {
	const { vecs, truth } = blobCorpus();
	const { assignments, centroids } = kmeans(vecs, 3, { seed: 7 });
	assert.equal(centroids.length, 3);
	// purity: each cluster's dominant true label / size
	const byCluster = new Map();
	for (let i = 0; i < vecs.length; i++) {
		if (!byCluster.has(assignments[i])) byCluster.set(assignments[i], {});
		const o = byCluster.get(assignments[i]);
		o[truth[i]] = (o[truth[i]] || 0) + 1;
	}
	let correct = 0;
	for (const o of byCluster.values()) correct += Math.max(...Object.values(o));
	assert.ok(correct / vecs.length >= 0.95, `purity ${(correct / vecs.length).toFixed(2)} >= 0.95`);
});

test('kmeans: deterministic for a fixed seed', () => {
	const { vecs } = blobCorpus();
	const a = kmeans(vecs, 3, { seed: 7 }).assignments;
	const b = kmeans(vecs, 3, { seed: 7 }).assignments;
	assert.deepEqual([...a], [...b]);
});

test('kmeans: every point is assigned to a compacted, non-empty cluster', () => {
	const { vecs } = blobCorpus();
	const { assignments, centroids } = kmeans(vecs, 8, { seed: 3, minClusterSize: 2 });
	const seen = new Set(assignments);
	// assignments index into the returned centroid array with no gaps
	for (const a of assignments) assert.ok(a >= 0 && a < centroids.length);
	assert.equal(seen.size, centroids.length, 'no empty clusters in the output');
});

test('nearestCentroid: picks the closest centroid (incremental-assignment primitive)', () => {
	const cents = [normalize([1, 0, 0]), normalize([0, 1, 0])];
	const { index } = nearestCentroid(normalize([0.9, 0.1, 0]), cents);
	assert.equal(index, 0);
	assert.ok(dot(normalize([0, 1, 0]), cents[1]) > 0.99);
});
