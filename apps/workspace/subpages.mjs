// Founder subpages compose read-only product views from Runtime/Experience
// projections. All prototype examples stay inside explicitly marked pages.
import { acceptedStateText, stageText, taskStateText, verdictText, workStatusText, workIntentText } from './domain.mjs';
import { symbol } from './icons.mjs';
import { renderCompanyMemory } from './company-memory.mjs';
import { renderCompanyHiring } from './company-hiring.mjs';

export const SUBPAGES = Object.freeze({
  work: { title: '工作', eyebrow: 'WORK', subtitle: '公司正在推进的每一份工作。', tabs: [['active', '进行中'], ['needs', '需要你'], ['completed', '已完成'], ['all', '全部']], source: 'LIVE' },
  artifacts: { title: '交付物', eyebrow: 'DELIVERABLES', subtitle: '公司最近产出的成果。', tabs: [['needs', '待决定'], ['reviewed', '已评审'], ['accepted', '已接受'], ['all', '全部']], source: 'LIVE' },
  hiring: { title: '招聘', eyebrow: 'HIRING', subtitle: '组建公司下一阶段需要的团队。', tabs: [['home', '首页']], source: 'READ_ONLY' },
  knowledge: { title: '公司记忆', eyebrow: 'COMPANY MEMORY', subtitle: '公司知道什么，以及为什么。', tabs: [['memory', '记忆'], ['candidates', '待确认'], ['sources', '来源']], source: 'READ_ONLY' },
  settings: { title: '设置', eyebrow: 'SETTINGS', subtitle: '工作空间与运行环境。', tabs: [['general', '通用'], ['runtime', 'Runtime'], ['execution', '执行'], ['permissions', '权限'], ['appearance', '外观'], ['advanced', '高级']], source: 'LIVE' },
});

export function filterWork(works, tab) {
  if (tab === 'all') return works;
  if (tab === 'needs') return works.filter((item) => item.lineage?.founderBoundary?.waitingForFounder && !item.lineage?.founderBoundary?.decision);
  if (tab === 'completed') return works.filter((item) => item.lineage?.outcome?.state === 'ACCEPTED' || item.lineage?.work?.status === 'CANCELLED');
  return works.filter((item) => item.lineage && item.lineage.outcome?.state !== 'ACCEPTED' && item.lineage.work?.status !== 'CANCELLED');
}

export function filterDeliveries(deliveries, tab, attention = []) {
  if (tab === 'all') return deliveries;
  if (tab === 'accepted') return deliveries.filter((item) => item.acceptedState === 'ACCEPTED');
  if (tab === 'reviewed') return deliveries.filter((item) => Boolean(item.reviewState));
  const pending = new Set(attention.filter((item) => item.kind === 'DECISION_REQUIRED').map((item) => item.workId));
  return deliveries.filter((item) => pending.has(item.workId) && item.decisionCandidate === true && item.acceptedState !== 'ACCEPTED');
}

