// Presentation state for the Founder Workspace.
//
// This module is the screen's own model and nothing else. It renames frozen
// Experience fields for the product surface and keeps transport state
// (`connection`) strictly apart from Company truth: an unreachable Runtime
// never changes what the last projection said an Employee was doing.
//
// Two rules hold everywhere here:
//   1. unknown Runtime values fail closed to a neutral phrase — a raw Runtime
//      identifier is never rendered as product language;
//   2. there is no command, no write and no second lifecycle in this file.
//      The Workspace reads; Founder authority stays at the Runtime seam.

export const CONNECTION = Object.freeze({
  CONNECTING: 'CONNECTING',
  LIVE: 'LIVE',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
});

// What the screen can show in the central canvas. `workspace` is the real
// product; the others are honest placeholders until their milestone lands.
export const NAV_ITEMS = Object.freeze([
  { id: 'workspace', label: '公司', kind: 'VIEW' },
  { id: 'work', label: '工作', kind: 'PLACEHOLDER' },
  { id: 'employees', label: 'AI 员工', kind: 'LINK', href: '/employees' },
  { id: 'hiring', label: '招聘', kind: 'PLACEHOLDER' },
  { id: 'artifacts', label: '成果', kind: 'PLACEHOLDER' },
  { id: 'knowledge', label: '知识', kind: 'PLACEHOLDER' },
  { id: 'settings', label: '设置', kind: 'PLACEHOLDER' },
]);

export const PLACEHOLDERS = Object.freeze({
  work: {
    title: '工作',
    message: '工作列表将在后续里程碑开放。Runtime 里的每一份 Work 都会在这里展开。',
  },
  hiring: { title: '招聘', message: '招聘能力将在 Hiring MVP 中开放。' },
  artifacts: {
    title: '成果',
    message: '成果库将在 Artifact 视图接入 Experience 投影后开放。',
  },
  knowledge: { title: '知识', message: '知识空间将在 Knowledge layer 接入后开放。' },
  settings: { title: '设置', message: '设置将在后续里程碑开放。' },
});

// --- frozen vocabulary, rendered -------------------------------------------
//
// Values come from the Runtime and the Experience projection; the Chinese
// labels are product language. Unknown values never fall through to the raw
// identifier — they fail closed to the neutral fallback given per lookup.

export const availabilityNames = Object.freeze({
  AVAILABLE: '空闲',
  WORKING: '工作中',
  DISABLED: '已停用',
});

export const roleNames = Object.freeze({
  EXECUTION: '执行中',
  REVIEW: '审核中',
  REPAIR: '返工中',
});

export const workStatusNames = Object.freeze({
  OPEN: '已创建',
  ACTIVE: '进行中',
  NEEDS_ATTENTION: '需要处理',
  READY_FOR_DECISION: '等待你的决定',
  BLOCKED: '已阻塞',
  CANCELLED: '已取消',
});

export const stageNames = Object.freeze({
  NOT_STARTED: '尚未开始',
  EXECUTING: '执行中',
  AWAITING_REVIEW: '等待审核',
  REVIEWING: '审核中',
  REVISION_REQUESTED: '已请求修订',
  REPAIRING: '返工中',
  INTERRUPTED: '已中断',
  READY_FOR_DECISION: '等待你的决定',
  BLOCKED: '已阻塞',
  CANCELLED: '已取消',
});

export const taskStateNames = Object.freeze({
  OPEN: '待开始',
  RUNNING: '进行中',
  INTERRUPTED: '已中断',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
});

export const workerRunStateNames = Object.freeze({
  RUNNING: '进行中',
  COMPLETED: '已完成',
  INTERRUPTED: '已中断',
  CANCELLED: '已取消',
});

export const verdictNames = Object.freeze({
  PASS: '评审通过',
  REQUEST_REVISION: '已要求修订',
});

export const acceptedStateNames = Object.freeze({
  ACCEPTED: '你已接受',
  NOT_ACCEPTED: '尚未接受',
});

