// Founder Workspace v0C — the product homepage.
//
// This file renders Experience projections; it owns no Runtime truth and has
// no write path: no request that changes Company truth originates in the
// page, the adapter or the static shell. Selection, open panels and zoom are
// presentation state and live in memory only — never in the Runtime, never
// persisted. Dragging a card changes pixels, never Company reality.
import {
  CONNECTION,
  NAV_ITEMS,
  WorkspaceStore,
  acceptedStateText,
  activityText,
  actionText,
  attentionCount,
  attentionKindText,
  attentionLeadText,
  availabilityText,
  companyMoment,
  conditionText,
  detailBasis,
  freshness,
  lineageEvidence,
  outcomeText,
  pulseStory,
  roleText,
  stageText,
  taskStateText,
  verdictText,
  workerRunStateText,
  workStatusText,
  workIntentText,
} from './domain.mjs';
import { HttpWorkspaceAdapter } from './adapter.mjs';
import { placeAnchoredSurface } from './placement.mjs';
import { clampCardPosition, initialCardPosition } from './board-layout.mjs';
import { SUBPAGES, renderSubpage } from './subpages.mjs';
import { symbol } from './icons.mjs';
import { companyStageModel } from './company-stage.mjs';
import { capabilityText } from './company-hiring-domain.mjs';
import { createSurfaceMotion, surfaceOrigin } from './surface-motion.mjs';

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
const detailTrigger = (element, type, id) => {
  element.dataset.detailType = type;
  element.dataset.detailId = id;
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
function navGlyph(id) {
  const wrap = node('span', 'fc-nav-glyph');
  wrap.append(symbol(id));
  return wrap;
}

const adapter = new HttpWorkspaceAdapter();
const store = new WorkspaceStore();
// Presentation state, in memory only.
const initialMemoryView = () => ({ query: '', type: 'all', freshness: 'all', technicalOpen: false, evidenceId: null, evidence: null, evidenceStatus: null });
const initialHiringView = () => ({ planning: false, roleTitle: '' });
const initialHiringInventory = () => ({ positions: null, employees: null, loading: false, positionError: null, employeeError: null });
let memoryEvidenceEpoch = 0;
let hiringLoadEpoch = 0;
let hiringLastRead = 0;
const view = {
  memory: initialMemoryView(),
  hiringUI: initialHiringView(),
  hiring: initialHiringInventory(),
  boot: 'CONNECTING',
  companies: [],
  companyId: null,
  nav: 'workspace',
  popover: null,
  selection: null,
  detail: null,
  detailError: null,
  actions: new Map(),
  actionErrors: new Map(),
  expandedActionId: null,
  stageNewArtifacts: new Set(),
  attentionOpen: false,
  search: '',
  searchIndex: -1,
  zoom: 1,
  boardPositions: {},
  boardOrder: ['attention', 'deliveries', 'workforce'],
  boardSummary: null,
  boardDetail: null,
  assistantOpen: false,
  presentation: false,
  cardsOpen: false,
  subpageTab: null,
  subpageSelectedId: null,
  composerOpen: false,
  composerIntent: '',
  composerTitle: '',
  works: [],
  workLoading: false,
  workError: null,
};
let stopPolling = () => {};
let detailEpoch = 0;
let actionEpoch = 0;
const actionPending = new Set();
let stageArtifactTimer = null;
let basis = '';
let inspectorReturnFocus = null;
let inspectorFallback = null;
let inspectorSource = null;
let inspectorSourceRect = null;
let inspectorMotion = null;
let inspectorMotionEpoch = 0;
let inspectorClosing = false;
let attentionReturnFocus = null;
let attentionMotion = null;
let attentionMotionEpoch = 0;
let attentionClosing = false;
let searchMotion = null;
let searchDataSignature = '';
let searchMotionEpoch = 0;
let searchClosing = false;
let popoverReturnFocus = null;
let popoverMotionEpoch = 0;
let popoverClosing = false;
let boardClickTimer = null;
let assistantClickTimer = null;
let assistantBubbleEpoch = 0;
let boardDrag = null;
let boardDetailReturnFocus = null;
let boardDetailTransition = false;
let boardDetailClosing = false;
let workLoadEpoch = 0;
let workLastRead = 0;
const reducePopoverMotion = matchMedia('(prefers-reduced-motion: reduce)');
const surfaceMotions = new Map();
const motionFor = (surface) => {
  if (!surfaceMotions.has(surface)) surfaceMotions.set(surface, createSurfaceMotion(surface, { reduced: () => reducePopoverMotion.matches }));
  return surfaceMotions.get(surface);
};
const animateSurface = (surface, open, source) => motionFor(surface).run(open, sourceRect(source), { left: surface.offsetLeft, top: surface.offsetTop, width: surface.offsetWidth, height: surface.offsetHeight });


// --- data ------------------------------------------------------------------

async function boot() {
  render();
  try {
    const companies = await adapter.companies();
    view.boot = 'LIVE';
    view.companies = companies;
    if (companies.length === 0) {
      view.companyId = null;
      store.connection(CONNECTION.LIVE);
      render();
      return;
    }
    const current = companies.some((company) => company.id === view.companyId)
      ? view.companyId
      : companies[0].id;
    openCompany(current);
  } catch {
    view.boot = 'RUNTIME_UNAVAILABLE';
    store.connection(CONNECTION.RUNTIME_UNAVAILABLE);
    render();
    if (!view.companies.length) setTimeout(boot, 3000);
  }
}

function openCompany(companyId) {
  stopPolling();
  forceCloseInspector();
  forceCloseAttention();
  view.companyId = companyId;
  view.selection = null;
  view.detail = null;
  view.detailError = null;
  view.actions.clear();
  view.actionErrors.clear();
  view.expandedActionId = null;
  view.stageNewArtifacts.clear();
  clearTimeout(stageArtifactTimer);
  actionEpoch += 1;
  view.attentionOpen = false;
  closeBoardSummary(false, true);
  closeBoardDetail(false);
  closeAssistantBubble(false, true);
  view.boardPositions = {};
  view.boardOrder = ['attention', 'deliveries', 'workforce'];
  view.works = [];
  view.memory = initialMemoryView();
  memoryEvidenceEpoch += 1;
  view.hiringUI = initialHiringView();
  view.hiring = initialHiringInventory();
  hiringLoadEpoch += 1;
  hiringLastRead = 0;
  view.workLoading = false;
  view.workError = null;
  view.composerIntent = '';
  view.composerTitle = '';
  workLastRead = 0;
  workLoadEpoch += 1;
  inspectorReturnFocus = null;
  inspectorFallback = null;
  inspectorSource = null;
  inspectorSourceRect = null;
  basis = '';
  store.setCompany(companyId);
  render();
  stopPolling = adapter.subscribe(companyId, store);
}

function sourceRect(element) {
  return element?.getBoundingClientRect?.() ?? null;
}

function setSurfacePosition(surface, anchor, desired) {
  const placement = placeAnchoredSurface(anchor, { width: innerWidth, height: innerHeight }, desired);
  surface.style.setProperty('--fc-surface-left', `${placement.left}px`);
  surface.style.setProperty('--fc-surface-top', `${placement.top}px`);
  surface.style.setProperty('--fc-surface-width', `${placement.width}px`);
  surface.dataset.side = placement.side;
  return placement;
}

function sourceFrames(source, target) {
  return surfaceOrigin(source, target);
}

function presentationFrame(element) {
  const style = getComputedStyle(element);
  return { opacity: style.opacity, transform: style.transform };
}

function surfaceBaseRect(element) {
  const style = getComputedStyle(element);
  return {
    left: parseFloat(style.left), top: parseFloat(style.top),
    width: element.offsetWidth, height: element.offsetHeight,
  };
}

function currentSource() {
  if (inspectorSource?.isConnected) return inspectorSource;
  const selection = view.selection;
  if (!selection) return null;
  const candidates = document.querySelectorAll('[data-detail-type][data-detail-id]');
  return [...candidates].find((element) => element.dataset.detailType === selection.type && element.dataset.detailId === selection.id) ?? $('search');
}

function positionAttention() {
  const panel = $('attention-panel');
  const trigger = attentionReturnFocus?.isConnected ? attentionReturnFocus : document.querySelector('.fc-needs-you');
  if (panel.hidden || !trigger || !view.attentionOpen) return;
  const source = trigger.getBoundingClientRect();
  if (source.bottom < 0 || source.top > innerHeight) { void closeAttention(false); return; }
  setSurfacePosition(panel, source, { width: 392, height: Math.min(panel.scrollHeight, innerHeight * .65) });
}

function openAttention(trigger) {
  const panel = $('attention-panel');
  const from = attentionClosing && !panel.hidden ? presentationFrame(panel) : null;
  attentionMotionEpoch += 1;
  attentionMotion?.cancel();
  attentionClosing = false;
  attentionReturnFocus = trigger;
  view.attentionOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  renderAttention(store.state);
  positionAttention();
  if (panel.hidden) return;
  const source = trigger.getBoundingClientRect();
  attentionMotion = panel.animate(
    [from ?? (reducePopoverMotion.matches ? { opacity: 0 } : sourceFrames(source, surfaceBaseRect(panel))), { opacity: 1, transform: 'none' }],
    { duration: reducePopoverMotion.matches ? 90 : 210, easing: 'cubic-bezier(.2,.82,.22,1)' },
  );
  panel.querySelector('.fc-attention-work')?.focus();
}

function forceCloseAttention() {
  attentionMotionEpoch += 1;
  attentionMotion?.cancel();
  view.attentionOpen = false;
  attentionClosing = false;
  attentionReturnFocus?.setAttribute('aria-expanded', 'false');
  const panel = $('attention-panel');
  const focusWasInside = panel.contains(document.activeElement);
  panel.hidden = true;
  panel.replaceChildren();
  panel.dataset.signature = '';
  attentionReturnFocus = null;
  if (focusWasInside) (document.querySelector('.fc-needs-you') ?? $('search')).focus();
}

async function closeAttention(restoreFocus = true) {
  const panel = $('attention-panel');
  if (!view.attentionOpen || attentionClosing) return;
  view.attentionOpen = false;
  attentionClosing = true;
  const epoch = ++attentionMotionEpoch;
  const from = presentationFrame(panel);
  attentionMotion?.cancel();
  const trigger = document.querySelector('.fc-needs-you') ?? attentionReturnFocus;
  trigger?.setAttribute('aria-expanded', 'false');
  const source = sourceRect(trigger);
  if (!panel.hidden && source) {
    attentionMotion = panel.animate(
      [from, reducePopoverMotion.matches ? { opacity: 0 } : sourceFrames(source, surfaceBaseRect(panel))],
      { duration: reducePopoverMotion.matches ? 80 : 160, easing: 'cubic-bezier(.4,0,1,1)' },
    );
    try { await attentionMotion.finished; } catch { /* reopened while closing */ }
  }
  if (epoch !== attentionMotionEpoch) return;
  panel.hidden = true;
  panel.replaceChildren();
  panel.dataset.signature = '';
  attentionClosing = false;
  if (restoreFocus) (trigger?.isConnected ? trigger : $('search')).focus();
  attentionReturnFocus = null;
}

function positionInspector() {
  const dialog = $('inspector');
  if (!dialog.open) return;
  const source = sourceRect(currentSource()) ?? inspectorSourceRect;
  if (!source) return;
  const naturalHeight = $('inspector-body').scrollHeight + dialog.querySelector('.fc-inspector-top').offsetHeight + 2;
  const height = Math.min(naturalHeight, innerHeight * .72, innerHeight - 24);
  setSurfacePosition(dialog, source, { width: 420, height });
  dialog.style.setProperty('--fc-surface-height', `${height}px`);
}

function select(selection, trigger = document.activeElement) {
  const dialog = $('inspector');
  if (!dialog.open) {
    inspectorReturnFocus = trigger;
    inspectorFallback = trigger?.closest?.('#search-results') ? $('search')
      : trigger?.closest?.('#attention-panel') ? document.querySelector('.fc-needs-you')
        : null;
    inspectorSource = trigger;
    inspectorSourceRect = sourceRect(trigger);
  }
  closeSearch();
  closeBoardSummary(false, true);
  closeAssistantBubble(false, true);
  closeAttention(false);
  view.selection = selection;
  view.detail = null;
  view.detailError = null;
  detailEpoch += 1;
  basis = detailBasis(store.state.projection);
  render();
  if (!dialog.open) {
    dialog.showModal();
    positionInspector();
    const source = inspectorSourceRect;
    const target = surfaceBaseRect(dialog);
    inspectorMotion?.cancel();
    inspectorMotionEpoch += 1;
    if (source) inspectorMotion = dialog.animate(
      [reducePopoverMotion.matches ? { opacity: 0 } : sourceFrames(source, target), { opacity: 1, transform: 'none' }],
      { duration: reducePopoverMotion.matches ? 90 : 210, easing: 'cubic-bezier(.2,.82,.22,1)' },
    );
  } else {
    const from = inspectorClosing ? presentationFrame(dialog) : null;
    inspectorMotionEpoch += 1;
    inspectorMotion?.cancel();
    inspectorClosing = false;
    positionInspector();
    if (from) inspectorMotion = dialog.animate([from, { opacity: 1, transform: 'none' }], { duration: reducePopoverMotion.matches ? 90 : 210, easing: 'cubic-bezier(.2,.82,.22,1)' });
  }
  $('inspector-close').focus();
  void loadDetail();
  void refreshActions();
}

function forceCloseInspector() {
  inspectorMotionEpoch += 1;
  inspectorMotion?.cancel();
  inspectorClosing = false;
  if ($('inspector').open) $('inspector').close();
}

async function closeInspector() {
  const dialog = $('inspector');
  if (!dialog.open || inspectorClosing) return;
  inspectorClosing = true;
  const epoch = ++inspectorMotionEpoch;
  const from = presentationFrame(dialog);
  inspectorMotion?.cancel();
  const source = sourceRect(currentSource()) ?? inspectorSourceRect;
  if (source) {
    inspectorMotion = dialog.animate(
      [from, reducePopoverMotion.matches ? { opacity: 0 } : sourceFrames(source, surfaceBaseRect(dialog))],
      { duration: reducePopoverMotion.matches ? 80 : 160, easing: 'cubic-bezier(.4,0,1,1)' },
    );
    try { await inspectorMotion.finished; } catch { /* a new selection took over */ }
  }
  if (epoch !== inspectorMotionEpoch) return;
  const returnTo = inspectorReturnFocus?.isConnected ? inspectorReturnFocus
    : inspectorFallback?.isConnected ? inspectorFallback : currentSource();
  forceCloseInspector();
  detailEpoch += 1;
  view.selection = null;
  view.detail = null;
  view.detailError = null;
  render();
  (returnTo ?? $('search')).focus();
  inspectorReturnFocus = null;
  inspectorFallback = null;
  inspectorSource = null;
  inspectorSourceRect = null;
}

function openPagePopover(id, trigger, options = {}) {
  const item = NAV_ITEMS.find((entry) => entry.id === id);
  if (!item || id === 'workspace') return;
  const dialog = $('page-popover');
  const alreadyOpen = dialog.open;
  const wasClosing = popoverClosing;
  popoverClosing = false;
  popoverMotionEpoch += 1;
  if (!alreadyOpen || !dialog.contains(trigger)) popoverReturnFocus = trigger;
  view.popover = id;
  if (id === 'knowledge') { view.memory = initialMemoryView(); memoryEvidenceEpoch += 1; }
  if (id === 'hiring') view.hiringUI = initialHiringView();
  view.subpageTab = options.tab ?? SUBPAGES[id]?.tabs[0][0] ?? null;
  view.subpageSelectedId = options.selectedId ?? null;
  view.composerOpen = Boolean(options.compose);
  dialog.dataset.closing = 'false';
  dialog.dataset.size = id === 'employees' ? 'wide' : 'subpage';
  $('page-popover-title').textContent = SUBPAGES[id]?.title ?? item.label;
  $('page-popover-mark').replaceChildren(symbol(id));
  const frame = $('page-popover-frame');
  const content = $('page-popover-content');
  content.dataset.signature = '';
  content.scrollTop = 0;
  frame.hidden = id !== 'employees';
  content.hidden = id === 'employees';
  if (id === 'employees') {
    const params = new URLSearchParams({ embedded: '1' });
    if (view.companyId) params.set('company', view.companyId);
    if (options.selectedId) params.set('employee', options.selectedId);
    frame.src = `/employees?${params}`;
  }
  else renderCurrentSubpage(true);
  closeSearch();
  closeBoardSummary(false, true);
  closeAssistantBubble(false, true);
  forceCloseAttention();
  if (!alreadyOpen) dialog.showModal();
  const source = trigger.getBoundingClientRect();
  const surface = dialog.getBoundingClientRect();
  const anchorPreview = $('page-popover-anchor');
  anchorPreview.replaceChildren(navGlyph(id));
  anchorPreview.style.setProperty('--fc-anchor-left', `${source.left - surface.left}px`);
  anchorPreview.style.setProperty('--fc-anchor-top', `${source.top - surface.top}px`);
  anchorPreview.style.setProperty('--fc-anchor-width', `${source.width}px`);
  anchorPreview.style.setProperty('--fc-anchor-height', `${source.height}px`);
  if (!alreadyOpen || wasClosing) void animateSurface(dialog, true, popoverReturnFocus);
  $('page-popover-close').focus();
  renderNav();
  if (id === 'work' || id === 'artifacts' || id === 'knowledge') void loadWorks();
  if (id === 'hiring') void loadHiringInventory();
}

function showEmployeeIdentity(employeeId, trigger) {
  if (!employeeId) return;
  const navEntry = $('nav').querySelector('[data-nav-id="employees"]');
  const anchor = trigger?.closest?.('#inspector') ? navEntry : trigger;
  forceCloseInspector();
  detailEpoch += 1;
  view.selection = null;
  view.detail = null;
  view.detailError = null;
  openPagePopover('employees', anchor ?? navEntry, { selectedId: employeeId });
}

async function closePagePopover() {
  const dialog = $('page-popover');
  if (!dialog.open || popoverClosing) return;
  const epoch = ++popoverMotionEpoch;
  if (view.popover === 'employees') {
    const canClose = $('page-popover-frame').contentWindow?.requestEmbeddedClose;
    if (typeof canClose === 'function' && !await canClose()) return;
    if (epoch !== popoverMotionEpoch) return;
  }
  popoverClosing = true;
  dialog.dataset.closing = 'true';
  const finished = await animateSurface(dialog, false, popoverReturnFocus);
  if (!finished || epoch !== popoverMotionEpoch) return;
  dialog.close();
  popoverClosing = false;
}

async function loadWorks() {
  if (!view.companyId || view.workLoading || store.state.connection !== CONNECTION.LIVE) return;
  const epoch = ++workLoadEpoch;
  const companyId = view.companyId;
  view.workLoading = true;
  renderCurrentSubpage();
  try {
    const inventory = await adapter.works(companyId);
    const reads = await Promise.allSettled(inventory.map((work) => adapter.lineage(work.id)));
    if (epoch !== workLoadEpoch || companyId !== view.companyId) return;
    view.works = inventory.map((work, index) => ({ work, lineage: reads[index].status === 'fulfilled' ? reads[index].value : null }));
    view.workError = reads.some((entry) => entry.status === 'rejected') ? '部分工作线读取失败，请稍后重试。' : null;
    workLastRead = Date.now();
  } catch (error) {
    if (epoch !== workLoadEpoch) return;
    view.workError = error?.message ?? '无法读取工作清单。';
    workLastRead = Date.now();
  } finally {
    if (epoch === workLoadEpoch) {
      view.workLoading = false;
      renderCurrentSubpage(true);
    }
  }
}

async function loadHiringInventory() {
  if (!view.companyId || view.hiring.loading || store.state.connection !== CONNECTION.LIVE) return;
  const epoch = ++hiringLoadEpoch;
  const companyId = view.companyId;
  view.hiring.loading = true;
  renderCurrentSubpage();
  const [positions, employees] = await Promise.allSettled([adapter.positions(companyId), adapter.employees(companyId)]);
  if (epoch !== hiringLoadEpoch || companyId !== view.companyId) return;
  view.hiring.positions = positions.status === 'fulfilled' && Array.isArray(positions.value) ? positions.value : null;
  view.hiring.employees = employees.status === 'fulfilled' && Array.isArray(employees.value) ? employees.value : null;
  view.hiring.positionError = view.hiring.positions ? null : '岗位清单暂不可读取。';
  view.hiring.employeeError = view.hiring.employees ? null : '员工关联暂不可读取。';
  view.hiring.loading = false;
  hiringLastRead = Date.now();
  renderCurrentSubpage(true);
}

async function loadMemoryEvidence(record) {
  const companyId = view.companyId;
  const epoch = ++memoryEvidenceEpoch;
  const sourceId = view.subpageSelectedId;
    Object.assign(view.memory, { evidenceId: record.artifactId, evidenceWorkId: record.workId, evidenceTitle: record.title, evidence: null, evidenceStatus: 'loading', evidenceBodyOpen: false });
  renderCurrentSubpage(true);
  $('page-popover-content').querySelector('.fc-memory-inspector')?.focus();
  try {
    const reading = await adapter.artifactReading(record.artifactId);
    if (epoch !== memoryEvidenceEpoch || companyId !== view.companyId || sourceId !== view.subpageSelectedId || view.popover !== 'knowledge') return;
    if (!reading || reading.artifactId !== record.artifactId || reading.workId !== record.workId) throw new Error('Evidence linkage mismatch');
    view.memory.evidence = reading;
    view.memory.evidenceStatus = 'ready';
  } catch {
    if (epoch !== memoryEvidenceEpoch || companyId !== view.companyId || sourceId !== view.subpageSelectedId || view.popover !== 'knowledge') return;
    view.memory.evidenceStatus = 'error';
  }
  renderCurrentSubpage(true);
}

function renderCurrentSubpage(force = false) {
  const id = view.popover;
  if (!SUBPAGES[id]) return;
  const content = $('page-popover-content');
  const state = store.state;
  const signature = JSON.stringify([id, view.subpageTab, view.subpageSelectedId, view.composerOpen, id === 'knowledge' ? view.memory : null, id === 'hiring' ? view.hiringUI : null, id === 'hiring' ? view.hiring : null, view.works, view.workLoading, view.workError, state.projection, state.connection, id === 'settings' ? state.capturedAt : null]);
  if (!force && content.dataset.signature === signature) return;
  const oldTab = content.querySelector('[role="tab"][aria-selected="true"]');
  const oldTabRect = oldTab?.getBoundingClientRect();
  const oldTabLabel = oldTab?.textContent;
  content.dataset.signature = signature;
  const scroll = content.scrollTop;
  const memoryScroll = content.querySelector('.fc-memory-inspector')?.scrollTop;
  const memoryReadingKey = content.querySelector('.fc-memory')?.dataset.readingKey;
  const memoryListKey = content.querySelector('.fc-memory')?.dataset.listKey;
  const memoryListScroll = content.querySelector('.fc-memory-list')?.scrollTop;
  const focused = content.contains(document.activeElement) ? document.activeElement : null;
  const focusedRecord = focused?.dataset.recordId;
  const focusedBack = focused?.classList?.contains('fc-sub-back');
  const memoryFocus = focused?.dataset.memoryFocus;
  const focusedField = focused?.getAttribute('aria-label');
  const focusedTab = focused?.getAttribute('role') === 'tab';
  const selection = focusedField && typeof focused.selectionStart === 'number'
    ? [focused.selectionStart, focused.selectionEnd] : null;
  renderSubpage(content, {
    id, tab: view.subpageTab, selectedId: view.subpageSelectedId,
    composerOpen: view.composerOpen, works: view.works, loading: view.workLoading,
    composerIntent: view.composerIntent, composerTitle: view.composerTitle,
    error: view.workError, projection: state.projection, connection: state.connection,
    capturedAt: state.capturedAt,
    memory: view.memory,
    hiring: view.hiring,
    hiringUI: view.hiringUI,
    onHiring: (patch, render = true) => { if (patch.planning === true) view.subpageSelectedId = null; Object.assign(view.hiringUI, patch); if (render) { renderCurrentSubpage(true); if ('planning' in patch) content.querySelector(patch.planning ? '.fc-hiring-plan input' : '.fc-hiring-primary')?.focus(); } },
    onMemory: (patch, render = true) => { if (['query', 'type', 'freshness'].some(key => key in patch)) { view.subpageSelectedId = null; Object.assign(view.memory, { evidenceId: null, evidence: null }); memoryEvidenceEpoch += 1; } else if ('evidenceId' in patch) memoryEvidenceEpoch += 1; Object.assign(view.memory, patch); if (render) { renderCurrentSubpage(true); if ('evidenceId' in patch && !patch.evidenceId) content.querySelector('.fc-memory-inspector')?.focus({ preventScroll: true }); } },
    onMemoryEvidence: (record) => void loadMemoryEvidence(record),
    onMemoryRetry: () => void loadWorks(),
    company: view.companies.find((item) => item.id === view.companyId),
    onTab: (tab) => { if (id === 'knowledge') { view.memory = initialMemoryView(); memoryEvidenceEpoch += 1; } view.subpageTab = tab; view.subpageSelectedId = null; content.scrollTop = 0; renderCurrentSubpage(true); content.querySelector('[role="tab"][aria-selected="true"]')?.focus(); },
    onSelect: (selectedId) => { const previous = view.subpageSelectedId; view.subpageSelectedId = selectedId; if (id === 'hiring' && selectedId) view.hiringUI = initialHiringView(); if (id === 'knowledge') { memoryEvidenceEpoch += 1; Object.assign(view.memory, { evidenceId: null, evidence: null, technicalOpen: false }); } content.scrollTop = 0; renderCurrentSubpage(true); const narrow = matchMedia(id === 'knowledge' || id === 'hiring' ? '(max-width: 900px)' : '(max-width: 700px)').matches; if (selectedId && narrow) content.querySelector('.fc-sub-back')?.focus(); else [...content.querySelectorAll('.fc-sub-row')].find(row => row.dataset.recordId === (selectedId || previous))?.focus({ preventScroll: (id === 'knowledge' || id === 'hiring') && !narrow }); },
    onNavigate: (nextId, tab, selectedId) => openPagePopover(nextId, $('page-popover-close'), { tab, selectedId }),
    onCompose: () => { view.composerOpen = true; renderCurrentSubpage(true); content.querySelector('textarea')?.focus(); },
    onComposerClose: () => { view.composerOpen = false; renderCurrentSubpage(true); },
    onDraft: (field, value) => { if (field === 'intent') view.composerIntent = value; else view.composerTitle = value; },
  });
  content.scrollTop = scroll;
  if (memoryScroll !== undefined && memoryReadingKey === content.querySelector('.fc-memory')?.dataset.readingKey && content.querySelector('.fc-memory-inspector')) content.querySelector('.fc-memory-inspector').scrollTop = memoryScroll;
  if (memoryListScroll !== undefined && memoryListKey === content.querySelector('.fc-memory')?.dataset.listKey && content.querySelector('.fc-memory-list')) content.querySelector('.fc-memory-list').scrollTop = memoryListScroll;
  const selectedTab = content.querySelector('[role="tab"][aria-selected="true"]');
  const indicator = content.querySelector('.fc-sub-selection');
  if (selectedTab && indicator) {
    const rect = selectedTab.getBoundingClientRect();
    indicator.style.left = `${selectedTab.offsetLeft}px`;
    indicator.style.top = `${selectedTab.offsetTop}px`;
    indicator.style.width = `${selectedTab.offsetWidth}px`;
    indicator.style.height = `${selectedTab.offsetHeight}px`;
    if (oldTabRect && oldTabLabel !== selectedTab.textContent && !reducePopoverMotion.matches) {
      indicator.animate([{ transform: `translateX(${oldTabRect.left - rect.left}px) scaleX(${oldTabRect.width / rect.width})` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.82,.22,1)' });
    }
  }
  const nextFocus = focusedBack ? content.querySelector('.fc-sub-back') : memoryFocus ? [...content.querySelectorAll('[data-memory-focus]')].find(entry => entry.dataset.memoryFocus === memoryFocus) : focusedRecord
    ? [...content.querySelectorAll('[data-record-id]')].find((entry) => entry.dataset.recordId === focusedRecord)
    : focusedField
      ? [...content.querySelectorAll('[aria-label]')].find((entry) => entry.getAttribute('aria-label') === focusedField)
      : focusedTab ? content.querySelector('[role="tab"][aria-selected="true"]') : null;
  if (nextFocus) {
    nextFocus.focus({ preventScroll: id === 'knowledge' });
    if (selection && typeof nextFocus.setSelectionRange === 'function') nextFocus.setSelectionRange(...selection);
  }
}

async function loadDetail() {
  const selection = view.selection;
  if (!selection) {
    render();
    return;
  }
  const epoch = ++detailEpoch;
  try {
    const detail = selection.type === 'EMPLOYEE'
      ? await adapter.employeeDetail(selection.id)
      : selection.type === 'DELIVERY'
        ? await adapter.artifactReading(selection.id)
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
  if (selection.type === 'EMPLOYEE') void refreshActions();
}

// Live receipts are held by the current Host process. They can change even
// when the durable Workspace projection has not changed.
async function refreshActions() {
  if (store.state.connection !== CONNECTION.LIVE) return;
  const ids = new Set([
    store.state.projection?.primaryWork?.lineage?.work?.workId,
    view.selection?.type === 'WORK' ? view.selection.id : null,
    view.selection?.type === 'EMPLOYEE' ? view.detail?.currentWork?.workId : null,
  ].filter(Boolean));
  const epoch = actionEpoch;
  for (const workId of ids) {
    if (actionPending.has(workId)) continue;
    actionPending.add(workId);
    try {
      const action = await adapter.liveAction(workId);
      if (epoch !== actionEpoch || store.state.connection !== CONNECTION.LIVE) continue;
      const previous = view.actions.get(workId);
      if (previous && workId === store.state.projection?.primaryWork?.lineage?.work?.workId) {
        const known = new Set((previous.artifacts ?? []).map((item) => item.artifactId));
        const appeared = (action.artifacts ?? []).filter((item) => !known.has(item.artifactId));
        if (appeared.length) {
          for (const item of appeared) view.stageNewArtifacts.add(item.artifactId);
          clearTimeout(stageArtifactTimer);
          stageArtifactTimer = setTimeout(() => { view.stageNewArtifacts.clear(); render(); }, 700);
        }
      }
      view.actions.set(workId, action);
      view.actionErrors.delete(workId);
      render();
    } catch (error) {
      if (epoch !== actionEpoch) continue;
      view.actionErrors.set(workId, error?.message ?? '行动投影不可用');
      render();
    } finally {
      actionPending.delete(workId);
    }
  }
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
  app.dataset.presentation = String(view.presentation);
  app.dataset.cardsOpen = String(view.cardsOpen);
  renderNav();
  renderTopbar(state);
  renderCanvas(state);
  renderBoard(state);
  renderAssistant(state);
  renderInspector(state);
  renderAttention(state);
  renderZoom();
  renderCurrentSubpage();
  positionInspector();
  if (view.search && !searchClosing && searchDataSignature !== JSON.stringify(searchItems(state.projection))) renderSearchResults();
}

function renderNav() {
  const nav = $('nav');
  fill(nav, 'nav', () => {
    const items = NAV_ITEMS.map((item) => {
      const glyph = navGlyph(item.id);
      let element;
      if (item.kind === 'LINK') {
        element = node('a', 'fc-nav-item');
        element.href = item.href;
        element.addEventListener('click', (event) => {
          event.preventDefault();
          openPagePopover(item.id, element);
        });
        element.append(glyph, node('span', undefined, item.label), node('span', 'fc-nav-out', '↗'));
      } else {
        element = button('fc-nav-item', () => {
          if (item.id === 'workspace') {
            view.nav = 'workspace';
            forceCloseAttention();
            render();
          } else openPagePopover(item.id, element);
        });
        element.append(glyph, node('span', undefined, item.label));
      }
      element.dataset.navId = item.id;
      element.setAttribute('aria-label', item.label);
      if (item.id !== 'workspace') {
        element.setAttribute('aria-haspopup', 'dialog');
        element.setAttribute('aria-controls', 'page-popover');
      }
      return element;
    });
    const more = node('details', 'fc-nav-more');
    const summary = node('summary');
    summary.append(node('span', 'fc-nav-more-glyph', '···'), node('span', undefined, '更多'));
    const cardsToggle = button('fc-nav-cards-toggle', () => {
      view.cardsOpen = !view.cardsOpen;
      if (!view.cardsOpen) closeBoardSummary(false, true);
      more.open = false;
      render();
    }, '画布卡片');
    const menu = node('div', 'fc-nav-more-menu');
    menu.append(cardsToggle);
    more.append(summary, menu);
    const ordered = ['workspace', 'work', 'employees', 'hiring', 'artifacts', 'knowledge', 'settings'];
    return [...ordered.map((id) => items.find((item) => item.dataset.navId === id)), more];
  });
  const cardsToggle = nav.querySelector('.fc-nav-cards-toggle');
  cardsToggle?.setAttribute('aria-expanded', String(view.cardsOpen));
  if (cardsToggle) {
    cardsToggle.textContent = view.cardsOpen ? '收起画布卡片' : '展开画布卡片';
    cardsToggle.setAttribute('aria-label', cardsToggle.textContent);
  }
  for (const element of nav.querySelectorAll('[data-nav-id]')) {
    if (element.dataset.navId === view.nav) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
    if (element.dataset.navId !== 'workspace') element.setAttribute('aria-expanded', String(element.dataset.navId === view.popover));
  }
}

function renderTopbar(state) {
  $('presentation-toggle').replaceChildren(symbol('fit'), node('span', undefined, view.presentation ? '退出演示' : '演示视图'));
  $('presentation-toggle').setAttribute('aria-label', view.presentation ? '退出演示视图' : '演示视图');
  $('presentation-toggle').setAttribute('aria-pressed', String(view.presentation));
  const status = $('runtime-status');
  status.dataset.state = state.connection;
  status.textContent = state.connection === CONNECTION.LIVE
    ? view.companies.length === 0 ? 'Runtime 可读' : '运行中'
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
  $('company').disabled = view.companies.length === 0;

  const newWork = $('new-work');
  newWork.disabled = !view.companyId;
  newWork.title = '打开工作意图编辑器；提交功能尚未接入。';
  newWork.removeAttribute('aria-disabled');
}

function renderCanvas(state) {
  const container = $('canvas-content');
  const focused = document.activeElement?.closest?.('[data-stage-key]')?.dataset.stageKey;
  const previousSignature = container.dataset.signature;
  fill(
    container,
    JSON.stringify([view.nav, state.connection, view.boot, view.companies.length, state.projection,
      view.actions.get(state.projection?.primaryWork?.lineage?.work?.workId) ?? null,
      [...view.stageNewArtifacts]]),
    () => buildCanvas(state),
  );
  if (focused && previousSignature !== container.dataset.signature)
    ([...container.querySelectorAll('[data-stage-key]')].find((entry) => entry.dataset.stageKey === focused)
      ?? container.querySelector('.fc-primary-open'))?.focus({ preventScroll: true });
}

function buildCanvas(state) {
  if (view.nav !== 'workspace') return [];
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
  parts.push(companyWelcome(projection));
  parts.push(attentionCount(projection) > 0 ? needsYouRow(attentionCount(projection)) : noAttention());
  const stage = node('div', 'fc-company-stage fc-company-stage-focused');
  stage.setAttribute('aria-label', '公司画布');
  if (projection.primaryWork) {
    const wires = node('div', 'fc-stage-wires');
    wires.setAttribute('aria-hidden', 'true');
    stage.append(wires, primaryCard(projection));
  } else {
    const empty = emptyState('◌', '还没有主要工作', 'Runtime 中尚无 Work。新建 Work 的产品流程开放后，工作会在这里出现。');
    empty.classList.add('fc-primary-empty');
    stage.append(empty);
  }
  parts.push(stage);
  return parts;
}

function companyWelcome(projection) {
  const hero = node('section', 'fc-welcome');
  const intro = node('div');
  intro.append(node('p', 'fc-company-name', projection.company?.name ?? '你的公司'));
  intro.append(node('h1', undefined, projection.primaryWork ? '公司的当前工作' : '公司的下一步'));
  const working = projection.workforce?.working ?? 0;
  const attention = attentionCount(projection);
  intro.append(node('p', 'fc-welcome-subtitle', `${working} 位员工正在执行 · ${attention} 件事等待你处理`));
  hero.append(intro);
  return hero;
}

function noAttention() {
  const card = node('section', 'fc-needs-row fc-needs-idle');
  card.append(node('span', 'fc-needs-symbol', '✓'));
  const copy = node('span');
  copy.append(node('strong', undefined, '目前不需要你处理'), node('small', undefined, '工作与交付仍可继续查看'));
  card.append(copy);
  return card;
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

function needsYouRow(count) {
  const row = node('div', 'fc-needs-row');
  const bubble = button(
    'fc-needs-you',
    (event) => view.attentionOpen ? void closeAttention() : openAttention(event.currentTarget),
    '',
  );
  bubble.append(node('span', 'fc-needs-symbol', String(count)));
  const copy = node('span');
  copy.append(node('strong', undefined, '需要你处理'), node('small', undefined, `${count} 件事等待你的决定或授权`));
  bubble.append(copy, node('span', 'fc-needs-chevron', '›'));
  bubble.setAttribute('aria-expanded', String(view.attentionOpen));
  bubble.setAttribute('aria-controls', 'attention-panel');
  row.append(bubble);
  row.append(button('fc-link-btn', (event) => openPagePopover('work', event.currentTarget, { tab: 'needs' }), '查看全部待处理 ↗'));
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
  main.append(node('span', 'fc-eyebrow', '当前工作'));
  main.append(node('h2', undefined, lineage.work.title ?? '未命名工作'));
  const meta = node('div', 'fc-primary-meta');
  const status = workStatusText(lineage.work.status);
  const stage = stageText(lineage.work.stage);
  meta.append(chip(
    status,
    lineage.work.status === 'READY_FOR_DECISION' ? 'accent' : null,
  ));
  if (stage !== status && lineage.work.stage === 'INTERRUPTED') meta.append(chip(stage, 'warm'));
  main.append(meta);
  if (lineage.work.intent) main.append(node('p', 'fc-primary-intent', workIntentText(lineage.work.intent)));
  head.append(main);
  const actions = node('div', 'fc-primary-actions');
  const open = detailTrigger(button('fc-primary-open', (event) => select({ type: 'WORK', id: lineage.work.workId }, event.currentTarget)), 'WORK', lineage.work.workId);
  open.append(symbol('arrowUpRight'));
  open.setAttribute('aria-label', '查看工作详情');
  open.title = '查看工作详情';
  actions.append(open);
  head.append(actions);
  card.append(head);
  const liveAction = view.actions.get(lineage.work.workId);
  if (liveAction) card.append(companyStageScene(liveAction, lineage));
  else card.append(workSceneTeam(lineage), lineageFlow(lineage), actionTrail(lineage));
  return card;
}

function companyStageScene(action, lineage) {
  const model = companyStageModel(action);
  const scene = node('div', 'fc-stage-scene');
  scene.dataset.moment = model.moment.kind;
  const moment = node('div', 'fc-stage-now');
  const momentCopy = node('div');
  momentCopy.append(node('span', 'fc-stage-kicker', model.moment.kind === 'RUNNING' ? '正在进行' : '公司此刻'),
    node('strong', undefined, model.moment.text));
  moment.append(momentCopy, detailTrigger(button('fc-stage-now-detail', (event) => select({ type: 'WORK', id: lineage.work.workId }, event.currentTarget), '查看依据 ↗'), 'WORK', lineage.work.workId));
  scene.append(moment);

  const columns = node('div', 'fc-stage-columns');
  columns.append(stagePhase('员工协作', model.contributors, action.work.id));
  if (model.handoffs.length) {
    const handoff = stagePhase('交付汇合', model.handoffs, action.work.id);
    handoff.dataset.handoff = 'true';
    columns.append(handoff);
  }
  if (model.reviews.length) columns.append(stagePhase('独立评审', model.reviews, action.work.id));
  if (model.repairs.length) columns.append(stagePhase('修订', model.repairs, action.work.id));
  scene.append(columns);
  if (model.founderWaiting || model.decisionRecorded) {
    const founder = node('section', 'fc-stage-phase fc-stage-founder');
    founder.append(node('h3', undefined, 'Founder 决定'));
    const trigger = button('fc-stage-founder-action', (event) => {
      if (model.founderWaiting && attentionCount(store.state.projection) > 0) openAttention(event.currentTarget);
      else select({ type: 'WORK', id: lineage.work.workId }, event.currentTarget);
    }, model.decisionRecorded ? '已记录你的接受决定' : '有事项等待你处理');
    trigger.dataset.stageKey = 'founder';
    founder.append(trigger);
    scene.append(founder);
  }
  const boundary = node('p', 'fc-stage-boundary',
    '员工归属保持不变；这里只呈现当前 Work 的真实任务、依赖和交付。完整行动收据在工作详情中。');
  scene.append(boundary);
  return scene;
}

function stagePhase(title, tasks, workId) {
  const phase = node('section', 'fc-stage-phase');
  phase.append(node('h3', undefined, title));
  if (!tasks.length) {
    phase.append(node('p', 'fc-stage-empty', '当前没有已记录任务。'));
    return phase;
  }
  const list = node('div', 'fc-stage-people');
  for (const task of tasks) list.append(stageTask(task, workId));
  phase.append(list);
  return phase;
}

function stageTask(task, workId) {
  const item = node('article', 'fc-stage-task');
  item.dataset.state = task.state ?? '';
  const head = node('div', 'fc-stage-task-head');
  if (task.employeeId) {
    const employee = detailTrigger(button('fc-stage-person', (event) => showEmployeeIdentity(task.employeeId, event.currentTarget), task.employeeName ?? '员工'), 'EMPLOYEE', task.employeeId);
    employee.dataset.stageKey = `employee:${task.employeeId}`;
    employee.prepend(avatar(task.employeeId));
    head.append(employee);
  } else head.append(node('span', 'fc-stage-unassigned', '待指派'));
  head.append(chip(taskStateText(task.state), task.state === 'COMPLETED' ? 'ok' : task.state === 'INTERRUPTED' ? 'warm' : 'quiet'));
  item.append(head, node('p', 'fc-stage-task-title', task.title ?? '未命名任务'));
  if (task.barrier) item.append(node('p', 'fc-stage-barrier',
    task.barrier.ready ? '上游输入已齐备' : `等待上游输入 · ${task.barrier.fulfilled}/${task.barrier.required}`));
  if (task.artifacts.length) {
    const flow = node('div', 'fc-stage-artifacts');
    for (const artifact of task.artifacts) {
      const artifactButton = detailTrigger(button('fc-stage-artifact', (event) => select({ type: 'DELIVERY', id: artifact.artifactId, workId }, event.currentTarget), artifact.title ?? '已交付产物'), 'DELIVERY', artifact.artifactId);
      artifactButton.dataset.stageKey = `artifact:${artifact.artifactId}`;
      if (view.stageNewArtifacts.has(artifact.artifactId)) artifactButton.dataset.new = 'true';
      flow.append(artifactButton);
    }
    item.append(flow);
  }
  return item;
}

function workSceneTeam(lineage) {
  const section = node('div', 'fc-work-team');
  section.append(node('span', 'fc-work-team-label', '这份工作的参与者'));
  const people = new Map((lineage.steps ?? []).filter((step) => step.employeeId && step.employeeName).map((step) => [step.employeeId, step.employeeName]));
  if (people.size === 0) section.append(node('span', 'fc-work-team-empty', '尚未记录员工指派'));
  else for (const [id, name] of people) section.append(detailTrigger(button('fc-work-team-person', (event) => showEmployeeIdentity(id, event.currentTarget), name), 'EMPLOYEE', id));
  return section;
}

function actionTrail(lineage) {
  const section = node('section', 'fc-action-trail');
  section.append(node('h3', undefined, '可核对的行动'));
  const events = lineageEvidence(lineage);
  if (events.length === 0) {
    section.append(node('p', undefined, '当前工作线尚无交付或评审记录。'));
    return section;
  }
  const list = node('ol');
  for (const event of events) {
    const item = node('li');
    item.dataset.kind = event.kind;
    if (event.artifactId) item.append(detailTrigger(button('fc-action-link', (click) => select({ type: 'DELIVERY', id: event.artifactId, workId: lineage.work.workId }, click.currentTarget), event.text), 'DELIVERY', event.artifactId));
    else item.append(node('span', undefined, event.text));
    list.append(item);
  }
  section.append(list);
  section.append(node('p', 'fc-action-boundary', '只显示当前工作线中可核对的交付与评审；工具行动与依赖关系目前无法在这里核对。'));
  return section;
}

function modeChip(action, stale = false) {
  if (stale) return chip('最后已知 · 已过期', 'warm');
  if (action?.executionMode === 'SIMULATED_EXECUTION') return chip('LIVE Runtime · 模拟执行', 'warm');
  if (action?.executionMode === 'LOCAL_EXECUTION') return chip('LIVE Runtime · 本机执行', 'ok');
  return chip('LIVE Runtime · 无执行后端', 'quiet');
}

function workGraph(action) {
  const graph = node('div', 'fc-work-graph');
  const header = node('div', 'fc-work-graph-head');
  header.append(node('strong', undefined, 'Work Graph'), modeChip(action, store.state.connection !== CONNECTION.LIVE));
  graph.append(header);
  const nodes = action.graph?.nodes ?? [];
  if (!nodes.length) {
    graph.append(node('p', 'fc-inspector-note', '这份 Work 尚无任务。'));
    return graph;
  }
  const incoming = new Map(nodes.map((task) => [task.taskId,
    (action.graph?.dependencies ?? []).filter((edge) => edge.toTaskId === task.taskId)]));
  const groups = [
    ['分工任务', nodes.filter((task) => task.role === 'EXECUTION' && !incoming.get(task.taskId)?.length)],
    ['汇总与交接', nodes.filter((task) => task.role === 'EXECUTION' && incoming.get(task.taskId)?.length)],
    ['独立评审', nodes.filter((task) => task.role === 'REVIEW')],
    ['修订', nodes.filter((task) => task.role === 'REPAIR')],
  ];
  for (const [label, tasks] of groups) {
    if (!tasks.length) continue;
    const lane = node('div', 'fc-graph-lane');
    lane.append(node('span', 'fc-graph-lane-label', label));
    const cards = node('div', 'fc-graph-cards');
    for (const task of tasks) {
      const card = node('div', 'fc-graph-task');
      card.dataset.state = task.state ?? '';
      card.append(node('strong', undefined, task.employeeName ?? '未指派'),
        node('span', undefined, task.title ?? '任务'),
        chip(taskStateText(task.state), 'quiet'));
      if (task.barrier) card.append(node('small', 'fc-graph-barrier',
        `上游产物 ${task.barrier.fulfilled}/${task.barrier.required}${task.barrier.ready ? ' · 输入齐备' : ' · 等待输入'}`));
      if (task.workerRunState === 'RUNNING' && store.state.connection === CONNECTION.LIVE)
        card.append(node('small', 'fc-graph-active', '● WorkerRun 进行中'));
      for (const artifactId of task.artifactIds ?? [])
        card.append(detailTrigger(button('fc-graph-artifact', (event) => select({ type: 'DELIVERY', id: artifactId, workId: action.work.id }, event.currentTarget), '查看交付 →'), 'DELIVERY', artifactId));
      cards.append(card);
    }
    lane.append(cards);
    graph.append(lane);
  }
  graph.append(node('p', 'fc-graph-evidence', action.graph?.parallelObserved
    ? `已记录 ${action.graph.overlappingRunIds.length} 个发生时间重叠的 WorkerRun。`
    : '尚无可证明 WorkerRun 时间重叠的记录。'));
  graph.append(node('p', 'fc-graph-evidence', '历史回放暂不可用；这里是当前 Runtime 事实与当前进程保留的收据。'));
  return graph;
}

function actionLabel(action) {
  switch (action.kind) {
    case 'RUN_STARTED': return '员工开始执行';
    case 'TOOL_RECEIPT': return `${action.receipt?.capability ?? '工具'} · ${action.receipt?.status ?? '状态未知'}`;
    case 'SOURCE_OBSERVED': return '来源读取观察已记录';
    case 'ARTIFACT_DELIVERED': return `交付：${action.title ?? '产物'}`;
    case 'REVIEW_VERDICT': return `独立评审：${verdictText(action.verdict)}`;
    case 'REPAIR_CREATED': return 'Runtime 创建修订任务';
    case 'SENSE_SHADOW': return `${action.observation?.sensorName ?? 'Relay Sense'} Shadow 观察`;
    default: return action.kind;
  }
}

function actionPreview(action) {
  const wrap = node('div', 'fc-action-preview');
  wrap.append(node('span', 'fc-eyebrow', '可追溯行动'));
  const records = (action.actions ?? []).slice(-3).reverse();
  if (!records.length) wrap.append(node('span', 'fc-inspector-note', '尚无行动记录。'));
  for (const record of records) {
    const item = detailTrigger(button('fc-action-preview-item', (event) => {
      select({ type: 'WORK', id: action.work.id }, event.currentTarget);
      view.expandedActionId = record.id;
      render();
    }, actionLabel(record)), 'WORK', action.work.id);
    wrap.append(item);
  }
  return wrap;
}

function lineageFlow(lineage) {
  const flow = node('div', 'fc-flow');
  flow.tabIndex = 0;
  flow.setAttribute('aria-label', '已记录的工作线');
  if ((lineage.steps ?? []).length === 0) {
    flow.append(node('div', 'fc-lineage-empty', '这份 Work 还没有任务。'));
    return flow;
  }
  const artifacts = new Map(lineage.steps.flatMap((step) => (step.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact])));
  lineage.steps.forEach((step, index) => {
    if (index > 0) flow.append(node('span', 'fc-arrow', '→'));
    flow.append(stepNode(step, lineage.work.workId, artifacts));
  });
  const boundary = lineage.founderBoundary ?? {};
  if (boundary.waitingForFounder || boundary.decision) {
    flow.append(node('span', 'fc-arrow', '→'), founderNode(boundary));
  }
  return flow;
}

function stepNode(step, workId, artifactById) {
  const wrap = node('div', 'fc-step');
  wrap.dataset.role = step.role ?? '';
  const who = node('div', 'fc-step-who');
  if (step.employeeId && step.employeeName) {
    const person = detailTrigger(button('fc-step-person', (event) => showEmployeeIdentity(step.employeeId, event.currentTarget)), 'EMPLOYEE', step.employeeId);
    person.append(avatar(step.employeeId), node('span', 'fc-step-name', step.employeeName));
    who.append(person);
  } else {
    who.append(node('span', 'fc-step-name fc-step-unassigned', '未指派'));
  }
  who.append(node('span', 'fc-step-meta', `${lineageRoleText(step.role)} · ${taskStateText(step.state)}`));
  wrap.append(who);
  if (step.review) {
    wrap.append(chip(
      verdictText(step.review.verdict),
      step.review.verdict === 'PASS' ? 'ok' : 'warm',
    ));
    const target = artifactById.get(step.review.targetArtifactId);
    wrap.append(node('span', 'fc-step-target', target ? `审核产物 v${target.versionIndex ?? target.generation ?? '—'}` : '审核目标当前不可见'));
  }
  if (step.repair) {
    const target = artifactById.get(step.repair.targetArtifactId);
    wrap.append(node('span', 'fc-step-meta', target ? `返工针对产物 v${target.versionIndex ?? target.generation ?? '—'}` : '返工目标当前不可见'));
  }
  const artifacts = node('div', 'fc-step-artifacts');
  for (const artifact of step.artifacts ?? []) {
    const artifactButton = detailTrigger(button('fc-artifact-chip', (event) => select({ type: 'DELIVERY', id: artifact.artifactId, workId }, event.currentTarget)), 'DELIVERY', artifact.artifactId);
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

function lineageRoleText(role) {
  return { EXECUTION: '执行任务', REVIEW: '审核任务', REPAIR: '返工任务' }[role] ?? '任务角色待确认';
}

function workforceWidget(workforce) {
  const section = node('section', 'fc-widget fc-workforce-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, 'AI Workforce'));
  const link = node('a', 'fc-link-btn', '查看团队 ↗');
  link.href = '/employees';
  link.setAttribute('aria-haspopup', 'dialog');
  link.setAttribute('aria-controls', 'page-popover');
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openPagePopover('employees', link);
  });
  head.append(link);
  section.append(head);
  section.append(node('div', 'fc-widget-line', `${workforce?.employees ?? 0} 名员工 · ${workforce?.working ?? 0} 工作中`));
  const onDuty = workforce?.onDuty ?? [];
  if (onDuty.length === 0) {
    section.append(node('div', 'fc-widget-empty', workforce?.employees === 0
      ? '还没有员工。团队建立后会出现在这里。'
      : '此刻没有员工在执行。'));
    return section;
  }
  const row = node('div', 'fc-on-duty');
  for (const card of onDuty) {
    const person = detailTrigger(button('fc-duty-card', (event) => showEmployeeIdentity(card.employeeId, event.currentTarget)), 'EMPLOYEE', card.employeeId);
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
  const section = node('section', 'fc-widget fc-deliveries-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, 'Recent Deliveries'));
  head.append(button('fc-link-btn', (event) => openPagePopover('artifacts', event.currentTarget, { tab: 'all' }), '查看交付页 ↗'));
  section.append(head);
  const deliveries = projection.recentDeliveries ?? [];
  if (deliveries.length === 0) {
    section.append(node('div', 'fc-widget-empty', '还没有交付。'));
    return section;
  }
  const list = node('ul', 'fc-deliveries');
  for (const delivery of deliveries.slice(0, 6)) {
    const item = node('li');
    const row = detailTrigger(button('fc-delivery-row', (event) => select({ type: 'DELIVERY', id: delivery.artifactId, workId: delivery.workId }, event.currentTarget)), 'DELIVERY', delivery.artifactId);
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

function pulseWidget(projection) {
  const section = node('section', 'fc-widget fc-pulse-widget');
  const head = node('div', 'fc-widget-head');
  head.append(node('h2', undefined, '公司此刻'));
  head.append(node('span', 'fc-widget-line', '只显示已记录事实'));
  head.append(button('fc-link-btn', (event) => openPagePopover('knowledge', event.currentTarget), '公司记忆 ↗'));
  section.append(head);
  const lines = node('div', 'fc-pulse-story');
  for (const line of pulseStory(projection)) lines.append(node('p', undefined, line));
  section.append(lines);
  section.append(node('p', 'fc-pulse-boundary', '公司记忆与演化候选目前无法在这里核对。'));
  return section;
}

// --- Founder-facing Employee companion ------------------------------------

function positionAssistantBubble() {
  const bubble = $('assistant-bubble');
  const pet = $('assistant-pet');
  if (bubble.hidden || pet.hidden) return;
  setSurfacePosition(bubble, pet.getBoundingClientRect(), {
    width: 320, height: Math.min(bubble.scrollHeight, innerHeight - 24),
  });
}

function renderAssistant(state) {
  const pet = $('assistant-pet');
  const assistant = state.projection?.founderAssistant;
  const visible = view.nav === 'workspace' && !view.presentation && !!assistant;
  pet.hidden = !visible;
  if (!visible) {
    closeAssistantBubble(false, true);
    return;
  }
  $('assistant-name').textContent = assistant.displayName;
  $('assistant-role').textContent = assistant.position?.title ?? '创始人助理';
  pet.dataset.availability = assistant.availability;
  pet.dataset.stale = String(freshness(state) === 'STALE');
  pet.setAttribute('aria-label', `${assistant.displayName}，${assistant.position?.title ?? '创始人助理'}，${availabilityText(assistant.availability)}。单击查看简报，双击查看员工详情。`);
  pet.querySelector('.fc-assistant-sprite').style.backgroundImage = `url('/employee-assets/assets/sprite-${spriteNumber(assistant.employeeId)}.png')`;
  if (!view.assistantOpen) return;
  const bubble = $('assistant-bubble');
  const signature = JSON.stringify([assistant, state.projection.attention, state.projection.primaryWork, freshness(state)]);
  fill($('assistant-bubble-body'), signature, () => {
    const content = [];
    if (freshness(state) === 'STALE') content.push(node('p', 'fc-inspector-warning', 'Runtime 暂不可用；以下是最后一次读取的内容。'));
    content.push(node('p', 'fc-assistant-intro', `${assistant.position?.title ?? '创始人助理'} · ${availabilityText(assistant.availability)}`));
    content.push(node('p', undefined, `当前有 ${attentionCount(state.projection)} 项需要你处理。`));
    const first = state.projection.attention?.items?.[0];
    if (first) content.push(node('p', 'fc-assistant-fact', first.work?.title ?? '未命名工作'));
    const currentWork = assistant.currentWork?.title;
    if (currentWork) content.push(node('p', undefined, `正在参与：${currentWork}`));
    if (assistant.condition) content.push(node('p', undefined, `当前情况：${conditionText(assistant.condition)}`));
    content.push(node('p', 'fc-assistant-note', '简报取自当前公司记录。助理对话尚未接入；决定仍由你作出。'));
    return content;
  });
  $('assistant-bubble-title').textContent = assistant.displayName;
  bubble.dataset.stale = String(freshness(state) === 'STALE');
  positionAssistantBubble();
}

function openAssistantBubble() {
  const pet = $('assistant-pet');
  if (pet.hidden || $('board-detail').open || $('page-popover').open || $('inspector').open) return;
  if (view.assistantOpen) { closeAssistantBubble(true); return; }
  closeBoardSummary(false, true);
  forceCloseAttention();
  void closeSearch();
  assistantBubbleEpoch += 1;
  view.assistantOpen = true;
  const bubble = $('assistant-bubble');
  bubble.hidden = false;
  pet.setAttribute('aria-expanded', 'true');
  renderAssistant(store.state);
  void animateSurface(bubble, true, pet);
}

function closeAssistantBubble(restoreFocus = false, immediate = false) {
  clearTimeout(assistantClickTimer);
  const bubble = $('assistant-bubble');
  if (!view.assistantOpen && bubble.hidden) return;
  view.assistantOpen = false;
  const epoch = ++assistantBubbleEpoch;
  $('assistant-pet').setAttribute('aria-expanded', 'false');
  if (immediate) {
    motionFor(bubble).cancel();
    bubble.hidden = true;
  } else {
    void animateSurface(bubble, false, $('assistant-pet')).then((finished) => {
      if (finished && epoch === assistantBubbleEpoch) bubble.hidden = true;
    });
  }
  if (restoreFocus && !$('assistant-pet').hidden) $('assistant-pet').focus();
}

// --- movable Company Canvas cards -----------------------------------------

const BOARD_CARDS = ['attention', 'deliveries', 'workforce'];
const BOARD_TITLES = {
  attention: '需要你处理',
  deliveries: '最新交付',
  workforce: '团队在岗',
};
const compactBoard = () => matchMedia('(max-width: 900px)').matches;

function moveCompactCard(id, direction) {
  const from = view.boardOrder.indexOf(id);
  const to = Math.max(0, Math.min(view.boardOrder.length - 1, from + direction));
  if (from === to) return;
  view.boardOrder.splice(from, 1);
  view.boardOrder.splice(to, 0, id);
  $('board-layer').append(...view.boardOrder.map(boardCard));
  boardCard(id)?.focus();
  $('board-status').textContent = `${BOARD_TITLES[id]}已调整顺序`;
}

function boardCard(id) {
  return $('board-layer').querySelector(`[data-board-card="${id}"]`);
}

function createBoardCard(id) {
  const card = node('button', 'fc-board-card');
  card.type = 'button';
  card.dataset.boardCard = id;
  card.title = '拖动调整位置；单击查看简要情况；双击打开详情。';
  card.setAttribute('aria-keyshortcuts', 'Shift+Enter Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight');
  card.addEventListener('click', (event) => {
    if (card._ignoreClick) return;
    clearTimeout(boardClickTimer);
    if (event.detail >= 2) {
      openBoardDetail(id, card);
    } else if (event.detail === 0) {
      openBoardSummary(id, card);
    } else {
      boardClickTimer = setTimeout(() => openBoardSummary(id, card), 300);
    }
  });
  card.addEventListener('keydown', (event) => {
    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(boardClickTimer);
      openBoardDetail(id, card);
      return;
    }
    if (!event.altKey || !event.key.startsWith('Arrow')) return;
    const delta = {
      ArrowLeft: [-20, 0], ArrowRight: [20, 0],
      ArrowUp: [0, -20], ArrowDown: [0, 20],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    if (compactBoard()) {
      if (delta[0]) moveCompactCard(id, Math.sign(delta[0]));
      return;
    }
    const layer = $('board-layer');
    const current = view.boardPositions[id] ?? { x: card.offsetLeft, y: card.offsetTop };
    view.boardPositions[id] = clampCardPosition(
      { x: current.x + delta[0], y: current.y + delta[1] },
      { width: layer.clientWidth, height: layer.clientHeight },
      { width: card.offsetWidth, height: card.offsetHeight },
    );
    positionBoardCards();
    $('board-status').textContent = `${BOARD_TITLES[id]}已移动`;
  });
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    boardDrag = {
      id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: card.offsetLeft, y: card.offsetTop, moved: false, compact: compactBoard(),
    };
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener('pointermove', (event) => {
    if (!boardDrag || boardDrag.id !== id || boardDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - boardDrag.startX;
    const dy = event.clientY - boardDrag.startY;
    if (!boardDrag.moved && Math.hypot(dx, dy) < 6) return;
    if (!boardDrag.moved) {
      boardDrag.moved = true;
      clearTimeout(boardClickTimer);
      closeBoardSummary(false, true);
      card.classList.add('is-dragging');
    }
    if (boardDrag.compact) {
      card.style.transform = `translateX(${dx}px)`;
      return;
    }
    const layer = $('board-layer');
    const next = clampCardPosition(
      { x: boardDrag.x + dx, y: boardDrag.y + dy },
      { width: layer.clientWidth, height: layer.clientHeight },
      { width: card.offsetWidth, height: card.offsetHeight },
    );
    card.style.left = `${next.x}px`;
    card.style.top = `${next.y}px`;
  });
  const finishDrag = (event) => {
    if (!boardDrag || boardDrag.id !== id || boardDrag.pointerId !== event.pointerId) return;
    if (boardDrag.moved) {
      if (boardDrag.compact) {
        const center = card.getBoundingClientRect().left + card.offsetWidth / 2;
        const siblings = view.boardOrder.filter((entry) => entry !== id);
        const to = siblings.findIndex((entry) => center < boardCard(entry).getBoundingClientRect().left + boardCard(entry).offsetWidth / 2);
        const next = to < 0 ? siblings.length : to;
        view.boardOrder = [...siblings.slice(0, next), id, ...siblings.slice(next)];
        card.style.transform = '';
        $('board-layer').append(...view.boardOrder.map(boardCard));
      } else view.boardPositions[id] = { x: card.offsetLeft, y: card.offsetTop };
      card._ignoreClick = true;
      setTimeout(() => { card._ignoreClick = false; }, 0);
      card.classList.remove('is-dragging');
      $('board-status').textContent = `${BOARD_TITLES[id]}已${boardDrag.compact ? '调整顺序' : '移动'}`;
    }
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    boardDrag = null;
  };
  card.addEventListener('pointerup', finishDrag);
  card.addEventListener('pointercancel', finishDrag);
  return card;
}

function renderBoard(state) {
  const layer = $('board-layer');
  const visible = view.nav === 'workspace' && !view.presentation && view.companies.length > 0 && !!state.projection;
  $('app').dataset.board = visible ? 'ready' : 'empty';
  layer.hidden = !visible;
  if (!visible) {
    closeBoardSummary(false, true);
    closeBoardDetail(false);
    return;
  }
  fill(layer, view.companyId, () => view.boardOrder.map(createBoardCard));
  for (const id of BOARD_CARDS) renderBoardCard(boardCard(id), id, state.projection);
  positionBoardCards();
  if (view.boardSummary) renderBoardSummary();
  if (view.boardDetail) renderBoardDetail();
}

function renderBoardCard(card, id, projection) {
  const signature = JSON.stringify([projection.attention, projection.recentDeliveries, projection.workforce, freshness(store.state)]);
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  const head = node('span', 'fc-board-card-head');
  const label = node('span', 'fc-board-card-label');
  label.append(symbol({ attention: 'attention', deliveries: 'artifacts', workforce: 'employees' }[id]), node('strong', undefined, BOARD_TITLES[id]));
  head.append(label);
  const body = node('span', 'fc-board-card-body');
  if (id === 'attention') {
    const count = attentionCount(projection);
    card.dataset.priority = count > 0 ? 'high' : 'low';
    head.append(node('b', 'fc-board-count', String(count)));
    const first = projection.attention?.items?.[0];
    body.append(node('span', undefined, first?.work?.title ?? '目前没有待处理事项'));
    if (first) body.append(node('small', undefined, attentionLeadText(first.kind)));
  } else if (id === 'deliveries') {
    const deliveries = projection.recentDeliveries ?? [];
    head.append(node('b', 'fc-board-count', String(deliveries.length)));
    if (deliveries.length === 0) body.append(node('span', undefined, '还没有交付。'));
    for (const delivery of deliveries.slice(0, 2)) {
      body.append(node('span', 'fc-board-line', delivery.title ?? '未命名产物'));
    }
  } else {
    const workforce = projection.workforce ?? {};
    head.append(node('b', 'fc-board-count', String(workforce.working ?? 0)));
    body.append(node('span', undefined, `${workforce.working ?? 0} 人工作中 · ${workforce.employees ?? 0} 名员工`));
    const names = (workforce.onDuty ?? []).slice(0, 3).map((person) => person.displayName).filter(Boolean);
    body.append(node('small', undefined, names.length ? names.join('、') : '此刻没有员工在执行。'));
  }
  card.replaceChildren(head, body, node('span', 'fc-board-card-hint', '单击概览 · 双击详情 · 拖动调整'));
  const summary = [...body.children].map((entry) => entry.textContent).filter(Boolean).join('；');
  card.setAttribute('aria-label', `${BOARD_TITLES[id]}：${summary}。单击概览，双击详情；按 Alt 加方向键移动。`);
  card.dataset.stale = String(freshness(store.state) === 'STALE');
}

function positionBoardCards() {
  const layer = $('board-layer');
  if (layer.hidden) return;
  if (compactBoard()) {
    for (const id of BOARD_CARDS) {
      boardCard(id).style.left = '';
      boardCard(id).style.top = '';
    }
    positionBoardSummary();
    return;
  }
  let previousHeight = 0;
  for (const [index, id] of view.boardOrder.entries()) {
    const card = boardCard(id);
    if (boardDrag?.id === id) { previousHeight += card.offsetHeight; continue; }
    const bounds = { width: layer.clientWidth, height: layer.clientHeight };
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const proposed = view.boardPositions[id] ?? initialCardPosition(index, bounds, size, previousHeight);
    const next = clampCardPosition(proposed, bounds, size);
    card.style.left = `${next.x}px`;
    card.style.top = `${next.y}px`;
    if (view.boardPositions[id]) view.boardPositions[id] = next;
    previousHeight += size.height;
  }
  positionBoardSummary();
}

function positionBoardSummary() {
  const summary = $('board-summary');
  const card = boardCard(view.boardSummary);
  if (summary.hidden || !card) return;
  setSurfacePosition(summary, card.getBoundingClientRect(), {
    width: 304, height: Math.min(summary.scrollHeight, innerHeight - 24),
  });
}

function openBoardSummary(id, card) {
  if (!card?.isConnected || $('board-detail').open) return;
  if (view.boardSummary === id && !$('board-summary').hidden) {
    closeBoardSummary();
    return;
  }
  forceCloseAttention();
  closeAssistantBubble(false, true);
  void closeSearch();
  view.boardSummary = id;
  $('board-summary').hidden = false;
  renderBoardSummary();
  const summary = $('board-summary');
  void animateSurface(summary, true, card);
}

function closeBoardSummary(restoreFocus = false, immediate = false) {
  clearTimeout(boardClickTimer);
  const id = view.boardSummary;
  view.boardSummary = null;
  const summary = $('board-summary');
  if (summary.hidden) return;
  if (immediate) {
    motionFor(summary).cancel();
    summary.hidden = true;
  } else {
    void animateSurface(summary, false, boardCard(id)).then((finished) => {
      if (finished && !view.boardSummary) summary.hidden = true;
    });
  }
  if (restoreFocus) boardCard(id)?.focus();
}

function renderBoardSummary() {
  const id = view.boardSummary;
  const projection = store.state.projection;
  if (!id || !projection) return;
  $('board-summary-title').textContent = BOARD_TITLES[id];
  const body = $('board-summary-body');
  body.replaceChildren();
  if (freshness(store.state) === 'STALE') body.append(node('p', 'fc-inspector-warning', 'Runtime 暂不可用；以下是最后一次读取的内容。'));
  if (id === 'attention') {
    const count = attentionCount(projection);
    body.append(node('p', undefined, `${count} 个事项需要你处理。`));
    const first = projection.attention?.items?.[0];
    if (first) body.append(node('strong', undefined, first.work?.title ?? '未命名工作'), node('p', undefined, attentionLeadText(first.kind)));
  } else if (id === 'deliveries') {
    const deliveries = projection.recentDeliveries ?? [];
    body.append(node('p', undefined, `最近 ${deliveries.length} 份交付。`));
    const first = deliveries[0];
    if (first) body.append(node('strong', undefined, first.title ?? '未命名产物'), node('p', undefined, acceptedStateText(first.acceptedState)));
  } else {
    const workforce = projection.workforce ?? {};
    body.append(node('p', undefined, `${workforce.working ?? 0} 人工作中，${workforce.available ?? 0} 人空闲。`));
    const first = workforce.onDuty?.[0];
    if (first) body.append(node('strong', undefined, first.displayName ?? '员工'), node('p', undefined, roleText(first.role)));
  }
  $('board-summary-detail').onclick = () => openBoardDetail(id, boardCard(id));
  positionBoardSummary();
}

function openBoardDetail(id, card) {
  if (!card?.isConnected) return;
  clearTimeout(boardClickTimer);
  closeBoardSummary(false, true);
  forceCloseAttention();
  boardDetailClosing = false;
  closeAssistantBubble(false, true);
  void closeSearch();
  boardDetailReturnFocus = card;
  view.boardDetail = id;
  $('board-detail-title').textContent = BOARD_TITLES[id];
  const dialog = $('board-detail');
  if (!dialog.open) dialog.showModal();
  renderBoardDetail();
  void animateSurface(dialog, true, card);
  $('board-detail-close').focus();
}

async function closeBoardDetail(restoreFocus = true) {
  const dialog = $('board-detail');
  if (!dialog.open) return;
  boardDetailTransition = !restoreFocus;
  if (!restoreFocus) {
    motionFor(dialog).cancel();
    boardDetailClosing = false;
    dialog.close();
    return;
  }
  if (boardDetailClosing) return;
  boardDetailClosing = true;
  if (!await animateSurface(dialog, false, boardDetailReturnFocus)) return;
  boardDetailClosing = false;
  dialog.close();
}

function openBoardSelection(selection) {
  const card = boardDetailReturnFocus;
  closeBoardDetail(false);
  select(selection, card);
}

function renderBoardDetail() {
  const id = view.boardDetail;
  const projection = store.state.projection;
  if (!id || !projection || !$('board-detail').open) return;
  const body = $('board-detail-body');
  const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.boardDetailId : null;
  const signature = JSON.stringify([id, projection.attention, projection.recentDeliveries, projection.workforce, freshness(store.state)]);
  fill(body, signature, () => {
    const content = [];
    if (freshness(store.state) === 'STALE') content.push(node('p', 'fc-inspector-warning', 'Runtime 暂不可用；以下是最后一次读取的内容。'));
    if (id === 'attention') {
      const items = projection.attention?.items ?? [];
      content.push(node('p', 'fc-board-detail-intro', items.length ? `${items.length} 个事项有公司记录支持。这里仅展示可用动作。` : '目前没有待处理事项。'));
      for (const item of items) {
        const row = node('article', 'fc-board-detail-row');
        row.append(chip(attentionKindText(item.kind), 'accent'));
        const link = button('fc-board-detail-link', () => openBoardSelection({ type: 'WORK', id: item.workId }), item.work?.title ?? '未命名工作');
        link.dataset.boardDetailId = item.workId;
        row.append(link, node('p', undefined, attentionLeadText(item.kind)));
        if ((item.actions ?? []).length) row.append(node('small', undefined, `可用动作：${item.actions.map((action) => actionText(action.kind)).join('、')}`));
        content.push(row);
      }
      content.push(button('fc-link-btn', () => {
        const card = boardDetailReturnFocus;
        closeBoardDetail(false);
        openPagePopover('work', card, { tab: 'needs' });
      }, '查看待处理工作页 ↗'));
    } else if (id === 'deliveries') {
      const deliveries = projection.recentDeliveries ?? [];
      content.push(node('p', 'fc-board-detail-intro', deliveries.length ? `最近 ${deliveries.length} 份交付。状态来自公司记录。` : '还没有交付。'));
      for (const delivery of deliveries) {
        const row = node('article', 'fc-board-detail-row');
        const link = button('fc-board-detail-link', () => openBoardSelection({ type: 'DELIVERY', id: delivery.artifactId, workId: delivery.workId }), delivery.title ?? '未命名产物');
        link.dataset.boardDetailId = delivery.artifactId;
        row.append(link, node('p', undefined, [delivery.workTitle, delivery.producerName].filter(Boolean).join(' · ')));
        row.append(chip(acceptedStateText(delivery.acceptedState), delivery.acceptedState === 'ACCEPTED' ? 'accent' : 'quiet'));
        content.push(row);
      }
      content.push(button('fc-link-btn', () => {
        const card = boardDetailReturnFocus;
        closeBoardDetail(false);
        openPagePopover('artifacts', card, { tab: 'all', selectedId: deliveries[0]?.artifactId });
      }, '查看交付物页 ↗'));
    } else {
      const workforce = projection.workforce ?? {};
      content.push(node('p', 'fc-board-detail-intro', `${workforce.employees ?? 0} 名员工 · ${workforce.working ?? 0} 人工作中 · ${workforce.available ?? 0} 人空闲。`));
      for (const person of workforce.onDuty ?? []) {
        const row = node('article', 'fc-board-detail-row fc-board-person');
        row.append(avatar(person.employeeId));
        const link = button('fc-board-detail-link', () => openBoardSelection({ type: 'EMPLOYEE', id: person.employeeId }), person.displayName ?? '员工');
        link.dataset.boardDetailId = person.employeeId;
        row.append(link, node('small', undefined, person.condition ? '需要检查' : roleText(person.role)));
        content.push(row);
      }
      content.push(button('fc-link-btn', () => {
        const card = boardDetailReturnFocus;
        closeBoardDetail(false);
        openPagePopover('employees', card);
      }, '查看团队页面'));
    }
    return content;
  });
  if (focusKey) [...body.querySelectorAll('[data-board-detail-id]')].find((entry) => entry.dataset.boardDetailId === focusKey)?.focus();
}

function renderAttention(state) {
  const panel = $('attention-panel');
  const items = state.projection?.attention?.items ?? [];
  if (items.length === 0) {
    forceCloseAttention();
    return;
  }
  if (!view.attentionOpen) return;
  panel.hidden = false;
  const focusId = panel.contains(document.activeElement) ? document.activeElement.dataset.attentionWorkId : null;
  const closeFocused = panel.contains(document.activeElement) && document.activeElement.classList.contains('fc-attention-close');
  fill(panel, JSON.stringify(items), () => {
    const header = node('div', 'fc-attention-head');
    header.append(node('h2', undefined, `需要你处理 · ${items.length}`), button('fc-attention-close', () => void closeAttention(), '关闭'));
    const built = [header];
    for (const item of items) built.push(attentionItem(item));
    built.push(node('p', 'fc-attention-note', '以上为公司记录中的可用动作；这里仅供查看，不会代替你执行。'));
    return built;
  });
  if (focusId) [...panel.querySelectorAll('.fc-attention-work')].find((element) => element.dataset.attentionWorkId === focusId)?.focus();
  else if (closeFocused) panel.querySelector('.fc-attention-close')?.focus();
  positionAttention();
}

function attentionItem(item) {
  const article = node('article', 'fc-attention-item');
  article.append(chip(attentionKindText(item.kind), 'accent'));
  const workButton = detailTrigger(button('fc-attention-work', (event) => select({ type: 'WORK', id: item.workId }, event.currentTarget), item.work?.title ?? '未命名工作'), 'WORK', item.workId);
  workButton.dataset.attentionWorkId = item.workId;
  article.append(workButton);
  article.append(node('p', 'fc-attention-lead', attentionLeadText(item.kind)));
  const conditions = node('div', 'fc-attention-chips');
  for (const condition of item.conditions ?? []) conditions.append(chip(conditionText(condition), 'quiet'));
  if (conditions.childElementCount > 0) article.append(conditions);
  if ((item.actions ?? []).length > 0) {
    const actions = node('div', 'fc-attention-actions');
    actions.append(node('span', undefined, '可用动作：'));
    for (const action of item.actions) actions.append(chip(actionText(action.kind)));
    article.append(actions);
  }
  return article;
}

// --- inspector -------------------------------------------------------------

function renderInspector(state) {
  const body = $('inspector-body');
  fill(
    body,
    JSON.stringify([
      view.selection?.type ?? null,
      view.selection?.id ?? null,
      detailEpoch,
      view.detailError,
      view.detail,
      view.actions.get(view.selection?.id) ?? null,
      view.expandedActionId,
      freshness(state),
      state.projection?.recentDeliveries ?? null,
    ]),
    () => buildInspector(state),
  );
}

function buildInspector(state) {
  if (!view.selection)
    return [node('p', 'fc-inspector-note', '选择一名员工、一份工作或一次交付，这里会显示 Runtime 投影出的详情。')];
  const staleNote = freshness(state) === 'STALE'
    ? node('p', 'fc-inspector-warning', 'Runtime 暂不可用。以下详情可能已过时。')
    : null;
  const content = [];
  if (staleNote) content.push(staleNote);
  if (view.detailError) return [...content, node('p', 'fc-inspector-note', `读取失败：${view.detailError}`)];
  if (view.selection.type === 'DELIVERY' && !view.detail) return [...content, node('p', 'fc-inspector-note', '正在读取交付正文…')];
  if (view.selection.type === 'DELIVERY') return [...content, deliveryDetail(state)];
  if (!view.detail) return [...content, node('p', 'fc-inspector-note', '正在读取…')];
  return [...content, view.selection.type === 'EMPLOYEE' ? employeeDetail(view.detail) : workDetail(view.detail)];
}

function row(label, value) {
  const item = node('li');
  item.append(node('span', 'fc-kv-label', label), value instanceof Node ? value : node('span', 'fc-kv-value', value));
  return item;
}

function deliveryDetail(state) {
  const delivery = state.projection?.recentDeliveries?.find((entry) => entry.artifactId === view.selection.id);
  const reading = view.detail;
  const wrap = node('div', 'fc-section');
  if (!reading) {
    wrap.append(node('p', 'fc-inspector-note', '正在读取真实 Artifact 正文…'));
    return wrap;
  }
  wrap.append(node('h2', undefined, reading.title ?? '未命名产物'));
  const meta = node('div', 'fc-inspector-meta');
  if (reading.kind) meta.append(chip(reading.kind, 'quiet'));
  if (delivery?.reviewState) meta.append(chip(verdictText(delivery.reviewState), delivery.reviewState === 'PASS' ? 'ok' : 'warm'));
  if (delivery) meta.append(chip(acceptedStateText(delivery.acceptedState), delivery.acceptedState === 'ACCEPTED' ? 'accent' : 'quiet'));
  wrap.append(meta);
  const list = node('ul', 'fc-inspector-list');
  list.append(row('所属工作', button('fc-link-btn', () => select({ type: 'WORK', id: reading.workId }), delivery?.workTitle ?? '查看工作')));
  if (reading.producerEmployeeId) list.append(row('产出者', button('fc-link-btn', (event) => showEmployeeIdentity(reading.producerEmployeeId, event.currentTarget), delivery?.producerName ?? '查看员工身份')));
  else if (delivery?.producerName) list.append(row('产出者', delivery.producerName));
  if (reading.producerEmployeeId) {
    const technical = node('details', 'fc-inspector-technical');
    technical.append(node('summary', undefined, '技术记录'), node('p', undefined, `员工 ID：${reading.producerEmployeeId}`));
    wrap.append(technical);
  }
  if (reading.workerRunId) list.append(row('WorkerRun', reading.workerRunId));
  if (delivery?.generation) list.append(row('代次', `第 ${delivery.generation} 代`));
  const created = timeText(reading.createdAt);
  if (created) list.append(row('记录时间', created));
  if (reading.supersedesArtifactId) list.append(row('修订自', reading.supersedesArtifactId));
  wrap.append(list);
  const body = node('div', 'fc-section');
  body.append(node('h3', undefined, '真实交付正文'), node('pre', 'fc-artifact-body', reading.content ?? ''));
  wrap.append(body);
  if (reading.inputArtifacts?.length) {
    const inputs = node('div', 'fc-section');
    inputs.append(node('h3', undefined, '上游输入'));
    for (const input of reading.inputArtifacts) inputs.append(button('fc-link-btn',
      () => select({ type: 'DELIVERY', id: input.artifactId, workId: reading.workId }), input.title ?? input.artifactId));
    wrap.append(inputs);
  }
  if (reading.citedSources?.length) {
    const sources = node('div', 'fc-section');
    sources.append(node('h3', undefined, '引用来源'));
    for (const source of reading.citedSources) {
      const label = [source.sourceId, source.observationAvailable ? source.safeUrl : '当前进程无来源收据',
        source.observedAt ? timeText(source.observedAt) : null]
        .filter(Boolean).join(' · ');
      sources.append(node('p', 'fc-inspector-note', label));
    }
    sources.append(node('p', 'fc-inspector-note', '来源摘录尚未记录；来源观察不代表内容已被证实。'));
    wrap.append(sources);
  }
  if (reading.reviews?.length) {
    const reviews = node('div', 'fc-section');
    reviews.append(node('h3', undefined, '评审'));
    for (const review of reading.reviews) reviews.append(node('p', 'fc-inspector-note',
      `${verdictText(review.verdict)} · ${review.summary ?? '无评审摘要'}`));
    wrap.append(reviews);
  }
  return wrap;
}

function artifactOriginWorkId(artifactId, projection) {
  const lineages = [projection?.primaryWork?.lineage, ...view.works.map((item) => item.lineage)].filter(Boolean);
  return lineages.find((lineage) => lineage.steps?.some((step) => step.artifacts?.some((artifact) => artifact.artifactId === artifactId)))?.work?.workId ?? null;
}

function employeeDetail(detail) {
  const wrap = node('div', 'fc-section');
  const profile = node('div', 'fc-employee-profile');
  profile.append(avatar(detail.employeeId));
  const identity = node('div');
  identity.append(node('h2', undefined, detail.displayName ?? '员工'));
  if (detail.position?.title) identity.append(node('p', undefined, detail.position.title));
  profile.append(identity);
  wrap.append(profile);
  const meta = node('div', 'fc-inspector-meta');
  if (detail.position?.title) meta.append(chip(detail.position.title, 'quiet'));
  const role = detail.availability === 'WORKING' && detail.currentRole ? ` · ${roleText(detail.currentRole)}` : '';
  meta.append(chip(`${availabilityText(detail.availability)}${role}`, detail.availability === 'WORKING' ? 'accent' : null));
  wrap.append(meta);
  wrap.append(button('fc-link-btn', (event) => showEmployeeIdentity(detail.employeeId, event.currentTarget), '查看员工身份 →'));
  if (detail.condition) wrap.append(node('p', 'fc-inspector-warning', '该员工有多个进行中的执行，Runtime 无法确定唯一焦点，需要检查。'));

  const capabilities = node('div', 'fc-section');
  capabilities.append(node('h3', undefined, '岗位声明能力'));
  if ((detail.capabilities ?? []).length === 0) capabilities.append(node('p', 'fc-inspector-note', '岗位尚未声明预期能力。'));
  else {
    const rowOfChips = node('div', 'fc-kv');
    for (const capability of detail.capabilities) rowOfChips.append(chip(capabilityText(capability), 'quiet'));
    capabilities.append(rowOfChips);
  }
  capabilities.append(node('p', 'fc-inspector-note', '岗位声明不等于经过试用证明。逐项能力证据尚未接入。'));
  wrap.append(capabilities);

  const current = node('div', 'fc-section');
  current.append(node('h3', undefined, '当前工作'));
  if (detail.currentWork) {
    const line = node('div', 'fc-kv');
    line.append(button('fc-link-btn', (event) => select({ type: 'WORK', id: detail.currentWork.workId }, event.currentTarget), detail.currentWork.title ?? '未命名工作'));
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
    : detail.availability === 'WORKING' ? '当前执行未提供后端信息。' : '当前没有进行中的执行。'));
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
  if (lineage.work.intent) wrap.append(node('p', 'fc-inspector-note', workIntentText(lineage.work.intent)));

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
  const action = view.actions.get(lineage.work.workId);
  if (action) {
    wrap.append(workGraph(action), actionFeed(action));
    if (action.sense?.length) {
      const sense = node('div', 'fc-section');
      sense.append(node('h3', undefined, 'Relay Sense · Shadow 观察'));
      for (const item of action.sense.slice(-3).reverse())
        sense.append(node('p', 'fc-inspector-note', `${item.sensorName} · ${item.status} · ${timeText(item.at) || '时间未记录'}`));
      sense.append(node('p', 'fc-inspector-note', '这些观察只进入 Trace，不派工、不授权，也不决定评审。'));
      wrap.append(sense);
    }
  } else wrap.append(node('p', 'fc-inspector-note', view.actionErrors.get(lineage.work.workId)
    ? `行动投影不可用：${view.actionErrors.get(lineage.work.workId)}` : '正在读取行动投影…'));
  wrap.append(button('fc-link-btn', (event) => {
    forceCloseInspector();
    openPagePopover('work', event.currentTarget, { tab: 'all', selectedId: lineage.work.workId });
  }, '在工作页查看 ↗'));
  return wrap;
}

function actionFeed(action) {
  const section = node('div', 'fc-section');
  section.append(node('h3', undefined, `可追溯行动 · ${(action.actions ?? []).length} 条`));
  section.append(node('p', 'fc-inspector-note', '每次工具请求的最终状态记录在收据中；来源观察另行记录。收据仅保存在当前 Host 进程。'));
  if (!action.actions?.length) {
    section.append(node('p', 'fc-inspector-note', '尚无可显示的行动。'));
    return section;
  }
  const list = node('div', 'fc-action-feed');
  for (const item of action.actions.slice(-40).reverse()) {
    const entry = node('div', 'fc-action-entry');
    const open = button('fc-action-toggle', () => {
      view.expandedActionId = view.expandedActionId === item.id ? null : item.id;
      render();
    });
    open.setAttribute('aria-expanded', String(view.expandedActionId === item.id));
    open.append(node('strong', undefined, actionLabel(item)),
      node('small', undefined, timeText(item.at) || '时间未记录'));
    entry.append(open);
    if (view.expandedActionId === item.id) {
      const details = node('ul', 'fc-inspector-list fc-action-receipt');
      if (item.employeeId) details.append(row('员工', item.employeeId));
      if (item.taskId) details.append(row('任务', item.taskId));
      if (item.workerRunId) details.append(row('WorkerRun', item.workerRunId));
      if (item.receipt) {
        details.append(row('收据', item.receipt.callId ?? '未记录'));
        details.append(row('状态', item.receipt.status ?? '未知'));
        details.append(row('耗时', `${item.receipt.durationMs ?? 0} ms`));
        if (item.receipt.sourceId) details.append(row('来源 ID', item.receipt.sourceId));
        if (item.receipt.inputDigest) details.append(row('输入摘要', item.receipt.inputDigest));
        if (item.receipt.outputDigest) details.append(row('输出摘要', item.receipt.outputDigest));
      }
      if (item.source) {
        details.append(row('来源 ID', item.source.sourceId));
        details.append(row('来源收据', item.source.receiptCallId));
        details.append(row('安全域名', item.source.safeUrl ?? '未记录'));
        details.append(row('内容摘要', item.source.contentDigest ?? '未记录'));
      }
      if (item.observation) {
        details.append(row('状态', item.observation.status ?? '未知'));
        if (item.observation.signals) details.append(row('有界信号', JSON.stringify(item.observation.signals)));
        details.append(row('权限边界', 'Shadow 只观察，不控制 Runtime'));
      }
      if (item.reviewId) details.append(row('评审', item.reviewId));
      entry.append(details);
      if (item.artifactId) entry.append(button('fc-link-btn',
        () => select({ type: 'DELIVERY', id: item.artifactId, workId: action.work.id }), '阅读 Artifact →'));
      if (item.receipt) entry.append(node('p', 'fc-inspector-note',
        '收据不包含工具输入或输出正文；SUCCEEDED 仅表示工具执行成功。'));
    }
    list.append(entry);
  }
  section.append(list);
  return section;
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
    const artifactButton = button('fc-artifact-chip', (event) => select({ type: 'DELIVERY', id: artifact.artifactId, workId }, event.currentTarget));
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
  const assistant = projection?.founderAssistant;
  if (assistant && !items.some((item) => item.selection.id === assistant.employeeId))
    items.push({ selection: { type: 'EMPLOYEE', id: assistant.employeeId }, label: assistant.displayName, meta: assistant.position?.title ?? '', group: '员工' });
  const lineage = projection?.primaryWork?.lineage;
  if (lineage)
    items.push({ selection: { type: 'WORK', id: lineage.work.workId }, label: lineage.work.title ?? '', meta: '主要工作', group: '工作' });
  for (const delivery of projection?.recentDeliveries ?? [])
    items.push({ selection: { type: 'DELIVERY', id: delivery.artifactId, workId: delivery.workId }, label: delivery.title ?? '', meta: delivery.workTitle ?? '', group: '交付' });
  return items;
}

function renderSearchResults() {
  const box = $('search-results');
  const input = $('search');
  const query = view.search.toLowerCase();
  searchDataSignature = JSON.stringify(searchItems(store.state.projection));
  if (!query) {
    searchMotionEpoch += 1;
    searchMotion?.cancel();
    searchClosing = false;
    box.hidden = true;
    box.replaceChildren();
    view.searchIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    return;
  }
  const matches = searchItems(store.state.projection)
    .filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query))
    .slice(0, 8);
  const wasHidden = box.hidden;
  const from = searchClosing && !box.hidden ? presentationFrame(box) : null;
  searchMotionEpoch += 1;
  searchMotion?.cancel();
  searchClosing = false;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (view.searchIndex >= matches.length) view.searchIndex = matches.length - 1;
  if (matches.length === 0) {
    view.searchIndex = -1;
    input.removeAttribute('aria-activedescendant');
    box.replaceChildren(node('div', 'fc-search-empty', store.state.projection ? '没有匹配的已加载内容。' : '正在读取公司内容…'));
  } else {
    const items = node('div', 'fc-search-items');
    const highlight = node('span', 'fc-search-highlight');
    highlight.setAttribute('aria-hidden', 'true');
    items.append(highlight);
    for (const [index, match] of matches.entries()) {
      const result = button('fc-search-item', (event) => select(match.selection, event.currentTarget));
      result.id = `search-result-${index}`;
      result.setAttribute('role', 'option');
      result.setAttribute('aria-selected', String(index === view.searchIndex));
      result.tabIndex = -1;
      result.append(node('strong', undefined, match.label || '未命名'), node('small', undefined, `${match.group}${match.meta ? ' · ' + match.meta : ''}`));
      items.append(result);
    }
    box.replaceChildren(items);
    updateSearchHighlight();
  }
  if (view.searchIndex >= 0) input.setAttribute('aria-activedescendant', `search-result-${view.searchIndex}`);
  else input.removeAttribute('aria-activedescendant');
  if (wasHidden || from) searchMotion = box.animate(
    [from ?? (reducePopoverMotion.matches ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-8px) scale(.98)' }), { opacity: 1, transform: 'none' }],
    { duration: reducePopoverMotion.matches ? 90 : 210, easing: 'cubic-bezier(.2,.82,.22,1)' },
  );
}

function updateSearchHighlight() {
  const box = $('search-results');
  const highlight = box.querySelector('.fc-search-highlight');
  const target = box.querySelectorAll('[role="option"]')[view.searchIndex];
  if (!highlight) return;
  highlight.hidden = !target;
  if (!target) return;
  highlight.style.height = `${target.offsetHeight}px`;
  highlight.style.transform = `translateY(${target.offsetTop}px)`;
}

async function closeSearch() {
  const box = $('search-results');
  if (searchClosing) return;
  const wasOpen = !box.hidden;
  const epoch = ++searchMotionEpoch;
  const from = wasOpen ? presentationFrame(box) : null;
  searchClosing = wasOpen;
  searchMotion?.cancel();
  view.search = '';
  view.searchIndex = -1;
  $('search').value = '';
  $('search').setAttribute('aria-expanded', 'false');
  $('search').removeAttribute('aria-activedescendant');
  if (wasOpen) {
    searchMotion = box.animate(
      [from, reducePopoverMotion.matches ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-8px) scale(.98)' }],
      { duration: reducePopoverMotion.matches ? 80 : 160, easing: 'cubic-bezier(.4,0,1,1)' },
    );
    try { await searchMotion.finished; } catch { /* reopened while closing */ }
  }
  if (epoch !== searchMotionEpoch) return;
  searchClosing = false;
  box.hidden = true;
  box.replaceChildren();
}

// --- zoom (presentation only) ----------------------------------------------

const ZOOM_STEPS = [0.8, 0.9, 1];

function renderZoom() {
  $('zoom-label').textContent = `${Math.round(view.zoom * 100)}%`;
  $('world').style.transform = globalThis.matchMedia?.('(max-width: 620px)').matches ? '' : `scale(${view.zoom})`;
  $('controls').querySelector('[data-zoom="in"]').disabled = view.zoom === ZOOM_STEPS.at(-1);
  $('controls').querySelector('[data-zoom="out"]').disabled = view.zoom === ZOOM_STEPS[0];
}

// --- wiring ----------------------------------------------------------------

function wireOnce() {
  $('presentation-toggle').addEventListener('click', () => {
    view.presentation = !view.presentation;
    closeBoardSummary(false, true);
    closeAssistantBubble(false, true);
    render();
    $('presentation-toggle').focus();
  });
  $('new-work').replaceChildren(symbol('plus'), node('span', undefined, '新建 Work'));
  const searchIcon = node('span', 'fc-search-symbol');
  searchIcon.append(symbol('search'));
  $('search').before(searchIcon);
  const selectIcon = node('span', 'fc-select-symbol');
  selectIcon.append(symbol('chevronDown'));
  $('company').after(selectIcon);
  for (const [action, name, label] of [
    ['out', 'minus', null], ['in', 'plus', null],
    ['fit', 'fit', '适应'], ['reset', 'reset', '重置视图'],
  ]) {
    const control = $('controls').querySelector(`[data-zoom="${action}"]`);
    control.replaceChildren(symbol(name), ...(label ? [node('span', undefined, label)] : []));
  }
  for (const id of ['page-popover-close', 'inspector-close', 'board-summary-close', 'board-detail-close', 'assistant-bubble-close'])
    $(id).replaceChildren(symbol('close'));
  $('assistant-pet').addEventListener('click', (event) => {
    clearTimeout(assistantClickTimer);
    if (event.detail >= 2) {
      const employeeId = store.state.projection?.founderAssistant?.employeeId;
      closeAssistantBubble(false, true);
      if (employeeId) select({ type: 'EMPLOYEE', id: employeeId }, $('assistant-pet'));
    } else if (event.detail === 0) openAssistantBubble();
    else assistantClickTimer = setTimeout(openAssistantBubble, 280);
  });
  $('assistant-bubble-close').addEventListener('click', () => closeAssistantBubble(true));
  $('assistant-employee-detail').addEventListener('click', () => {
    const employeeId = store.state.projection?.founderAssistant?.employeeId;
    closeAssistantBubble(false, true);
    if (employeeId) select({ type: 'EMPLOYEE', id: employeeId }, $('assistant-pet'));
  });
  $('assistant-work-page').addEventListener('click', () => {
    closeAssistantBubble(false, true);
    openPagePopover('work', $('assistant-pet'), { tab: 'needs' });
  });
  $('board-summary-close').addEventListener('click', () => closeBoardSummary(true));
  $('board-detail-close').addEventListener('click', () => closeBoardDetail());
  $('board-detail').addEventListener('click', (event) => {
    if (event.target === $('board-detail')) closeBoardDetail();
  });
  $('board-detail').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeBoardDetail();
  });
  $('board-detail').addEventListener('close', () => {
    view.boardDetail = null;
    if (!boardDetailTransition && boardDetailReturnFocus?.isConnected) boardDetailReturnFocus.focus();
    boardDetailTransition = false;
    boardDetailReturnFocus = null;
  });
  $('page-popover-close').addEventListener('click', () => void closePagePopover());
  $('new-work').addEventListener('click', (event) => openPagePopover('work', event.currentTarget, { tab: 'active', compose: true }));
  $('page-popover').addEventListener('click', (event) => {
    if (event.target === $('page-popover')) void closePagePopover();
  });
  $('page-popover').addEventListener('cancel', (event) => {
    event.preventDefault();
    void closePagePopover();
  });
  $('page-popover').addEventListener('close', () => {
    const closedId = view.popover;
    $('page-popover-frame').removeAttribute('src');
    view.popover = null;
    renderNav();
    const fallback = $('nav').querySelector(`[data-nav-id="${closedId ?? 'workspace'}"]`);
    (popoverReturnFocus?.isConnected ? popoverReturnFocus : fallback)?.focus();
    popoverReturnFocus = null;
  });
  $('company').addEventListener('change', (event) => {
    if (event.target.value) openCompany(event.target.value);
  });
  $('inspector-close').addEventListener('click', () => void closeInspector());
  $('inspector').addEventListener('click', (event) => {
    if (event.target === $('inspector')) void closeInspector();
  });
  $('inspector').addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeInspector();
  });
  $('search').addEventListener('input', (event) => {
    view.search = event.target.value.trim();
    view.searchIndex = -1;
    renderSearchResults();
  });
  $('search').addEventListener('focus', renderSearchResults);
  $('search').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const results = [...$('search-results').querySelectorAll('[role="option"]')];
      if (!results.length) return;
      event.preventDefault();
      view.searchIndex = event.key === 'ArrowDown'
        ? (view.searchIndex + 1) % results.length
        : (view.searchIndex - 1 + results.length) % results.length;
      results.forEach((result, index) => result.setAttribute('aria-selected', String(index === view.searchIndex)));
      $('search').setAttribute('aria-activedescendant', results[view.searchIndex].id);
      results[view.searchIndex].scrollIntoView({ block: 'nearest' });
      updateSearchHighlight();
    } else if (event.key === 'Enter' && view.searchIndex >= 0) {
      const result = $('search-results').querySelectorAll('[role="option"]')[view.searchIndex];
      if (result) { event.preventDefault(); result.click(); }
    }
  });
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
    if (view.assistantOpen && !event.target.closest('#assistant-bubble') && !event.target.closest('#assistant-pet')) closeAssistantBubble();
    if (view.boardSummary && !event.target.closest('#board-summary') && !event.target.closest('.fc-board-card')) closeBoardSummary();
    if (view.attentionOpen && !event.target.closest('#attention-panel') && !event.target.closest('.fc-needs-you')) {
      void closeAttention(false);
    }
    if (!$('search-results').hidden && !event.target.closest('.fc-search')) void closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('search').focus();
      renderSearchResults();
      return;
    }
    if (event.key !== 'Escape') return;
    if ($('inspector').open || $('page-popover').open || $('board-detail').open) return;
    if (!$('search-results').hidden) void closeSearch();
    else if (view.assistantOpen) closeAssistantBubble(true);
    else if (view.boardSummary) closeBoardSummary(true);
    else if (view.attentionOpen) {
      void closeAttention();
    }
  });
  store.subscribe(() => {
    maybeRefreshDetail();
    void refreshActions();
    render();
    if ((view.popover === 'work' || view.popover === 'artifacts' || view.popover === 'knowledge') && Date.now() - workLastRead > 10000) void loadWorks();
    if (view.popover === 'hiring' && Date.now() - hiringLastRead > 10000) void loadHiringInventory();
  });
  window.addEventListener('resize', () => { renderZoom(); render(); positionBoardCards(); positionAssistantBubble(); positionAttention(); positionInspector(); });
  $('canvas').addEventListener('scroll', () => { positionAttention(); positionInspector(); }, { passive: true });
}

wireOnce();
void boot();
if (new URLSearchParams(location.search).get('search') === '1') $('search').focus();