const el = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
};
const btn = (label, action, className = 'fc-sub-link') => {
  const item = el('button', className, label);
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
};
const badge = (label, tone = '') => {
  const item = el('span', 'fc-sub-badge', label);
  if (tone) item.dataset.tone = tone;
  return item;
};
const para = (text, className = 'fc-sub-muted') => el('p', className, text);
const fmt = (iso) => {
  if (!iso) return '暂无时间';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '暂无时间' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const deliveryKind = (kind) => ({ document: '文档', code: '代码', report: '报告', dataset: '数据', design: '设计' })[kind] ?? '交付';
const originLineage = (delivery, works, projection) => {
  const candidates = [projection?.primaryWork?.lineage, ...works.map((item) => item.lineage)].filter(Boolean);
  return candidates.find((lineage) => lineage.steps?.some((step) => step.artifacts?.some((artifact) => artifact.artifactId === delivery.artifactId))) ?? null;
};
const section = (title, ...content) => {
  const item = el('section', 'fc-sub-inspect-section');
  item.append(el('h4', null, title), ...content);
  return item;
};
const value = (label, text) => {
  const item = el('div', 'fc-sub-value');
  item.append(el('span', null, label), el('strong', null, text || '暂无记录'));
  return item;
};
const empty = (title, copy) => {
  const item = el('div', 'fc-sub-empty');
  item.append(el('span', 'fc-sub-empty-symbol', '◌'), el('h3', null, title), para(copy));
  return item;
};
export function renderSubpage(target, state) {
  if (state.id === 'knowledge') { renderCompanyMemory(target, state); return; }
  if (state.id === 'hiring') { renderCompanyHiring(target, state); return; }
  const meta = SUBPAGES[state.id];
  if (!meta) return;
  const root = el('div', 'fc-subpage');
  root.dataset.page = state.id;
  root.dataset.source = meta.source;
  const hero = el('header', 'fc-sub-hero');
  const heroIcon = el('span', 'fc-sub-hero-icon');
  heroIcon.append(symbol(state.id));
  const heading = el('div');
  heading.append(el('span', 'fc-sub-eyebrow', meta.eyebrow), el('h3', null, meta.title), para(meta.subtitle));
  hero.append(heroIcon, heading, badge(meta.source === 'PROTOTYPE' ? '原型 · 非实时数据' : state.id === 'settings' ? '本机设置 · 只读' : state.connection === 'LIVE' ? 'LIVE · 实时投影' : '上次读取 · 连接中断', meta.source === 'PROTOTYPE' ? 'prototype' : state.connection === 'LIVE' ? 'live' : 'stale'));
  root.append(hero);
  if (meta.source === 'LIVE' && state.connection !== 'LIVE') root.append(para(state.projection ? 'Runtime 暂不可用；以下为最后一次读取的内容，状态可能已变化。' : 'Runtime 尚未连接。连接恢复后会显示真实记录。', 'fc-sub-notice'));
  if (meta.source === 'PROTOTYPE') root.append(para(
    '此页仅展示产品方向。示例、流程和确认均不会写入 Runtime。',
    'fc-sub-prototype-note',
  ));
  const tabs = el('div', 'fc-sub-tabs');
  const indicator = el('span', 'fc-sub-selection');
  indicator.setAttribute('aria-hidden', 'true');
  tabs.append(indicator);
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', `${meta.title}分类`);
  for (const [id, label] of meta.tabs) {
    const tab = btn(label, () => state.onTab(id), 'fc-sub-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(state.tab === id));
    tab.tabIndex = state.tab === id ? 0 : -1;
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const current = meta.tabs.findIndex(([key]) => key === id);
      const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + meta.tabs.length) % meta.tabs.length;
      state.onTab(meta.tabs[next][0]);
    });
    tabs.append(tab);
  }
  root.append(tabs);
  const body = el('div', 'fc-sub-body');
  if (state.id === 'work') renderWork(body, state);
  else if (state.id === 'artifacts') renderDeliverables(body, state);
  else renderSettings(body, state);
  root.append(body);
  target.replaceChildren(root);
}

