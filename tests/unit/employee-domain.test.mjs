import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSeats, EmployeeStore, cropRect, canArchive, visualAction, tokenLabel } from '../../apps/employee/domain.mjs';
import { validatePortrait } from '../../apps/employee/avatar.mjs';
const people = n => Array.from({ length: n }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`, enabled: true, taskGroupId: 'a' }));
test('7/20/60 employees expand, preserve seats, release only deleted seat', () => {
  for (const n of [7, 20, 60]) {
    const p = people(n), tables = syncSeats(p), ids = tables.flatMap(t => t.seats).filter(Boolean);
    assert.equal(new Set(ids).size, n); assert.ok(tables.length >= Math.ceil(n / 6));
    const after = syncSeats(p.slice(1), tables);
    tables.forEach((t, i) => t.seats.forEach((id, j) => { if (id && id !== p[0].id) assert.equal(after[i].seats[j], id); }));
    assert.deepEqual(syncSeats([...p].reverse(), tables), tables);
  }
});
test('group affinity and fresh snapshot never reshuffle existing employees', () => {
  const p = [...people(7), { id: 'z', taskGroupId: 'b' }]; const tables = syncSeats(p);
  assert.equal(tables.filter(t => t.groupId === 'a').length, 2);
  assert.ok(tables.find(t => t.groupId === 'b').seats.includes('z'));
  assert.deepEqual(syncSeats(p, tables), tables);
});
test('duplicate, wrong company, gaps and stale snapshot fail closed', () => {
  const s = new EmployeeStore(); const snapshot = { companyId: 'c', employees: people(1), runs: [], tasks: [], activity: [], source: 'live', cursor: 10 };
  s.snapshot(snapshot, 5); assert.equal(s.snapshot({ ...snapshot, employees: [] }, 4), false);
  assert.equal(s.event({ companyId: 'x', seq: 11 }), 'wrong_company');
  assert.equal(s.event({ companyId: 'c', seq: 10 }), 'duplicate');
  assert.equal(s.event({ companyId: 'c', seq: 12 }), 'gap'); assert.equal(s.state.connection, 'stale');
  s.snapshot(snapshot, 6); assert.equal(s.state.connection, 'live');
  s.snapshot({...snapshot,revision:20},7);
  assert.equal(s.snapshot({...snapshot,revision:19,employees:[]},8),false);
  assert.equal(s.state.employees.length,1);
});
test('active deletion protection, offline motion and unknown usage', () => {
  const state = { connection: 'live', runs: [{ employeeId: 'e', status: 'running' }] };
  assert.equal(canArchive(state, 'e'), false); assert.equal(visualAction(state, { id: 'e' }), 'typing');
  state.connection = 'offline'; assert.equal(visualAction(state, { id: 'e' }), 'idle');
  assert.equal(tokenLabel({ tokenUsed: 0, tokenLimit: null }), '0 / 未提供');
  assert.equal(tokenLabel(), '未提供 / 未提供');
});
test('crop preserves 0.618 aspect ratio and stays inside original image', () => {
  for (const [w,h] of [[100,200],[400,100]]) for (const pan of [-1,0,1]) {
    const r = cropRect(w,h,2,pan,pan); assert.ok(Math.abs(r.width/r.height-.618)<1e-10);
    assert.ok(r.x>=0 && r.y>=0 && r.x+r.width<=w && r.y+r.height<=h);
  }
  assert.throws(() => cropRect(0, 10));
});
test('avatar rejects unsupported MIME, spoofed SVG, oversized data and oversized PNG dimensions',async()=>{
  await assert.rejects(()=>validatePortrait(new Blob(['<svg/>'],{type:'image/svg+xml'})),/仅支持/);
  await assert.rejects(()=>validatePortrait(new Blob(['<svg/>'],{type:'image/png'})),/文件内容/);
  await assert.rejects(()=>validatePortrait(new Blob([new Uint8Array(5*1024*1024+1)],{type:'image/png'})),/仅支持/);
  const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,5000);view.setUint32(20,5000);
  await assert.rejects(()=>validatePortrait(new Blob([bytes],{type:'image/png'})),/1600/);
  view.setUint32(16,309);view.setUint32(20,500);await validatePortrait(new Blob([bytes],{type:'image/png'}));
});
