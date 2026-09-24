import {
  AVAILABILITY,
  CONNECTION,
  EmployeeStore,
  FLOOR_ROOMS,
  cropRect,
  currentRoleOf,
  isWorking,
  needsFounderCheck,
  visualAction,
} from './domain.mjs';
import { HttpEmployeeAdapter } from './adapter.mjs';
import { validatePortrait } from './avatar.mjs';
import { symbol } from '/employee-assets/icons.mjs';
import { createSurfaceMotion } from '/employee-assets/surface-motion.mjs';
import { createSpritePlayer, portraitUrl } from './sprite-motion.mjs';
import { roomPoint, roomRoute } from './room-path.mjs';

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
const capabilityNames = {
  'commerce.product.research': '产品研究', 'commerce.user.insights': '用户洞察',
  'commerce.market.analysis': '市场分析', 'commerce.market.review': '独立复核',
  'commerce.market.synthesis': '市场进入方案', 'founder.assistant': '创始人协作',
  'research.interviews': '用户访谈', 'research.synthesis': '研究归纳',
  'product.strategy': '产品策略', 'product.writing': '产品写作',
  'design.prototype': '原型设计', 'design.visual': '视觉设计',
};
const capabilityName = id => capabilityNames[id] ?? '未命名能力';
const store = new EmployeeStore();
const pageParams = new URLSearchParams(location.search);
const demo = pageParams.get('demo') === '1';
const embedded = pageParams.get('embedded') === '1';
const requestedEmployeeId = embedded && !demo ? pageParams.get('employee') : null;
const requestedCompanyId = embedded && !demo ? pageParams.get('company') : null;
let requestedEmployeePending = Boolean(requestedEmployeeId);
document.body.classList.toggle('fc-embedded', embedded);
const adapter = demo ? new (await import('./demo.mjs')).DemoEmployeeAdapter() : new HttpEmployeeAdapter();
const portraits = new Map(), visuals = new Map(), seenMessages = new Set(), animations = new Set();
let selectedId, page = 'overview', stop = () => {}, currentCompany, dirty = false, pending = false, toastTimer, draftVersion;
let initialized = false, lastCompany, imageDraft, avatarGeneration = 0, avatarDirty = false, cardSignature = '';
let cardDetail = null, detailEpoch = 0, lineageView = null;
let focusedRoom = null, roomReturnFocus = null;
const returnView = { card: null, avatar: null, lineage: null };
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const inspectorWide = matchMedia('(min-width: 860px)');
const reduced = () => $('reduce-motion').checked || reduceQuery.matches;
const activeEmployees = () => store.state.employees;
const selected = () => store.state.employees.find(e => e.employeeId === selectedId);
const connected = () => store.state.connection === CONNECTION.LIVE;
const isAssistant = e => e.capabilities?.includes('founder.assistant') ?? false;
const preset = e => portraitUrl(e.employeeId, isAssistant(e));
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
const employeeMotions = new Map();
function employeeMotion(surface) {
  if (!employeeMotions.has(surface)) employeeMotions.set(surface, createSurfaceMotion(surface, { reduced }));
  return employeeMotions.get(surface);
}
function animateEmployeeSurface(surface, open, origin) {
  return employeeMotion(surface).run(open, origin?.getBoundingClientRect(), { left: surface.offsetLeft, top: surface.offsetTop, width: surface.offsetWidth, height: surface.offsetHeight });
}
function showEmployeeDialog(id) {
  if (id === 'card' && inspectorWide.matches) $(id).show();
  else $(id).showModal();
}
inspectorWide.addEventListener('change', () => {
  const card = $('card');
  if (!card.open || card.matches(':modal') === !inspectorWide.matches) return;
  const focused = card.contains(document.activeElement) ? document.activeElement : null;
  employeeMotion(card).cancel();
  card.close();
  showEmployeeDialog('card');
  focused?.focus({ preventScroll: true });
});
function openDialog(id) {
  const dialog = $(id);
  if (dialog.open) return;
  dialog._returnFocus = document.activeElement;
  const parent = id === 'card' && $('roster').open ? 'roster' : ['avatar', 'lineage'].includes(id) && $('card').open ? 'card' : null;
  if (id in returnView) returnView[id] = parent;
  if (parent) $(parent).close();
  showEmployeeDialog(id);
  if (id === 'card') document.body.classList.add('fc-inspector-open');
  void animateEmployeeSurface(dialog, true, dialog._returnFocus);
  history.pushState({ employeeView: id }, '', location.href);
}
function ask(message) {
  if ($('confirmation').open) return Promise.resolve(false);
  const focus = document.activeElement, d = $('confirmation'); $('confirmation-message').textContent = message; d.showModal();
  return new Promise(resolve => { const done = answer => { d.close(); focus?.focus(); resolve(answer); }; $('confirmation-cancel').onclick = () => done(false); $('confirmation-accept').onclick = () => done(true); d.oncancel = e => { e.preventDefault(); done(false); }; });
}
async function discard() { return !dirty || await ask('有尚未保存的修改，放弃这些修改？'); }
if (embedded) window.requestEmbeddedClose = async () => {
  if ((dirty || avatarDirty) && !await ask('有尚未保存的修改，关闭后将放弃，确定关闭？')) return false;
  dirty = false;
  avatarDirty = false;
  return true;
};
async function closeDialog(id, fromHistory = false, restoreParent = true) {
  if ((id === 'card' && !await discard()) || (id === 'avatar' && avatarDirty && !await ask('放弃尚未确认的肖像修改？'))) return false;
  const d = $(id); if (!d.open) return true;
  if (d._closing) return false;
  d._closing = true;
  if (restoreParent) {
    const finished = await animateEmployeeSurface(d, false, d._returnFocus);
    d._closing = false;
    if (!finished) return false;
  } else { employeeMotion(d).cancel(); d._closing = false; }
  if (id === 'card') { dirty = false; detailEpoch++; cardDetail = null; }
  if (id === 'avatar') { avatarGeneration++; imageDraft = undefined; avatarDirty = false; }
  if (id === 'lineage') lineageView = null;
  d.close();
  if (id === 'card') document.body.classList.remove('fc-inspector-open');
  const parent = id in returnView ? returnView[id] : null;
  if (id in returnView) returnView[id] = null;
  if (restoreParent && parent === 'roster') renderRoster();
  if (restoreParent && parent && !$(parent).open) showEmployeeDialog(parent);
  if (id === 'card') renderWorkforce();
  const origin = d._returnFocus;
  const restored = origin?.isConnected ? origin : [...document.querySelectorAll('[data-employee-id]')].find(el => el.dataset.employeeId === origin?.dataset.employeeId && el.className === origin?.className && (el.closest('dialog')?.open ?? true));
  if (restoreParent) (restored ?? $('open-roster')).focus();
  if (!fromHistory && history.state?.employeeView === id) history.back();
  return true;
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
for (const id of ['roster','card','avatar','lineage']) $(id).addEventListener('cancel', e => { e.preventDefault(); closeDialog(id); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dialog = ['confirmation','avatar','lineage','card','roster'].map($).find(d => d.open && d.matches(':modal'));
  if (!dialog) return;
  const controls = [...dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !$('card').open || $('card').matches(':modal')) return;
  if (['avatar', 'lineage', 'confirmation', 'roster'].some(id => $(id).open)) return;
  e.preventDefault();
  void closeDialog('card');
});
document.addEventListener('pointerdown', e => {
  if (!$('card').open || $('card').matches(':modal') || $('card').contains(e.target) || e.target.closest?.('[data-employee-id]')) return;
  void closeDialog('card', false, false);
});
window.addEventListener('popstate', async () => {
  const top = ['avatar','lineage','card','roster'].find(id => $(id).open);
  if (top && history.state?.employeeView !== top && !await closeDialog(top, true)) history.pushState({ employeeView: top }, '', location.href);
});
function openCard(id) {
  if (focusedRoom) {
    const returnButton = roomReturnFocus;
    closeRoomFocus(false);
    returnButton?.focus({ preventScroll: true });
  }
  if ($('card').open && id === selectedId) { $('card').querySelector('.fc-identity-name')?.focus({ preventScroll: true }); return; }
  if ($('card').open) $('card')._returnFocus = document.activeElement;
  selectedId = id; page = 'overview'; dirty = false; cardDetail = null; cardSignature = '';
  renderCard(); openDialog('card'); $('card-body').scrollTop = 0;
  $('card').querySelector('.fc-identity-name')?.focus({ preventScroll: true });
  renderWorkforce();
  if (!$('card')._returnFocus?.isConnected) $('card')._returnFocus = [...$('workforce-list').querySelectorAll('[data-employee-id]')].find(item => item.dataset.employeeId === id) ?? $('open-roster');
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
$('open-roster').onclick = () => { $('workforce-search').scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); $('workforce-search').focus(); };
$('search').oninput = renderRoster; $('filter').onchange = renderRoster;
async function focusEmployeeSearch() {
  for (const id of ['avatar', 'lineage', 'card']) if ($(id).open && !await closeDialog(id)) return;
  $('workforce-search').focus();
}
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    void focusEmployeeSearch();
  }
});
$('search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    const first = $('grid').querySelector('.fc-roster-item');
    if (first) { event.preventDefault(); first.focus(); }
  }
});
$('reduce-motion').checked = reduceQuery.matches;
function reduceMotion() { document.body.classList.toggle('fc-reduced', reduced()); if (reduced()) for (const a of animations) a.finish(); for (const visual of visuals.values()) visual.player?.update(); }
$('reduce-motion').onchange = reduceMotion; reduceQuery.addEventListener('change', reduceMotion); reduceMotion();
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('fc-hidden', document.hidden); for (const a of animations) document.hidden ? a.pause() : a.play(); for (const visual of visuals.values()) visual.player?.update(); });

