// Founder Workspace v0C — the product homepage.
//
// This file renders Experience projections; it owns no Runtime truth and has
// no write path: no request that changes Company truth originates in the
// page, the adapter or the static shell. Selection, open panels and zoom are
// presentation state and live in memory only — never in the Runtime, never
// persisted, and a drag (if ever added) would change pixels, never reality.
import {
  CONNECTION,
  NAV_ITEMS,
  PLACEHOLDERS,
  WorkspaceStore,
  acceptedStateText,
  activityText,
  actionText,
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
} from './domain.mjs';
import { HttpWorkspaceAdapter } from './adapter.mjs';

const $ = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
};
const button = (className, action, text) => {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
};
const chip = (text, tone = null) => {
  const element = node('span', 'fc-chip', text);
  if (tone) element.dataset.tone = tone;
  return element;
};
const spriteNumber = (employeeId) =>
  (Array.from(String(employeeId)).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 8) + 1;
const avatar = (employeeId) => {
  const image = node('img', 'fc-avatar');
  image.src = `/employee-assets/assets/portrait-${spriteNumber(employeeId)}.png`;
  image.alt = '';
  image.loading = 'lazy';
  return image;
};
const timeText = (iso) => {
  if (typeof iso !== 'string' || iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};
// Rebuild a section only when its signature changed: the poll replaces the
// read model, never the DOM identity of unchanged content.
const fill = (container, signature, build) => {
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  const built = build();
  container.replaceChildren(...(Array.isArray(built) ? built : [built]));
};
const narrow = () => globalThis.matchMedia?.('(max-width: 1180px)').matches ?? false;

const adapter = new HttpWorkspaceAdapter();
const store = new WorkspaceStore();
// Presentation state, in memory only.
const view = {
  boot: 'CONNECTING',
  companies: [],
  companyId: null,
  nav: 'workspace',
  selection: null,
  detail: null,
  detailError: null,
  attentionOpen: false,
  search: '',
  zoom: 1,
};
let stopPolling = () => {};
let detailEpoch = 0;
let basis = '';

// --- data ------------------------------------------------------------------

async function boot() {
  render();
  try {
    const companies = await adapter.companies();
    view.boot = 'LIVE';
    view.companies = companies;
    if (companies.length === 0) {
      view.companyId = null;
      render();
      return;
    }
    const current = companies.some((company) => company.id === view.companyId)
      ? view.companyId
      : companies[0].id;
    openCompany(current);
  } catch {
    view.boot = 'RUNTIME_UNAVAILABLE';
    render();
    if (!view.companies.length) setTimeout(boot, 3000);
  }
}

function openCompany(companyId) {
  stopPolling();
  view.companyId = companyId;
  view.selection = null;
  view.detail = null;
  view.detailError = null;
  view.attentionOpen = false;
  basis = '';
  store.setCompany(companyId);
  render();
  stopPolling = adapter.subscribe(companyId, store);
}

function select(selection) {
  view.selection = selection;
  view.detail = null;
  view.detailError = null;
  detailEpoch += 1;
  basis = detailBasis(store.state.projection);
  render();
  void loadDetail();
}

function closeInspector() {
  detailEpoch += 1;
  view.selection = null;
  view.detail = null;
  view.detailError = null;
  render();
}

async function loadDetail() {
  const selection = view.selection;
  if (!selection || selection.type === 'DELIVERY') {
    render();
    return;
  }
  const epoch = ++detailEpoch;
  try {
    const detail = selection.type === 'EMPLOYEE'
      ? await adapter.employeeDetail(selection.id)
      : await adapter.lineage(selection.id);
    if (epoch !== detailEpoch) return;
    view.detail = detail;
    view.detailError = null;
  } catch (error) {
    if (epoch !== detailEpoch) return;
    view.detail = null;
    view.detailError = error?.message ?? '未知错误';
  }
  render();
}

// A selected detail is re-read when the projection's basis moved — not on
// every poll. A screen that did not change is not re-fetched.
function maybeRefreshDetail() {
  if (!view.selection) return;
  if (store.state.connection !== CONNECTION.LIVE) return;
  const current = detailBasis(store.state.projection);
  if (current === basis) return;
  basis = current;
  void loadDetail();
}

// --- render ----------------------------------------------------------------

function render() {
  const state = store.state;
  const app = $('app');
  app.dataset.connection = state.connection;
  app.dataset.nav = view.nav;
  $('overlay').hidden = !(narrow() && Boolean(view.selection));
  renderNav();
  renderTopbar(state);
  renderCanvas(state);
  renderInspector(state);
  renderAttention(state);
  renderZoom();
}

function renderNav() {
  const nav = $('nav');
  fill(nav, 'nav', () =>
    NAV_ITEMS.map((item) => {
      const glyph = node('span', 'fc-nav-glyph', item.label.slice(0, 1));
      let element;
      if (item.kind === 'LINK') {
        element = node('a', 'fc-nav-item');
        element.href = item.href;
        element.append(glyph, node('span', undefined, item.label), node('span', 'fc-nav-out', '↗'));
      } else {
        element = button('fc-nav-item', () => {
          view.nav = item.id;
          view.attentionOpen = false;
          render();
        });
        element.append(glyph, node('span', undefined, item.label));
        if (item.kind === 'PLACEHOLDER') element.append(node('span', 'fc-nav-later', '稍后'));
      }
      element.dataset.navId = item.id;
      return element;
    }),
  );
  for (const element of nav.querySelectorAll('[data-nav-id]')) {
    if (element.dataset.navId === view.nav) element.setAttribute('aria-current', 'true');
    else element.removeAttribute('aria-current');
  }
}

function renderTopbar(state) {
  const status = $('runtime-status');
  status.dataset.state = state.connection;
  status.textContent = state.connection === CONNECTION.LIVE
    ? '运行中'
    : state.connection === CONNECTION.RUNTIME_UNAVAILABLE
      ? 'Runtime 暂不可用'
      : '连接中…';
  // Transport wording only: it says the projection is readable and nothing
  // about model providers, the network or infrastructure.
  status.title = '仅表示本机 Runtime 可读；不代表模型、网络或基础设施状态。';

  fill($('company'), view.companies.map((company) => `${company.id}:${company.name}`).join('|'), () => {
    if (view.companies.length === 0) {
      const option = node('option', undefined, '还没有公司');
      option.value = '';
      return [option];
    }
    return view.companies.map((company) => {
      const option = node('option', undefined, company.name);
      option.value = company.id;
      option.selected = company.id === view.companyId;
      return option;
    });
  });

  const newWork = $('new-work');
  newWork.title = 'Work 创建流程将在 Founder Work 定义里程碑接入；v0C 工作台只读。';
  newWork.setAttribute('aria-disabled', 'true');
}

function renderCanvas(state) {
  const container = $('canvas-content');
  fill(
    container,
    JSON.stringify([view.nav, state.connection, view.boot, view.companies.length, view.attentionOpen, state.projection]),
    () => buildCanvas(state),
  );
}

function buildCanvas(state) {
  if (view.nav !== 'workspace') return [placeholderView(view.nav)];
  if (view.boot === 'LIVE' && view.companies.length === 0)
    return [emptyState('F', '还没有公司', 'Company Genesis 将在后续里程碑开放。创建公司后，你的 AI 公司会出现在这里。')];
  const projection = state.projection;
  if (!projection) {
    if (state.connection === CONNECTION.RUNTIME_UNAVAILABLE)
      return [emptyState('◌', '无法读取 Runtime', '请确认本机 Runtime 正在运行。连接恢复后此页会自动刷新，不会显示替代数据。')];
    return [loadingState()];
  }
  const parts = [];
  if (freshness(state) === 'STALE') {
    const banner = node('div', 'fc-banner', `Runtime 暂不可用：画面保留最后已知的投影，尚未刷新。最后读取：${timeText(state.capturedAt) || '未知'}`);
    banner.dataset.state = 'UNAVAILABLE';
    parts.push(banner);
  }
  if (!projection.primaryWork)
    return [...parts, emptyState('◌', '当前没有需要关注的工作', '这里会显示你公司正在推进的工作。现在画布保持安静。')];
  const count = attentionCount(projection);
  if (count > 0) parts.push(needsYouRow(count));
  parts.push(primaryCard(projection));
  const grid = node('div', 'fc-grid');
  grid.append(workforceWidget(projection.workforce), deliveriesWidget(projection));
  parts.push(grid);
  parts.push(pulseWidget(projection.pulse));
  return parts;
}

function loadingState() {
  const wrap = node('div', 'fc-skeleton');
  wrap.append(node('div', 'fc-skeleton-bar'), node('div', 'fc-skeleton-bar'));
  wrap.append(node('p', undefined, '正在连接本地 Runtime…'));
  return wrap;
}

function emptyState(mark, title, message) {
  const wrap = node('div', 'fc-empty-state');
  wrap.append(node('div', 'fc-empty-mark', mark), node('h2', undefined, title), node('p', undefined, message));
  return wrap;
}

function placeholderView(id) {
  const info = PLACEHOLDERS[id] ?? { title: '稍后开放', message: '此区域将在后续里程碑开放。' };
  const wrap = node('div', 'fc-placeholder');
  wrap.append(node('div', 'fc-empty-mark', info.title.slice(0, 1)));
  wrap.append(node('h2', undefined, info.title));
  wrap.append(node('p', undefined, info.message));
  wrap.append(button('fc-link-btn', () => { view.nav = 'workspace'; render(); }, '← 返回工作台'));
  return wrap;
}

function needsYouRow(count) {
  const row = node('div', 'fc-needs-row');
  const bubble = button(
    'fc-needs-you',
    () => {
      view.attentionOpen = !view.attentionOpen;
      render();
    },
    `需要你处理 ${count}`,
  );
  bubble.setAttribute('aria-expanded', String(view.attentionOpen));
  bubble.setAttribute('aria-controls', 'attention-panel');
  row.append(bubble);
  return row;
}

function selectionSourceText(selection) {
  return selection === 'FOUNDER_ATTENTION' ? '因为需要你' : selection === 'ACTIVE' ? '最近推进' : '最近创建';
}

function primaryCard(projection) {
  const lineage = projection.primaryWork.lineage;
  const card = node('section', 'fc-primary');
  const head = node('div', 'fc-primary-head');
  const main = node('div');
  main.append(node('span', 'fc-eyebrow', '主要工作 · PRIMARY WORK'));
  main.append(node('h1', undefined, lineage.work.title ?? '未命名工作'));
  const meta = node('div', 'fc-primary-meta');
  meta.append(chip(
    workStatusText(lineage.work.status),
    lineage.work.status === 'READY_FOR_DECISION' ? 'accent' : null,
  ));
  meta.append(chip(stageText(lineage.work.stage), 'quiet'));
  meta.append(chip(selectionSourceText(projection.primaryWork.selection), 'quiet'));
  main.append(meta);
  if (lineage.work.intent) main.append(node('p', 'fc-primary-intent', lineage.work.intent));
  head.append(main);
  const actions = node('div', 'fc-primary-actions');
  actions.append(
    button('fc-link-btn', () => select({ type: 'WORK', id: lineage.work.workId }), '查看完整工作线 →'),
  );
  head.append(actions);
  card.append(head);
  card.append(lineageFlow(lineage));
  return card;
}

function lineageFlow(lineage) {
  const flow = node('div', 'fc-flow');
  if ((lineage.steps ?? []).length === 0) {
    flow.append(node('div', 'fc-lineage-empty', '这份 Work 还没有任务。'));
    return flow;
  }
  lineage.steps.forEach((step, index) => {
    if (index > 0) flow.append(node('span', 'fc-arrow', '→'));
    flow.append(stepNode(step, lineage.work.workId));
  });
  const boundary = lineage.founderBoundary ?? {};
  if (boundary.waitingForFounder || boundary.decision) {
    flow.append(node('span', 'fc-arrow', '→'), founderNode(boundary));
  }
  return flow;
}

function stepNode(step, workId) {
  const wrap = node('div', 'fc-step');
  wrap.dataset.role = step.role ?? '';
  const who = node('div', 'fc-step-who');
  if (step.employeeId && step.employeeName) {
    const person = button('fc-step-person', () => select({ type: 'EMPLOYEE', id: step.employeeId }));
    person.append(avatar(step.employeeId), node('span', 'fc-step-name', step.employeeName));
    who.append(person);
  } else {
    who.append(node('span', 'fc-step-name fc-step-unassigned', '未指派'));
  }
  who.append(node('span', 'fc-step-meta', `${roleText(step.role)} · ${taskStateText(step.state)}`));
  wrap.append(who);
  if (step.review) {
    wrap.append(chip(
      verdictText(step.review.verdict),
      step.review.verdict === 'PASS' ? 'ok' : 'warm',
    ));
  }
  if (step.repair) wrap.append(node('span', 'fc-step-meta', '返工任务'));
  const artifacts = node('div', 'fc-step-artifacts');
  for (const artifact of step.artifacts ?? []) {
    const artifactButton = button('fc-artifact-chip', () => select({ type: 'DELIVERY', id: artifact.artifactId, workId }));
    artifactButton.append(
      node('span', 'fc-artifact-label', `产物 v${artifact.versionIndex ?? artifact.generation ?? '—'}`),
      node('span', 'fc-artifact-title', artifact.title ?? ''),
    );
    artifacts.append(artifactButton);
  }
  if (artifacts.childElementCount > 0) wrap.append(artifacts);
  return wrap;
}

function founderNode(boundary) {
  const wrap = node('div', 'fc-step fc-step-founder');
  if (boundary.decision) {
    wrap.append(node('span', 'fc-step-name', '你已接受'));
    wrap.append(node('span', 'fc-step-meta', timeText(boundary.decision.decidedAt) || 'Founder 决定'));
    return wrap;
  }
  wrap.append(node('span', 'fc-step-name', '等待你处理'));
  wrap.append(node('span', 'fc-step-meta', attentionKindText(boundary.attentionKind)));
  return wrap;
}

function workforceWidget(workforce) {
  const section = node('section', 'fc-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, 'AI 员工'));
  const link = node('a', 'fc-link-btn', '打开团队大厅 ↗');
  link.href = '/employees';
  head.append(link);
  section.append(head);
  section.append(node('div', 'fc-widget-line', workforceSummaryLine(workforce)));
  const onDuty = workforce?.onDuty ?? [];
  if (onDuty.length === 0) {
    section.append(node('div', 'fc-widget-empty', '此刻没有员工在执行。'));
    return section;
  }
  const row = node('div', 'fc-on-duty');
  for (const card of onDuty) {
    const person = button('fc-duty-card', () => select({ type: 'EMPLOYEE', id: card.employeeId }));
    person.title = [card.displayName, card.position?.title].filter(Boolean).join(' · ');
    person.append(
      avatar(card.employeeId),
      node('span', 'fc-duty-name', card.displayName ?? '员工'),
      node('span', 'fc-duty-role', card.condition ? '需要检查' : roleText(card.role)),
    );
    row.append(person);
  }
  section.append(row);
  return section;
}

function deliveriesWidget(projection) {
  const section = node('section', 'fc-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, '最近交付'));
  section.append(head);
  const deliveries = projection.recentDeliveries ?? [];
  if (deliveries.length === 0) {
    section.append(node('div', 'fc-widget-empty', '还没有交付。'));
    return section;
  }
  const list = node('ul', 'fc-deliveries');
  for (const delivery of deliveries.slice(0, 6)) {
    const item = node('li');
    const row = button('fc-delivery-row', () => select({ type: 'DELIVERY', id: delivery.artifactId, workId: delivery.workId }));
    const main = node('div', 'fc-delivery-main');
    main.append(node('span', 'fc-delivery-title', delivery.title ?? '未命名产物'));
    main.append(node('span', 'fc-delivery-sub', [delivery.workTitle, delivery.producerName].filter(Boolean).join(' · ')));
    row.append(main);
    const chips = node('div', 'fc-delivery-chips');
    if (delivery.reviewState) chips.append(chip(verdictText(delivery.reviewState), delivery.reviewState === 'PASS' ? 'ok' : 'warm'));
    chips.append(chip(acceptedStateText(delivery.acceptedState), delivery.acceptedState === 'ACCEPTED' ? 'accent' : 'quiet'));
    row.append(chips);
    const time = timeText(delivery.createdAt);
    if (time) row.append(node('span', 'fc-time', time));
    item.append(row);
    list.append(item);
  }
  section.append(list);
  return section;
}

function pulseWidget(pulse) {
  const section = node('section', 'fc-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, '公司脉搏'));
  head.append(node('span', 'fc-widget-line', '仅显示 Runtime 事实计数'));
  section.append(head);
  if (!pulse) return section;
  const row = node('div', 'fc-pulse');
  const items = [
    ['进行中的工作', pulse.activeWorks],
    ['等待你的决定', pulse.readyForDecision],
    ['已接受', pulse.acceptedWorks],
    ['评审中', pulse.reviewsActive],
    ['返工中', pulse.repairsActive],
    ['需要你处理', pulse.founderAttentionCount],
    ['工作中', pulse.employeesWorking],
    ['空闲', pulse.employeesAvailable],
  ];
  for (const [label, value] of items) {
    const item = node('span', 'fc-pulse-item');
    item.append(node('b', undefined, value ?? 0), node('span', undefined, label));
    row.append(item);
  }
  section.append(row);
  return section;
}

function renderAttention(state) {
  const panel = $('attention-panel');
  const items = state.projection?.attention?.items ?? [];
  if (!view.attentionOpen || items.length === 0) {
    panel.hidden = true;
    panel.dataset.signature = '';
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  fill(panel, JSON.stringify(items), () => {
    const built = [node('h2', undefined, `需要你处理 · ${items.length}`)];
    for (const item of items) built.push(attentionItem(item));
    built.push(node('p', 'fc-attention-note', '以上为 Runtime 当前提供的 Founder 动作；v0C 工作台只读展示，不会代替你执行。'));
    return built;
  });
}

function attentionItem(item) {
  const article = node('article', 'fc-attention-item');
  article.append(chip(attentionKindText(item.kind), 'accent'));
  article.append(button('fc-attention-work', () => select({ type: 'WORK', id: item.workId }), item.work?.title ?? '未命名工作'));
  article.append(node('p', 'fc-attention-lead', attentionLeadText(item.kind)));
  const conditions = node('div', 'fc-attention-chips');
  for (const condition of item.conditions ?? []) conditions.append(chip(conditionText(condition), 'quiet'));
  if (conditions.childElementCount > 0) article.append(conditions);
  if ((item.actions ?? []).length > 0) {
    const actions = node('div', 'fc-attention-actions');
    actions.append(node('span', undefined, 'Runtime 可提供：'));
    for (const action of item.actions) actions.append(chip(actionText(action.kind)));
    article.append(actions);
  }
  return article;
}

// --- inspector -------------------------------------------------------------

function renderInspector(state) {
  const body = $('inspector-body');
  $('inspector').dataset.open = view.selection ? 'true' : 'false';
  $('inspector-close').hidden = !view.selection;
  fill(
    body,
    JSON.stringify([
      view.selection?.type ?? null,
      view.selection?.id ?? null,
      detailEpoch,
      view.detailError,
      view.detail,
      state.projection?.recentDeliveries ?? null,
    ]),
    () => buildInspector(state),
  );
}

function buildInspector(state) {
  if (!view.selection)
    return [node('p', 'fc-inspector-note', '选择一名员工、一份工作或一次交付，这里会显示 Runtime 投影出的详情。')];
  if (view.detailError) return [node('p', 'fc-inspector-note', `读取失败：${view.detailError}`)];
  if (view.selection.type === 'DELIVERY') return [deliveryDetail(state)];
  if (!view.detail) return [node('p', 'fc-inspector-note', '正在读取…')];
  return [view.selection.type === 'EMPLOYEE' ? employeeDetail(view.detail) : workDetail(view.detail)];
}

function row(label, value) {
  const item = node('li');
  item.append(node('span', 'fc-kv-label', label), value instanceof Node ? value : node('span', 'fc-kv-value', value));
  return item;
}

function deliveryDetail(state) {
  const delivery = state.projection?.recentDeliveries?.find((entry) => entry.artifactId === view.selection.id);
  const wrap = node('div', 'fc-section');
  if (!delivery) {
    wrap.append(node('p', 'fc-inspector-note', '这次交付已不在当前投影窗口中。'));
    return wrap;
  }
  wrap.append(node('h2', undefined, delivery.title ?? '未命名产物'));
  const meta = node('div', 'fc-inspector-meta');
  if (delivery.kind) meta.append(chip(delivery.kind, 'quiet'));
  if (delivery.reviewState) meta.append(chip(verdictText(delivery.reviewState), delivery.reviewState === 'PASS' ? 'ok' : 'warm'));
  meta.append(chip(acceptedStateText(delivery.acceptedState), delivery.acceptedState === 'ACCEPTED' ? 'accent' : 'quiet'));
  wrap.append(meta);
  const list = node('ul', 'fc-inspector-list');
  list.append(row('所属工作', button('fc-link-btn', () => select({ type: 'WORK', id: delivery.workId }), delivery.workTitle ?? '查看工作线')));
  if (delivery.producerName) list.append(row('产出者', delivery.producerName));
  list.append(row('代次', `第 ${delivery.generation ?? '—'} 代`));
  const created = timeText(delivery.createdAt);
  if (created) list.append(row('记录时间', created));
  wrap.append(list);
  wrap.append(node('p', 'fc-inspector-note', '交付内容本身不在产品投影中；这里显示的是它的身份、评审与接受状态。'));
  return wrap;
}

function employeeDetail(detail) {
  const wrap = node('div', 'fc-section');
  wrap.append(node('h2', undefined, detail.displayName ?? '员工'));
  const meta = node('div', 'fc-inspector-meta');
  if (detail.position?.title) meta.append(chip(detail.position.title, 'quiet'));
  const role = detail.availability === 'WORKING' && detail.currentRole ? ` · ${roleText(detail.currentRole)}` : '';
  meta.append(chip(`${availabilityText(detail.availability)}${role}`, detail.availability === 'WORKING' ? 'accent' : null));
  wrap.append(meta);
  if (detail.condition) wrap.append(node('p', 'fc-inspector-warning', '该员工有多个进行中的执行，Runtime 无法确定唯一焦点，需要检查。'));

  const capabilities = node('div', 'fc-section');
  capabilities.append(node('h3', undefined, '能力'));
  if ((detail.capabilities ?? []).length === 0) capabilities.append(node('p', 'fc-inspector-note', '未记录能力。'));
  else {
    const rowOfChips = node('div', 'fc-kv');
    for (const capability of detail.capabilities) rowOfChips.append(chip(capability, 'quiet'));
    capabilities.append(rowOfChips);
  }
  wrap.append(capabilities);

  const current = node('div', 'fc-section');
  current.append(node('h3', undefined, '当前工作'));
  if (detail.currentWork) {
    const line = node('div', 'fc-kv');
    line.append(button('fc-link-btn', () => select({ type: 'WORK', id: detail.currentWork.workId }), detail.currentWork.title ?? '未命名工作'));
    line.append(chip(roleText(detail.currentWork.role)));
    current.append(line);
    current.append(node('p', 'fc-inspector-note', `第 ${detail.currentWork.attempt ?? 1} 次尝试 · 自动尝试上限 ${detail.currentWork.maxAutonomousAttempts ?? '—'} 次`));
  } else {
    current.append(node('p', 'fc-inspector-note', '当前没有进行中的工作。'));
  }
  wrap.append(current);

  const execution = node('div', 'fc-section');
  execution.append(node('h3', undefined, '执行后端'));
  execution.append(node('p', 'fc-inspector-note', detail.execution
    ? [detail.execution.backendType, detail.execution.backendVersion].filter(Boolean).join(' · ')
    : '当前没有进行中的执行。'));
  wrap.append(execution);

  const deliveries = node('div', 'fc-section');
  deliveries.append(node('h3', undefined, '最近交付'));
  if ((detail.recentDeliveries ?? []).length === 0) deliveries.append(node('p', 'fc-inspector-note', '还没有交付。'));
  else {
    const list = node('ul', 'fc-inspector-list');
    for (const delivery of detail.recentDeliveries.slice(0, 5)) {
      const item = node('li');
      const value = node('div', 'fc-delivery-main');
      value.append(node('span', 'fc-delivery-title', delivery.title ?? '未命名产物'));
      value.append(node('span', 'fc-delivery-sub', [delivery.workTitle, delivery.reviewState ? verdictText(delivery.reviewState) : '尚无评审'].join(' · ')));
      item.append(value);
      const time = timeText(delivery.createdAt);
      if (time) item.append(node('span', 'fc-time', time));
      list.append(item);
    }
    deliveries.append(list);
  }
  wrap.append(deliveries);

  const activity = node('div', 'fc-section');
  activity.append(node('h3', undefined, '最近动态'));
  if ((detail.recentActivity ?? []).length === 0) activity.append(node('p', 'fc-inspector-note', '没有可显示的公开动态。'));
  else {
    const list = node('ul', 'fc-inspector-list');
    for (const record of detail.recentActivity.slice(0, 8)) {
      const item = node('li');
      item.append(node('span', 'fc-kv-value', activityText(record)));
      const time = timeText(record.createdAt);
      if (time) item.append(node('span', 'fc-time', time));
      list.append(item);
    }
    activity.append(list);
  }
  wrap.append(activity);
  return wrap;
}

function workDetail(lineage) {
  const wrap = node('div', 'fc-section');
  wrap.append(node('h2', undefined, lineage.work.title ?? '未命名工作'));
  const meta = node('div', 'fc-inspector-meta');
  meta.append(chip(workStatusText(lineage.work.status), lineage.work.status === 'READY_FOR_DECISION' ? 'accent' : null));
  meta.append(chip(stageText(lineage.work.stage), 'quiet'));
  meta.append(chip(outcomeText(lineage.outcome?.state), lineage.outcome?.state === 'ACCEPTED' ? 'ok' : 'quiet'));
  wrap.append(meta);
  if (lineage.work.intent) wrap.append(node('p', 'fc-inspector-note', lineage.work.intent));

  const boundary = lineage.founderBoundary ?? {};
  const block = node('div', 'fc-founder-block');
  if (boundary.decision) {
    block.dataset.state = 'accepted';
    block.append(node('strong', undefined, '你已接受这份交付'));
    block.append(node('span', undefined, `决定时间：${timeText(boundary.decision.decidedAt) || '已记录'}`));
  } else if (boundary.waitingForFounder) {
    block.append(node('strong', undefined, '等待你处理'));
    block.append(node('span', undefined, attentionKindText(boundary.attentionKind)));
  } else {
    block.append(node('strong', undefined, 'Runtime 暂无需要你处理的事项'));
    block.append(node('span', undefined, '这份工作由 Runtime 继续推进。'));
  }
  wrap.append(block);

  const steps = node('div', 'fc-section');
  steps.append(node('h3', undefined, `工作线 · ${(lineage.steps ?? []).length} 步`));
  if ((lineage.steps ?? []).length === 0) steps.append(node('p', 'fc-inspector-note', '这份 Work 还没有任务。'));
  else {
    const list = node('ul', 'fc-steps');
    for (const step of lineage.steps) list.append(workStepRow(step, lineage.work.workId));
    steps.append(list);
  }
  wrap.append(steps);
  return wrap;
}

function workStepRow(step, workId) {
  const item = node('li', 'fc-step-row');
  const head = node('div', 'fc-step-row-head');
  head.append(chip(roleText(step.role)));
  head.append(node('strong', undefined, step.employeeName ?? '未指派'));
  head.append(node('span', 'fc-step-row-meta', `${taskStateText(step.state)} · 第 ${step.attempt ?? 0} 次尝试`));
  if (step.workerRunState) head.append(node('span', 'fc-step-row-meta', `最新执行：${workerRunStateText(step.workerRunState)}`));
  item.append(head);
  if (step.title) item.append(node('span', 'fc-step-row-meta', step.title));
  if (step.review) {
    item.append(chip(verdictText(step.review.verdict), step.review.verdict === 'PASS' ? 'ok' : 'warm'));
    if (step.review.summary) item.append(node('span', 'fc-step-row-meta', step.review.summary));
    if (step.review.findingsCount) item.append(node('span', 'fc-step-row-meta', `评审意见 ${step.review.findingsCount} 条`));
  }
  if (step.repair) item.append(node('span', 'fc-step-row-meta', '这是一次返工。'));
  for (const artifact of step.artifacts ?? []) {
    const artifactButton = button('fc-artifact-chip', () => select({ type: 'DELIVERY', id: artifact.artifactId, workId }));
    artifactButton.append(
      node('span', 'fc-artifact-label', `产物 v${artifact.versionIndex ?? artifact.generation ?? '—'}`),
      node('span', 'fc-artifact-title', artifact.title ?? ''),
    );
    item.append(artifactButton);
  }
  return item;
}

// --- search (local, over already loaded Experience data only) ---------------

function searchItems(projection) {
  const items = [];
  for (const card of projection?.workforce?.onDuty ?? [])
    items.push({ selection: { type: 'EMPLOYEE', id: card.employeeId }, label: card.displayName ?? '', meta: card.position?.title ?? '', group: '员工' });
  const lineage = projection?.primaryWork?.lineage;
  if (lineage)
    items.push({ selection: { type: 'WORK', id: lineage.work.workId }, label: lineage.work.title ?? '', meta: '主要工作', group: '工作' });
  for (const delivery of projection?.recentDeliveries ?? [])
    items.push({ selection: { type: 'DELIVERY', id: delivery.artifactId, workId: delivery.workId }, label: delivery.title ?? '', meta: delivery.workTitle ?? '', group: '交付' });
  return items;
}

function renderSearchResults() {
  const box = $('search-results');
  const query = view.search.toLowerCase();
  if (!query) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const matches = searchItems(store.state.projection)
    .filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query))
    .slice(0, 8);
  box.hidden = false;
  if (matches.length === 0) {
    box.replaceChildren(node('div', 'fc-search-empty', '没有匹配的已加载内容。'));
    return;
  }
  box.replaceChildren(...matches.map((match) => {
    const result = button('fc-search-item', () => {
      closeSearch();
      select(match.selection);
    });
    result.append(node('strong', undefined, match.label || '未命名'), node('small', undefined, `${match.group}${match.meta ? ' · ' + match.meta : ''}`));
    return result;
  }));
}

function closeSearch() {
  const box = $('search-results');
  box.hidden = true;
  box.replaceChildren();
  view.search = '';
  $('search').value = '';
}

// --- zoom (presentation only) ----------------------------------------------

const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25];

function renderZoom() {
  $('zoom-label').textContent = `${Math.round(view.zoom * 100)}%`;
  $('world').style.transform = `scale(${view.zoom})`;
}

// --- wiring ----------------------------------------------------------------

function wireOnce() {
  $('company').addEventListener('change', (event) => {
    if (event.target.value) openCompany(event.target.value);
  });
  $('inspector-close').addEventListener('click', closeInspector);
  $('overlay').addEventListener('click', closeInspector);
  $('search').addEventListener('input', (event) => {
    view.search = event.target.value.trim();
    renderSearchResults();
  });
  $('search').addEventListener('focus', renderSearchResults);
  $('controls').addEventListener('click', (event) => {
    const action = event.target.closest('[data-zoom]')?.dataset.zoom;
    if (!action) return;
    if (action === 'in') view.zoom = ZOOM_STEPS.find((step) => step > view.zoom) ?? ZOOM_STEPS.at(-1);
    else if (action === 'out') view.zoom = [...ZOOM_STEPS].reverse().find((step) => step < view.zoom) ?? ZOOM_STEPS[0];
    else {
      view.zoom = 1;
      $('canvas').scrollTop = 0;
    }
    renderZoom();
  });
  document.addEventListener('click', (event) => {
    if (view.attentionOpen && !event.target.closest('#attention-panel') && !event.target.closest('.fc-needs-you')) {
      view.attentionOpen = false;
      render();
    }
    if (!$('search-results').hidden && !event.target.closest('.fc-search')) closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('search-results').hidden) closeSearch();
    else if (view.attentionOpen) {
      view.attentionOpen = false;
      render();
    } else if (view.selection) closeInspector();
  });
  store.subscribe(() => {
    maybeRefreshDetail();
    render();
  });
}

wireOnce();
void boot();
