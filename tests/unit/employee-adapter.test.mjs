import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpEmployeeAdapter, workforceToReadModel, EXPERIENCE_PATHS } from '../../apps/employee/adapter.mjs';
import { DemoEmployeeAdapter } from '../../apps/employee/demo.mjs';
import { EmployeeStore, CONNECTION } from '../../apps/employee/domain.mjs';

const projection = {
  company: { id: 'c1', name: 'Company One' },
  summary: { employees: 2, working: 1, available: 1, disabled: 0 },
  employees: [
    {
      employeeId: 'e1',
      displayName: 'Producer A',
      position: { id: 'p1', title: 'Producer' },
      capabilities: ['capability.produce'],
      availability: 'WORKING',
      condition: null,
      currentWork: { workId: 'w1', title: 'Work one', taskId: 't1', role: 'REPAIR', workerRunId: 'r1', generation: 2, attempt: 2, maxAutonomousAttempts: 3 },
      execution: { backendType: 'codex-exec', backendVersion: '1.0' },
    },
    {
      employeeId: 'e2',
      displayName: 'Reviewer B',
      position: { id: 'p2', title: 'Reviewer' },
      capabilities: [],
      availability: 'AVAILABLE',
      condition: null,
      currentWork: null,
      execution: null,
    },
  ],
};

test('the Experience projection maps into the lobby read model without inventing state', () => {
  const model = workforceToReadModel('c1', projection);
  assert.equal(model.source, 'live');
  assert.deepEqual(model.summary, { employees: 2, working: 1, available: 1, disabled: 0 });
  assert.equal(model.employees[0].availability, 'WORKING');
  assert.equal(model.employees[0].currentWork.role, 'REPAIR');
  assert.equal(model.employees[0].execution.backendType, 'codex-exec');
  assert.equal(model.employees[1].availability, 'AVAILABLE');
  assert.equal(model.employees[1].currentWork, null);
  const unknown = workforceToReadModel('c1', { summary: { employees: 0, working: 0, available: 0, disabled: 0 }, employees: [{ ...projection.employees[0], currentWork: { ...projection.employees[0].currentWork, role: 'MYSTERY' } }] });
  assert.equal(unknown.employees[0].currentWork.role, null, 'an unknown role fails closed, never guesses');
});

test('the adapter reads the frozen Experience endpoints and the Founder command seam', async () => {
  const calls = [];
  const adapter = new HttpEmployeeAdapter({
    fetcher: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/companies') return new Response(JSON.stringify({ companies: [{ id: 'c1', name: 'One' }] }), { status: 200 });
      if (path === EXPERIENCE_PATHS.workforce('c1')) return new Response(JSON.stringify(projection), { status: 200 });
      if (path === EXPERIENCE_PATHS.employee('e1')) return new Response(JSON.stringify({ employeeId: 'e1', availability: 'WORKING' }), { status: 200 });
      if (path === EXPERIENCE_PATHS.lineage('w1')) return new Response(JSON.stringify({ work: { workId: 'w1' } }), { status: 200 });
      if (path === '/commands') return new Response(JSON.stringify({ result: { enabled: true } }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND' } }), { status: 404 });
    },
  });
  assert.deepEqual(await adapter.companies(), [{ id: 'c1', name: 'One' }]);
  const model = await adapter.snapshot('c1');
  assert.equal(model.companyId, 'c1');
  assert.equal(model.employees[1].employeeId, 'e2');
  assert.equal((await adapter.employeeDetail('e1')).employeeId, 'e1');
  assert.equal((await adapter.lineage('w1')).work.workId, 'w1');
  await adapter.setEmployeeEnabled('e1', false);
  const command = calls.find((call) => call.path === '/commands');
  assert.deepEqual(JSON.parse(command.body), { command: 'setEmployeeEnabled', input: { employeeId: 'e1', enabled: false } });
  assert.ok(calls.every((call) => call.path !== '/employee-api/snapshot' && call.path !== '/employee-api/commands'), 'the lobby never touches its own legacy routes');
});

test('poll failure marks transport unavailable and never fabricates a demo fallback', async () => {
  let calls = 0;
  const adapter = new HttpEmployeeAdapter({
    interval: 30,
    fetcher: async (path) => {
      if (path === EXPERIENCE_PATHS.workforce('c1')) {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify(projection), { status: 200 });
        throw new Error('connection refused');
      }
      throw new Error('unexpected path');
    },
  });
  const store = new EmployeeStore();
  const stop = adapter.subscribe('c1', store);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.state.connection, CONNECTION.LIVE);
    assert.equal(store.state.employees.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(store.state.connection, CONNECTION.RUNTIME_UNAVAILABLE);
    assert.equal(store.state.employees.length, 2, 'the last known projection stays; no synthetic employees appear');
    assert.equal(store.state.source, 'live');
    stop();
    const generation = store.generation;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(store.generation, generation, 'stopping the poller aborts and suppresses late writes');
  } finally {
    stop();
  }
});

test('a 202 is never treated as a confirmed Founder control', async () => {
  const adapter = new HttpEmployeeAdapter({ fetcher: async () => new Response(JSON.stringify({ state: 'accepted' }), { status: 202 }) });
  await assert.rejects(() => adapter.setEmployeeEnabled('e1', false), /尚未确认/);
});

test('demo and live read models never mix', async () => {
  const demo = new DemoEmployeeAdapter();
  const demoModel = await demo.snapshot();
  assert.equal(demoModel.source, 'mock');
  assert.equal(demoModel.companyId, 'demo');
  assert.equal(typeof demo.fetcher, 'undefined', 'the demo adapter has no transport to call');
  assert.ok(demoModel.employees.every((card) => ['AVAILABLE', 'WORKING', 'DISABLED'].includes(card.availability)));
  const live = new HttpEmployeeAdapter({ fetcher: async (path) => { if (path === EXPERIENCE_PATHS.workforce('c1')) return new Response(JSON.stringify(projection), { status: 200 }); throw new Error('offline'); } });
  const liveModel = await live.snapshot('c1');
  assert.equal(liveModel.source, 'live');
  assert.ok(liveModel.employees.every((card) => card.employeeId !== 'demo-1'), 'synthetic employees never appear in live results');
});