function rosterMatch(e) {
  const filter = $('filter').querySelector('input:checked')?.value ?? 'all';
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
function roomElement(id) { return [...$('rooms').children].find((room) => room.dataset.roomId === id); }
function roomEntry(id) { return roomElement(id)?.querySelector('.fc-room-entry'); }

function closeRoomFocus(restoreFocus = true) {
  if (!focusedRoom) return;
  const origin = roomReturnFocus;
  focusedRoom = null;
  roomReturnFocus = null;
  const surface = $('room-focus');
  if (!restoreFocus) { employeeMotion(surface).cancel(); surface.hidden = true; }
  else void animateEmployeeSurface(surface, false, origin).then((finished) => { if (finished && !focusedRoom) surface.hidden = true; });
  $('scene').classList.remove('is-focused');
  for (const room of $('rooms').children) room.dataset.focused = 'false';
  if (restoreFocus) (origin?.isConnected ? origin : roomEntry(origin?.dataset.roomId))?.focus({ preventScroll: true });
}

function renderRoomFocus(state) {
  if (!focusedRoom) return;
  const room = state.rooms.find((item) => item.id === focusedRoom);
  if (!room) { closeRoomFocus(false); return; }
  const people = room.seats.filter(Boolean).map((id) => state.employees.find((entry) => entry.employeeId === id)).filter(Boolean);
  $('room-focus-title').textContent = `${room.name} · ${people.length} 位成员`;
  const list = $('room-focus-list');
  const signature = JSON.stringify(people.map((person) => [person.employeeId, person.displayName, person.position?.title, person.availability]));
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.employeeId : null;
  list.replaceChildren(...(people.length ? people.map((person) => {
    const item = button('', () => openCard(person.employeeId), 'fc-room-member');
    item.dataset.employeeId = person.employeeId;
    item.append(symbol('employees'), node('span', person.displayName), node('small', person.position?.title ?? '未设置岗位'), pill(person));
    return item;
  }) : [node('p', '这个展示分区目前没有员工。', 'fc-room-empty')]));
  if (focusedId) [...list.querySelectorAll('[data-employee-id]')].find((item) => item.dataset.employeeId === focusedId)?.focus({ preventScroll: true });
}

function openRoomFocus(id, origin) {
  focusedRoom = id;
  roomReturnFocus = origin;
  $('room-focus-list').dataset.signature = '';
  $('room-focus').hidden = false;
  $('scene').classList.add('is-focused');
  for (const room of $('rooms').children) room.dataset.focused = String(room.dataset.roomId === id);
  renderRoomFocus(store.state);
  roomElement(id)?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
  void animateEmployeeSurface($('room-focus'), true, origin);
  $('room-focus-close').focus({ preventScroll: true });
}

$('room-focus-close').addEventListener('click', () => closeRoomFocus());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && focusedRoom && !['roster', 'card', 'avatar', 'lineage', 'confirmation'].some((id) => $(id).open)) {
    event.preventDefault();
    closeRoomFocus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (focusedRoom && !$('room-focus').contains(event.target) && !$('rooms').contains(event.target)) closeRoomFocus(false);
});

