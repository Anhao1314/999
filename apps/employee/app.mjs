import {
  AVAILABILITY,
  CONNECTION,
  EmployeeStore,
  cropRect,
  currentRoleOf,
  isWorking,
  needsFounderCheck,
  visualAction,
} from './domain.mjs';
import { HttpEmployeeAdapter } from './adapter.mjs';
import { validatePortrait } from './avatar.mjs';

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text, action, className) => { const b = node('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b; };

// The frozen vocabulary, rendered. No other Employee states exist in the UI.
const availabilityNames = { AVAILABLE: '空闲', WORKING: '工作中', DISABLED: '已停用' };
const roleNames = { EXECUTION: '执行中', REVIEW: '审核中', REPAIR: '返工中' };
// Domain-level Activity kinds, rendered as product language; unknown kinds
// fail closed to a neutral phrase, never the raw Runtime identifier.
const activityNames = {
  WORKER_RUN_STARTED: '执行已开始', WORKER_RUN_COMPLETED: '执行已完成', WORKER_RUN_INTERRUPTED: '执行已中断',
  WORKER_RUN_CANCELLED: '执行已取消', WORKER_RUN_FAILED: '执行未产生结果',
  TASK_ASSIGNED: '任务已指派', TASK_REQUIREMENTS_SET: '任务要求已更新', TASK_CANCELLED: '任务已取消',
  'task.created': '任务已创建', 'task.completed': '任务已完成', 'work.created': '工作已创建',
  'company.created': '公司已创建', 'artifact.recorded': '产物已记录', 'checkpoint.written': '检查点已写入',
  REVIEW_REQUESTED: '已请求评审', REVIEW_SUBMITTED: '评审已提交', REVIEW_PASSED: '评审通过（不等于 Founder 接受）',
  REPAIR_TASK_CREATED: '返工任务已创建', WORK_ACCEPTED: 'Founder 已接受',
  EMPLOYEE_CREATED: '员工已创建', EMPLOYEE_UPDATED: '员工状态已更新', POSITION_CREATED: '岗位已创建',
  WORKER_RESULT_SUBMITTED: '已交付产物', WORKER_REVIEW_RESULT_SUBMITTED: '已提交评审结论',
  WORKER_EXECUTION_BOUND: '已绑定执行后端', ARTIFACT_HANDED_OFF: '产物已交接',
  ARTIFACT_SUPERSEDED: '产物已被替代', REVISION_REQUESTED: '已请求修订',
  'task.execution_started': '执行已开始', 'task.interrupted': '任务已中断', 'task.cancelled': '任务已取消',
};
// Fail closed: an unrecognised kind renders a neutral product phrase, never the
// raw Runtime identifier.
const activityText = record => record.summary ?? activityNames[record.kind] ?? '工作已更新';
const store = new EmployeeStore();
const demo = new URLSearchParams(location.search).get('demo') === '1';
const adapter = demo ? new (await import('./demo.mjs')).DemoEmployeeAdapter() : new HttpEmployeeAdapter();
const portraits = new Map(), visuals = new Map(), seenMessages = new Set(), animations = new Set();
let selectedId, page = 'overview', stop = () => {}, currentCompany, dirty = false, pending = false, toastTimer, draftVersion;
let initialized = false, lastCompany, imageDraft, avatarGeneration = 0, avatarDirty = false, cardSignature = '';
let cardDetail = null, detailEpoch = 0, lineageView = null;
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => $('reduce-motion').checked || reduceQuery.matches;
const activeEmployees = () => store.state.employees;
const selected = () => store.state.employees.find(e => e.employeeId === selectedId);
const connected = () => store.state.connection === CONNECTION.LIVE;
const spriteNumber = e => e.sprite ?? (Array.from(e.employeeId).reduce((sum, c) => sum + c.charCodeAt(0), 0) % 8 + 1);
const preset = e => `/employee-assets/assets/portrait-${spriteNumber(e)}.png`;
const portrait = e => portraits.get(`${currentCompany}/${e.employeeId}`) ?? preset(e);
function toast(text) { $('toast').textContent = text; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5000); }
function pill(e) {
  const p = node('span', availabilityNames[e.availability] ?? e.availability, 'fc-status');
  p.dataset.status = e.availability;
  const role = currentRoleOf(e);
  if (isWorking(e) && role) { p.textContent = `${availabilityNames.WORKING} · ${roleNames[role]}`; p.dataset.role = role; }
  if (needsFounderCheck(e)) p.dataset.condition = 'check';
  return p;
}
function block(title) { const el = node('section', undefined, 'fc-block'); el.append(node('h3', title)); return el; }
function notice(text) { return node('div', text, 'fc-notice'); }
function warning(text) { return node('div', text, 'fc-warning'); }
function openDialog(id) { const dialog = $(id); dialog._returnFocus = document.activeElement; if (!dialog.open) { dialog.showModal(); history.pushState({ employeeView: id }, '', location.href); } }
function ask(message) {
  if ($('confirmation').open) return Promise.resolve(false);
  const focus = document.activeElement, d = $('confirmation'); $('confirmation-message').textContent = message; d.showModal();
  return new Promise(resolve => { const done = answer => { d.close(); focus?.focus(); resolve(answer); }; $('confirmation-cancel').onclick = () => done(false); $('confirmation-accept').onclick = () => done(true); d.oncancel = e => { e.preventDefault(); done(false); }; });
}
async function discard() { return !dirty || await ask('有尚未保存的修改，放弃这些修改？'); }
async function closeDialog(id, fromHistory = false) {
  if ((id === 'card' && !await discard()) || (id === 'avatar' && avatarDirty && !await ask('放弃尚未确认的肖像修改？'))) return false;
  const d = $(id); if (!d.open) return true;
  if (id === 'card') { dirty = false; detailEpoch++; cardDetail = null; }
  if (id === 'avatar') { avatarGeneration++; imageDraft = undefined; avatarDirty = false; }
  if (id === 'lineage') lineageView = null;
  d.close();
  const origin = d._returnFocus;
  const restored = origin?.isConnected ? origin : [...document.querySelectorAll('[data-employee-id]')].find(el => el.dataset.employeeId === origin?.dataset.employeeId && el.className === origin?.className && (el.closest('dialog')?.open ?? true));
  (restored ?? $('open-roster')).focus();
  if (!fromHistory && history.state?.employeeView === id) history.back();
  return true;
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
for (const id of ['roster','card','avatar','lineage']) $(id).addEventListener('cancel', e => { e.preventDefault(); closeDialog(id); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dialog = ['confirmation','avatar','lineage','card','roster'].map($).find(d => d.open);
  if (!dialog) return;
  const controls = [...dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
});
window.addEventListener('popstate', async () => {
  const top = ['avatar','lineage','card','roster'].find(id => $(id).open);
  if (top && history.state?.employeeView !== top && !await closeDialog(top, true)) history.pushState({ employeeView: top }, '', location.href);
});
function openCard(id) {
  selectedId = id; page = 'overview'; dirty = false; cardDetail = null; cardSignature = '';
  renderCard(); openDialog('card'); $('card-body').scrollTop = 0;
  loadDetail(id);
}
async function loadDetail(id) {
  const epoch = ++detailEpoch;
  try {
    const detail = await adapter.employeeDetail(id);
    if (epoch !== detailEpoch || selectedId !== id) return;
    cardDetail = detail; cardSignature = ''; renderCard();
  } catch (error) {
    if (epoch === detailEpoch) toast(`员工详情读取失败：${error.message}`);
  }
}
async function navigate(next) { if (!await discard()) return; dirty = false; page = next; renderCard(); $('card-body').scrollTop = 0; }
$('open-roster').onclick = () => { renderRoster(); openDialog('roster'); };
$('search').oninput = renderRoster; $('filter').onchange = renderRoster;
$('reduce-motion').checked = reduceQuery.matches;
function reduceMotion() { document.body.classList.toggle('fc-reduced', reduced()); if (reduced()) for (const a of animations) a.finish(); }
$('reduce-motion').onchange = reduceMotion; reduceQuery.addEventListener('change', reduceMotion); reduceMotion();
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('fc-hidden', document.hidden); for (const a of animations) document.hidden ? a.pause() : a.play(); });

function rosterMatch(e) {
  const filter = $('filter').value;
  if (filter === 'all') return true;
  if (filter === 'CHECK') return needsFounderCheck(e);
  return e.availability === filter;
}
function renderRoster() {
  const search = $('search').value.trim().toLowerCase(), list = activeEmployees().filter(e => `${e.displayName} ${e.position?.title ?? ''}`.toLowerCase().includes(search) && rosterMatch(e));
  const signature = JSON.stringify(list.map(e => [e.employeeId, e.displayName, e.position?.title, e.availability, e.condition, portrait(e)]));
  if ($('grid').dataset.signature === signature) return;
  $('grid').dataset.signature = signature;
  const focusId = document.activeElement?.dataset.employeeId;
  const items = list.map(e => { const b = button('', () => openCard(e.employeeId), 'fc-roster-item'); b.dataset.employeeId = e.employeeId; const img = node('img'); img.src = portrait(e); img.alt = ''; const text = node('div'); text.append(node('strong', e.displayName), node('p', e.position?.title ?? '未设置岗位'), pill(e)); b.append(img, text); return b; });
  $('grid').replaceChildren(...(items.length ? items : [node('p', '没有符合条件的员工。', 'fc-empty')]));
  if (focusId) [...$('grid').children].find(e => e.dataset.employeeId === focusId)?.focus();
}
function position(tableIndex, seat) {
  const x = 290 + tableIndex % 3 * 290, y = 130 + Math.floor(tableIndex / 3) * 240;
  const offsets = [[-57,-55],[57,-55],[108,22],[57,89],[-57,89],[-108,22]];
  return { x: x + offsets[seat][0], y: y + offsets[seat][1], cx: x, cy: y };
}
function renderLobby(state) {
  const companyChanged = lastCompany !== state.companyId;
  if (companyChanged) { for (const a of animations) a.cancel(); animations.clear(); visuals.clear(); $('sprites').replaceChildren(); initialized = false; lastCompany = state.companyId; seenMessages.clear(); }
  const tableSignature = JSON.stringify(state.tables);
  if ($('tables').dataset.signature !== tableSignature) {
    $('tables').dataset.signature = tableSignature; const elements = [];
    state.tables.forEach((table, i) => { const center = position(i, 0); const t = node('div', `TABLE ${String(i + 1).padStart(2, '0')}`, 'fc-table'); t.style.left = `${center.cx - 82}px`; t.style.top = `${center.cy - 32}px`; elements.push(t);
      table.seats.forEach((_, j) => { const p = position(i, j), chair = node('div', undefined, 'fc-seat'); chair.style.left = `${p.x - 17}px`; chair.style.top = `${p.y + 4}px`; elements.push(chair); }); });
    $('tables').replaceChildren(...elements);
    $('scene').style.height = `${Math.max(490, Math.ceil(state.tables.length / 3) * 240 + 80)}px`;
  }
  const currentIds = new Set(activeEmployees().map(e => e.employeeId));
  for (const [id, v] of visuals) if (!currentIds.has(id)) { v.animation?.cancel(); v.el.remove(); clearTimeout(v.talkTimer); visuals.delete(id); }
  state.tables.forEach((table, i) => table.seats.forEach((id, j) => {
    const e = state.employees.find(entry => entry.employeeId === id); if (!e) return; const p = position(i, j); let v = visuals.get(id);
    if (!v) {
      const el = button('', () => openCard(id), 'fc-person'), sprite = node('span', undefined, 'fc-sprite'), label = node('span', undefined, 'fc-person-label'); el.dataset.employeeId = id; sprite.style.backgroundImage = `url('/employee-assets/assets/sprite-${spriteNumber(e)}.png')`; el.append(sprite, label); $('sprites').append(el); v = { el, label }; visuals.set(id, v);
      if (initialized && connected() && !reduced()) {
        const aisle = p.cy + 118, sideX = j < 3 ? p.cx + 120 : p.cx - 120;
        const points = [[70,120],[140,120],[140,aisle],[sideX,aisle],[sideX,p.y],[p.x,p.y]];
        const animation = el.animate(points.map(([x, y]) => ({ left: `${x}px`, top: `${y}px` })), { duration: 2200, easing: 'linear' });
        v.animation = animation; el.dataset.walking = 'true'; animations.add(animation);
        animation.onfinish = animation.oncancel = () => { delete el.dataset.walking; animations.delete(animation); v.animation = null; };
      }
    }
    v.el.style.left = `${p.x}px`; v.el.style.top = `${p.y}px`; v.label.textContent = e.displayName;
    const role = currentRoleOf(e);
    v.el.dataset.status = e.availability;
    v.el.dataset.role = role ?? '';
    v.el.dataset.condition = needsFounderCheck(e) ? 'check' : '';
    v.el.setAttribute('aria-label', `${e.displayName}，${e.position?.title ?? '未设置岗位'}，${availabilityNames[e.availability] ?? e.availability}${isWorking(e) && role ? `，${roleNames[role]}` : ''}${needsFounderCheck(e) ? '，执行状态需要检查' : ''}`);
    if (!v.talking || !connected()) v.el.dataset.action = visualAction(state, e);
    if (!connected()) { v.animation?.finish(); clearTimeout(v.talkTimer); v.talking = false; }
  }));
  if (initialized && connected() && state.source === 'mock') for (const event of state.activity ?? []) if (event.kind === 'message.sent' && !seenMessages.has(event.id)) {
    seenMessages.add(event.id);
    for (const id of [event.employeeId, event.toEmployeeId]) { const v = visuals.get(id); if (!v) continue; clearTimeout(v.talkTimer); v.talking = true; v.el.dataset.action = 'talking'; v.talkTimer = setTimeout(() => { v.talking = false; const e = store.state.employees.find(entry => entry.employeeId === id); if (e) v.el.dataset.action = visualAction(store.state, e); }, 3000); }
  }
  if (!initialized) for (const event of state.activity ?? []) seenMessages.add(event.id);
  if (connected()) initialized = true;
}
function render(state) {
  const employees = activeEmployees(); $('count').textContent = employees.length;
  const summary = state.summary ?? { employees: employees.length, working: 0, available: 0, disabled: 0 };
  const parts = [`${summary.employees} 位成员`, `${summary.working} 工作中`, `${summary.available} 空闲`];
  if (summary.disabled > 0) parts.push(`${summary.disabled} 已停用`);
  $('counts').textContent = parts.join(' / ');
  $('mode').textContent = demo ? '模拟模式' : '本地 Runtime';
  $('connection').dataset.state = state.connection;
  $('connection').textContent = state.connection === CONNECTION.RUNTIME_UNAVAILABLE
    ? 'Runtime 暂不可用：保留最后已知投影，动画与写操作已停止，正在重试。传输状态不代表员工状态。'
    : state.connection === CONNECTION.CONNECTING
      ? '正在连接本地 Runtime…'
      : demo
        ? '模拟数据 · 所有运行、命令和配置仅用于交互演示，不连接模型。'
        : `真实 Runtime · Experience 投影 · 每 2 秒同步${employees.length ? '' : ' · 当前公司暂无员工。'}`;
  renderLobby(state); if ($('roster').open) renderRoster();
  if ($('card').open) {
    if (!selected()) closeDialog('card');
    else if (page === 'overview' || page === 'details' || page === 'settings') {
      const signature = JSON.stringify([selected(), cardDetail, state.connection, pending, page]);
      if (signature !== cardSignature) { cardSignature = signature; renderCard(); }
    }
    else { $('card-footer').querySelectorAll('[data-command]').forEach(b => b.disabled = pending || !connected()); }
  }
  const events = state.source === 'mock' ? (state.activity ?? []).slice(0, 3) : [];
  $('feed').replaceChildren(...(events.length ? events.map(e => { const a = node('article'); a.append(node('time', new Date(e.at).toLocaleTimeString('zh-CN')), node('span', e.summary)); return a; }) : [node('div', '公司级活动流尚未接入 Experience API（v0A 已知缺口）。员工级近期公开活动请打开员工卡查看。', 'fc-empty')]));
}
const unsubscribe = store.subscribe(render);

function activityList(detail) {
  return detail?.recentActivity ?? [];
}
function overview(e) {
  const wrap = node('div', undefined, 'fc-overview'), left = node('div'), right = node('div');
  const detail = cardDetail ?? {};
  const work = e.currentWork ?? null;
  const photo = node('div', undefined, 'fc-portrait'), img = node('img'); img.src = portrait(e); img.alt = `${e.displayName}的本地肖像`; photo.append(img, button('▧ 更换肖像', openAvatar)); left.append(photo);
  const live = block('近期公开活动'), log = node('div', undefined, 'fc-mini-log'); log.setAttribute('aria-label', '近期公开活动');
  const events = activityList(detail).slice(0, 5);
  for (const a of events) { const p = node('p', activityText(a)); if (a.createdAt) p.append(node('time', new Date(a.createdAt).toLocaleString('zh-CN'))); else if (a.at) p.append(node('time', new Date(a.at).toLocaleTimeString('zh-CN'))); log.append(p); }
  if (!events.length) log.append(node('p', isWorkingWorker(e) || work ? '这条工作还没有公开活动记录。' : '没有公开记录'));
  live.append(log); left.append(live);
  const identity = block('员工身份'); identity.classList.add('fc-identity'); identity.append(node('h2', e.displayName), pill(e), node('div', e.employeeId, 'fc-id'), node('div', e.position?.title ?? '未设置岗位', 'fc-role'), node('p', demo ? '合成演示角色，用于验证界面交互。' : '长期员工身份 · 独立于任何一次执行')); right.append(identity);
  if (needsFounderCheck(e)) right.append(warning('执行状态异常，需要检查：该员工同时有多个执行中的尝试，Runtime 未指定唯一当前工作。'));
  const workBlock = block(work ? '当前工作' : '当前状态');
  if (work) {
    workBlock.append(node('p', work.title));
    const role = work.role ? roleNames[work.role] : '角色未定';
    workBlock.append(node('p', `${role} · 第 ${work.attempt} 次尝试 / 上限 ${work.maxAutonomousAttempts}`));
    if (!demo) workBlock.append(button('查看工作线 →', () => openLineage(work.workId)));
  } else {
    workBlock.append(node('p', e.availability === AVAILABILITY.WORKING ? '工作中：Runtime 未给出唯一当前工作。' : '当前没有执行中的工作。'));
  }
  right.append(workBlock);
  const execution = block('执行后端');
  if (e.execution) execution.append(node('p', `${e.execution.backendType} · ${e.execution.backendVersion}`), node('p', '执行细节不进入员工身份。'));
  else execution.append(node('p', needsFounderCheck(e) ? '多个执行中的尝试：不指定单一执行后端。' : '当前没有执行中的尝试。'));
  right.append(execution);
  if (demo) {
    const usage = block('模拟 Token 用量 / 单次预算 (demo)');
    const used = e.demo?.tokenUsed, limit = e.demo?.tokenLimit;
    usage.append(node('div', `${used ?? '未提供'} / ${limit ?? '未提供'}`, 'fc-token'));
    usage.append(node('p', '模拟配额消耗，不是任务进度，也不写入 Runtime。'));
    right.append(usage);
  }
  const skills = block('岗位能力'), tags = node('div', undefined, 'fc-tags'); for (const s of e.capabilities ?? []) tags.append(node('span', s)); if (!tags.children.length) tags.append(node('span', '未提供')); skills.append(tags); right.append(skills);
  const tools = block('工具 / 权限'); tools.append(node('p', '未接入工具与授权目录')); right.append(tools); wrap.append(left, right); return wrap;
}
function isWorkingWorker(e) { return e.availability === AVAILABILITY.WORKING; }
function renderCard() {
  const e = selected(); if (!e) return;
  $('card-heading').textContent = e.displayName;
  const body = $('card-body'), scroll = body.scrollTop;
  const focusText = $('card').contains(document.activeElement) ? document.activeElement?.textContent : null;
  const activityScroll = body.querySelector('.fc-mini-log')?.scrollTop ?? 0;
  const title = node('h2', e.displayName); title.id = 'card-title'; title.hidden = true;
  body.replaceChildren(title); $('card-footer').replaceChildren();
  if (!connected()) body.append(notice('Runtime 暂不可用：以下是最后已知投影，写操作与动画已停止。'));
  if (page === 'overview') body.append(overview(e));
  else {
    const titles = { settings: demo ? 'Agent 设置（模拟）' : '员工控制', details: '工作详情', logs: '公开活动历史', assign: '分配任务（模拟）' };
    const head = node('div', undefined, 'fc-subtitle'); head.append(button('← 返回', () => navigate('overview')), node('h2', titles[page])); body.append(head);
    if (page === 'settings') body.append(settings(e));
    if (page === 'details') body.append(details(e));
    if (page === 'logs') body.append(logs(e));
    if (page === 'assign') body.append(assignForm(e));
  }
  if (page === 'overview') {
    const work = e.currentWork;
    if (!demo && work) $('card-footer').append(button('查看工作线', () => openLineage(work.workId)));
    $('card-footer').append(button('查看详情', () => navigate('details')));
    if (!demo) $('card-footer').append(button('员工控制', () => navigate('settings')));
    $('card-footer').append(button('公开活动', () => navigate('logs')));
    if (demo) {
      $('card-footer').append(button('分配任务', () => navigate('assign'), 'fc-primary'), button('⚙ 设置', () => navigate('settings'), 'fc-primary'));
      const pause = button(e.demo?.paused ? '▷ 恢复' : 'Ⅱ 暂停', () => execute(e.demo?.paused ? 'resume' : 'pause', { employeeId: e.employeeId })); pause.disabled = !connected() || pending || !e.currentWork; $('card-footer').append(pause);
    }
  }
  if (page !== 'logs') body.scrollTop = scroll;
  const activity = body.querySelector('.fc-mini-log'); if (activity) activity.scrollTop = activityScroll;
  if (focusText) [...$('card').querySelectorAll('button')].find(b => b.textContent === focusText && !b.disabled)?.focus({ preventScroll: true });
}
function details(e) {
  const detail = cardDetail ?? {}, section = node('div'), work = e.currentWork;
  const current = block(work ? '当前尝试' : '当前状态');
  if (work) {
    current.append(node('p', work.title));
    current.append(node('p', `${work.role ? roleNames[work.role] : '角色未定'} · 第 ${work.attempt} 次尝试 / 上限 ${work.maxAutonomousAttempts}`));
    current.append(node('div', `${work.taskId} · generation ${work.generation}`, 'fc-id'));
    current.append(node('p', e.execution ? `执行后端：${e.execution.backendType} · ${e.execution.backendVersion}` : '执行后端未提供'));
    if (!demo) current.append(button('查看工作线 →', () => openLineage(work.workId)));
  } else current.append(node('p', '当前没有执行中的尝试。'));
  section.append(current);
  const deliveries = block('近期交付');
  const items = detail.recentDeliveries ?? [];
  if (!items.length) deliveries.append(node('p', '尚无交付记录。'));
  for (const item of items) {
    const line = node('p', `${item.title ?? item.artifactId} · ${item.kind}`);
    const review = item.reviewState === 'PASS' ? '评审通过（≠ Founder 接受）' : item.reviewState === 'REQUEST_REVISION' ? '已要求返工' : '尚未评审';
    const accepted = item.acceptedState === 'ACCEPTED' ? 'Founder 已接受' : '尚未被 Founder 接受';
    line.append(node('time', `${item.workTitle ?? ''} · ${review} · ${accepted}`));
    deliveries.append(line);
  }
  section.append(deliveries);
  return section;
}
function logs(e) {
  const detail = cardDetail ?? {}, section = node('div');
  section.append(notice('公开状态摘要（最多 20 条）；不读取工作指令、密钥、隐藏推理或产物正文。'));
  const list = node('ul', undefined, 'fc-history');
  const events = activityList(detail);
  if (!events.length) list.append(node('li', '尚无公开活动记录'));
  for (const event of events) { const li = node('li', activityText(event)); const at = event.createdAt ?? event.at; if (at) li.append(node('time', `${new Date(at).toLocaleString('zh-CN')} · ${event.source === 'mock' ? '模拟' : 'Runtime'}`)); list.append(li); }
  section.append(list);
  return section;
}
function settings(e) {
  if (!demo) {
    const form = node('div', undefined, 'fc-settings');
    form.append(notice('启用/停用是 Company 控制：只影响未来派工，不暂停当前执行，也不会修改任何历史。'));
    const enable = button(e.availability === AVAILABILITY.DISABLED ? '启用未来派工' : '停用未来派工', async () => {
      const next = e.availability === AVAILABILITY.DISABLED;
      if (await ask(`${next ? '启用' : '停用'}“${e.displayName}”的未来派工？当前执行不会被暂停。`)) execute('enabled', { employeeId: e.employeeId, enabled: next });
    });
    enable.disabled = !connected() || pending;
    form.append(enable, notice('配置、模型、工具与 Token 预算尚未接入 Experience；这里不会假装它们存在。'));
    return form;
  }
  const form = node('form', undefined, 'fc-settings'); draftVersion = e.demo?.configVersion ?? 1;
  form.append(notice(`模拟配置 v${draftVersion}；更改只应用于下一次模拟执行，不写入 Runtime。`));
  const label = (text, name, value, disabled = false, multiline = false) => { const l = node('label', text), i = node(multiline ? 'textarea' : 'input'); i.name = name; i.value = value ?? ''; i.disabled = disabled; l.append(i); return l; };
  const basic = node('fieldset'); basic.append(node('legend', '基本信息'), label('姓名', 'displayName', e.displayName, false), label('职位（岗位定义）', 'position', e.position?.title ?? '', true)); form.append(basic);
  const instructions = node('fieldset'); instructions.append(node('legend', '工作指令（模拟）'), label('下一次模拟执行使用', 'instructions', e.demo?.instructions ?? '', false, true)); form.append(instructions);
  const limits = node('fieldset'); limits.append(node('legend', '运行限制'), label('单次模拟 Token 预算', 'tokenLimitPerRun', e.demo?.tokenLimit ?? 40000, false)); form.append(limits);
  form.elements.tokenLimitPerRun.type = 'number'; form.elements.tokenLimitPerRun.min = '1'; form.elements.tokenLimitPerRun.step = '1'; form.elements.displayName.maxLength = 40; form.elements.instructions.maxLength = 16000;
  form.addEventListener('input', () => dirty = true);
  const save = button('保存模拟配置', () => {}); save.type = 'submit'; form.append(save);
  form.onsubmit = async ev => { ev.preventDefault(); if (pending || !connected()) return; try { adapter.updateConfig(e.employeeId, { displayName: form.elements.displayName.value, instructions: form.elements.instructions.value, tokenLimitPerRun: Number(form.elements.tokenLimitPerRun.value) }, draftVersion); dirty = false; toast('模拟配置已保存，下次模拟执行生效'); renderCard(); } catch (error) { toast(error.message); } };
  const enable = button(e.availability === AVAILABILITY.DISABLED ? '启用未来派工（模拟）' : '停用未来派工（模拟）', async () => { if (await ask(`${e.availability === AVAILABILITY.DISABLED ? '启用' : '停用'}“${e.displayName}”的未来派工？（模拟）`)) execute('enabled', { employeeId: e.employeeId, enabled: e.availability === AVAILABILITY.DISABLED }); });
  enable.dataset.command = 'enabled'; enable.disabled = !connected() || pending; form.append(enable);
  const danger = node('fieldset', undefined, 'fc-danger'); danger.append(node('legend', '危险区 · 删除 Agent（模拟归档）'), node('p', '仅模拟归档；保留历史与导入抑制标记。活跃执行必须先取消并确认。'));
  danger.append(label('输入完整员工名称确认', 'confirmName', '', false));
  const cancel = button('取消模拟执行', async () => { if (await ask('确认取消该员工的模拟执行？')) execute('cancel', { employeeId: e.employeeId }); }); cancel.disabled = !e.currentWork || pending || !connected(); danger.append(cancel);
  const archive = button('确认模拟归档', () => { const wasDirty = dirty; try { dirty = false; adapter.archive(e.employeeId, form.elements.confirmName.value, draftVersion); closeDialog('card'); toast('模拟归档完成；未删除真实员工'); } catch (error) { dirty = wasDirty; toast(error.message); } }); archive.disabled = pending || !connected(); danger.append(archive); form.append(danger); return form;
}
function assignForm(e) {
  const form = node('div', undefined, 'fc-settings');
  if (!demo) { form.append(notice('生产大厅不是调度器：指派与启动由 Runtime 协调逻辑（Continuation Driver）完成，不能从这个界面手动执行。')); return form; }
  form.append(notice('创建一条模拟任务，命令受理后等待确认；不写入 Runtime。'));
  const label = node('label', '模拟任务标题'), input = node('input'); input.id = 'task-title'; input.maxLength = 160; input.value = '整理下一轮产品发布清单'; label.append(input);
  form.append(label, button('确认分配模拟任务', () => execute('assign', { employeeId: e.employeeId, title: input.value }), 'fc-primary'));
  return form;
}
async function execute(kind, input) {
  if (pending || !connected() || !await discard()) return; dirty = false; pending = true; $('company').disabled = true; toast('命令请求中，等待后端确认…'); renderCard();
  try {
    if (demo) { const ack = await adapter.command(currentCompany, kind, input); if (ack.state !== 'confirmed') throw new Error('命令尚未确认，请核对状态'); toast(`模拟命令已确认${ack.runId ? ` · ${ack.runId}` : ''}`); store.replace(await adapter.snapshot(currentCompany)); }
    else {
      if (kind !== 'enabled') throw new Error(`生产大厅不支持 ${kind}`);
      await adapter.setEmployeeEnabled(input.employeeId, input.enabled);
      toast('员工控制已确认：只影响未来派工');
      store.replace(await adapter.snapshot(currentCompany));
      await loadDetail(input.employeeId);
    }
  } catch (error) { toast(`命令未确认：${error.message}`); try { store.replace(await adapter.snapshot(currentCompany)); } catch { store.connection(CONNECTION.RUNTIME_UNAVAILABLE); } }
  finally { pending = false; $('company').disabled = false; if ($('card').open) renderCard(); }
}
async function openLineage(workId) {
  lineageView = { workId, state: 'loading', data: null, error: null };
  $('lineage-body').replaceChildren(node('p', '正在读取工作线…'));
  openDialog('lineage');
  try {
    const data = await adapter.lineage(workId);
    lineageView = { workId, state: 'ready', data, error: null };
  } catch (error) { lineageView = { workId, state: 'error', data: null, error }; }
  renderLineage();
}
function renderLineage() {
  const body = $('lineage-body'); if (!lineageView) return;
  if (lineageView.state === 'loading') { body.replaceChildren(node('p', '正在读取工作线…')); return; }
  if (lineageView.state === 'error') { body.replaceChildren(notice(`工作线读取失败：${lineageView.error?.message ?? '未知错误'}`)); return; }
  const { work, steps, outcome, founderBoundary } = lineageView.data;
  body.replaceChildren();
  body.append(node('h2', work.title));
  const meta = node('div', undefined, 'fc-tags'); meta.append(node('span', work.status), node('span', work.stage)); body.append(meta);
  if (work.intent) body.append(node('p', work.intent));
  const list = node('ul', undefined, 'fc-history');
  for (const step of steps) {
    const li = node('li');
    li.append(node('strong', `${roleNames[step.role] ?? step.role} · ${step.title ?? step.taskId}`));
    li.append(node('time', `${step.state} · 第 ${step.attempt} 次尝试${step.employeeName ? ` · ${step.employeeName}` : ''}`));
    for (const artifact of step.artifacts ?? []) li.append(node('time', `产物 v${artifact.versionIndex ?? '?'} · ${artifact.title ?? artifact.artifactId}${artifact.supersedesArtifactId ? ' · 取代旧版本' : ''}`));
    if (step.review) li.append(node('time', `评审：${step.review.verdict ?? '尚未提交'}${step.review.summary ? ` · ${step.review.summary}` : ''}`));
    if (step.repair) li.append(node('time', '返工任务已绑定该评审'));
    list.append(li);
  }
  if (!steps.length) list.append(node('li', '尚无 Runtime 记录。'));
  body.append(list);
  const boundary = node('div', undefined, 'fc-block');
  boundary.append(node('h3', 'Founder 边界'));
  boundary.append(node('p', founderBoundary.waitingForFounder ? `等待 Founder：${founderBoundary.attentionKind ?? '需要决定'}` : founderBoundary.decision ? `Founder 已接受 · ${founderBoundary.decision.disposition} · ${new Date(founderBoundary.decision.decidedAt).toLocaleString('zh-CN')}` : '尚无 Founder 决定；评审通过不等于 Founder 接受。'));
  boundary.append(node('p', `outcome：${outcome.state}`));
  body.append(boundary);
  body.append(node('p', '只读工作线：派生自 Runtime 事实，不可编辑。'));
}
async function setImage(src) { const generation = ++avatarGeneration; try { const img = new Image(); img.src = src; await img.decode(); if (generation !== avatarGeneration || !$('avatar').open) return; if (img.naturalWidth * img.naturalHeight > 16000000) throw new Error('图片解码超过 1600 万像素'); imageDraft = img; avatarDirty = true; for (const id of ['zoom','pan-x','pan-y']) $(id).value = id === 'zoom' ? '1' : '0'; drawCrop(); $('avatar-error').textContent = ''; $('save-portrait').disabled = false; } catch (error) { if (generation === avatarGeneration) { $('avatar-error').textContent = `无法使用此图片：${error.message}。原肖像未改变。`; $('save-portrait').disabled = true; } } }
function drawCrop() { if (!imageDraft) return; const rect = cropRect(imageDraft.naturalWidth, imageDraft.naturalHeight, Number($('zoom').value), Number($('pan-x').value), Number($('pan-y').value)); const canvas = $('crop'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(imageDraft, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height); }
function openAvatar() { openDialog('avatar'); $('avatar-error').textContent = ''; $('avatar-file').value = ''; $('presets').replaceChildren(...Array.from({ length: 8 }, (_, i) => { const b = button('', () => setImage(`/employee-assets/assets/portrait-${i + 1}.png`)); b.setAttribute('aria-label', `内置肖像 ${i + 1}`); const img = node('img'); img.src = `/employee-assets/assets/portrait-${i + 1}.png`; img.alt = ''; b.append(img); return b; })); setImage(portrait(selected())).then(() => avatarDirty = false); }
for (const id of ['zoom','pan-x','pan-y']) $(id).oninput = () => { avatarDirty = true; drawCrop(); };
$('restore-portrait').onclick = () => setImage(preset(selected()));
$('avatar-file').onchange = async () => { const file = $('avatar-file').files[0]; if (!file) return; $('save-portrait').disabled = true;
  try { await validatePortrait(file); } catch (error) { avatarGeneration++; $('avatar-error').textContent = `${error.message}；原肖像未改变。`; return; }
  const url = URL.createObjectURL(file); try { await setImage(url); } finally { URL.revokeObjectURL(url); }
};
$('save-portrait').onclick = () => { if (!imageDraft) return; try { const result = $('crop').toDataURL('image/png'); portraits.set(`${currentCompany}/${selectedId}`, result); avatarDirty = false; closeDialog('avatar'); renderCard(); renderRoster(); toast('已应用本页本地肖像预览；未上传服务器'); } catch { toast('裁剪失败，原肖像未改变'); } };
async function selectCompany(id) { if (!await discard()) { $('company').value = currentCompany; return; } stop(); dirty = false; for (const dialog of ['avatar','lineage','card','roster']) if ($(dialog).open) await closeDialog(dialog, true); currentCompany = id; selectedId = undefined; cardDetail = null; store.replace({ companyId: id, source: demo ? 'mock' : 'live', capturedAt: null, summary: { employees: 0, working: 0, available: 0, disabled: 0 }, employees: [] }); initialized = false; stop = adapter.subscribe(id, store); }
$('company').onchange = () => selectCompany($('company').value);
$('demo-controls').hidden = !demo; $('mode-link').href = demo ? '/employees' : '/employees?demo=1'; $('mode-link').textContent = demo ? '返回真实 Runtime ↗' : '查看模拟演示 ↗';
if (demo) {
  $('demo-add').onclick = () => adapter.add();
  $('demo-work').onclick = () => adapter.collaborate();
  $('demo-interrupt').onclick = () => { adapter.connection(); $('demo-interrupt').textContent = adapter.interrupted ? '恢复模拟连接' : '模拟连接中断'; };
  $('demo-sixty').onclick = () => { while (adapter.employees.filter(e => !e.archived).length < 60) adapter.add(false); adapter.publish(); };
}
window.addEventListener('beforeunload', e => { if (dirty || avatarDirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => { stop(); unsubscribe(); adapter.dispose?.(); clearTimeout(toastTimer); for (const a of animations) a.cancel(); for (const v of visuals.values()) clearTimeout(v.talkTimer); reduceQuery.removeEventListener('change', reduceMotion); });
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
async function boot() {
  $('retry-connection').disabled = true;
  try {
    const companies = await adapter.companies();
    $('company').replaceChildren(...companies.map(c => { const o = node('option', c.name); o.value = c.id; return o; }));
    $('retry-connection').hidden = companies.length > 0;
    if (companies.length) await selectCompany(companies[0].id);
    else { $('company').append(node('option', '尚未创建公司')); store.replace({ companyId: null, source: demo ? 'mock' : 'live', capturedAt: null, summary: { employees: 0, working: 0, available: 0, disabled: 0 }, employees: [] }); $('connection').textContent = demo ? '模拟模式已就绪。' : '真实 Runtime 已连接，但尚无公司。请先完成团队的 Company 创建流程；也可查看明确标记的模拟演示。'; }
  } catch (error) { store.connection(CONNECTION.RUNTIME_UNAVAILABLE); $('retry-connection').hidden = false; toast(`连接失败：${error.message}`); }
  finally { $('retry-connection').disabled = false; }
}
$('retry-connection').onclick = boot; await boot();
