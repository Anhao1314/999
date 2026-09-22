import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION,
  NAV_ITEMS,
  PLACEHOLDERS,
  WorkspaceStore,
  acceptedStateText,
  actionText,
  activityNames,
  activityText,
  attentionCount,
  attentionKindText,
  attentionLeadText,
  availabilityText,
  conditionText,
  detailBasis,
  freshness,
  outcomeText,
  roleText,
  stageText,
  taskStateText,
  verdictText,
  workerRunStateText,
  workforceSummaryLine,
  workStatusText,
} from '../../apps/workspace/domain.mjs';
import {
  DELIVERY_ACCEPTED_STATES,
  DELIVERY_REVIEW_STATES,
  EXPERIENCE_AVAILABILITY,
  EXPERIENCE_ROLES,
} from '../../packages/experience/index.mjs';
import { COLLABORATION_STAGES, COLLABORATION_STATUSES } from '../../packages/work/collaboration.mjs';
import { TASK_STATES } from '../../packages/work/work.mjs';
import { WORKER_RUN_STATES } from '../../packages/workforce/worker-runs.mjs';
import {
  ATTENTION_ACTIONS,
  ATTENTION_DIAGNOSTICS,
  ATTENTION_KINDS,
} from '../../packages/work/attention.mjs';
import { OUTCOME_STATES } from '../../packages/work/outcome.mjs';
import { EVENTS, LEGACY_LIFECYCLE_KINDS } from '../../packages/runtime/events.mjs';

const projectionOf = (over = {}) => ({
  company: { id: 'cmp_x', name: 'X' },
  runtime: { available: true },
  attention: { count: 0, items: [] },
  primaryWork: null,
  workforce: { employees: 0, working: 0, available: 0, disabled: 0, onDuty: [] },
  recentDeliveries: [],
  pulse: { activeWorks: 0 },
  ...over,
});

test('every frozen Runtime value has product language and none renders the raw identifier', () => {
  for (const value of Object.values(EXPERIENCE_AVAILABILITY)) {
    assert.ok(availabilityText(value), value);
    assert.notEqual(availabilityText(value), value, value);
  }
  for (const value of Object.values(EXPERIENCE_ROLES)) {
    assert.ok(roleText(value), value);
    assert.notEqual(roleText(value), value, value);
  }
  for (const value of COLLABORATION_STATUSES) {
    assert.ok(workStatusText(value), value);
    assert.notEqual(workStatusText(value), value, value);
  }
  for (const value of COLLABORATION_STAGES) {
    assert.ok(stageText(value), value);
    assert.notEqual(stageText(value), value, value);
  }
  for (const value of Object.values(TASK_STATES)) {
    assert.ok(taskStateText(value), value);
    assert.notEqual(taskStateText(value), value, value);
  }
  for (const value of Object.values(WORKER_RUN_STATES)) {
    assert.ok(workerRunStateText(value), value);
    assert.notEqual(workerRunStateText(value), value, value);
  }
  for (const value of DELIVERY_REVIEW_STATES) {
    assert.ok(verdictText(value), value);
    assert.notEqual(verdictText(value), value, value);
  }
  for (const value of DELIVERY_ACCEPTED_STATES) {
    assert.ok(acceptedStateText(value), value);
    assert.notEqual(acceptedStateText(value), value, value);
  }
  for (const value of Object.values(ATTENTION_KINDS)) {
    assert.ok(attentionKindText(value), value);
    assert.ok(attentionLeadText(value), value);
    assert.notEqual(attentionKindText(value), value, value);
  }
  for (const value of [...Object.values(ATTENTION_KINDS), ...Object.values(ATTENTION_DIAGNOSTICS)]) {
    assert.ok(conditionText(value), value);
    assert.notEqual(conditionText(value), value, value);
  }
  for (const value of Object.values(ATTENTION_ACTIONS)) {
    assert.ok(actionText(value), value);
    assert.notEqual(actionText(value), value, value);
  }
  for (const value of Object.values(OUTCOME_STATES)) {
    assert.ok(outcomeText(value), value);
    assert.notEqual(outcomeText(value), value, value);
  }
});

test('unknown Runtime values fail closed to neutral phrases, never the raw identifier', () => {
  assert.equal(availabilityText('IDLE'), '状态未知');
  assert.equal(availabilityText('OFFLINE'), '状态未知');
  assert.equal(roleText('WIZARD'), '任务');
  assert.equal(workStatusText('ALMOST'), '状态未知');
  assert.equal(stageText('SOMEWHERE'), '状态未知');
  assert.equal(verdictText('MAYBE'), '评审结论未知');
  assert.equal(acceptedStateText('PERHAPS'), '尚未接受');
  assert.equal(attentionKindText('URGENT'), '需要你处理');
  assert.equal(conditionText('WEIRD'), '需要检查');
  assert.equal(actionText('TELEPORT'), '由 Runtime 处理');
  assert.equal(outcomeText('UNKNOWN'), '结果状态未知');
});

