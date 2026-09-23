import { symbol } from './icons.mjs';
import { verdictText, workStatusText, workIntentText } from './domain.mjs';
import { readCompanyMemory, MEMORY_TYPES, MEMORY_FRESHNESS, memoryScopeText, filterMemory, contextUseText, workEvidence, filterWorkEvidence, safeSourceUrl } from './company-memory-domain.mjs';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const text=(value,cls='fc-memory-muted')=>el('p',cls,value);
const button=(label,action,cls='fc-memory-link')=>{const n=el('button',cls,label);n.type='button';n.addEventListener('click',action);return n;};
const section=(title,...children)=>{const n=el('section','fc-memory-section');n.append(el('h4',null,title),...children);return n;};
const date=value=>{const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleDateString('zh-CN'):'尚未提供';};
const workLabel=lineage=>lineage.outcome?.state==='ACCEPTED'||lineage.founderBoundary?.decision?.disposition==='ACCEPT'?'工作已验收':workStatusText(lineage.work.status);
const tabs=[['memory','记忆'],['candidates','待确认'],['sources','来源']];
const emit=(state,patch)=>state.onMemory(patch);
function technical(entries,state) {
  const details=el('details','fc-memory-technical');details.open=Boolean(state.memory.technicalOpen);
  details.append(el('summary',null,'记录信息'));
  const list=el('dl');
  for(const [key,value] of entries)if(value!==null&&value!==undefined){list.append(el('dt',null,key),el('dd',null,String(value)));}
  details.append(list);details.addEventListener('toggle',()=>state.onMemory({technicalOpen:details.open},false));return details;
}
function empty(title,copy) {
  const n=el('div','fc-memory-empty');const icon=el('span','fc-memory-empty-icon');icon.append(symbol('knowledge'));
  n.append(icon,el('h4',null,title),text(copy));return n;
}
function guide() {
  const n=el('aside','fc-memory-guide');n.setAttribute('aria-label','一条公司记忆应说明什么');
  n.append(el('span','fc-memory-kicker','有依据，才值得记住'),el('h4',null,'每一条记忆，都能回答。'));
  for(const [title,copy] of [['记住什么','可供未来工作使用的结论。'],['为什么相信','独立知识接纳，以及工作、评审与来源。'],['在哪成立','明确市场、产品、工作类型与适用条件。'],['是否仍然有效','复核时间、失效原因与替代关系。']])n.append(section(title,text(copy)));
  return n;
}
function admissionNote(){return text('工作验收与知识接纳，是两次不同的决定。','fc-memory-boundary');}
function unavailable(tab,collection,state) {
  const invalid=collection.reason==='INVALID_CONTRACT';
  const title=invalid?'暂时无法核对记忆记录':tab==='memory'?'正式公司记忆尚未接入':tab==='candidates'?'待确认内容尚未接入':'记忆的来源关系尚未接入';
  const copy=invalid?'收到的记录与当前公司或读取约定不一致，已停止展示。':tab==='memory'?'目前无法读取公司已接纳的长期认知。这表示状态未知，并不表示公司没有记忆。':tab==='candidates'?'只有后端提出的真实知识候选，才会出现在这里。已完成或已验收的工作不会自动成为候选。':'现有工作和交付可以被追溯，但它们与正式记忆的关联仍需知识接纳记录证明。';
  const n=empty(title,copy);
  if(tab!=='sources')n.append(button('查看已有工作依据 →',()=>state.onTab('sources'),'fc-memory-primary'));
  if(tab==='memory'&&workEvidence(state.works,state.projection).some(item=>item.outcome?.state==='ACCEPTED'||item.founderBoundary?.decision?.disposition==='ACCEPT'))n.append(text('已有已验收工作，但仍需独立的知识接纳。'));
  n.append(admissionNote());return n;
}
function freshness(item) {
  const panel=section('是否仍然有效',text(MEMORY_FRESHNESS[item.freshness?.status]||'有效性尚未提供','fc-memory-answer'));
  const f=item.freshness;
  if(f?.observedAt)panel.append(text(`观察于 ${date(f.observedAt)}`));
  if(f?.reviewAt)panel.append(text(`下次复核 ${date(f.reviewAt)}`));
  if(f?.expiresAt)panel.append(text(`有效截止 ${date(f.expiresAt)}`));
  if(f?.reason)panel.append(text(f.reason));
  if(f?.supersededBy)panel.append(text(`替代记录：${f.supersededBy.title||'后端已记录替代关系'}`));
  if(!f)panel.append(text('尚无法判断是否需要复核；不会根据本机日期推算状态。'));
  return panel;
}
function provenance(entries=[],state) {
  const list=el('ol','fc-memory-lineage');
  const names={WORK:'工作',ARTIFACT:'交付物',REVIEW:'独立评审',FOUNDER_ACCEPT:'创始人验收',KNOWLEDGE_ADMISSION:'知识接纳',SOURCE_OBSERVATION:'来源观察',REPAIR:'修订'};
  for(const entry of entries){const row=el('li');row.dataset.kind=entry.kind;row.append(el('strong',null,names[entry.kind]||'来源记录'),text(entry.title||entry.summary||'摘要尚未提供'));if(entry.kind==='ARTIFACT'&&entry.artifactId&&entry.workId&&state)row.append(button('查看交付依据',()=>state.onMemoryEvidence({artifactId:entry.artifactId,workId:entry.workId,title:entry.title})));list.append(row);}
  return list;
}
function memoryInspector(item,state) {
  const detail=inspector(item.title||'记忆详情',state);
  detail.append(section('公司记住了什么',text(item.content,'fc-memory-answer'),text(MEMORY_TYPES[item.type]||'类型尚未提供')));
  if(state.tab==='candidates') {
    detail.append(section('为什么值得记住',text(item.reason||'提出原因尚未提供')),section('仍需谁确认',text(item.confirmationRequired||'确认职责尚未提供')),text('这是一条候选，尚不代表已进入公司记忆。','fc-memory-boundary'));
  } else detail.append(section('未来工作能否使用',text(contextUseText(item))));
  const why=section('为什么相信 / 采用',text(item.reason||'采用依据尚未提供'));
  if(item.provenance?.length)why.append(provenance(item.provenance,state));else why.append(text('来源链尚未提供。'));
  if(item.admission)why.append(section('独立知识接纳',text(item.admission.summary||'已收到独立知识接纳记录。')));
  why.append(admissionNote());detail.append(why,section('适用范围',text(memoryScopeText(item.scope))),freshness(item));
  if(item.relatedMethod)detail.append(section('相关方法',text(item.relatedMethod.title||'方法采用记录'),text('方法改变以后怎么做；记忆改变以后知道什么。方法采用不等于知识接纳。')));
  detail.append(technical([['记录 ID',item.id],['知识接纳 ID',item.admission?.id],['版本',item.version],['记录时间',item.createdAt]],state));return detail;
}
function inspector(title,state) {
  const detail=el('aside','fc-memory-inspector');detail.setAttribute('aria-labelledby','memory-inspector-title');detail.tabIndex=-1;detail.dataset.memoryFocus='inspector';
  const head=el('header','fc-memory-inspector-head');
  const back=button('← 返回列表',()=>state.onSelect(null),'fc-sub-back fc-memory-back');back.dataset.memoryFocus='back';
  head.append(back,el('h4',null,title));head.lastChild.id='memory-inspector-title';detail.append(head);
  detail.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();state.onSelect(null);}});return detail;
}
function workInspector(lineage,state) {
  const detail=inspector('工作依据',state), work=lineage.work;
  detail.append(text('现有工作记录 · 尚未证明属于公司记忆','fc-memory-kicker'),section('这份工作记录了什么',el('h3',null,work.title||'未命名工作'),text(workIntentText(work.intent)||'工作目标尚未提供')));
  const chain=el('ol','fc-memory-lineage');
  const append=(title,copy,kind)=>{const row=el('li');row.dataset.kind=kind;row.append(el('strong',null,title),text(copy));chain.append(row);return row;};
  append('工作',workLabel(lineage),'WORK');
  for(const step of lineage.steps||[]) {
    for(const artifact of step.artifacts||[]) {
      const row=append('交付物',artifact.title||'未命名交付','ARTIFACT');
      row.append(button('查看正文与引用来源',()=>state.onMemoryEvidence({artifactId:artifact.artifactId,workId:work.workId,title:artifact.title}),'fc-memory-link'));
    }
    if(step.review?.reviewId)append('独立评审',`${verdictText(step.review.verdict)} · ${step.review.summary||'未提供摘要'}`,'REVIEW');
    if(step.repair)append('修订',step.title||'后端已记录修订关系','REPAIR');
  }
  const decision=lineage.founderBoundary?.decision;
  append('创始人验收',decision?`${decision.disposition==='ACCEPT'?'已接受工作':'已记录决定'} · ${date(decision.decidedAt)}`:'当前工作线未提供验收决定','FOUNDER_ACCEPT');
  append('知识接纳','接纳投影尚未接入，不能从工作验收推断。','KNOWLEDGE_ADMISSION').dataset.unavailable='true';
  detail.append(section('可核对的依据',chain),admissionNote(),section('记忆适用范围',text('尚未提供。工作目标中的市场或产品，不自动成为记忆的适用范围。')),section('记忆有效性',text('尚未提供。交付时间不代表知识的有效期限。')),technical([['工作 ID',work.workId],['验收决定 ID',decision?.decisionId]],state));
  return detail;
}
function readingInspector(state) {
  const detail=el('aside','fc-memory-inspector');detail.setAttribute('aria-label','交付与来源详情');detail.tabIndex=-1;detail.dataset.memoryFocus='inspector';
  detail.append(button(state.selectedId?.startsWith('work:')?'← 返回工作依据':'← 返回详情',()=>emit(state,{evidenceId:null,evidence:null,evidenceStatus:null}),'fc-memory-back'),el('h3',null,state.memory.evidenceTitle||'交付与来源'));
  if(state.memory.evidenceStatus==='loading'){detail.append(text('正在读取这份交付的真实内容…'));return detail;}
  if(state.memory.evidenceStatus==='error'){detail.append(text('交付内容暂不可读，工作依据已保留。'),button('重新读取',()=>state.onMemoryEvidence({artifactId:state.memory.evidenceId,workId:state.memory.evidenceWorkId,title:state.memory.evidenceTitle})));return detail;}
  const reading=state.memory.evidence;
  if(!reading){detail.append(text('交付读取结果尚未提供。'));return detail;}
  detail.append(text('交付内容不自动成为公司知识。','fc-memory-boundary'));
  const body=el('details','fc-memory-content');body.open=Boolean(state.memory.evidenceBodyOpen);body.append(el('summary',null,'交付原文'),el('pre',null,reading.content||'当前投影未提供正文'));body.addEventListener('toggle',()=>state.onMemory({evidenceBodyOpen:body.open},false));detail.append(body);
  const reviews=section('独立评审');
  for(const review of reading.reviews||[])reviews.append(text(`${verdictText(review.verdict)} · ${review.summary||'未提供摘要'}`));
  if(!reading.reviews?.length)reviews.append(text('当前交付读取结果未提供评审。'));detail.append(reviews);
  const sources=section('引用来源');
  for(const source of reading.citedSources||[]) {
    const row=el('div','fc-memory-source-observation');const url=source.observationAvailable?safeSourceUrl(source.safeUrl):null;
    if(url){const link=el('a',null,new URL(url).hostname);link.href=url;link.target='_blank';link.rel='noopener noreferrer';row.append(link,text(`观察于 ${date(source.observedAt)}`));}
    else row.append(el('strong',null,'来源观察收据当前不可用'));
    row.append(text('来源观察不等于内容已被证实。'));sources.append(row);
  }
  if(!reading.citedSources?.length)sources.append(text('当前投影未提供可展示的来源引用。'));
  sources.append(text('来源摘录与逐句证据对应关系尚未提供。'));detail.append(sources,technical([['产物 ID',reading.artifactId||state.memory.evidenceId],['所属工作',reading.workId],['记录时间',reading.createdAt],['来源引用',reading.citedSources?.map(s=>s.sourceId).join(' · ')]],state));return detail;
}
function row(item,state,{work=false}={}) {
  const id=work?`work:${item.work.workId}`:item.id;
  const n=button('',()=>{emit(state,{evidenceId:null,evidence:null},false);state.onSelect(id);},'fc-memory-row fc-sub-row');
  n.dataset.recordId=id;n.dataset.selected=String(state.selectedId===id);n.setAttribute('aria-pressed',String(state.selectedId===id));
  n.append(el('strong',null,work?item.work.title:item.title||item.content));
  n.append(text(work?'工作依据 · 不是正式记忆':item.content||item.title));
  const meta=el('span','fc-memory-row-meta');
  meta.textContent=work?workLabel(item):[MEMORY_TYPES[item.type],MEMORY_FRESHNESS[item.freshness?.status]||'有效性尚未提供'].filter(Boolean).join(' · ');
  n.append(meta);return n;
}
function sourceInspector(item,state) {
  const detail=inspector('记忆来源',state);
  detail.append(section('来源内容',text(item.title,'fc-memory-answer'),text(item.summary||'来源摘要尚未提供')));
  const url=safeSourceUrl(item.safeUrl);
  if(url){const a=el('a','fc-memory-link',new URL(url).hostname);a.href=url;a.target='_blank';a.rel='noopener noreferrer';detail.append(a);}
  const memory=readCompanyMemory(state.projection,state.company?.id).memory;
  const refs=section('关联的公司记忆');
  for(const id of item.memoryIds||[]){const match=memory.items.find(entry=>entry.id===id);refs.append(text(match?.content||'关联记忆的内容尚未提供'));}
  if(!item.memoryIds?.length)refs.append(text('当前投影没有提供关联记忆。'));
  detail.append(refs,section('来源链',item.provenance?.length?provenance(item.provenance,state):text('完整知识接纳链尚未提供。')),admissionNote(),technical([['来源 ID',item.id],['关联记忆',item.memoryIds?.join(' · ')],['观察时间',item.observedAt]],state));return detail;
}
export function renderCompanyMemory(target,state) {
  const data=readCompanyMemory(state.projection,state.company?.id), tab=state.tab||'memory', collection=data[tab];
  const local=state.memory, root=el('div','fc-memory fc-subpage');root.dataset.page='knowledge';root.dataset.source='READ_ONLY';root.dataset.tab=tab;
  root.dataset.readingKey=`${tab}:${state.selectedId||''}:${local.evidenceId||''}`;root.dataset.listKey=`${tab}:${local.query}`;
  const hero=el('header','fc-memory-hero');hero.append(el('span','fc-memory-kicker','COMPANY MEMORY'),el('h3',null,'值得记住的，成为公司的认知。'),text('有来源，有适用范围，经过独立接纳，才能进入未来的工作。'));
  root.append(hero);
  const searchWrap=el('div','fc-memory-search');searchWrap.append(symbol('search'));
  const search=el('input');search.type='search';search.placeholder=tab==='sources'?'搜索已加载的工作依据…':'搜索公司知道的内容…';search.setAttribute('aria-label',search.placeholder);search.value=local.query;search.autocomplete='off';
  search.disabled=collection.state!=='ready'&&tab!=='sources';search.setAttribute('aria-describedby','memory-search-note');
  search.addEventListener('input',()=>emit(state,{query:search.value}));searchWrap.append(search);root.append(searchWrap);
  const note=el('p','fc-memory-search-note',search.disabled?'正式读取能力尚未接入，搜索暂不可用。':'仅筛选当前已加载记录；不会生成回答或执行语义搜索。');note.id='memory-search-note';root.append(note);
  const nav=el('div','fc-memory-tabs fc-sub-tabs');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','公司记忆分类');const indicator=el('span','fc-sub-selection');indicator.setAttribute('aria-hidden','true');nav.append(indicator);
  tabs.forEach(([id,label],index)=>{const b=button(label,()=>state.onTab(id),'fc-sub-tab');b.id=`memory-tab-${id}`;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===id));b.setAttribute('aria-controls','memory-panel');b.tabIndex=tab===id?0:-1;b.addEventListener('keydown',event=>{const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;let next=event.key==='Home'?0:event.key==='End'?2:delta?(index+delta+3)%3:null;if(next!==null){event.preventDefault();state.onTab(tabs[next][0]);}});nav.append(b);});root.append(nav);
  const panel=el('div','fc-memory-panel');panel.id='memory-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`memory-tab-${tab}`);
  if(state.connection!=='LIVE')panel.append(text(state.projection?'连接中断，以下工作依据为上次读取；记忆接纳状态仍不可判断。':'公司记录尚未连接，无法读取工作依据。','fc-memory-connection'));
  const layout=el('div','fc-memory-layout'), list=el('div','fc-memory-list');
  let selected=null;
  if(collection.state!=='ready')list.append(unavailable(tab,collection,state));
  if(tab==='sources') {
    if(collection.state==='ready'&&!collection.items.length)list.append(empty('目前没有关联记忆的来源','这是正式读取结果；现有工作依据仍可单独查看。'));
    if(collection.state==='ready'&&collection.items.length) {
      list.append(text('正式记忆来源','fc-memory-kicker'));
      for(const item of filterMemory(collection.items,{query:local.query}))list.append(row(item,state));
      selected=collection.items.find(item=>item.id===state.selectedId);
    }
    const evidence=filterWorkEvidence(workEvidence(state.works,state.projection),local.query);
    const head=el('div','fc-memory-evidence-head');head.append(el('h4',null,'现有工作依据'),text('可核对真实工作与交付，不代表已形成公司记忆。'));list.append(head);
    if(state.loading&&!evidence.length)list.append(text('正在读取工作依据…'));
    else if(!evidence.length)list.append(text(local.query?'已加载的工作依据中没有匹配内容。':state.error?'工作依据读取失败。':'当前读取范围内没有可展示的工作依据。'));
    if(state.error)list.append(text('部分工作依据读取失败，已显示可读取部分。'),button('重新读取',state.onMemoryRetry));
    for(const item of evidence)list.append(row(item,state,{work:true}));
    const work=evidence.find(item=>`work:${item.work.workId}`===state.selectedId);
    if(work)selected={workEvidence:work};
  } else if(collection.state==='ready') {
    const filters=el('div','fc-memory-filters');
    for(const [key,label,values] of [['type','记忆类型',MEMORY_TYPES],['freshness','有效性',MEMORY_FRESHNESS]]){
      const select=el('select');select.setAttribute('aria-label',label);select.append(el('option',null,`全部${label}`));select.firstChild.value='all';
      for(const [value,label] of Object.entries(values)){const o=el('option',null,label);o.value=value;select.append(o);}select.value=local[key];select.addEventListener('change',()=>emit(state,{[key]:select.value}));filters.append(select);
    }
    list.append(filters);
    const items=filterMemory(collection.items,local);
    if(!collection.items.length)list.append(empty(tab==='memory'?'公司尚未接纳长期记忆':'目前没有待确认的知识候选',tab==='memory'?'这是正式读取结果。工作验收不会自动把内容加入公司记忆。':'这是正式读取结果；新的候选由后端提出。'));
    else if(!items.length)list.append(empty('已加载记录中没有匹配内容','调整关键词或筛选条件。'));
    for(const item of items)list.append(row(item,state));
    selected=items.find(item=>item.id===state.selectedId);
  }
  layout.dataset.detail=String(Boolean(selected));layout.append(list);
  if(selected)layout.append(local.evidenceId?readingInspector(state):selected.workEvidence?workInspector(selected.workEvidence,state):tab==='sources'?sourceInspector(selected,state):memoryInspector(selected,state));else layout.append(guide());
  panel.append(layout);root.append(panel);
  const footer=el('footer','fc-memory-footer');footer.append(text('记忆决定以后知道什么。方法演进决定以后怎么做。'),text('员工的个人经历，不自动成为公司的长期认知。'));
  root.append(footer);
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&selected){event.preventDefault();event.stopPropagation();if(local.evidenceId)emit(state,{evidenceId:null,evidence:null,evidenceStatus:null});else state.onSelect(null);}},true);
  target.replaceChildren(root);
}
