import { symbol } from './icons.mjs';
import { HIRING_CONTRACT, readCompanyHiring, positionRoster, candidatePhase, capabilityText } from './company-hiring-domain.mjs';

const el = (tag, className, value) => { const n = document.createElement(tag); if (className) n.className = className; if (value !== undefined) n.textContent = String(value); return n; };
const copy = (value, className = 'fc-hiring-muted') => el('p', className, value);
const button = (label, action, className = 'fc-hiring-link') => { const n = el('button', className, label); n.type = 'button'; n.addEventListener('click', action); return n; };
const section = (title, ...nodes) => { const n = el('section', 'fc-hiring-section'); n.append(el('h4', null, title), ...nodes); return n; };
const disclosed = (entries) => {
  const details = el('details', 'fc-hiring-technical'); details.append(el('summary', null, '记录信息'));
  const list = el('dl'); for (const [name, value] of entries) if (value !== undefined && value !== null) list.append(el('dt', null, name), el('dd', null, String(value)));
  details.append(list); return details;
};
const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleDateString('zh-CN') : '日期尚未提供';
const notConnected = (label, reason) => copy(reason === 'INVALID_CONTRACT' ? `${label}记录与当前公司或读取约定不一致，已停止展示。` : `${label}投影尚未接入，当前状态未知。`);
const capabilityList = (items, note) => {
  const n = el('div', 'fc-hiring-capabilities');
  if (!Array.isArray(items) || !items.length) return copy(note);
  for (const item of items) n.append(el('span', 'fc-hiring-capability', capabilityText(item)));
  return n;
};

function stateLine(title, main, detail, action) {
  const n = el('section', 'fc-hiring-state-line');
  n.append(el('h4', null, title), el('strong', null, main), copy(detail));
  if (action) n.append(action);
  return n;
}

function candidateRow(candidate, state) {
  const id = `candidate:${candidate.id}`, phase = candidatePhase(candidate);
  const n = button('', () => state.onSelect(id), 'fc-hiring-row fc-sub-row');
  n.dataset.recordId = id; n.dataset.selected = String(state.selectedId === id); n.setAttribute('aria-pressed', String(state.selectedId === id));
  n.append(el('strong', null, candidate.displayName), el('span', null, candidate.positionTitle || '岗位名称尚未提供'), el('small', null, ({ IN_TRIAL: '真实试用进行中', NEEDS_YOU: '等待你的决定', HIRED: '已加入公司', DECIDED: '已有创始人决定', EVIDENCE_RECORDED: '试用评审已记录', TRIAL_LINKED: '已关联真实试用工作' })[phase] || '候选员工'));
  return n;
}

function roleRow(record, state) {
  const { position, employees } = record, id = `position:${position.id}`;
  const n = button('', () => state.onSelect(id), 'fc-hiring-row fc-sub-row');
  n.dataset.recordId = id; n.dataset.selected = String(state.selectedId === id); n.setAttribute('aria-pressed', String(state.selectedId === id));
  n.append(el('strong', null, position.title), el('span', null, position.capabilities?.length ? position.capabilities.map(capabilityText).join(' · ') : '尚未声明预期能力'), el('small', null, employees ? `${employees.length} 名已关联员工 · 招聘状态未提供` : '已关联员工尚未读取 · 招聘状态未提供'));
  return n;
}

function openingRow(opening, state, roster) {
  const id = `opening:${opening.id}`, position = roster?.find(r => r.position.id === opening.positionId)?.position;
  const n = button('', () => state.onSelect(id), 'fc-hiring-row fc-sub-row');
  n.dataset.recordId = id; n.dataset.selected = String(state.selectedId === id); n.setAttribute('aria-pressed', String(state.selectedId === id));
  n.append(el('strong', null, opening.title || position?.title || '岗位名称尚未提供'), el('span', null, opening.summary || '岗位招聘记录'), el('small', null, `招聘状态：${opening.status}`));
  return n;
}

function inspector(title, state) {
  const n = el('aside', 'fc-hiring-inspector'); n.setAttribute('aria-label', title); n.tabIndex = -1;
  n.append(button('← 返回列表', () => state.onSelect(null), 'fc-hiring-back fc-sub-back'), el('span', 'fc-hiring-kicker', 'WORKFORCE INSPECTOR'), el('h3', null, title));
  n.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.onSelect(null); } });
  return n;
}

