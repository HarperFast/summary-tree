import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings } from '../dist/settings.js';

test('orientationShare defaults to half and must be a finite number in range', () => {
	assert.equal(DEFAULT_SETTINGS.orientationShare, 0.5);
	assert.equal(parseSettings({ orientationShare: 1 }).orientationShare, 1);
	for (const bad of [Number.NaN, 0, 1.5, Infinity]) {
		assert.throws(() => parseSettings({ orientationShare: bad }), /orientationShare must be between/);
	}
	assert.throws(() => parseSettings({ dirtyFraction: Number.NaN }), /dirtyFraction must be between/);
});