test('activity vocabulary covers every Runtime kind and fails closed for the rest', () => {
  for (const kind of [...Object.values(EVENTS), ...LEGACY_LIFECYCLE_KINDS]) {
    assert.ok(activityNames[kind], `activityNames must cover ${kind}`);
    assert.notEqual(activityText({ kind }), kind);
  }
  assert.equal(activityText({ kind: 'mystery.event' }), '工作已更新');
  assert.match(activityText({ kind: 'REVIEW_PASSED' }), /不等于 Founder 接受/);
  assert.equal(activityText({ kind: 'mystery.event', summary: 'runtime summary' }), 'runtime summary');
});

test('the workforce line is a pure function of projection counts', () => {
  assert.equal(
    workforceSummaryLine({ employees: 4, working: 1, available: 2, disabled: 1 }),
    '4 位员工 · 1 工作中 · 2 空闲 · 1 已停用',
  );
  assert.equal(
    workforceSummaryLine({ employees: 3, working: 0, available: 3, disabled: 0 }),
    '3 位员工 · 0 工作中 · 3 空闲',
  );
  assert.equal(workforceSummaryLine(null), '暂无员工数据');
});

test('attention, navigation and placeholders are bounded presentation facts', () => {
  assert.equal(attentionCount(projectionOf()), 0);
  assert.equal(attentionCount(projectionOf({ attention: { count: 2, items: [] } })), 2);
  assert.equal(attentionCount(null), 0);
  const kinds = new Set(NAV_ITEMS.map((item) => item.id));
  for (const id of ['workspace', 'work', 'employees', 'hiring', 'artifacts', 'knowledge', 'settings'])
    assert.ok(kinds.has(id), id);
  assert.equal(NAV_ITEMS.find((item) => item.id === 'employees').href, '/employees');
  assert.match(PLACEHOLDERS.hiring.message, /Hiring MVP/);
  assert.match(PLACEHOLDERS.knowledge.message, /Knowledge layer/);
});

test('a projection replaces the read model whole; transport never rewrites it', () => {
  const store = new WorkspaceStore();
  assert.equal(freshness(store.state), 'NONE');
  const first = { companyId: 'c1', source: 'live', capturedAt: 't1', projection: projectionOf({ attention: { count: 1, items: [] } }) };
  assert.equal(store.replace(first, 1), true);
  assert.equal(freshness(store.state), 'LIVE');
  assert.equal(store.replace({ ...first, capturedAt: 't0' }, 0), false, 'a stale generation can never overwrite a newer one');
  assert.equal(store.state.capturedAt, 't1');
  store.connection(CONNECTION.RUNTIME_UNAVAILABLE);
  assert.equal(freshness(store.state), 'STALE');
  assert.equal(store.state.projection.attention.count, 1, 'transport state never rewrites Company truth');
  store.replace({ ...first, capturedAt: 't2' }, 2);
  assert.equal(freshness(store.state), 'LIVE');
  store.setCompany('c2');
  assert.equal(freshness(store.state), 'NONE');
  assert.equal(store.state.projection, null, 'switching company drops the previous projection');
});

test('a late poll from a previous company can never replace the selected company', () => {
  const store = new WorkspaceStore();
  const previous = {
    companyId: 'c1',
    source: 'live',
    capturedAt: 't1',
    projection: projectionOf({ company: { id: 'c1', name: 'One' } }),
  };
  store.replace(previous, 1);
  store.setCompany('c2');

  assert.equal(store.replace({ ...previous, capturedAt: 't2' }, 2), false);
  assert.equal(store.state.companyId, 'c2');
  assert.equal(store.state.projection, null, 'the old company projection stays out of the new canvas');
});
test('detail basis moves only when the facts a detail depends on move', () => {
  const base = projectionOf({
    attention: { count: 1, items: [] },
    pulse: { activeWorks: 2, readyForDecision: 1 },
    workforce: { employees: 3, working: 1, available: 2, disabled: 0, onDuty: [{ employeeId: 'e1', role: 'EXECUTION', condition: null }] },
  });
  assert.equal(detailBasis(base), detailBasis(projectionOf({ ...base })));
  assert.notEqual(detailBasis(base), detailBasis({ ...base, pulse: { activeWorks: 3, readyForDecision: 1 } }));
  assert.notEqual(detailBasis(base), detailBasis({ ...base, attention: { count: 0, items: [] } }));
  assert.equal(detailBasis(null), '');
});
