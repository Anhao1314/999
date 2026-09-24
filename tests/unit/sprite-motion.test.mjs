import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { ACTIONS, DIRECTIONS, FRAME, spriteVariant, portraitUrl } from '../../apps/employee/sprite-motion.mjs';
import { roomPoint, roomRoute, roomRouteValid } from '../../apps/employee/room-path.mjs';
import { createAssistantMotionTracker } from '../../apps/workspace/assistant-motion.mjs';

const asset = (name) => new URL(`../../apps/employee/assets/${name}`, import.meta.url);
function png(name) {
  const file = readFileSync(asset(name));
  assert.equal(file.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, pixels;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset), type = file.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') pixels = inflateSync(file.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20), pixels };
}

test('nine original human sprite sets share dimensions, transparent cells, and matching portraits', () => {
  const manifest = JSON.parse(readFileSync(asset('manifest.json')));
  assert.equal(manifest.sprites.length, 9);
  assert.deepEqual(manifest.actions, ACTIONS);
  assert.deepEqual(manifest.directions, DIRECTIONS);
  for (const { id, image, portrait } of manifest.sprites) {
    const atlas = png(image), avatar = png(portrait);
    assert.equal(atlas.width, FRAME.width * FRAME.columns, id);
    assert.equal(atlas.height, FRAME.height * FRAME.rows, id);
    assert.deepEqual([avatar.width, avatar.height], [72, 108], id);
    assert.equal(atlas.pixels[1], 0, 'transparent top-left cell');
    assert.equal(avatar.pixels[1], 0, 'transparent portrait corner');
    assert.ok(atlas.pixels.some((value, index) => index % 4 === 0 && value !== 0), id);
  }
  assert.equal(new Set(Array.from({ length: 8 }, (_, n) => spriteVariant(`employee-${n}`))).size, 8);
  assert.match(portraitUrl('person', true), /portrait-assistant\.png$/);
});

test('all overview routes stay within distinct room lanes and end at stable seats', () => {
  for (const size of [0, 1, 7, 20, 60]) {
    const visible = Math.min(4, size);
    for (let slot = 0; slot < visible; slot++) {
      for (const [from, to] of [[false, true], [true, false]]) {
        const route = roomRoute(slot, from, to);
        assert.ok(roomRouteValid(slot, route));
        assert.deepEqual(route[0], roomPoint(slot, from));
        assert.deepEqual(route.at(-1), roomPoint(slot, to));
      }
    }
  }
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const first = roomRoute(a, false, true), second = roomRoute(b, false, true);
    assert.ok(first.every((point) => second.every((other) => point.x !== other.x || point.y !== other.y)));
  }
});

test('assistant motion only celebrates new facts in consecutive live reads', () => {
  const tracker = createAssistantMotionTracker();
  const read = (companyId, live, attentionIds, deliveryIds) => tracker.observe({ companyId, live, attentionIds, deliveryIds });
  assert.equal(read('a', true, ['needs-1'], ['artifact-1']), null);
  assert.equal(read('a', true, ['needs-1'], ['artifact-1']), null);
  assert.equal(read('a', true, ['needs-1', 'needs-2'], ['artifact-1']), 'excited');
  assert.equal(read('a', true, ['needs-2'], ['artifact-1', 'artifact-2']), 'cheer');
  assert.equal(read('a', false, ['needs-2'], ['artifact-1', 'artifact-2']), null);
  assert.equal(read('a', true, ['needs-3'], ['artifact-3']), null, 'reconnection sets baseline');
  assert.equal(read('b', true, ['needs-4'], ['artifact-4']), null, 'company switch sets baseline');
});
