import { DemoCompanyAdapter, employees, deliveries } from './demo-adapter.mjs';
import { HiringStore, employeeFromHire, HIRING_KEY } from './hiring-store.mjs';
import { createHiringUI, lobbyURL } from './hiring-ui.mjs';

const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let storage;try{storage=window.localStorage;}catch{/* Private-browser fallback keeps the prototype usable. */}
const hiringStore=new HiringStore(storage);
const baseEmployees=employees.slice();
function syncTeam(){employees.splice(0,employees.length,...baseEmployees,...hiringStore.hires.map(employeeFromHire));}
syncTeam();
const adapter=new DemoCompanyAdapter(storage);
const state={page:'company',employee:'alice',tab:'details',zoom:100,layout:'canvas',widgets:new Set(['team','attention','work','deliveries','pulse'])};
const icons={
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z"/>',
  work:'<path d="M8 4H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 15v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M8 4V2h8v4H8Zm0 8 3 3 5-6"/>',
  user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/>',
  users:'<circle cx="9" cy="7" r="3"/><path d="M2 20v-3a7 7 0 0 1 14 0v3ZM16 4a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 5v2h-3"/>',
  'plus-circle':'<circle cx="12" cy="12" r="9"/><path d="M12 8v8m-4-4h8"/>',
  file:'<path d="M5 3h9l5 5v13H5Zm9 0v6h5M9 13h6m-6 4h6"/>',
  book:'<path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2Z"/>',
  settings:'<path d="m9 3 1-2h4l1 2 3 2 3 1v4l-2 2 2 3-2 4-3-1-3 3h-3l-2-3-4 1-2-4 2-3-2-2V6l3-1Z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  moon:'<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z"/>',
  building:'<path d="M4 22V2h10v20m0-15h6v15M8 6h2m-2 4h2m-2 4h2m6-3h1m-1 4h1M8 22v-4h3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>','chevron-right':'<path d="m9 5 7 7-7 7"/>',
  'arrow-right':'<path d="M4 12h15m-6-6 6 6-6 6"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  clipboard:'<path d="M8 5H5v16h14V5h-3M8 3h8v4H8Zm0 9h8m-8 4h6"/>',
  cube:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M12 12 3 7m9 5v10M7 4.7l10 5.6"/>',
  chart:'<path d="M3 12h4v9H3ZM10 3h4v18h-4Zm7 6h4v12h-4Z"/>',
  cursor:'<path d="m5 3 5 18 3-7 7-3Z" fill="currentColor" stroke-width="1.2"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16m6-14v16"/>',
  panel:'<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8m-4-4v4M16 3v15"/>',
  terminal:'<path d="m4 6 5 6-5 6m9 0h7"/>',message:'<path d="M21 11a8 8 0 0 1-8 8H9l-5 3v-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',alert:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]??icons.file}</svg>`;
function hydrateIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon);});}
function avatar(e,extra=''){return `<span class="avatar ${extra}"><img src="../employee/assets/portrait-${e.portrait}.png" alt="${escape(e.name)}"></span>`;}
function badge(status){return `<span class="badge ${status==='REVIEW'?'review':status==='本地草稿'?'draft':''}">${escape(status)}</span>`;}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),3300);}
function openModal(title,html){$('modal-title').textContent=title;$('modal-content').innerHTML=html;hydrateIcons($('modal'));if(!$('modal').open)$('modal').showModal();$('modal').scrollTop=0;}
function closeModal(){$('modal').close();}
function employee(){return employees.find(e=>e.id===state.employee)??employees[0];}
function inspect(id){if(!employees.some(e=>e.id===id))return;state.employee=id;state.tab='details';renderInspector();if(matchMedia('(max-width:1120px)').matches)$('inspector').classList.add('mobile-open');else document.body.classList.remove('inspector-hidden');syncInspectorButton();}
function syncInspectorButton(){const shown=matchMedia('(max-width:1120px)').matches?$('inspector').classList.contains('mobile-open'):!document.body.classList.contains('inspector-hidden');document.querySelector('.canvas-toolbar [data-action="toggle-inspector"]').setAttribute('aria-pressed',String(shown));}
function renderInspector(){
  const e=employee();document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===state.tab)));
  $('inspector-content').setAttribute('aria-labelledby',`${state.tab}-tab`);
  if(e.source==='hiring-demo'){
    const c=hiringStore.hires.find(h=>h.employeeId===e.id).candidate;
    $('inspector-content').innerHTML=state.tab==='activity'?`<div class="activity-timeline"><p>${escape(e.name)} 的公开活动</p><div class="activity-item"><strong>Founder 已确认入职</strong><p>本地招聘演示 · 尚无真实工作或交付记录。</p></div></div>`:`<div class="employee-profile">${avatar(e)}<div><h2>${escape(e.name)}</h2><span class="employee-state">● Available</span><p class="employee-role">${escape(e.role)}</p><p class="employee-quote">${escape(e.quote)}</p></div></div><section class="inspector-section"><h3>岗位能力 · Declared</h3><div class="tags">${e.skills.map(s=>`<span>${escape(s)}</span>`).join('')}</div></section><section class="inspector-section"><h3>当前工作</h3><p class="modal-hint">等待新的工作，尚无交付记录。</p></section><section class="inspector-section"><h3>招聘确认 · Demo</h3><p class="modal-hint">模拟试用 PASS · Founder 已确认</p><p class="modal-hint">权限：${escape(c.permissions.join(' · ')||'无')}</p><p class="modal-hint">未连接执行环境；禁止外部发布与财务操作。</p></section><button class="full-profile" data-action="employee-profile">在圆桌大厅查看工牌 ${icon('arrow-right')}</button><p class="inspector-footnote">本地演示员工 · 不代表真实入职</p>`;return;
  }
  if(state.tab==='activity'){
    $('inspector-content').innerHTML=`<div class="activity-timeline"><p>${escape(e.name)} 的公开活动 · 演示记录</p>${[['刚刚','等待下一步协作','工作进展将在这里持续呈现。'],['10 分钟前','提交了一份交付物',e.work??'当前没有分配的工作'],['35 分钟前','开始处理工作','已读取工作目标与交付要求。'],['今天 09:00','加入工作空间','所有活动均为 UI 示例，不代表真实执行。']].map(([time,title,copy])=>`<div class="activity-item"><strong>${escape(title)}</strong><p>${escape(copy)}</p><small>${time}</small></div>`).join('')}</div>`;return;
  }
  $('inspector-content').innerHTML=`<div class="employee-profile">${avatar(e)}<div><h2>${escape(e.name)}</h2><span class="employee-state"><i class="status-dot ${e.state==='Available'?'blue-dot':''}"></i>${escape(e.state)}</span><p class="employee-role">${escape(e.role)}</p><p class="employee-quote">“${escape(e.quote)}”</p></div></div><section class="inspector-section"><h3>当前工作</h3>${e.work?`<button class="inspector-work" data-work="${adapter.works().find(w=>w.title===e.work)?.id??'102'}"><span>${icon('alert')}</span><span><strong>${escape(e.work)}</strong><small>${e.state==='Reviewing'?'评审中':e.state==='Working'?'执行中':'待开始'}</small></span><span>${icon('chevron-right')}</span></button>`:'<p class="modal-hint">暂未分配工作，等待新的想法。</p>'}</section><section class="inspector-section"><h3>能力标签</h3><div class="tags">${e.skills.map(s=>`<span>${escape(s)}</span>`).join('')}</div></section><section class="inspector-section"><h3>执行环境</h3><div class="environment"><span class="terminal-icon">${icon('terminal')}</span>Codex Local</div></section><section class="inspector-section artifact-list"><h3>最近交付物</h3>${[['Export API','api'],['User Auth Fix','patch'],['Docs Improvement','research']].map(([name,id])=>`<button class="side-artifact" data-artifact="${id}"><span class="file-symbol">${icon('file')}</span><span>${name}</span>${badge(id==='research'?'REVIEW':'PASS')}</button>`).join('')}<button class="full-profile" data-action="employee-profile">查看完整档案 ${icon('arrow-right')}</button></section><section class="quick-actions"><h3>快捷操作</h3><div class="quick-action-grid"><button data-action="message"><span>${icon('message')}</span>发送消息</button><button data-action="employee-work"><span>${icon('work')}</span>查看工作</button><button data-action="employee-profile"><span>${icon('more')}</span>更多</button></div></section><p class="inspector-footnote">示例员工 · 执行环境尚未连接</p>`;
}
function renderDeliveries(){$('recent-deliveries').innerHTML=deliveries.map(d=>`<button class="delivery-row" data-artifact="${d.id}">${avatar(employees.find(e=>e.id===d.employee))}<span><strong>${d.title}</strong><small>${d.work}</small></span>${badge(d.status)}</button>`).join('');}
function workRow(w){const e=employees.find(e=>e.id===w.employee);return `<button class="list-card" data-work="${escape(w.id)}">${avatar(e)}<span><strong>${escape(w.title)}</strong><small>${escape(e.name)} · ${escape(w.priority)}${w.source==='demo'?' · 仅保存于此浏览器':''}</small></span>${badge(w.status)}${icon('chevron-right')}</button>`;}
const pageInfo={company:['Good morning, Founder.','你的 AI 公司，一切从这里开始。'],work:['Work, in motion.','让每一个想法，都有清晰的下一步。'],employees:['Meet your workforce.','熟悉的身影，各有所长。'],hiring:['Make room for possibility.','为公司需要的新能力，找到合适的伙伴。'],artifacts:['Ideas, delivered.','工作留下成果，每一份成果都有来处。'],knowledge:['A company that remembers.','让被确认的知识，成为团队共同的记忆。']};
function navigate(page,{updateHash=true}={}){
  if(page==='employees'){location.assign(lobbyURL());return;}
  if(!pageInfo[page])page='company';state.page=page;
  if(updateHash&&location.hash!==`#${page}`)history.replaceState(null,'',`#${page}`);
  $('page-title').textContent=pageInfo[page][0];$('page-description').textContent=pageInfo[page][1];
  document.querySelectorAll('.nav-item[data-nav]').forEach(b=>{b.classList.toggle('active',b.dataset.nav===page);if(b.dataset.nav===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('canvas-view').hidden=page!=='company';$('section-view').hidden=page==='company';
  if(page==='company')return;
  let html='';
  if(page==='work')html=`<div class="section-head"><h2>全部工作 <span class="badge draft">${adapter.works().length}</span></h2><button class="primary-button" data-action="new-work">＋ 新建 Work</button></div><p class="section-note">演示空间中的工作。新建内容保存为本地草稿，不会触发真实执行。</p><div class="section-list">${adapter.works().map(workRow).join('')}</div>`;
  if(page==='employees')html=`<div class="section-head"><h2>你的团队</h2><span>8 位成员 · 示例员工</span></div><div class="employee-grid">${employees.map(e=>`<button class="employee-tile" data-employee="${e.id}">${avatar(e)}<strong>${escape(e.name)}</strong><small>${escape(e.role)}</small><span class="employee-status"><i class="status-dot ${e.state==='Available'?'blue-dot':''}"></i>${escape(e.state)}</span></button>`).join('')}</div>`;
  if(page==='artifacts')html=`<div class="section-head"><h2>最近交付</h2><span>3 份示例成果</span></div><p class="section-note">PASS 是评审状态，不等于你已接受成果。当前内容均为界面演示。</p><div class="section-list">${deliveries.map(d=>`<button class="list-card" data-artifact="${d.id}"><span class="file-symbol">${icon('file')}</span><span><strong>${d.title}</strong><small>${d.work} · ${employees.find(e=>e.id===d.employee).name}</small></span>${badge(d.status)}${icon('chevron-right')}</button>`).join('')}</div>`;
  if(page==='hiring')html=hiring.overview();
  if(page==='knowledge')html=`<div class="empty-panel"><span class="color-icon blue">${icon('book')}</span><h2>让好的想法，成为共同的知识</h2><p>这里将存放你确认过的公司资料、原则和工作经验。完成工作或接受交付物，都不会自动改写公司知识。</p><span class="badge draft">知识模块尚未接入</span></div>`;
  $('section-view').innerHTML=html;
}

function showWork(id='102'){
  const w=adapter.works().find(w=>w.id===id);if(!w)return;
  const e=employees.find(e=>e.id===w.employee);
  openModal(w.title,`<p class="modal-copy">${w.source==='demo'?'本地演示草稿 · 尚未提交 Runtime':'示例工作 · 所有状态与结果仅用于 UI 演示'}</p><div class="detail-box"><h3>工作目标</h3><p>${escape(w.description||'尚未填写工作说明。')}</p></div><div class="detail-box"><h3>负责人和状态</h3><p>${escape(e.name)} · ${escape(e.role)}\n${escape(w.priority)} · ${w.status}</p></div>${id==='102'?'<div class="detail-box"><h3>交付要求</h3><ul><li>修复登录状态刷新失败</li><li>补充过期与并发刷新场景的测试</li><li>独立评审通过后，等待 Founder 验收</li></ul></div>':''}<div class="form-actions"><button class="secondary-button" data-action="close-modal">关闭</button><button class="primary-button" data-employee="${e.id}" data-close-after>查看负责员工</button></div>`);
}
function showArtifact(id='patch'){
  const d=deliveries.find(d=>d.id===id);if(!d)return;
  openModal(d.title,`<p class="modal-copy">${d.work} · ${badge(d.status)} · 示例交付物</p><div class="detail-box"><h3>内容预览</h3><p>${escape(d.body)}</p></div><p class="modal-hint">这里展示交付物阅读体验；未读取真实仓库代码或模型输出。</p><div class="form-actions"><button class="primary-button" data-action="close-modal">完成阅读</button></div>`);
}
function newWork(){
  openModal('一个新的想法',`<p class="modal-copy">告诉团队你想完成什么。此版本只创建浏览器本地草稿。</p><form id="new-work-form" class="modal-form"><label class="form-field">工作名称<input name="title" placeholder="例如：整理下一轮产品发布清单" maxlength="100" required autofocus></label><label class="form-field">预期成果<textarea name="description" placeholder="希望得到什么？有哪些需要注意的事情？" maxlength="3000"></textarea></label><label class="form-field">负责员工<select name="employee">${employees.map(e=>`<option value="${e.id}">${escape(e.name)} · ${escape(e.role)}</option>`).join('')}</select></label><label class="form-field">优先级<select name="priority"><option>普通优先级</option><option>高优先级</option></select></label><p class="modal-hint">仅保存在此浏览器，不调用模型、不启动任务。</p><div class="form-actions"><button type="button" class="secondary-button" data-action="close-modal">稍后再说</button><button class="primary-button" type="submit">创建本地草稿</button></div></form>`);
  $('new-work-form').addEventListener('submit',event=>{event.preventDefault();try{adapter.createWork(Object.fromEntries(new FormData(event.currentTarget)));closeModal();navigate('work');$('metric-new').textContent=6+adapter.drafts.length;toast(adapter.storageAvailable?'工作草稿已保存到此浏览器':'浏览器存储不可用，草稿仅保留在本页');}catch(error){toast(error.message);}});
}
function showSearch(){
  openModal('寻找工作或伙伴',`<input class="search-input" id="global-search" aria-label="搜索名称、职位或工作" placeholder="搜索名称、职位或工作…" autofocus><div class="search-results" id="search-results"></div><p class="modal-hint">Ctrl / ⌘ K 打开搜索 · Esc 关闭</p>`);
  const render=()=>{const query=$('global-search').value.trim().toLowerCase();const foundPeople=employees.filter(e=>`${escape(e.name)} ${escape(e.role)}`.toLowerCase().includes(query));const foundWorks=adapter.works().filter(w=>w.title.toLowerCase().includes(query));$('search-results').innerHTML=[...foundWorks.map(w=>`<button data-work="${escape(w.id)}"><span class="file-symbol">${icon('work')}</span><span>${escape(w.title)}<small>工作 · ${w.status}</small></span></button>`),...foundPeople.map(e=>`<button data-employee="${e.id}" data-close-after>${avatar(e)}<span>${escape(e.name)}<small>${escape(e.role)}</small></span></button>`)].join('')||'<p>没有找到匹配的工作或员工。</p>';};
  $('global-search').addEventListener('input',render);render();
}
function showAttention(){openModal('需要你的判断',`<p class="modal-copy">只把需要你做决定的事情，放到你面前。以下为待办样式示例。</p><div class="detail-box"><h3>验收 OAuth Refresh Bug</h3><p>补丁已准备好。查看交付物，再决定是否接受。</p><div class="form-actions"><button class="secondary-button" data-artifact="patch">查看示例交付物</button></div></div><div class="detail-box"><h3>确认 Market Analysis 的研究范围</h3><p>请明确优先关注产品定位、价格还是用户体验。</p><div class="form-actions"><button class="secondary-button" data-work="103">查看工作说明</button></div></div><p class="modal-hint">本版不提供真实审批操作，示例待办不会被写入后端。</p>`);}
function showProfile(){location.assign(lobbyURL(employee().id));}
function showWidgets(){openModal('让画布适合你的工作',`<p class="modal-copy">选择想在公司画布中看到的内容。调整只影响本页布局。</p>${[['team','AI Workforce','团队成员与员工入口'],['work','当前工作','交付、评审与等待决策的过程'],['attention','需要你处理','关键待决事项'],['deliveries','Recent Deliveries','最近提交的成果'],['pulse','Company Pulse','公司的日常概览']].map(([id,title,description])=>`<label class="dialog-row"><span>${title}<small>${description}</small></span><input type="checkbox" data-widget-toggle="${id}" ${state.widgets.has(id)?'checked':''}></label>`).join('')}`);}
function layout(value){state.layout=value;$('canvas-stage').classList.toggle('grid-layout',value==='grid');document.querySelectorAll('[data-action="canvas-layout"],[data-action="grid-layout"]').forEach(b=>{const selected=b.dataset.action===`${value}-layout`;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});}
function zoom(delta){state.zoom=Math.max(70,Math.min(120,delta===0?100:state.zoom+delta));$('canvas-stage').style.transform=`scale(${state.zoom/100})`;$('zoom-value').textContent=`${state.zoom}%`;}
const actions={
  'new-work':newWork,search:showSearch,attention:showAttention,'work-detail':()=>showWork(),artifact:()=>showArtifact(),'employee-profile':showProfile,widgets:showWidgets,
  'close-modal':closeModal,'canvas-layout':()=>layout('canvas'),'grid-layout':()=>layout('grid'),'zoom-in':()=>zoom(10),'zoom-out':()=>zoom(-10),'zoom-reset':()=>zoom(0),
  'toggle-inspector':()=>{if(matchMedia('(max-width:1120px)').matches)$('inspector').classList.toggle('mobile-open');else document.body.classList.toggle('inspector-hidden');syncInspectorButton();},
  'employee-work':()=>{const w=adapter.works().find(w=>w.title===employee().work);if(w)showWork(w.id);else openModal('等待新的工作','<p class="modal-copy">这位员工目前没有分配的工作。你可以先创建一份本地工作草稿。</p><button class="primary-button" data-action="new-work">新建 Work</button>');},
  'canvas-map':()=>openModal('你的公司画布',`<p class="modal-copy">从一个目标出发，让团队、工作和成果连接起来。</p><div class="detail-box"><h3>团队 → 工作 → 交付 → 你的决定</h3><p>左上：AI Workforce\n中央：当前工作的协作过程\n右上：需要你处理的事项\n左下：最近交付物\n右下：公司概览</p></div><button class="primary-button" data-action="widgets">管理画布内容</button>`),
  pulse:()=>openModal('Company Pulse · 今日概览',`<p class="modal-copy">以下数字仅演示概览组件的样式。</p><div class="detail-box"><h3>工作正在向前</h3><p>新建工作：${6+adapter.drafts.length}\n完成交付：3\n等待 Review：2\n需要你处理：2</p></div><p class="modal-hint">真实统计将在接入 Runtime 后计算，本地草稿不代表任务已执行。</p>`),
  'demo-info':()=>openModal('这是你的公司工作台初版','<p class="modal-copy">当前为纯前端演示空间，用来体验布局和交互。员工、运行状态、测试结果、交付物与指标均为示例数据。</p><div class="detail-box"><h3>现在可以体验</h3><p>浏览公司画布、切换员工、查看工作和交付物、创建本地草稿、搜索、调整画布布局。</p></div><p class="modal-hint">没有连接 Runtime、模型或外部服务，也不会产生真实执行与审批。</p>'),
  workspace:()=>openModal('工作空间',`<button class="list-card" data-action="close-modal"><span class="color-icon blue">${icon('building')}</span><span><strong>FlowCredit Studio</strong><small>当前空间 · UI 演示</small></span>${icon('check')}</button><p class="modal-hint" style="margin-top:17px">此版本只有一个演示空间，公司创建与切换将在后续接入。</p>`),
  profile:()=>openModal('你好，Founder。','<p class="modal-copy">目标由你提出，关键决定由你确认。你的团队负责把工作向前推进。</p><div class="detail-box"><h3>FlowCredit Studio</h3><p>本地演示身份 · 未连接登录账户</p></div>'),
  settings:()=>openModal('让这里更像你的工作空间',`<label class="dialog-row"><span>减少动态效果<small>关闭布局和交互过渡动画</small></span><input type="checkbox" data-setting="motion" ${document.body.classList.contains('reduced-motion')?'checked':''}></label><label class="dialog-row"><span>安静的背景<small>用柔和渐变替换雪山背景</small></span><input type="checkbox" data-setting="background" ${document.body.classList.contains('quiet-background')?'checked':''}></label><p class="modal-hint" style="margin-top:20px">设置仅应用于本页。模型、运行与权限配置尚未接入。</p>`),
  message:()=>openModal(`给 ${employee().name} 的消息`,'<p class="modal-copy">员工消息功能还没有接入。后续你可以在这里补充工作背景、讨论交付物，或给出下一步方向。</p><div class="detail-box"><h3>预留的对话入口</h3><p>这版先确认界面和信息层级，不会向员工或外部服务发送任何内容。</p></div>'),
  'hiring-preview':()=>openModal('岗位需求 · 研究分析师','<p class="modal-copy">招聘流程的内容示例，尚未创建真实岗位或员工。</p><div class="detail-box"><h3>这位伙伴负责什么</h3><p>定期研究竞品变化，整理可信来源，输出有依据的分析与建议。</p></div><div class="detail-box"><h3>入职前需要确认</h3><ul><li>职责与交付要求</li><li>可访问的资料和工具权限</li><li>一份可以检查的试用成果</li><li>Founder 明确确认</li></ul></div>'),
};
document.addEventListener('click',event=>{
  const target=event.target.closest('button,a');if(!target)return;
  if(target.dataset.nav){navigate(target.dataset.nav);return;}
  if(target.dataset.employee){if(target.hasAttribute('data-close-after'))closeModal();inspect(target.dataset.employee);return;}
  if(target.dataset.work){showWork(target.dataset.work);return;}
  if(target.dataset.artifact){showArtifact(target.dataset.artifact);return;}
  if(target.dataset.tab){state.tab=target.dataset.tab;renderInspector();return;}
  if(target.dataset.action)actions[target.dataset.action]?.();
});
document.addEventListener('change',event=>{const t=event.target;if(t.dataset.widgetToggle){if(t.checked)state.widgets.add(t.dataset.widgetToggle);else state.widgets.delete(t.dataset.widgetToggle);document.querySelector(`[data-widget="${t.dataset.widgetToggle}"]`).hidden=!t.checked;}if(t.dataset.setting==='motion')document.body.classList.toggle('reduced-motion',t.checked);if(t.dataset.setting==='background')document.body.classList.toggle('quiet-background',t.checked);});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();showSearch();}if(event.key==='Escape'&&!$('modal').open)$('inspector').classList.remove('mobile-open');});
document.querySelector('.inspector-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!event.target.matches('[role="tab"]'))return;event.preventDefault();state.tab=event.key==='Home'?'details':event.key==='End'?'activity':state.tab==='details'?'activity':'details';renderInspector();$(`${state.tab}-tab`).focus();});
$('modal').addEventListener('click',event=>{if(event.target!==$('modal'))return;const r=$('modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();});
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),{updateHash:false}));
window.addEventListener('resize',syncInspectorButton);
function updateClock(){const now=new Date();$('date').textContent=now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});$('time').textContent=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
function refreshTeam(){syncTeam();$('team-avatars').innerHTML=employees.slice(0,4).map(e=>`<button class="avatar-button" data-employee="${e.id}" aria-label="查看 ${escape(e.name)}">${avatar(e)}</button>`).join('')+`<button class="more-people" data-nav="employees" aria-label="查看全部 ${employees.length} 位员工">+${employees.length-4}</button>`;document.querySelector('.company-status>span:nth-of-type(2)').textContent=`${employees.length} 名员工`;document.querySelector('.workforce-card .card-heading small').textContent=`${employees.length} 名员工 · 3 工作中`;}
const hiring=createHiringUI({store:hiringStore,onHired:()=>{refreshTeam();renderInspector();},onRefresh:()=>{if(state.page==='hiring')$('section-view').innerHTML=hiring.overview();}});
pageInfo.hiring=['Hiring','Build the team your company needs.'];
window.addEventListener('storage',event=>{if(event.key!==HIRING_KEY)return;hiringStore.load();refreshTeam();renderInspector();if(state.page==='hiring')navigate('hiring');});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
refreshTeam();
$('metric-new').textContent=6+adapter.drafts.length;
hydrateIcons();renderDeliveries();renderInspector();navigate(location.hash.slice(1)||'company');updateClock();syncInspectorButton();setInterval(updateClock,30000);