function positionInspector(record, state) {
  const { position, employees } = record, n = inspector(position.title, state);
  n.append(copy('已定义岗位 · 当前读取结果未说明是否开放招聘', 'fc-hiring-boundary'));
  n.append(section('公司希望这个岗位做什么', capabilityList(position.capabilities, '预期能力尚未提供。'), copy('岗位声明的是预期能力；只有真实工作与独立评审才能提供能力证据。')));
  n.append(section('谁已在这个岗位', employees ? copy(employees.length ? employees.map(e => e.displayName).join(' · ') : '当前没有已关联员工；这不代表岗位已经开放。') : copy('已关联员工尚未读取。')));
  if (employees?.length) n.append(button(employees.length === 1 ? `查看 ${employees[0].displayName} 的工牌 →` : '查看岗位员工 →', () => state.onNavigate('employees', null, employees.length === 1 ? employees[0].id : null), 'fc-hiring-link'));
  n.append(section('访问与权限', copy('岗位能力不授予工具访问。当前读取结果未提供权限配置。')));
  n.append(disclosed([['岗位 ID', position.id], ['能力 ID', position.capabilities?.join(' · ')], ['创建时间', date(position.createdAt)], ['公司 ID', position.companyId]]));
  return n;
}

function openingInspector(opening, state, roster) {
  const position = roster?.find(r => r.position.id === opening.positionId)?.position;
  const n = inspector(opening.title || position?.title || '招聘岗位', state);
  n.append(copy('由 Runtime 明确提供的招聘记录。岗位定义和招聘开放状态分别记录。', 'fc-hiring-boundary'));
  n.append(section('招聘状态', copy(opening.status)));
  n.append(section('预期能力', capabilityList(position?.capabilities || opening.capabilities, '岗位预期能力尚未提供。'), copy('能力声明不等于能力证据，也不授予访问权限。')));
  n.append(section('访问与权限', copy(opening.authority?.summary || '此招聘记录尚未提供访问范围。')));
  n.append(disclosed([['招聘记录 ID', opening.id], ['岗位 ID', opening.positionId]]));
  return n;
}

function candidateInspector(candidate, state) {
  const phase = candidatePhase(candidate), n = inspector(candidate.displayName, state);
  n.append(copy(candidate.positionTitle || '岗位名称尚未提供', 'fc-hiring-position-name'));
  n.append(section('组织身份', copy(phase === 'HIRED' ? 'Runtime 已提供聘用决定与正式员工关联。' : '候选员工；尚未成为正式员工。')));
  n.append(section('声明的能力', capabilityList(candidate.declaredCapabilities, '候选的预期能力尚未提供。'), copy('声明不等于经过试用证明。')));
  const skills = section('工作方法', copy(candidate.skill?.title || '受治理的方法尚未提供。')); n.append(skills);
  const access = section('访问与权限', copy(candidate.authority?.summary || '可用工具与访问范围尚未提供；能力不自动授予权限。')); n.append(access);
  const trial = section('真实试用工作');
  if (candidate.trial?.workId) {
    trial.append(copy(candidate.trial.title || 'Runtime 已关联一份真实 Work。'), button('查看试用工作与执行 →', () => state.onNavigate('work', 'all', candidate.trial.workId)));
    trial.append(copy(candidate.trial.artifactTitle ? `交付物：${candidate.trial.artifactTitle}` : '交付摘要尚未提供。'));
  } else trial.append(copy('尚无真实试用 Work 关联；不会播放模拟试用。'));
  n.append(trial);
  n.append(section('独立评审与能力证据', copy(candidate.trial?.review?.verdict ? `独立评审：${candidate.trial.review.verdict}` : '独立评审结果尚未提供。'), capabilityList(candidate.capabilityEvidence, '能力证据尚未提供；不会根据能力声明推断“已验证”。')));
  const decision = section('创始人决定', copy(candidate.founderDecision ? `已记录决定：${candidate.founderDecision.disposition}` : phase === 'NEEDS_YOU' ? '试用评审已通过，等待你决定是否聘用。' : '尚无创始人招聘决定；试用通过不自动聘用。'));
  if (phase === 'NEEDS_YOU') decision.append(copy('招聘决定命令尚未接入；此处只呈现真实证据，不会代你确认。'));
  n.append(decision);
  if (phase === 'HIRED') n.append(section('长期员工', copy('后端已关联正式员工身份；后续工作是否再次选用此人仍由 Runtime 决定。'), button('查看员工 →', () => state.onNavigate('employees', null, candidate.employeeId))));
  n.append(disclosed([['候选 ID', candidate.id], ['岗位 ID', candidate.positionId], ['试用 Work ID', candidate.trial?.workId], ['员工 ID', candidate.employeeId]]));
  return n;
}

