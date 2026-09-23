import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceMotion, surfaceOrigin } from '../../apps/workspace/surface-motion.mjs';

function harness(reduced = false) {
  const animations = [];
  const element = { animate(frames, options) {
    let resolve, reject;
    const animation = { frames, options, finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
      finish: () => resolve(), cancel: () => reject(new Error('cancelled')) };
    animations.push(animation);
    return animation;
  } };
  const motion = createSurfaceMotion(element, { reduced: () => reduced, read: () => ({ opacity: '.48', transform: 'matrix(0.97,0,0,0.97,-6,2)' }) });
  return { motion, animations };
}
const source = { left: 10, top: 200, width: 36, height: 36 };
const target = { left: 150, top: 100, width: 700, height: 600 };

test('reopening during close keeps the current presentation and invalidates the old completion', async () => {
  const { motion, animations } = harness();
  const closing = motion.run(false, source, target);
  const opening = motion.run(true, source, target);
  assert.equal(await closing, false);
  assert.equal(animations[1].frames[0].opacity, '.48');
  assert.match(animations[1].frames[0].transform, /matrix/);
  animations[1].finish();
  assert.equal(await opening, true);
});

test('closing during open replaces the animation without a jump to the fully open frame', async () => {
  const { motion, animations } = harness();
  const opening = motion.run(true, source, target);
  const closing = motion.run(false, source, target);
  assert.equal(await opening, false);
  assert.equal(animations[1].frames[0].opacity, '.48');
  assert.equal(animations[1].options.duration, 160);
  animations[1].finish();
  assert.equal(await closing, true);
});

test('reduced motion uses opacity only, including interruption', async () => {
  const { motion, animations } = harness(true);
  const opening = motion.run(true, source, target);
  const closing = motion.run(false, source, target);
  assert.equal(await opening, false);
  assert.equal(animations[1].options.duration, 90);
  assert.ok(animations.every(a => a.frames.every(frame => !('transform' in frame))));
  animations[1].finish();
  assert.equal(await closing, true);
});

test('forced removal cancels completion; source motion keeps uniform text proportions', async () => {
  const { motion } = harness();
  const opening = motion.run(true, source, target);
  motion.cancel();
  assert.equal(await opening, false);
  assert.match(surfaceOrigin(source, target).transform, /scale\(\.94\)/);
  assert.ok(!surfaceOrigin(null, target).transform.includes('NaN'));
});
