import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCardPosition, initialCardPosition } from '../../apps/workspace/board-layout.mjs';

test('a moved card stays inside the visible Company Canvas', () => {
  const bounds = { width: 1000, height: 650 };
  const size = { width: 276, height: 150 };
  assert.deepEqual(clampCardPosition({ x: -200, y: -40 }, bounds, size), { x: 14, y: 14 });
  assert.deepEqual(clampCardPosition({ x: 1200, y: 800 }, bounds, size), { x: 710, y: 486 });
  assert.deepEqual(clampCardPosition({ x: 400, y: 240 }, bounds, size), { x: 400, y: 240 });
});

test('the default stack begins at the right and remains bounded after narrowing', () => {
  const size = { width: 276, height: 150 };
  assert.deepEqual(initialCardPosition(0, { width: 1000, height: 650 }, size), { x: 710, y: 18 });
  assert.deepEqual(initialCardPosition(2, { width: 360, height: 390 }, size, 300), { x: 70, y: 226 });
  assert.deepEqual(clampCardPosition({ x: Infinity, y: NaN }, { width: 250, height: 110 }, size), { x: 14, y: 14 });
});