function planningSheet(state) {
  const n = el('section', 'fc-hiring-plan'); n.setAttribute('aria-label', '规划新岗位');
  const head = el('div', 'fc-hiring-plan-head'); head.append(el('span', 'fc-hiring-kicker', 'A NEW ROLE'), button('关闭', () => state.onHiring({ planning: false, roleTitle: '' }), 'fc-hiring-link')); n.append(head);
  n.append(el('h4', null, '公司需要什么角色？'), copy('先从组织需要的岗位开始。候选员工、权限和试用工作需要后续真实记录。'));
  const input = el('input'); input.type = 'text'; input.placeholder = '例如：Customer Researcher'; input.setAttribute('aria-label', '岗位名称构想，尚未保存'); input.maxLength = 120; input.value = state.hiringUI.roleTitle || '';
  input.addEventListener('input', () => state.onHiring({ roleTitle: input.value }, false)); n.append(input);
  n.append(copy('这只是未保存的岗位构想。正式创建命令尚未接入，关闭后不会留下岗位或候选员工。', 'fc-hiring-boundary'));
  return n;
}

export function renderCompanyHiring(target, state) {
  const data = readCompanyHiring(state.projection, state.company?.id);
  const roster = positionRoster(state.hiring.positions, state.hiring.employees, state.company?.id);
  const candidates = data.candidates.state === 'ready' ? data.candidates.items : [];
  const inTrial = candidates.filter(item => candidatePhase(item) === 'IN_TRIAL');
  const needsYou = candidates.filter(item => candidatePhase(item) === 'NEEDS_YOU');
  const root = el('div', 'fc-hiring fc-subpage'); root.dataset.page = 'hiring'; root.dataset.source = 'READ_ONLY';
  const hero = el('header', 'fc-hiring-hero');
  hero.append(el('span', 'fc-hiring-kicker', 'BUILD YOUR WORKFORCE'), el('h3', null, '公司的下一位员工，从真正需要的岗位开始。'), copy('真实工作证明能力，创始人决定谁加入长期团队。'));
  root.append(hero);
  if (state.connection !== 'LIVE') root.append(copy(state.projection ? 'Runtime 连接中断；以下已读取的记录可能已经变化。' : 'Runtime 尚未连接，招聘记录不可读取。', 'fc-hiring-connection'));
  const activity = el('div', 'fc-hiring-activity');
  const need = el('section', 'fc-hiring-need'); need.append(el('span', 'fc-hiring-kicker', 'COMPANY NEED'), el('h4', null, '公司目前缺什么能力？'));
  if (data.demand.state !== 'ready') need.append(notConnected('能力需求', data.demand.reason));
  else if (!data.demand.items.length) need.append(copy('当前读取结果没有待补能力。'));
  else for (const item of data.demand.items) need.append(el('strong', 'fc-hiring-demand-title', capabilityText(item.capability)), copy(item.reason));
  const plan = button('规划新岗位 →', () => state.onHiring({ planning: true }), 'fc-hiring-primary'); need.append(plan); activity.append(need);
  const signals = el('div', 'fc-hiring-signals');
  signals.append(stateLine('正在试用', data.candidates.state !== 'ready' ? '试用状态尚未接入' : inTrial.length ? `${inTrial.length} 位候选员工正在真实 Work 中试用` : '当前没有正在试用的候选员工', data.candidates.state !== 'ready' ? '尚无可核对的候选人与试用工作关联。' : '试用是一份可追溯的真实工作。'));
  for (const candidate of inTrial) signals.append(candidateRow(candidate, state));
  signals.append(stateLine('需要你决定', data.candidates.state !== 'ready' ? '招聘决定状态尚未接入' : needsYou.length ? `${needsYou.length} 位候选员工等待你决定` : '当前没有待确认的招聘决定', '独立评审通过后，仍需你的聘用决定。'));
  for (const candidate of needsYou) signals.append(candidateRow(candidate, state));
  activity.append(signals); root.append(activity);
  if (state.hiringUI.planning) root.append(planningSheet(state));
  const lower = el('div', 'fc-hiring-lower');
  const inventory = el('section', 'fc-hiring-inventory'); inventory.append(el('span', 'fc-hiring-kicker', 'POSITIONS'), el('h4', null, '岗位与招聘进展'));
  if (data.openings.state !== 'ready') inventory.append(copy('开放招聘状态尚未接入。下面是 Runtime 中已定义的岗位，不代表正在招聘。'));
  else if (!data.openings.items.length) inventory.append(copy('本次正式读取没有招聘记录。'));
  else { inventory.append(el('h5', null, '招聘记录')); for (const opening of data.openings.items) inventory.append(openingRow(opening, state, roster)); }
  inventory.append(el('h5', null, '已定义岗位'));
  if (state.hiring.loading && !roster) inventory.append(copy('正在读取真实岗位…'));
  else if (!roster) inventory.append(copy(state.hiring.positionError || '岗位清单暂不可读取。'));
  else if (!roster.length) inventory.append(copy('Runtime 明确返回空岗位清单。'));
  else for (const record of roster) inventory.append(roleRow(record, state));
  if (data.candidates.state === 'ready' && candidates.length) {
    inventory.append(el('h5', null, '候选员工'));
    for (const candidate of candidates) inventory.append(candidateRow(candidate, state));
  }
  lower.append(inventory);
  let selected = null;
  if (state.selectedId?.startsWith('position:')) selected = roster?.find(r => `position:${r.position.id}` === state.selectedId);
  else if (state.selectedId?.startsWith('opening:')) selected = data.openings.items.find(o => `opening:${o.id}` === state.selectedId);
  else if (state.selectedId?.startsWith('candidate:')) selected = candidates.find(c => `candidate:${c.id}` === state.selectedId);
  const aside = selected ? ('position' in selected ? positionInspector(selected, state) : state.selectedId.startsWith('opening:') ? openingInspector(selected, state, roster) : candidateInspector(selected, state)) : el('aside', 'fc-hiring-guide');
  if (!selected) {
    aside.append(el('span', 'fc-hiring-kicker', 'FROM NEED TO EMPLOYEE'), el('h4', null, '聘用是一段有证据的过程。'));
    for (const [title, detail] of [['岗位', '定义公司需要的角色与预期能力。'], ['试用', '候选员工完成真实工作，留下交付与独立评审。'], ['决定', '创始人确认后，正式员工身份才会出现。']]) aside.append(section(title, copy(detail)));
    aside.append(copy('试用通过不自动聘用。能力声明不授予权限。', 'fc-hiring-boundary'));
  }
  lower.dataset.detail = String(Boolean(selected)); lower.append(aside); root.append(lower);
  const history = el('footer', 'fc-hiring-history'); history.append(el('h4', null, '入职与招聘历史'));
  if (data.history.state !== 'ready') history.append(notConnected('招聘历史', data.history.reason), copy('现有员工可以在「员工」中查看；员工创建时间不等于正式入职时间。'));
  else if (!data.history.items.length) history.append(copy('本次正式读取没有招聘历史。'));
  else for (const item of data.history.items) history.append(copy(`${item.title} · ${item.outcome}`));
  history.append(button('查看现有员工 →', () => state.onNavigate('employees'))); root.append(history);
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && (selected || state.hiringUI.planning)) { event.preventDefault(); event.stopPropagation(); if (state.hiringUI.planning) state.onHiring({ planning: false, roleTitle: '' }); else state.onSelect(null); } }, true);
  target.replaceChildren(root);
}
