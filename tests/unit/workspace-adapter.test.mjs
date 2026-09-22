import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIENCE_PATHS, HttpWorkspaceAdapter } from '../../apps/workspace/adapter.mjs';
import { CONNECTION, WorkspaceStore, freshness } from '../../apps/workspace/domain.mjs';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('condition was not reached in time');
};

test('the adapter reads exactly the frozen Experience paths', async () => {
  assert.equal(EXPERIENCE_PATHS.workspace('cmp_1'), '/experience/companies/cmp_1/workspace');
  assert.equal(EXPERIENCE_PATHS.employee('emp_1'), '/experience/employees/emp_1');
  assert.equal(EXPERIENCE_PATHS.lineage('wrk_1'), '/experience/works/wrk_1/lineage');
  assert.equal(EXPERIENCE_PATHS.workspace('a/b c'), '/experience/companies/a%2Fb%20c/workspace');

  const calls = [];
  const adapter = new HttpWorkspaceAdapter({
    fetcher: async (path) => {
      calls.push(path);
      return json({ ok: true });
    },
  });
  await adapter.companies();
  await adapter.workspace('cmp_1');
  await adapter.employeeDetail('emp_1');
  await adapter.lineage('wrk_1');
  assert.deepEqual(calls, [
    '/companies',
    '/experience/companies/cmp_1/workspace',
    '/experience/employees/emp_1',
    '/experience/works/wrk_1/lineage',
  ]);
});

test('the adapter owns no write path at all', () => {
  const adapter = new HttpWorkspaceAdapter({ fetcher: async () => json({}) });
  for (const forbidden of [
    'setEmployeeEnabled',
    'acceptWork',
    'assignTask',
    'startWorkerRun',
    'requestReview',
    'submitReview',
    'driveWork',
    'command',
    'post',
  ])
    assert.equal(typeof adapter[forbidden], 'undefined', `${forbidden} must not exist`);
});

test('a snapshot keeps the projection intact and stamps company, source and capture time', async () => {
  const projection = {
    company: { id: 'cmp_1', name: 'One' },
    runtime: { available: true },
    attention: { count: 1, items: [{ id: 'att:1', kind: 'DECISION_REQUIRED' }] },
    primaryWork: null,
    workforce: { employees: 0, working: 0, available: 0, disabled: 0, onDuty: [] },
    recentDeliveries: [],
    pulse: { works: 0 },
  };
  const adapter = new HttpWorkspaceAdapter({ fetcher: async () => json(projection) });
  const readModel = await adapter.snapshot('cmp_1');
  assert.equal(readModel.companyId, 'cmp_1');
  assert.equal(readModel.source, 'live');
  assert.match(readModel.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readModel.projection, projection);
});

test('a projection error propagates its bounded code, never a raw failure', async () => {
  const adapter = new HttpWorkspaceAdapter({
    fetcher: async () => json({ error: { code: 'COMPANY_NOT_FOUND', message: 'company does not exist' } }, 404),
  });
  await assert.rejects(
    () => adapter.workspace('missing'),
    (error) => error.code === 'COMPANY_NOT_FOUND' && error.status === 404,
  );
});

test('polling replaces the read model whole and an outage never rewrites it', async () => {
  const store = new WorkspaceStore();
  let failing = false;
  let calls = 0;
  const adapter = new HttpWorkspaceAdapter({
    interval: 5,
    fetcher: async () => {
      calls += 1;
      if (failing) throw new Error('ECONNREFUSED');
      return json({ attention: { count: 3, items: [] }, primaryWork: null });
    },
  });
  const stop = adapter.subscribe('cmp_1', store);
  await waitFor(() => store.state.connection === CONNECTION.LIVE);
  assert.equal(store.state.projection.attention.count, 3);
  failing = true;
  await waitFor(() => store.state.connection === CONNECTION.RUNTIME_UNAVAILABLE);
  assert.equal(freshness(store.state), 'STALE');
  assert.equal(store.state.projection.attention.count, 3, 'the last known projection survives the outage');
  const seen = calls;
  stop();
  await sleep(30);
  assert.equal(calls, seen, 'the poll loop stops and leaves no timer behind');
});
