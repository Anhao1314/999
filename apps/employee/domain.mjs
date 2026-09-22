// Seating/crop algorithms adapted from the user-supplied ai_employee_codex_kit/core/core.js.
export const PORTRAIT_RATIO = 0.618;
export function syncSeats(employees, previous = []) {
  const active = new Map(employees.filter(e => e.lifecycle !== 'archived').map(e => [e.id, e]));
  if (active.size !== employees.filter(e => e.lifecycle !== 'archived').length) throw new Error('Duplicate employee');
  const seen = new Set();
  const tables = previous.map(t => ({ ...t, seats: t.seats.map(id => {
    if (!active.has(id) || seen.has(id) || (active.get(id).taskGroupId ?? null) !== (t.groupId ?? null)) return null;
    seen.add(id); return id;
  }) }));
  const add = groupId => { const t = { id: `table-${tables.length + 1}`, groupId, seats: Array(6).fill(null) }; tables.push(t); return t; };
  while (tables.length < 3) add(null);
  for (const e of [...active.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (seen.has(e.id)) continue;
    const group = e.taskGroupId ?? null;
    let table = tables.find(t => t.groupId === group && t.seats.includes(null));
    if (!table) { table = tables.find(t => t.seats.every(id => id === null)); if (table) table.groupId = group; }
    if (!table) table = add(group);
    table.seats[table.seats.indexOf(null)] = e.id;
  }
  return tables;
}
export function cropRect(width, height, zoom = 1, x = 0, y = 0) {
  if (![width, height, zoom, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 1) throw new Error('Invalid crop');
  let w = Math.min(width, height * PORTRAIT_RATIO) / zoom, h = w / PORTRAIT_RATIO;
  return { x: (width - w) / 2 * (1 + Math.max(-1, Math.min(1, x))), y: (height - h) / 2 * (1 + Math.max(-1, Math.min(1, y))), width: w, height: h };
}
export function employeeRun(state, id) {
  const runs = state.runs.filter(r => r.employeeId === id);
  return runs.find(r => ['running', 'paused', 'waiting'].includes(r.status)) ?? runs.at(-1);
}
export function employeeStatus(state, employee) {
  const run = employeeRun(state, employee.id);
  if (run && ['running', 'paused', 'waiting', 'failed'].includes(run.status)) return run.status;
  return employee.enabled ? 'idle' : 'disabled';
}
export function visualAction(state, employee) {
  if (!['live', 'mock'].includes(state.connection)) return 'idle';
  return employeeStatus(state, employee) === 'running' ? 'typing' : 'idle';
}
export function canArchive(state, id) { return !state.runs.some(r => r.employeeId === id && ['running', 'paused', 'waiting', 'queued'].includes(r.status)); }
export function tokenLabel(run) { return `${run?.tokenUsed ?? '未提供'} / ${run?.tokenLimit ?? '未提供'}`; }
export class EmployeeStore {
  constructor() { this.state = { companyId: null, employees: [], tasks: [], runs: [], activity: [], tables: syncSeats([]), connection: 'connecting' }; this.listeners = new Set(); this.generation = -1; this.sequence = 0; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.state); }
  connection(value) { this.state = { ...this.state, connection: value }; this.emit(); }
  snapshot(snapshot, generation = this.generation + 1) {
    if (generation <= this.generation) return false;
    const same = this.state.companyId === snapshot.companyId;
    if (same && Number.isSafeInteger(snapshot.revision) && Number.isSafeInteger(this.state.revision) && snapshot.revision < this.state.revision) return false;
    this.generation = generation;
    this.sequence = snapshot.cursor ?? 0;
    this.state = { ...snapshot, tables: syncSeats(snapshot.employees, same ? this.state.tables : []), connection: snapshot.source === 'mock' ? 'mock' : 'live' };
    this.emit(); return true;
  }
  // Reserved for adapters with a genuine contiguous sequence (demo today).
  event(event) {
    if (event.companyId !== this.state.companyId) return 'wrong_company';
    if (event.seq <= this.sequence) return 'duplicate';
    if (event.seq !== this.sequence + 1) { this.connection('stale'); return 'gap'; }
    this.sequence = event.seq;
    if (event.snapshot) this.snapshot({ ...event.snapshot, cursor: event.seq });
    return 'applied';
  }
}
