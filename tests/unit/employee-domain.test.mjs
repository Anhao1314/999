import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSeats, EmployeeStore, cropRect, visualAction, needsFounderCheck, isWorking, currentRoleOf, CONNECTION, AVAILABILITY } from '../../apps/employee/domain.mjs';
import { validatePortrait } from '../../apps/employee/avatar.mjs';

const people = (n) => Array.from({ length: n }, (_, i) => ({ employeeId: `e${String(i).padStart(3, '0')}`, availability: 'AVAILABLE', condition: null, currentWork: null }));
const card = (over = {}) => ({ employeeId: 'e', availability: 'AVAILABLE', condition: null, currentWork: null, ...over });

test('seating is presentation only: 7/20/60 employees expand and keep their seats', () => {
  for (const n of [7, 20, 60]) {
    const p = people(n), tables = syncSeats(p), ids = tables.flatMap((t) => t.seats).filter(Boolean);
    assert.equal(new Set(ids).size, n);
    assert.ok(tables.length >= Math.ceil(n / 6));
    const after = syncSeats(p.slice(1), tables);
    tables.forEach((t, i) => t.seats.forEach((id, j) => { if (id && id !== p[0].employeeId) assert.equal(after[i].seats[j], id); }));
    assert.deepEqual(syncSeats([...p].reverse(), tables), tables);
  }
});

test('a fresh projection replaces the read model; stale generations never overwrite it', () => {
  const s = new EmployeeStore();
  const model = { companyId: 'c', source: 'live', capturedAt: 't', summary: { employees: 1, working: 0, available: 1, disabled: 0 }, employees: people(1) };
  s.replace(model, 5);
  assert.equal(s.state.connection, CONNECTION.LIVE);
  assert.equal(s.replace({ ...model, employees: [] }, 4), false);
  assert.equal(s.state.employees.length, 1);
  s.connection(CONNECTION.RUNTIME_UNAVAILABLE);
  assert.equal(s.state.connection, CONNECTION.RUNTIME_UNAVAILABLE);
  assert.equal(s.state.employees.length, 1, 'transport state never rewrites employee data');
});

test('visual action is derived from availability and role, never guessed', () => {
  const live = { connection: CONNECTION.LIVE };
  assert.equal(visualAction(live, card({ availability: AVAILABILITY.WORKING })), 'typing');
  assert.equal(visualAction(live, card({ availability: AVAILABILITY.AVAILABLE })), 'still');
  assert.equal(visualAction(live, card({ availability: AVAILABILITY.DISABLED })), 'still');
  assert.equal(visualAction(live, card({ availability: AVAILABILITY.WORKING, condition: 'MULTIPLE_ACTIVE_RUNS' })), 'still', 'an ambiguous card does not pretend to have one focus');
  assert.equal(visualAction({ connection: CONNECTION.RUNTIME_UNAVAILABLE }, card({ availability: AVAILABILITY.WORKING })), 'still');
  assert.equal(isWorking(card({ availability: AVAILABILITY.WORKING })), true);
  assert.equal(currentRoleOf(card({ currentWork: { role: 'REVIEW' } })), 'REVIEW');
  assert.equal(needsFounderCheck(card({ condition: 'MULTIPLE_ACTIVE_RUNS' })), true);
});

test('crop preserves 0.618 aspect ratio and stays inside the original image', () => {
  for (const [w, h] of [[100, 200], [400, 100]]) for (const pan of [-1, 0, 1]) {
    const r = cropRect(w, h, 2, pan, pan);
    assert.ok(Math.abs(r.width / r.height - .618) < 1e-10);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h);
  }
  assert.throws(() => cropRect(0, 10));
});

test('avatar rejects unsupported MIME, spoofed SVG, oversized data and oversized PNG dimensions', async () => {
  await assert.rejects(() => validatePortrait(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /仅支持/);
  await assert.rejects(() => validatePortrait(new Blob(['<svg/>'], { type: 'image/png' })), /文件内容/);
  await assert.rejects(() => validatePortrait(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })), /仅支持/);
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(bytes.buffer); view.setUint32(16, 5000); view.setUint32(20, 5000);
  await assert.rejects(() => validatePortrait(new Blob([bytes], { type: 'image/png' })), /1600/);
  view.setUint32(16, 309); view.setUint32(20, 500); await validatePortrait(new Blob([bytes], { type: 'image/png' }));
});