function renderLobby(state) {
  const companyChanged = lastCompany !== state.companyId;
  if (companyChanged) {
    closeRoomFocus(false);
    for (const a of animations) a.cancel();
    for (const visual of visuals.values()) { visual.player?.destroy(); visual.routeAnimation?.cancel(); clearTimeout(visual.talkTimer); }
    animations.clear(); visuals.clear(); $('rooms').replaceChildren();
    initialized = false; lastCompany = state.companyId; seenMessages.clear();
  }
  if (!$('rooms').childElementCount) for (const room of FLOOR_ROOMS) {
    const section = node('section', undefined, 'fc-floor-room');
    section.dataset.roomId = room.id;
    section.dataset.focused = 'false';
    section.addEventListener('click', (event) => { if (!event.target.closest('button')) openRoomFocus(room.id, entry); });
    const entry = button('', () => openRoomFocus(room.id, entry), 'fc-room-entry');
    entry.dataset.roomId = room.id;
    const name = node('strong', room.name);
    const count = node('span', '0 位', 'fc-room-count');
    const roomIcons = { founder: 'workspace', research: 'knowledge', design: 'artifacts', engineering: 'settings', delivery: 'work', collaboration: 'employees' };
    entry.append(symbol(roomIcons[room.id]), name, count);
    const stage = node('div', undefined, 'fc-room-stage');
    const compact = node('div', undefined, 'fc-room-compact-list');
    const extra = node('span', undefined, 'fc-room-extra');
    section.append(entry, stage, compact, extra);
    $('rooms').append(section);
  }
  const visibleIds = new Set(state.rooms.flatMap((room) => room.seats.filter(Boolean).slice(0, 4)));
  for (const [id, visual] of visuals) if (!visibleIds.has(id)) {
    visual.animation?.cancel(); visual.routeAnimation?.cancel(); visual.player.destroy(); visual.el.remove(); clearTimeout(visual.talkTimer); visuals.delete(id);
  }
  for (const room of state.rooms) {
    const section = roomElement(room.id);
    if (!section) continue;
    const ids = room.seats.filter(Boolean);
    section.querySelector('.fc-room-count').textContent = `${ids.length} 位`;
    section.querySelector('.fc-room-entry').setAttribute('aria-label', `聚焦${room.name}，${ids.length}位成员；展示分区`);
    const extra = section.querySelector('.fc-room-extra');
    extra.textContent = ids.length > 4 ? `另有 ${ids.length - 4} 位 · 点击区域查看` : ids.length ? '点击区域查看全部成员' : '预留办公空间';
    const stage = section.querySelector('.fc-room-stage');
    const compact = section.querySelector('.fc-room-compact-list');
    const compactSignature = JSON.stringify(ids.map((id) => {
      const employee = state.employees.find((entry) => entry.employeeId === id);
      return [id, employee?.displayName, employee?.availability];
    }));
    if (compact.dataset.signature !== compactSignature) {
      compact.dataset.signature = compactSignature;
      compact.replaceChildren(...ids.map((id) => {
        const employee = state.employees.find((entry) => entry.employeeId === id);
        return button(`${employee?.displayName ?? '员工'} · ${availabilityNames[employee?.availability] ?? '状态未知'}`, () => openCard(id), 'fc-room-compact-person');
      }));
    }
    for (const [slot, id] of ids.slice(0, 4).entries()) {
      const person = state.employees.find((entry) => entry.employeeId === id);
      if (!person) continue;
      let visual = visuals.get(id);
      if (!visual) {
        const el = button('', () => openCard(id), 'fc-person');
        const sprite = node('span', undefined, 'fc-sprite');
        const label = node('span', undefined, 'fc-person-label');
        el.dataset.employeeId = id;
        el.append(sprite, label);
        stage.append(el);
        const working = isWorking(person);
        const point = roomPoint(slot, working);
        el.style.left = `${point.x}%`; el.style.top = `${point.y}%`;
        visual = { el, label, slot, working, player: createSpritePlayer(sprite, { employeeId: id, assistant: isAssistant(person), reduced }) };
        el.addEventListener('focus', () => visual.routeAnimation?.finish());
        visuals.set(id, visual);
      } else if (visual.el.parentElement !== stage) stage.append(visual.el);
      const working = isWorking(person);
      if (visual.slot !== slot) { visual.slot = slot; visual.working = working; visual.routeAnimation?.cancel(); const point = roomPoint(slot, working); visual.el.style.left = `${point.x}%`; visual.el.style.top = `${point.y}%`; }
      else if (person.availability === AVAILABILITY.DISABLED && visual.working) {
        visual.routeAnimation?.cancel(); visual.working = false;
        const point = roomPoint(slot, false); visual.el.style.left = `${point.x}%`; visual.el.style.top = `${point.y}%`;
      }
      else if (visual.working !== working && connected() && initialized) {
        visual.routeAnimation?.finish();
        const route = roomRoute(slot, visual.working, working);
        visual.working = working;
        const destination = route.at(-1);
        visual.el.style.left = `${destination.x}%`; visual.el.style.top = `${destination.y}%`;
        if (!reduced() && !document.hidden && !visual.el.matches(':focus')) {
          const animation = visual.el.animate(route.map((point) => ({ left: `${point.x}%`, top: `${point.y}%` })), { duration: 620, easing: 'linear' });
          visual.routeAnimation = animation; animations.add(animation);
          visual.player.setDirection(working ? (slot % 2 ? 'right' : 'left') : 'front');
          visual.player.play('walk');
          animation.onfinish = animation.oncancel = () => { animations.delete(animation); visual.routeAnimation = null; visual.player.setDirection('front'); visual.player.setBase(visual.workAction ?? 'idle'); };
        }
      } else if (!connected()) { visual.routeAnimation?.finish(); visual.player.setEnabled(false); }
      else visual.player.setEnabled(true);
      visual.label.textContent = person.displayName;
      const role = currentRoleOf(person);
      visual.el.dataset.status = person.availability;
      visual.el.dataset.role = role ?? '';
      visual.el.dataset.condition = needsFounderCheck(person) ? 'check' : '';
      visual.el.setAttribute('aria-label', `${person.displayName}，${person.position?.title ?? '未设置岗位'}，${availabilityNames[person.availability] ?? person.availability}${isWorking(person) && role ? `，${roleNames[role]}` : ''}${needsFounderCheck(person) ? '，执行状态需要检查' : ''}`);
      const action = visualAction(state, person);
      visual.workAction = action === 'typing' ? (role === 'REVIEW' ? 'read' : 'type') : 'idle';
      if (!visual.routeAnimation && !visual.talking) visual.player.setBase(visual.workAction);
      if (!connected()) { visual.animation?.finish(); clearTimeout(visual.talkTimer); visual.talking = false; }
    }
  }
  if (initialized && connected() && state.source === 'mock') for (const event of state.activity ?? []) if (event.kind === 'message.sent' && !seenMessages.has(event.id)) {
    seenMessages.add(event.id);
    for (const id of [event.employeeId, event.toEmployeeId]) { const v = visuals.get(id); if (!v) continue; clearTimeout(v.talkTimer); v.talking = true; v.player.play('wave'); v.talkTimer = setTimeout(() => { v.talking = false; v.player.setBase(v.workAction ?? 'idle'); }, 3000); }
  }
  if (!initialized) for (const event of state.activity ?? []) seenMessages.add(event.id);
  renderRoomFocus(state);
  if (connected()) initialized = true;
}
function renderWorkforce() {
  const query = $('workforce-search').value.trim().toLocaleLowerCase();
  const filter = $('workforce-filter').value;
  const people = activeEmployees().filter(e =>
    (filter === 'all' || e.availability === filter)
    && `${e.displayName} ${e.position?.title ?? ''}`.toLocaleLowerCase().includes(query));
  $('workforce-count').textContent = `${activeEmployees().length} 位员工`;
  const signature = JSON.stringify([currentCompany, selectedId, $('card').open, query, filter, people.map(e => [e.employeeId, e.displayName, e.position?.title, e.availability, e.currentWork?.title, e.capabilities])]);
  if ($('workforce-list').dataset.signature === signature) return;
  $('workforce-list').dataset.signature = signature;
  const focusedId = $('workforce-list').contains(document.activeElement) ? document.activeElement.dataset.employeeId : null;
  const cards = people.map(e => {
    const item = button('', () => openCard(e.employeeId), 'fc-workforce-item');
    item.dataset.employeeId = e.employeeId;
    item.setAttribute('aria-pressed', String($('card').open && e.employeeId === selectedId));
    const img = node('img'); img.src = portrait(e); img.alt = '';
    const identity = node('span', undefined, 'fc-workforce-identity');
    identity.append(node('strong', e.displayName), node('span', e.position?.title ?? '岗位尚未提供'));
    const context = node('span', e.currentWork?.title ? `当前工作 · ${e.currentWork.title}`
      : e.capabilities?.length ? `岗位声明 · ${capabilityName(e.capabilities[0])}` : '能力依据尚未提供', 'fc-workforce-context');
    item.append(img, identity, pill(e), context);
    item.setAttribute('aria-label', `${e.displayName}，${e.position?.title ?? '岗位尚未提供'}，${availabilityNames[e.availability] ?? '状态未知'}，${context.textContent}`);
    return item;
  });
  $('workforce-list').replaceChildren(...(cards.length ? cards : [node('p', query || filter !== 'all' ? '没有符合条件的员工。' : store.state.connection === CONNECTION.CONNECTING ? '正在读取员工…' : '当前公司暂无员工记录。', 'fc-workforce-empty')]));
  if (focusedId) [...$('workforce-list').querySelectorAll('[data-employee-id]')].find(item => item.dataset.employeeId === focusedId)?.focus({ preventScroll: true });
}
$('workforce-search').addEventListener('input', renderWorkforce);
$('workforce-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    const first = $('workforce-list').querySelector('button');
    if (first) { event.preventDefault(); first.focus(); }
  }
});
$('workforce-filter').addEventListener('change', renderWorkforce);
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
        : `公司记录 · 自动更新${employees.length ? '' : ' · 当前公司暂无员工。'}`;
  renderLobby(state); renderWorkforce(); if ($('roster').open) renderRoster();
  if (requestedEmployeePending && state.connection === CONNECTION.LIVE && (!requestedCompanyId || requestedCompanyId === currentCompany) && activeEmployees().some(e => e.employeeId === requestedEmployeeId)) {
    requestedEmployeePending = false;
    queueMicrotask(() => { if (currentCompany === state.companyId && activeEmployees().some(e => e.employeeId === requestedEmployeeId)) openCard(requestedEmployeeId); });
  }
  if ($('card').open) {
    if (!selected()) closeDialog('card');
    else if (page === 'overview' || page === 'details' || page === 'settings') {
      const signature = JSON.stringify([selected(), cardDetail, state.connection, pending, page]);
      if (signature !== cardSignature) { cardSignature = signature; renderCard(); }
    }
    else { $('card-footer').querySelectorAll('[data-command]').forEach(b => b.disabled = pending || !connected()); }
  }
  const events = state.source === 'mock' ? (state.activity ?? []).slice(0, 3) : [];
  $('feed').replaceChildren(...(events.length ? events.map(e => { const a = node('article'); a.append(node('time', new Date(e.at).toLocaleTimeString('zh-CN')), node('span', e.summary)); return a; }) : [node('div', '目前没有可核对的公司级行动记录。打开员工卡可查看员工近期公开活动。', 'fc-empty')]));
}
const unsubscribe = store.subscribe(render);