function renderWork(body, state) {
  const toolbar = el('div', 'fc-sub-toolbar');
  toolbar.append(para('全部工作来自 Runtime；状态和工作线来自 Experience。'));
  const create = btn('新建工作', state.onCompose, 'fc-sub-action');
  create.prepend(symbol('plus'));
  toolbar.append(create);
  body.append(toolbar);
  if (state.composerOpen) {
    const composer = el('section', 'fc-sub-composer');
    const head = el('div', 'fc-sub-composer-head');
    head.append(el('h4', null, '想让公司做什么？'), btn('关闭', state.onComposerClose));
    const intent = el('textarea');
    intent.placeholder = '描述目标和期望结果…';
    intent.setAttribute('aria-label', '工作意图');
    intent.value = state.composerIntent ?? '';
    intent.addEventListener('input', () => state.onDraft('intent', intent.value));
    const title = el('input');
    title.placeholder = '可选：为工作起一个标题';
    title.setAttribute('aria-label', '工作标题，可选');
    title.value = state.composerTitle ?? '';
    title.addEventListener('input', () => state.onDraft('title', title.value));
    const start = btn('开始工作', () => {}, 'fc-sub-action');
    start.disabled = true;
    start.title = '产品创建命令尚未接入；不会创建本地假工作。';
    composer.append(head, intent, title, para('当前界面尚未接入安全的产品创建命令，暂不能提交。'), start);
    body.append(composer);
  }
  if (state.loading && !state.works.length) { body.append(empty('正在读取工作', '从 Runtime 读取工作清单与工作线。')); return; }
  if (state.error && !state.works.length) { body.append(empty('工作清单暂不可用', state.error)); return; }
  if (state.error) body.append(para(state.error, 'fc-sub-notice'));
  const list = filterWork(state.works, state.tab);
  if (!list.length) {
    const copy = state.tab === 'needs' ? '当前没有等待创始人处理的工作。' : state.tab === 'completed' ? '目前没有已接受或已取消的工作。' : state.tab === 'active' ? '目前没有进行中的工作。' : '公司还没有工作。';
    body.append(empty('这里暂时为空', copy));
    return;
  }
  const split = el('div', 'fc-sub-split');
  const items = el('div', 'fc-sub-list');
  const selected = list.find((item) => item.work.id === state.selectedId) ?? null;
  for (const item of list) {
    const lineage = item.lineage;
    const record = btn('', () => state.onSelect(item.work.id), 'fc-sub-row');
    record.dataset.selected = String(item.work.id === selected?.work.id);
    record.dataset.recordId = item.work.id;
    const headline = el('span', 'fc-sub-row-head');
    headline.append(el('strong', null, item.work.title || '未命名工作'), badge(lineage ? workStatusText(lineage.work.status) : '状态暂不可读', lineage?.founderBoundary?.waitingForFounder ? 'attention' : ''));
    record.append(headline);
    if (item.work.intent) record.append(el('span', 'fc-sub-row-intent', workIntentText(item.work.intent)));
    const active = [...(lineage?.steps ?? [])].reverse().find((step) => step.state !== 'COMPLETED' && step.state !== 'CANCELLED');
    const latest = [...(lineage?.steps ?? [])].at(-1);
    record.append(el('span', 'fc-sub-row-meta', [lineage ? stageText(lineage.work.stage) : '工作线读取失败', active?.employeeName || latest?.employeeName, latest ? `${latest.title || '任务'} · ${taskStateText(latest.state)}` : '尚无任务'].filter(Boolean).join(' · ')));
    items.append(record);
  }
  split.append(items);
  if (selected) split.append(workInspector(selected, state));
  body.append(split);
}

function workInspector(item, state) {
  const detail = el('aside', 'fc-sub-inspector');
  detail.setAttribute('aria-label', '工作详情');
  detail.append(btn('← 返回列表', () => state.onSelect(null), 'fc-sub-back'));
  const lineage = item.lineage;
  detail.append(el('span', 'fc-sub-eyebrow', 'WORK INSPECTOR'), el('h3', null, item.work.title || '未命名工作'));
  if (!lineage) { detail.append(para('工作线暂不可读。请稍后重试。')); return detail; }
  detail.append(section('意图', para(workIntentText(lineage.work.intent) || '未记录意图。')));
  detail.append(section('当前进度', value('阶段', stageText(lineage.work.stage)), value('状态', workStatusText(lineage.work.status))));
  const steps = lineage.steps ?? [];
  const active = [...steps].reverse().find((step) => step.state !== 'COMPLETED' && step.state !== 'CANCELLED');
  detail.append(section('当前任务', para(active ? `${active.title || '任务'} · ${taskStateText(active.state)}` : '当前没有进行中的任务。')));
  const team = [...new Set(steps.map((step) => step.employeeName).filter(Boolean))];
  detail.append(section('工作团队', para(team.length ? team.join('、') : '尚未指派员工。')));
  const produced = steps.flatMap((step) => step.artifacts ?? []);
  const deliveries = section('交付物', para(produced.length ? `${produced.length} 份产物已记录。` : '尚无交付。'));
  for (const artifact of produced) deliveries.append(btn(artifact.title || '未命名产物', () => state.onNavigate('artifacts', 'all', artifact.artifactId)));
  detail.append(deliveries);
  const review = [...steps].reverse().find((step) => step.review?.verdict)?.review;
  detail.append(section('评审', para(review ? `${verdictText(review.verdict)}${review.summary ? ` · ${review.summary}` : ''}` : '尚无评审结论。')));
  detail.append(decisionPanel(lineage.founderBoundary, state.connection));
  const history = section('工作线与动态');
  if (!steps.length) history.append(para('这份工作还没有任务。'));
  for (const step of steps) history.append(value(step.title || '任务', `${step.employeeName || '未指派'} · ${taskStateText(step.state)}`));
  detail.append(history);
  return detail;
}