export const outcomeNames = Object.freeze({
  NO_CANDIDATE: '暂无候选交付',
  READY: '有交付等待你的决定',
  AMBIGUOUS: '交付不唯一，需要处理',
  ACCEPTED: '已接受',
});

export const attentionKindNames = Object.freeze({
  EXECUTION_INTERRUPTED: '执行中断',
  REPAIR_UNASSIGNABLE: '返工无人可派',
  DECISION_REQUIRED: '等待你的决定',
});

export const attentionLead = Object.freeze({
  EXECUTION_INTERRUPTED: '执行中断，Runtime 无法自行继续。',
  REPAIR_UNASSIGNABLE: '有返工任务目前无人可派。',
  DECISION_REQUIRED: '一份交付已就绪，等待你的决定。',
});

export const conditionNames = Object.freeze({
  EXECUTION_INTERRUPTED: '执行中断',
  REPAIR_UNASSIGNABLE: '返工无人可派',
  DECISION_REQUIRED: '等待你的决定',
  COLLABORATION_BLOCKED: '协作被阻塞',
  CAPABILITY_GAP: '能力缺口',
  NO_DISPATCHABLE_EMPLOYEE: '暂无可自动开工的员工',
  OUTCOME_AMBIGUOUS: '交付不唯一',
  NO_CANDIDATE: '没有候选交付',
  AUTO_RETRY_EXHAUSTED: '自动重试已用尽',
});

export const actionNames = Object.freeze({
  ACCEPT: '接受交付',
  RESUME_EXECUTION: '恢复执行',
  ASSIGN_EMPLOYEE: '指派员工',
  ENABLE_EMPLOYEE: '启用员工',
  ABANDON_TASK: '放弃任务',
});

// Domain-level Activity kinds, rendered as product language. Kept in sync with
// the Employee Lobby's map — both freeze the same Runtime kinds — and unknown
// kinds fail closed to a neutral phrase, never the raw identifier.
export const activityNames = Object.freeze({
  WORKER_RUN_STARTED: '执行已开始',
  WORKER_RUN_COMPLETED: '执行已完成',
  WORKER_RUN_INTERRUPTED: '执行已中断',
  WORKER_RUN_CANCELLED: '执行已取消',
  WORKER_RUN_FAILED: '执行未产生结果',
  TASK_ASSIGNED: '任务已指派',
  TASK_REQUIREMENTS_SET: '任务要求已更新',
  TASK_CANCELLED: '任务已取消',
  'task.created': '任务已创建',
  'task.completed': '任务已完成',
  'work.created': '工作已创建',
  'company.created': '公司已创建',
  'artifact.recorded': '产物已记录',
  'checkpoint.written': '检查点已写入',
  REVIEW_REQUESTED: '已请求评审',
  REVIEW_SUBMITTED: '评审已提交',
  REVIEW_PASSED: '评审通过（不等于 Founder 接受）',
  REPAIR_TASK_CREATED: '返工任务已创建',
  WORK_ACCEPTED: 'Founder 已接受',
  EMPLOYEE_CREATED: '员工已创建',
  EMPLOYEE_UPDATED: '员工状态已更新',
  POSITION_CREATED: '岗位已创建',
  WORKER_RESULT_SUBMITTED: '已交付产物',
  WORKER_REVIEW_RESULT_SUBMITTED: '已提交评审结论',
  WORKER_EXECUTION_BOUND: '已绑定执行后端',
  ARTIFACT_HANDED_OFF: '产物已交接',
  ARTIFACT_SUPERSEDED: '产物已被替代',
  REVISION_REQUESTED: '已请求修订',
  'task.execution_started': '执行已开始',
  'task.interrupted': '任务已中断',
  'task.cancelled': '任务已取消',
});

const lookup = (map, value, fallback) =>
  (typeof value === 'string' && map[value]) || fallback;

export const availabilityText = (availability) =>
  lookup(availabilityNames, availability, '状态未知');

export const roleText = (role) => lookup(roleNames, role, '任务');