function activityList(detail) {
  return detail?.recentActivity ?? [];
}
function overview(e, activationOpen = false) {
  const wrap = node('div', undefined, 'fc-id-inspector');
  const detail = cardDetail ?? null, work = e.currentWork ?? null;
  const identity = node('section', undefined, 'fc-id-hero');
  const photo = node('div', undefined, 'fc-id-portrait'), img = node('img');
  img.src = portrait(e); img.alt = ''; photo.append(img); identity.append(photo);
  const name = node('div', undefined, 'fc-id-intro');
  const heading = node('h2', e.displayName, 'fc-identity-name'); heading.tabIndex = -1;
  name.append(heading, node('p', e.position?.title ?? '岗位尚未提供', 'fc-id-position'), pill(e));
  name.append(node('p', demo ? '模拟员工 · 仅用于交互演示' : '长期员工身份 · 不随 WorkerRun 更换', 'fc-id-tenure'));
  identity.append(name); wrap.append(identity);
  const record = node('div', undefined, 'fc-id-record');
  record.append(node('span', '组织编号'), node('strong', '尚未提供'), node('span', '入职记录'), node('strong', '尚未接入'));
  wrap.append(record);
  if (needsFounderCheck(e)) wrap.append(warning('该员工有多个执行中的尝试，Runtime 尚未确定唯一当前工作。'));

  const now = block('此刻'); now.classList.add('fc-id-section');
  now.append(node('p', e.availability === AVAILABILITY.DISABLED ? '已停用未来派工；历史记录仍可查看。' : work ? `当前工作：${work.title}` : e.availability === AVAILABILITY.WORKING ? '工作中，但当前工作尚未确定。' : '目前可用，没有进行中的工作。'));
  if (work) {
    now.append(node('p', `当前参与：${work.role ? roleNames[work.role] : '角色未提供'}`));
    if (!demo) now.append(button('查看工作线', () => openLineage(work.workId)));
  }
  wrap.append(now);

  const capability = block('能力与依据'); capability.classList.add('fc-id-section');
  if (e.capabilities?.length) for (const id of e.capabilities) {
    const row = node('div', undefined, 'fc-id-capability');
    row.append(node('strong', capabilityName(id)), node('span', '岗位声明'));
    capability.append(row);
  }
  else capability.append(node('p', '岗位尚未声明预期能力。'));
  capability.append(node('p', '当前投影没有逐项能力证据。岗位声明不等于试用验证或已证明；近期交付也不会自动升级能力。', 'fc-id-evidence-note'));
  wrap.append(capability);

  const historyBlock = block('近期记录'); historyBlock.classList.add('fc-id-section');
  historyBlock.append(node('p', '这里只显示当前可核对的有界记录，不代表完整履历。'));
  if (!detail) historyBlock.append(node('p', '正在读取近期交付与公开活动…'));
  else {
    const deliveries = detail.recentDeliveries ?? [];
    for (const item of deliveries.slice(0, 3)) {
      const row = node('div', undefined, 'fc-id-history-item');
      row.append(node('strong', item.title ?? '未命名交付'), node('span', item.workTitle ?? '所属工作未提供'));
      if (item.acceptedState === 'ACCEPTED') row.append(node('small', 'Founder 已接受'));
      else if (item.reviewState === 'PASS') row.append(node('small', '评审通过 · 尚非 Founder 接受'));
      historyBlock.append(row);
    }
    if (!deliveries.length) historyBlock.append(node('p', '当前窗口没有交付记录。'));
    const events = activityList(detail).slice(0, 3);
    for (const event of events) historyBlock.append(node('p', activityText(event), 'fc-id-activity'));
    if (!events.length) historyBlock.append(node('p', '当前窗口没有公开活动。'));
  }
  wrap.append(historyBlock);

  const access = block('访问范围'); access.classList.add('fc-id-section');
  access.append(node('p', '当前员工投影没有权限目录。不能由岗位或能力推断工具访问。'));
  wrap.append(access);
  const activation = node('details', undefined, 'fc-activation-details fc-id-advanced'); activation.open = activationOpen;
  activation.append(node('summary', '本次执行与技术记录'));
  activation.append(node('p', work ? `当前尝试：第 ${work.attempt ?? '—'} 次；上限 ${work.maxAutonomousAttempts ?? '未提供'}。` : '当前没有执行中的尝试。'));
  activation.append(node('p', e.execution ? `执行后端：${[e.execution.backendType, e.execution.backendVersion].filter(Boolean).join(' · ')}` : '执行后端与模型未在当前记录中提供。'));
  activation.append(node('p', '本次工具授权与可用 Skill 尚未接入。'));
  activation.append(node('p', `真实员工 ID：${e.employeeId}`));
  if (e.capabilities?.length) activation.append(node('p', `岗位声明 ID：${e.capabilities.join(' · ')}`));
  if (demo) activation.append(node('p', '以上为模拟员工记录，不代表 Runtime 生产事实。'));
  wrap.append(activation);
  return wrap;
}
function renderCard() {
  const e = selected(); if (!e) return;
  $('card-heading').textContent = '员工身份';
  const body = $('card-body'), scroll = body.scrollTop;
  const focusText = $('card').contains(document.activeElement) ? document.activeElement?.textContent : null;
  const activityScroll = body.querySelector('.fc-mini-log')?.scrollTop ?? 0;
  const activationOpen = body.querySelector('.fc-activation-details')?.open ?? false;
  const title = node('h2', e.displayName); title.id = 'card-title'; title.hidden = true;
  body.replaceChildren(title); $('card-footer').replaceChildren();
  if (!connected()) body.append(notice('Runtime 暂不可用：以下是最后已知投影，写操作与动画已停止。'));
  if (page === 'overview') body.append(overview(e, activationOpen));
  else {
    const titles = { settings: demo ? 'Agent 设置（模拟）' : '员工控制', details: '近期交付与当前尝试', logs: '公开活动历史', assign: '分配任务（模拟）' };
    const head = node('div', undefined, 'fc-subtitle'); head.append(button('← 返回', () => navigate('overview')), node('h2', titles[page])); body.append(head);
    if (page === 'settings') body.append(settings(e));
    if (page === 'details') body.append(details(e));
    if (page === 'logs') body.append(logs(e));
    if (page === 'assign') body.append(assignForm(e));
  }
  if (page === 'overview') {
    const work = e.currentWork;
    if (!demo && work) $('card-footer').append(button('查看工作线', () => openLineage(work.workId)));
    $('card-footer').append(button('近期交付', () => navigate('details')));
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
  section.append(current);
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
$('save-portrait').onclick = () => { if (!imageDraft) return; try { const result = $('crop').toDataURL('image/png'); portraits.set(`${currentCompany}/${selectedId}`, result); avatarDirty = false; closeDialog('avatar'); renderCard(); renderRoster(); $('workforce-list').dataset.signature = ''; renderWorkforce(); toast('已应用本页本地肖像预览；未上传服务器'); } catch { toast('裁剪失败，原肖像未改变'); } };
async function selectCompany(id) { if (!await discard()) { $('company').value = currentCompany; return; } stop(); dirty = false; for (const dialog of ['avatar','lineage','card','roster']) if ($(dialog).open) await closeDialog(dialog, true, false); returnView.card = returnView.avatar = returnView.lineage = null; currentCompany = id; selectedId = undefined; cardDetail = null; store.replace({ companyId: id, source: demo ? 'mock' : 'live', capturedAt: null, summary: { employees: 0, working: 0, available: 0, disabled: 0 }, employees: [] }); initialized = false; stop = adapter.subscribe(id, store); }
$('company').onchange = () => selectCompany($('company').value);
$('demo-controls').hidden = !demo; $('mode-link').hidden = !demo; $('mode-link').href = demo ? embedded ? '/employees?embedded=1' : '/employees' : embedded ? '/employees?demo=1&embedded=1' : '/employees?demo=1'; $('mode-link').textContent = demo ? '返回真实公司 ↗' : '查看模拟演示 ↗';
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
    $('company').disabled = companies.length === 0;
    $('retry-connection').hidden = companies.length > 0;
    if (companies.length) await selectCompany(companies.find(c => c.id === requestedCompanyId)?.id ?? companies[0].id);
    else { $('company').append(node('option', '尚未创建公司')); store.replace({ companyId: null, source: demo ? 'mock' : 'live', capturedAt: null, summary: { employees: 0, working: 0, available: 0, disabled: 0 }, employees: [] }); $('connection').textContent = demo ? '模拟模式已就绪。' : '真实 Runtime 已连接，但尚无公司。请先完成团队的 Company 创建流程；也可查看明确标记的模拟演示。'; }
  } catch (error) { store.connection(CONNECTION.RUNTIME_UNAVAILABLE); $('retry-connection').hidden = false; toast(`连接失败：${error.message}`); }
  finally { $('retry-connection').disabled = false; }
}
$('retry-connection').onclick = boot; await boot();
if (new URLSearchParams(location.search).get('search') === '1') void focusEmployeeSearch();