function decisionPanel(boundary, connection) {
  const panel = section('创始人决定');
  if (boundary?.decision) { panel.append(para(`已接受 · ${fmt(boundary.decision.decidedAt)}`)); return panel; }
  if (!boundary?.waitingForFounder) { panel.append(para('当前无需你的决定。')); return panel; }
  panel.append(badge('等待你处理', 'attention'), para('Runtime 已提出待处理事项。当前界面尚未接入产品决策命令。'));
  const actions = el('div', 'fc-sub-decision-actions');
  for (const label of ['请求修订', '接受交付']) {
    const action = btn(label, () => {}, 'fc-sub-action');
    action.disabled = true;
    action.title = connection === 'LIVE' ? '产品决策命令尚未接入。' : 'Runtime 连接中断。';
    actions.append(action);
  }
  panel.append(actions);
  return panel;
}

function renderDeliverables(body, state) {
  body.append(para('显示当前 Experience 投影中的最近交付窗口；“全部”仅指这个窗口。', 'fc-sub-scope'));
  const deliveries = (state.projection?.recentDeliveries ?? []).map((item) => {
    const lineage = originLineage(item, state.works, state.projection);
    return { ...item, workId: item.workId ?? lineage?.work?.workId ?? null, decisionCandidate: lineage?.outcome?.candidateArtifactIds?.includes(item.artifactId) === true };
  });
  if (state.loading && state.tab === 'needs') body.append(para('正在读取工作线，以匹配需要你决定的交付。'));
  if (state.error) body.append(para(`部分来源工作线暂不可读：${state.error}`, 'fc-sub-notice'));
  const list = filterDeliveries(deliveries, state.tab, state.projection?.attention?.items ?? []);
  if (!list.length) {
    body.append(empty(state.loading && state.tab === 'needs' ? '正在核对待决定交付' : '这里暂时为空', state.loading && state.tab === 'needs' ? '读取工作线后会显示核对结果。' : state.tab === 'needs' ? '当前窗口内没有需要你决定的交付。' : state.tab === 'accepted' ? '当前窗口内没有已接受的交付。' : state.tab === 'reviewed' ? '当前窗口内没有已评审的交付。' : '当前还没有交付。'));
    return;
  }
  const split = el('div', 'fc-sub-split');
  const items = el('div', 'fc-sub-list');
  const selected = list.find((item) => item.artifactId === state.selectedId) ?? null;
  for (const item of list) {
    const record = btn('', () => state.onSelect(item.artifactId), 'fc-sub-row');
    record.dataset.selected = String(item.artifactId === selected?.artifactId);
    record.dataset.recordId = item.artifactId;
    const headline = el('span', 'fc-sub-row-head');
    headline.append(el('strong', null, item.title || '未命名交付'), badge(item.acceptedState === 'ACCEPTED' ? '已接受' : item.reviewState ? verdictText(item.reviewState) : '待评审', item.acceptedState === 'ACCEPTED' ? 'live' : ''));
    record.append(headline, el('span', 'fc-sub-row-intent', item.workTitle || '所属工作未命名'));
    record.append(el('span', 'fc-sub-row-meta', [deliveryKind(item.kind), item.producerName, fmt(item.createdAt)].filter(Boolean).join(' · ')));
    items.append(record);
  }
  split.append(items);
  if (selected) split.append(deliveryInspector(selected, state));
  body.append(split);
}

