import { EmployeeStore, employeeRun, employeeStatus, visualAction, cropRect, tokenLabel, canArchive } from './domain.mjs';
import { HttpEmployeeAdapter } from './adapter.mjs';
import { validatePortrait } from './avatar.mjs';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text, action, className) => { const b = node('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b; };
const statusNames = { idle: '空闲', running: '运行中', waiting: '等待中', paused: '已暂停', failed: '执行中断', disabled: '已停用', completed: '已完成', cancelled: '已取消' };
const store = new EmployeeStore();
const demo = new URLSearchParams(location.search).get('demo') === '1';
const adapter = demo ? new (await import('./demo.mjs')).DemoEmployeeAdapter() : new HttpEmployeeAdapter();
const portraits = new Map(), visuals = new Map(), seenMessages = new Set(), animations = new Set();
let selectedId, page = 'overview', stop = () => {}, currentCompany, dirty = false, pending = false, historyPage = [], historyCursor, historyGeneration = 0, toastTimer, draftVersion;
let initialized = false, lastCompany, imageDraft, avatarGeneration = 0, avatarDirty = false, cardSignature = '';
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => $('reduce-motion').checked || reduceQuery.matches;
const activeEmployees = () => store.state.employees.filter(e => e.lifecycle !== 'archived');
const selected = () => store.state.employees.find(e => e.id === selectedId);
const connected = () => ['live','mock'].includes(store.state.connection);
const spriteNumber = e => e.sprite ?? (Array.from(e.id).reduce((sum,c) => sum+c.charCodeAt(0),0) % 8 + 1);
const preset = e => `/employee-assets/assets/portrait-${spriteNumber(e)}.png`;
const portrait = e => portraits.get(`${currentCompany}/${e.id}`) ?? preset(e);
function toast(text) { $('toast').textContent = text; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5000); }
function pill(e) { const state = employeeStatus(store.state, e), p = node('span', statusNames[state], 'fc-status'); p.dataset.status = state; return p; }
function block(title) { const el = node('section', undefined, 'fc-block'); el.append(node('h3', title)); return el; }
function notice(text) { return node('div', text, 'fc-notice'); }
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
  if (id === 'card') { dirty = false; historyGeneration++; }
  if (id === 'avatar') { avatarGeneration++; imageDraft = undefined; avatarDirty = false; }
  d.close();
  const origin = d._returnFocus;
  const restored = origin?.isConnected ? origin : [...document.querySelectorAll('[data-employee-id]')].find(el => el.dataset.employeeId === origin?.dataset.employeeId && el.className === origin?.className && (el.closest('dialog')?.open ?? true));
  (restored ?? $('open-roster')).focus();
  if (!fromHistory && history.state?.employeeView === id) history.back();
  return true;
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
for (const id of ['roster','card','avatar']) $(id).addEventListener('cancel', e => { e.preventDefault(); closeDialog(id); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dialog = ['confirmation','avatar','card','roster'].map($).find(d => d.open);
  if (!dialog) return;
  const controls = [...dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
});
window.addEventListener('popstate', async () => {
  const top = ['avatar','card','roster'].find(id => $(id).open);
  if (top && history.state?.employeeView !== top && !await closeDialog(top, true)) history.pushState({ employeeView: top }, '', location.href);
});
function openCard(id) { selectedId = id; page = 'overview'; dirty = false; renderCard(); openDialog('card'); $('card-body').scrollTop=0; }
async function navigate(next) { if (!await discard()) return; dirty = false; page = next; renderCard(); $('card-body').scrollTop=0; if (next === 'logs') loadHistory(true); }
$('open-roster').onclick = () => { renderRoster(); openDialog('roster'); };
$('search').oninput = renderRoster; $('filter').onchange = renderRoster;
$('reduce-motion').checked = reduceQuery.matches;
function reduceMotion() { document.body.classList.toggle('fc-reduced', reduced()); if (reduced()) for (const a of animations) a.finish(); }
$('reduce-motion').onchange = reduceMotion; reduceQuery.addEventListener('change', reduceMotion); reduceMotion();
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('fc-hidden', document.hidden); for (const a of animations) document.hidden ? a.pause() : a.play(); });
function renderRoster() {
  const search = $('search').value.trim().toLowerCase(), filter = $('filter').value;
  const list = activeEmployees().filter(e => `${e.displayName} ${e.role}`.toLowerCase().includes(search) && (filter === 'all' || employeeStatus(store.state, e) === filter));
  const signature = JSON.stringify(list.map(e => [e.id,e.displayName,e.role,employeeStatus(store.state,e),portrait(e)]));
  if ($('grid').dataset.signature === signature) return;
  $('grid').dataset.signature = signature;
  const focusId = document.activeElement?.dataset.employeeId;
  const items = list.map(e => { const b = button('', () => openCard(e.id), 'fc-roster-item'); b.dataset.employeeId = e.id; const img = node('img'); img.src = portrait(e); img.alt = ''; const text = node('div'); text.append(node('strong',e.displayName),node('p',e.role),pill(e)); b.append(img,text); return b; });
  $('grid').replaceChildren(...(items.length ? items : [node('p','没有符合条件的员工。','fc-empty')]));
  if (focusId) [...$('grid').children].find(e => e.dataset.employeeId === focusId)?.focus();
}
function position(tableIndex, seat) {
  const x = 290 + tableIndex % 3 * 290, y = 130 + Math.floor(tableIndex / 3) * 240;
  const offsets = [[-57,-55],[57,-55],[108,22],[57,89],[-57,89],[-108,22]];
  return { x: x + offsets[seat][0], y: y + offsets[seat][1], cx:x, cy:y };
}
function renderLobby(state) {
  const companyChanged = lastCompany !== state.companyId;
  if (companyChanged) { for (const a of animations) a.cancel(); animations.clear(); visuals.clear(); $('sprites').replaceChildren(); initialized = false; lastCompany = state.companyId; seenMessages.clear(); }
  const tableSignature = JSON.stringify(state.tables);
  if ($('tables').dataset.signature !== tableSignature) {
    $('tables').dataset.signature = tableSignature; const elements = [];
    state.tables.forEach((table, i) => { const center = position(i,0); const t = node('div', `TABLE ${String(i+1).padStart(2,'0')}`, 'fc-table'); t.style.left = `${center.cx-82}px`; t.style.top = `${center.cy-32}px`; elements.push(t);
      table.seats.forEach((_, j) => { const p = position(i,j), chair = node('div',undefined,'fc-seat'); chair.style.left = `${p.x-17}px`; chair.style.top = `${p.y+4}px`; elements.push(chair); }); });
    $('tables').replaceChildren(...elements);
    $('scene').style.height = `${Math.max(490, Math.ceil(state.tables.length/3)*240+80)}px`;
  }
  const currentIds = new Set(activeEmployees().map(e => e.id));
  for (const [id,v] of visuals) if (!currentIds.has(id)) { v.animation?.cancel(); v.el.remove(); clearTimeout(v.talkTimer); visuals.delete(id); }
  state.tables.forEach((table, i) => table.seats.forEach((id,j) => {
    const e = state.employees.find(e => e.id === id); if (!e) return; const p = position(i,j); let v = visuals.get(id);
    if (!v) {
      const el = button('', () => openCard(id), 'fc-person'), sprite = node('span',undefined,'fc-sprite'), label = node('span',undefined,'fc-person-label'); el.dataset.employeeId=id;sprite.style.backgroundImage = `url('/employee-assets/assets/sprite-${spriteNumber(e)}.png')`; el.append(sprite,label); $('sprites').append(el); v = { el,label }; visuals.set(id,v);
      if (initialized && connected() && !reduced()) {
        // Follow horizontal aisle, then table perimeter: never cross tabletop.
        const aisle = p.cy + 118, sideX = j < 3 ? p.cx+120 : p.cx-120;
        const points = [[70,120],[140,120],[140,aisle],[sideX,aisle],[sideX,p.y],[p.x,p.y]];
        const animation = el.animate(points.map(([x,y]) => ({ left:`${x}px`,top:`${y}px` })), { duration:2200, easing:'linear' });
        v.animation = animation; el.dataset.walking = 'true'; animations.add(animation);
        animation.onfinish = animation.oncancel = () => { delete el.dataset.walking; animations.delete(animation); v.animation = null; };
      }
    }
    v.el.style.left = `${p.x}px`; v.el.style.top = `${p.y}px`; v.label.textContent = e.displayName;
    v.el.dataset.status = employeeStatus(state,e); v.el.setAttribute('aria-label',`${e.displayName}，${e.role}，${statusNames[employeeStatus(state,e)]}`);
    if (!v.talking || !connected()) v.el.dataset.action = visualAction(state,e);
    if (!connected()) { v.animation?.finish(); clearTimeout(v.talkTimer); v.talking = false; }
  }));
  if (initialized && connected()) for (const event of state.activity ?? []) if (event.kind === 'message.sent' && !seenMessages.has(event.id)) {
    seenMessages.add(event.id);
    for (const id of [event.employeeId,event.toEmployeeId]) { const v = visuals.get(id); if (!v) continue; clearTimeout(v.talkTimer); v.talking = true; v.el.dataset.action = 'talking'; v.talkTimer = setTimeout(() => { v.talking = false; const e = store.state.employees.find(e => e.id === id); if (e) v.el.dataset.action = visualAction(store.state,e); },3000); }
  }
  if (!initialized) for (const event of state.activity ?? []) seenMessages.add(event.id);
  if (connected()) initialized = true;
}
function render(state) {
  const employees = activeEmployees(); $('count').textContent = employees.length;
  const running = employees.filter(e => employeeStatus(state,e) === 'running').length;
  $('counts').textContent = `${employees.length} 位成员 / ${running} 运行中 / ${employees.filter(e => employeeStatus(state,e)==='idle').length} 空闲`;
  $('mode').textContent = demo ? '模拟模式' : '本地 Runtime';
  $('connection').dataset.state = state.connection;
  $('connection').textContent = !connected() ? '连接中断或数据尚未同步。保留最后已知状态；工作动画和写操作已停止，正在重新获取完整快照。' : demo ? '模拟数据 · 所有运行、命令和配置仅用于交互演示，不连接模型。' : `真实 Kernel 数据 · 每 2 秒同步 · 模型执行尚未接入${employees.length ? '' : ' · 当前公司暂无员工，请通过团队现有创建/导入流程加入。'}`;
  renderLobby(state); if ($('roster').open) renderRoster();
  if ($('card').open) {
    if (!selected() || selected().lifecycle === 'archived') closeDialog('card');
    else if (page === 'overview' || page === 'details') {
      const signature = JSON.stringify([selected(),state.runs,state.tasks,state.activity,state.connection,pending]);
      if (signature !== cardSignature) { cardSignature = signature; renderCard(); }
    }
    else { $('card-footer').querySelectorAll('[data-command]').forEach(b => b.disabled = pending || !connected()); }
  }
  const events = (state.activity ?? []).slice(0,3);
  $('feed').replaceChildren(...(events.length ? events.map(e => { const a = node('article'); a.append(node('time',new Date(e.at).toLocaleTimeString('zh-CN')),node('span',e.summary)); return a; }) : [node('div','尚无公开工作记录。新事件会在这里出现。','fc-empty')]));
}
const unsubscribe = store.subscribe(render);
function overview(e) {
  const wrap = node('div',undefined,'fc-overview'), left = node('div'), right = node('div'), run = employeeRun(store.state,e.id);
  const photo = node('div',undefined,'fc-portrait'), img = node('img'); img.src = portrait(e); img.alt = `${e.displayName}的本地肖像`; photo.append(img,button('▧ 更换肖像',openAvatar)); left.append(photo);
  const live = block('● 当前活动'), log = node('div',undefined,'fc-mini-log'); log.setAttribute('aria-label','近期公开活动');
  const events = (store.state.activity??[]).filter(a => a.employeeId === e.id || a.toEmployeeId === e.id).slice(0,5);
  for (const a of events) { const p = node('p',a.summary); p.append(node('time',new Date(a.at).toLocaleTimeString('zh-CN'))); log.append(p); }
  if (!events.length) log.append(node('p','没有公开记录')); live.append(log,button('查看历史 →',()=>navigate('logs'))); left.append(live);
  const identity = block('员工身份'); identity.classList.add('fc-identity'); identity.append(node('h2',e.displayName),pill(e),node('div',e.id,'fc-id'),node('div',e.role,'fc-role'),node('p',e.description || '长期员工身份 · 独立于单次运行')); right.append(identity);
  const work = block(run && ['running','paused','waiting'].includes(run.status) ? '当前任务' : '最近任务'), task = store.state.tasks.find(t => t.id === run?.taskId);
  work.append(node('p',task?.title??'等待新的工作安排'),button('查看任务详情 →',()=>navigate('details'))); right.append(work);
  const usage = block('本次 Token 用量 / 单次预算'); usage.append(node('div',tokenLabel(run),'fc-token'));
  const bar = node('div',undefined,'fc-token-bar'); if (Number.isFinite(run?.tokenUsed) && Number.isFinite(run?.tokenLimit) && run.tokenLimit > 0) { const fill = node('span'); fill.style.width = `${Math.min(100,run.tokenUsed/run.tokenLimit*100)}%`; bar.append(fill); }
  usage.append(bar,node('p',demo ? '模拟配额消耗，不是任务进度。' : 'Runtime 尚未提供 usage 与预算；未知值不记为 0。')); right.append(usage);
  const skills = block('岗位能力'), tags = node('div',undefined,'fc-tags'); for (const s of e.capabilities??[]) tags.append(node('span',s)); if (!tags.children.length) tags.append(node('span','未提供')); skills.append(tags); right.append(skills);
  const tools = block('工具 / 权限'); tools.append(node('p','未接入工具与授权目录')); right.append(tools); wrap.append(left,right); return wrap;
}
function renderCard() {
  const e = selected(); if (!e) return;
  $('card-heading').textContent = e.displayName;
  const body = $('card-body'), scroll = body.scrollTop;
  const focusText = $('card').contains(document.activeElement) ? document.activeElement?.textContent : null;
  const activityScroll = body.querySelector('.fc-mini-log')?.scrollTop ?? 0;
  const title = node('h2',e.displayName); title.id = 'card-title'; title.hidden = true;
  body.replaceChildren(title); $('card-footer').replaceChildren();
  if (!connected()) body.append(notice('连接中断：以下是最后已知数据，写操作与工作动画已停止。'));
  if (page === 'overview') body.append(overview(e));
  else { const head = node('div',undefined,'fc-subtitle'); head.append(button('← 返回',()=>navigate('overview')),node('h2',{ settings:'Agent 设置',details:'工作详情',logs:'公开活动历史',assign:'分配任务' }[page])); body.append(head);
    if (page === 'settings') body.append(settings(e));
    if (page === 'details') body.append(details(e));
    if (page === 'logs') { body.append(notice('公开状态摘要；不读取工作指令、密钥、隐藏推理或产物正文。')); const list = node('ul',undefined,'fc-history'); list.id = 'history-list'; body.append(list); const more = button('加载更多',()=>loadHistory(false)); more.id='history-more'; body.append(more); }
    if (page === 'assign') body.append(assignForm(e));
  }
  if (page === 'overview') {
    $('card-footer').append(button('⚙ 设置',()=>navigate('settings')),button('查看详情',()=>navigate('details')),button('分配任务',()=>navigate('assign'),'fc-primary'));
    const run = employeeRun(store.state,e.id), kind = run?.status === 'paused' ? 'resume':'pause';
    const pause = button(kind === 'pause' ? 'Ⅱ 暂停':'▷ 恢复',()=>execute(kind,{employeeId:e.id})); pause.disabled = !demo || !connected() || pending || (kind==='pause' && run?.status!=='running'); pause.title = demo ? '模拟命令，确认后改变状态' : '后端没有安全点暂停/恢复接口'; $('card-footer').append(pause,button('日志',()=>navigate('logs')));
  }
  if (page !== 'logs') body.scrollTop = scroll;
  const activity = body.querySelector('.fc-mini-log'); if (activity) activity.scrollTop = activityScroll;
  if (focusText) [...$('card').querySelectorAll('button')].find(b => b.textContent === focusText && !b.disabled)?.focus({preventScroll:true});
}
function details(e) {
  const section = node('div'), runs = store.state.runs.filter(r=>r.employeeId===e.id).toReversed();
  if (!runs.length) section.append(notice('此员工尚无运行记录。'));
  for (const r of runs) { const task=store.state.tasks.find(t=>t.id===r.taskId), b=block(task?.title??r.taskId); b.append(node('p',`状态：${statusNames[r.status]??r.status}`),node('div',`Run ${r.id}`,'fc-id'),node('p',`配置版本：${r.configVersion??'后端未提供'} · generation：${r.generation??'未提供'}`),node('p',`依赖：${task?.dependencies?.join(', ') || '后端未提供依赖图'}`));
    if(r.endReason) b.append(node('p',`结束原因：${r.endReason}`));
    const artifacts = (task?.artifacts??[]).filter(a=>a.workerRunId===r.id); b.append(node('h3','产物'));
    for(const a of artifacts) b.append(node('p',`${a.title} · ${a.kind}`),node('div',a.id,'fc-id'));
    if(!artifacts.length)b.append(node('p','没有该运行的产物记录。')); section.append(b); }
  return section;
}
async function loadHistory(reset) {
  const generation = ++historyGeneration, id=selectedId, company=currentCompany;
  if(reset){historyPage=[];historyCursor=null;}
  try { const result=await adapter.history(company,id,reset?undefined:historyCursor); if(generation!==historyGeneration||page!=='logs'||id!==selectedId)return;
    historyPage=[...new Map([...historyPage,...result.items].map(e=>[e.id,e])).values()];historyCursor=result.nextCursor;
    $('history-list').replaceChildren(...historyPage.map(e=>{const li=node('li',e.summary);li.append(node('time',`${new Date(e.at).toLocaleString('zh-CN')} · ${e.source==='mock'?'模拟':'Runtime'}`));return li;}));
    if(!historyPage.length)$('history-list').append(node('li','尚无活动记录'));
    $('history-more').disabled=!historyCursor; $('history-more').textContent=historyCursor?'加载更多':'已显示全部';
  } catch(error){if(generation===historyGeneration)toast(`读取失败：${error.message}`);}
}
function settings(e) {
  const form = node('form',undefined,'fc-settings'); draftVersion=e.configVersion;
  form.append(notice(demo?`模拟配置 v${e.configVersion}；更改只应用于下一次模拟运行。`:'Runtime 尚无配置版本与写入接口。以下运行配置禁用；启用/停用只影响未来派工，不暂停当前运行。'));
  const label=(text,name,value,disabled=false,multiline=false)=>{const l=node('label',text),i=node(multiline?'textarea':'input');i.name=name;i.value=value??'';i.disabled=disabled;l.append(i);return l;};
  const basic=node('fieldset');basic.append(node('legend','基本信息'),label('姓名','displayName',e.displayName,!demo),label('职位（岗位定义）','role',e.role,true));form.append(basic);
  const instructions=node('fieldset');instructions.append(node('legend','工作指令'),label('下一次运行使用','instructions',e.config?.instructions??'未接入',!demo,true));form.append(instructions);
  for(const [group,text] of [['模型','模型 / temperature / reasoningEffort：未接入能力目录'],['工具与资料','工具权限 / 知识来源 / 记忆：未接入授权目录'],['协作','委派 / handoff / 并发：由现有协调器控制'],['结果','输出格式 / JSON Schema：未接入'],['审核','外部写入审批：未接入；前端不能授予权限']]){const f=node('fieldset');f.disabled=true;f.append(node('legend',group),label(text,group,'未接入',true));form.append(f);}
  const limits=node('fieldset');limits.append(node('legend','运行限制'),label('单次 Token 预算（演示）','tokenLimitPerRun',e.config?.tokenLimitPerRun??'未提供',!demo));form.append(limits);
  form.elements.tokenLimitPerRun.type=demo?'number':'text'; if(demo){form.elements.tokenLimitPerRun.min='1';form.elements.tokenLimitPerRun.step='1';form.elements.displayName.maxLength=40;form.elements.instructions.maxLength=16000;}
  form.addEventListener('input',()=>dirty=true);
  const save=button(demo?'保存模拟配置':'配置保存未接入',()=>{});save.type='submit';save.disabled=!demo;form.append(save);
  form.onsubmit=async ev=>{ev.preventDefault(); if(!demo||pending||!connected())return;try{adapter.updateConfig(e.id,{displayName:form.elements.displayName.value,instructions:form.elements.instructions.value,tokenLimitPerRun:Number(form.elements.tokenLimitPerRun.value)},draftVersion);dirty=false;toast('模拟配置已保存，下次模拟运行生效');renderCard();}catch(error){toast(error.message);}};
  const enable=button(e.enabled?'停用未来派工':'启用未来派工',async()=>{if(await ask(`${e.enabled?'停用':'启用'}“${e.displayName}”的未来派工？${demo?'（模拟）':'当前运行不会被暂停。'}`))execute('enabled',{employeeId:e.id,enabled:!e.enabled});});enable.dataset.command='enabled';enable.disabled=!connected()||pending;form.append(enable);
  const danger=node('fieldset',undefined,'fc-danger');danger.append(node('legend','危险区 · 删除 Agent（归档）'),node('p',demo?'仅模拟归档；保留历史与导入抑制标记。活跃运行必须先取消并确认。':'后端缺少归档事务与导入抑制标记，禁止删除。停用不等于删除。'));
  const name=label('输入完整员工名称确认','confirmName','',!demo);danger.append(name);
  const cancel=button('取消模拟运行',async()=>{if(await ask('确认取消该员工的模拟运行？'))execute('cancel',{employeeId:e.id});});cancel.disabled=!demo||canArchive(store.state,e.id)||pending||!connected();danger.append(cancel);
  const archive=button(demo?'确认模拟归档':'删除未接入',()=>{const wasDirty=dirty;try{dirty=false;adapter.archive(e.id,form.elements.confirmName.value,draftVersion);closeDialog('card');toast('模拟归档完成；未删除真实员工');}catch(error){dirty=wasDirty;toast(error.message);}});archive.disabled=!demo||pending||!connected();danger.append(archive);form.append(danger);return form;
}
function assignForm(e) {
  const form=node('div',undefined,'fc-settings');form.append(notice(demo?'创建一条模拟任务，命令受理后等待确认。':'分配与启动为两个明确操作。真实命令写入 Kernel；尚无模型执行适配器，不会调用 LLM。'));
  if(demo){const label=node('label','模拟任务标题'),input=node('input');input.id='task-title';input.maxLength=160;input.value='整理下一轮产品发布清单';label.append(input);form.append(label,button('确认分配模拟任务',()=>execute('assign',{employeeId:e.id,title:input.value}),'fc-primary'));return form;}
  const tasks=store.state.tasks.filter(t=>['OPEN','INTERRUPTED'].includes(t.state));
  if(!tasks.length){form.append(notice('没有可分配的待办/中断任务。请通过现有 Work 流程创建任务。'));return form;}
  for(const task of tasks){const row=block(task.title);row.append(node('div',`${task.id} · ${task.state}`,'fc-id'));const assigned=store.state.employees.find(x=>x.id===task.employeeId);row.append(node('p',`当前指派：${assigned?.displayName??'未指派'}`));
    const assign=button('确认分配给此员工',async()=>{if(await ask(`将“${task.title}”分配给“${e.displayName}”？`))execute('assign',{employeeId:e.id,taskId:task.id,expectedAssignmentId:task.assignmentId});});assign.disabled=pending||!connected()||!e.enabled||!canArchive(store.state,e.id);row.append(assign);
    if(task.employeeId===e.id){const start=button('启动 Kernel 运行',async()=>{if(await ask('启动一次真实 Kernel 执行记录？当前项目没有模型执行器。'))execute('start',{employeeId:e.id,taskId:task.id});},'fc-primary');start.disabled=pending||!connected()||!e.enabled||!canArchive(store.state,e.id);row.append(start);}form.append(row);}
  return form;
}
async function execute(kind,input){
  if(pending||!connected()||!await discard())return;dirty=false;pending=true;$('company').disabled=true;toast('命令请求中，等待后端确认…');renderCard();
  try{const ack=await adapter.command(currentCompany,kind,input);if(ack.state!=='confirmed')throw new Error('命令尚未确认，请核对状态');
    store.snapshot(await adapter.snapshot(currentCompany));toast(`${demo?'模拟':'Kernel'}命令已确认${ack.runId?` · Run ${ack.runId}`:''}`);
  }catch(error){toast(`命令未确认：${error.message}。请核对最新状态，勿盲目重试。`);try{store.snapshot(await adapter.snapshot(currentCompany));}catch{store.connection('offline');}}
  finally{pending=false;$('company').disabled=false;if($('card').open)renderCard();}
}
async function setImage(src){const generation=++avatarGeneration;try{const img=new Image();img.src=src;await img.decode();if(generation!==avatarGeneration||!$('avatar').open)return;if(img.naturalWidth*img.naturalHeight>16000000)throw new Error('图片解码超过 1600 万像素');imageDraft=img;avatarDirty=true;for(const id of ['zoom','pan-x','pan-y'])$(id).value=id==='zoom'?'1':'0';drawCrop();$('avatar-error').textContent='';$('save-portrait').disabled=false;}catch(error){if(generation===avatarGeneration){$('avatar-error').textContent=`无法使用此图片：${error.message}。原肖像未改变。`;$('save-portrait').disabled=true;}}}
function drawCrop(){if(!imageDraft)return;const rect=cropRect(imageDraft.naturalWidth,imageDraft.naturalHeight,Number($('zoom').value),Number($('pan-x').value),Number($('pan-y').value));const canvas=$('crop'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(imageDraft,rect.x,rect.y,rect.width,rect.height,0,0,canvas.width,canvas.height);}
function openAvatar(){openDialog('avatar');$('avatar-error').textContent='';$('avatar-file').value='';$('presets').replaceChildren(...Array.from({length:8},(_,i)=>{const b=button('',()=>setImage(`/employee-assets/assets/portrait-${i+1}.png`));b.setAttribute('aria-label',`内置肖像 ${i+1}`);const img=node('img');img.src=`/employee-assets/assets/portrait-${i+1}.png`;img.alt='';b.append(img);return b;}));setImage(portrait(selected())).then(()=>avatarDirty=false);}
for(const id of ['zoom','pan-x','pan-y'])$(id).oninput=()=>{avatarDirty=true;drawCrop();};
$('restore-portrait').onclick=()=>setImage(preset(selected()));
$('avatar-file').onchange=async()=>{const file=$('avatar-file').files[0];if(!file)return;$('save-portrait').disabled=true;
  try { await validatePortrait(file); } catch(error) { avatarGeneration++;$('avatar-error').textContent=`${error.message}；原肖像未改变。`;return; }
  const url=URL.createObjectURL(file);try{await setImage(url);}finally{URL.revokeObjectURL(url);}
};
$('save-portrait').onclick=()=>{if(!imageDraft)return;try{const result=$('crop').toDataURL('image/png');portraits.set(`${currentCompany}/${selectedId}`,result);avatarDirty=false;closeDialog('avatar');renderCard();renderRoster();toast('已应用本页本地肖像预览；未上传服务器');}catch{toast('裁剪失败，原肖像未改变');}};
async function selectCompany(id){if(!await discard()){$('company').value=currentCompany;return;}stop();dirty=false;for(const dialog of ['avatar','card','roster'])if($(dialog).open)await closeDialog(dialog,true);currentCompany=id;selectedId=undefined;store.snapshot({companyId:id,employees:[],runs:[],tasks:[],activity:[],source:demo?'mock':'live'});initialized=false;stop=adapter.subscribe(id,store);}
$('company').onchange=()=>selectCompany($('company').value);
$('demo-controls').hidden=!demo;$('mode-link').href=demo?'/employees':'/employees?demo=1';$('mode-link').textContent=demo?'返回真实 Runtime ↗':'查看模拟演示 ↗';
if(demo){$('demo-add').onclick=()=>adapter.add();$('demo-work').onclick=()=>adapter.collaborate();$('demo-offline').onclick=()=>{adapter.connection();$('demo-offline').textContent=adapter.offline?'恢复模拟连接':'模拟断线';};$('demo-sixty').onclick=()=>{while(adapter.data.employees.filter(e=>e.lifecycle==='active').length<60)adapter.add(false);adapter.publish();};}
window.addEventListener('beforeunload',e=>{if(dirty||avatarDirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{stop();unsubscribe();adapter.dispose?.();clearTimeout(toastTimer);for(const a of animations)a.cancel();for(const v of visuals.values())clearTimeout(v.talkTimer);reduceQuery.removeEventListener('change',reduceMotion);});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
async function boot(){
  $('retry-connection').disabled=true;
  try{const companies=await adapter.companies();$('company').replaceChildren(...companies.map(c=>{const o=node('option',c.name);o.value=c.id;return o;}));$('retry-connection').hidden=companies.length>0;if(companies.length)await selectCompany(companies[0].id);else{$('company').append(node('option','尚未创建公司'));store.snapshot({companyId:null,employees:[],tasks:[],runs:[],activity:[],source:'live'});$('connection').textContent='真实 Runtime 已连接，但尚无公司。请先完成团队的 Company 创建流程；也可查看明确标记的模拟演示。';}}
  catch(error){store.connection('offline');$('retry-connection').hidden=false;toast(`连接失败：${error.message}`);}
  finally{$('retry-connection').disabled=false;}
}
$('retry-connection').onclick=boot;await boot();
