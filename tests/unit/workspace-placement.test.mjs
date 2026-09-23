import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAnchoredSurface } from '../../apps/workspace/placement.mjs';

const anchor = (left, top, width = 40, height = 40) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});
const inside = (placed, viewport, margin = 12) => {
  assert.ok(placed.left >= margin);
  assert.ok(placed.top >= margin);
  assert.ok(placed.left + placed.width <= viewport.width - margin);
  assert.ok(placed.top + placed.height <= viewport.height - margin);
};

test('contextual bubble prefers the source side and flips at horizontal edges', () => {
  const viewport = { width: 1280, height: 800 };
  const right = placeAnchoredSurface(anchor(240, 300), viewport, { width: 420, height: 350 });
  const left = placeAnchoredSurface(anchor(1150, 300), viewport, { width: 420, height: 350 });
  assert.equal(right.side, 'right');
  assert.equal(left.side, 'left');
  inside(right, viewport);
  inside(left, viewport);
});

test('viewport coordinates remain bounded for scrolled or corner sources', () => {
  const viewport = { width: 780, height: 520 };
  for (const source of [anchor(0, 0), anchor(740, 480), anchor(350, -20), anchor(350, 500)]) {
    const placed = placeAnchoredSurface(source, viewport, { width: 420, height: 450 });
    inside(placed, viewport);
  }
});

test('compact bubbles keep a margin and choose below or above the source', () => {
  const viewport = { width: 390, height: 720 };
  const below = placeAnchoredSurface(anchor(14, 40, 120, 48), viewport, { width: 420, height: 400 });
  const above = placeAnchoredSurface(anchor(280, 640, 90, 42), viewport, { width: 420, height: 400 });
  assert.equal(below.side, 'below');
  assert.equal(above.side, 'above');
  assert.ok(above.top < 640);
  inside(below, viewport);
  inside(above, viewport);
});