function deliveryInspector(item, state) {
  const detail = el('aside', 'fc-sub-inspector');
  detail.setAttribute('aria-label', '交付物详情');
  detail.append(btn('← 返回列表', () => state.onSelect(null), 'fc-sub-back'), el('span', 'fc-sub-eyebrow', 'DELIVERY INSPECTOR'), el('h3', null, item.title || '未命名交付'));
  detail.append(section('交付身份', value('类型', deliveryKind(item.kind)), value('记录时间', fmt(item.createdAt))));
  detail.append(section('来源工作', item.workId ? btn(item.workTitle || '查看工作', () => state.onNavigate('work', 'all', item.workId)) : para(`${item.workTitle || '未命名工作'} · 当前投影尚未提供可核对的跳转关联。`)));
  detail.append(section('产出员工', para(item.producerName || '当前投影未提供产出者。')));
  detail.append(section('评审', para(item.reviewState ? verdictText(item.reviewState) : '尚无评审结论。')));
  const lineage = originLineage(item, state.works, state.projection);
  const sourceStep = lineage?.steps?.find((step) => step.artifacts?.some((artifact) => artifact.artifactId === item.artifactId));
  detail.append(section('来源与工作线', para(sourceStep ? `来自「${sourceStep.title || '任务'}」；${sourceStep.employeeName || '产出员工未记录'}参与。可通过来源工作查看完整工作线。` : '当前投影未提供完整来源工作线。')));
  const decision = section('创始人决定', para(acceptedStateText(item.acceptedState)));
  const needs = item.decisionCandidate && (state.projection?.attention?.items ?? []).some((attention) => attention.kind === 'DECISION_REQUIRED' && attention.workId === item.workId);
  if (needs && item.acceptedState !== 'ACCEPTED') {
    decision.append(badge('等待你处理', 'attention'), para('当前界面尚未接入产品决策命令。'));
    const actions = el('div', 'fc-sub-decision-actions');
    for (const label of ['请求修订', '接受交付']) {
      const action = btn(label, () => {}, 'fc-sub-action');
      action.disabled = true;
      action.title = state.connection === 'LIVE' ? '产品决策命令尚未接入。' : 'Runtime 连接中断。';
      actions.append(action);
    }
    decision.append(actions);
  }
  detail.append(decision);
  detail.append(para('当前产品投影尚未提供交付内容预览。', 'fc-sub-notice'));
  return detail;
}

function renderSettings(body, state) {
  const company = state.projection?.company ?? state.company;
  const sections = {
    general: ['通用', [['公司', company?.name || '尚未选择'], ['创始人', '本机单用户'], ['工作空间', 'FlowCredit Company OS']]],
    runtime: ['Runtime', [['连接', state.connection === 'LIVE' ? '可读' : '连接中断或尚未连接'], ['数据状态', state.connection === 'LIVE' ? '实时投影' : '最后一次读取'], ['上次刷新', fmt(state.capturedAt)]]],
    execution: ['执行', [['模型与工作后端', '未来设置 · 尚未开放'], ['网页研究', '未来可用性设置 · 尚未开放']]],
    permissions: ['权限', [['创始人权限', '未来设置 · 尚未开放'], ['员工访问', '未来设置 · 尚未开放']]],
    appearance: ['外观', [['界面', '跟随系统外观与减少动态设置'], ['偏好', '目前没有可持久保存的外观偏好']]],
    advanced: ['高级', [['诊断', '请使用本机 Runtime 诊断工具'], ['配置写入', '当前页面只读']]],
  };
  const [title, entries] = sections[state.tab] ?? sections.general;
  const panel = section(title);
  for (const [label, content] of entries) panel.append(value(label, content));
  body.append(panel);
}