export const workStatusText = (status) => lookup(workStatusNames, status, '状态未知');

export const stageText = (stage) => lookup(stageNames, stage, '状态未知');

export const taskStateText = (state) => lookup(taskStateNames, state, '状态未知');

export const workerRunStateText = (state) =>
  lookup(workerRunStateNames, state, '状态未知');

export const verdictText = (verdict) => lookup(verdictNames, verdict, '评审结论未知');

export const acceptedStateText = (state) =>
  lookup(acceptedStateNames, state, '尚未接受');

export const outcomeText = (state) => lookup(outcomeNames, state, '结果状态未知');

export const attentionKindText = (kind) =>
  lookup(attentionKindNames, kind, '需要你处理');

export const attentionLeadText = (kind) =>
  lookup(attentionLead, kind, '有工作需要你处理。');

export const conditionText = (condition) =>
  lookup(conditionNames, condition, '需要检查');

export const actionText = (kind) => lookup(actionNames, kind, '由 Runtime 处理');

export const activityText = (record) =>
  (typeof record?.summary === 'string' && record.summary) ||
  lookup(activityNames, record?.kind, '工作已更新');

// --- derived presentation strings ------------------------------------------

// The AI Workforce widget's one-line summary, straight from projection counts.
export function workforceSummaryLine(summary) {
  if (!summary) return '暂无员工数据';
  const parts = [
    `${summary.employees} 位员工`,
    `${summary.working} 工作中`,
    `${summary.available} 空闲`,
  ];
  if (summary.disabled > 0) parts.push(`${summary.disabled} 已停用`);
  return parts.join(' · ');
}

export const attentionCount = (projection) => projection?.attention?.count ?? 0;

// A stable signature of the facts that change what a selected detail shows.
// The client refetches a selected Employee/Work when this changes, and not on
// every poll: a projection that did not move is not re-read.
export function detailBasis(projection) {
  if (!projection) return '';
  return JSON.stringify([
    attentionCount(projection),
    projection.primaryWork?.lineage?.work?.workId ?? null,
    projection.primaryWork?.lineage?.steps?.length ?? null,
    (projection.workforce?.onDuty ?? []).map((card) => [
      card.employeeId,
      card.role,
      card.condition,
    ]),
    (projection.recentDeliveries ?? []).map((delivery) => [
      delivery.artifactId,
      delivery.reviewState,
      delivery.acceptedState,
    ]),
    projection.pulse ?? null,
  ]);
}

// Transport freshness of what is on screen. LIVE means the last read answered;
// STALE means the Runtime became unreadable and the visible projection is the
// last known one; NONE means nothing was ever read.
export function freshness(state) {
  if (state.connection === CONNECTION.LIVE) return 'LIVE';
  return state.projection ? 'STALE' : 'NONE';
}

// The one place the browser read model is replaced after a poll. A new
// projection replaces the previous one whole: the Workspace never patches
// Runtime truth event by event, and a stale response can never overwrite a
// newer one.
export class WorkspaceStore {
  constructor() {
    this.state = {
      companyId: null,
      source: 'live',
      capturedAt: null,
      projection: null,
      connection: CONNECTION.CONNECTING,
    };
    this.listeners = new Set();
    this.generation = -1;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener(this.state);
  }

  connection(value) {
    this.state = { ...this.state, connection: value };
    this.emit();
  }

  // Switching Company is presentation state; the projection is dropped so the
  // canvas can never mix two companies' truth.
  setCompany(companyId) {
    this.state = {
      companyId,
      source: 'live',
      capturedAt: null,
      projection: null,
      connection: CONNECTION.CONNECTING,
    };
    this.emit();
  }

  replace(readModel, generation = this.generation + 1) {
    if (this.state.companyId !== null && readModel.companyId !== this.state.companyId) return false;
    if (generation <= this.generation) return false;
    this.generation = generation;
    this.state = { ...readModel, connection: CONNECTION.LIVE };
    this.emit();
    return true;
  }
}
