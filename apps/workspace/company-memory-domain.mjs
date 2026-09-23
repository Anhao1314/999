// Presentation-only reader for the proposed additive contract. An absent
// contract is unavailable, not an empty collection or an admission decision.
export const MEMORY_CONTRACT = 'CompanyMemoryRead.v0';
export const MEMORY_TYPES = Object.freeze({ FACT:'事实', INSIGHT:'洞察', DECISION:'决策', POLICY:'准则', SOP:'工作规程' });
export const MEMORY_FRESHNESS = Object.freeze({ CURRENT:'当前有效', CHANGED:'发生变化', NEEDS_REVIEW:'需要复核', SUPERSEDED:'已被替代', EXPIRED:'已过期' });
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const unavailable = reason => ({ state:'unavailable', items:[], reason });
export function readCompanyMemory(projection, companyId) {
  const raw=projection?.companyMemory;
  const missing=()=>({ memory:unavailable('NOT_CONNECTED'), candidates:unavailable('NOT_CONNECTED'), sources:unavailable('NOT_CONNECTED') });
  if(!raw) return missing();
  if(raw.contract!==MEMORY_CONTRACT || !companyId || raw.companyId!==companyId) {
    return Object.fromEntries(['memory','candidates','sources'].map(key=>[key,unavailable('INVALID_CONTRACT')]));
  }
  return Object.fromEntries(['memory','candidates','sources'].map(key=>{
    const collection=raw[key];
    if(collection?.state!=='ready' || !Array.isArray(collection.items)) return [key,unavailable(collection?.state==='error'?'READ_ERROR':'NOT_CONNECTED')];
    const ids=new Set();
    const valid=collection.items.every(item=>{
      if(!item || typeof item.id!=='string' || !item.id || ids.has(item.id) || item.companyId!==companyId) return false;
      ids.add(item.id);
      if(key==='memory') return Boolean(string(item.content).trim() && item.admission?.status==='ADMITTED' && string(item.admission.id));
      if(key==='candidates') return Boolean(string(item.content).trim() && item.status==='CANDIDATE');
      return Boolean(string(item.title) && Array.isArray(item.memoryIds));
    });
    return [key, valid ? {state:'ready',items:collection.items,reason:null} : unavailable('INVALID_CONTRACT')];
  }));
}
export function memoryScopeText(scope) {
  if(!scope || typeof scope!=='object') return '适用范围尚未提供';
  return [scope.market,scope.workType,scope.product,scope.timeRange,...list(scope.conditions)].filter(v=>typeof v==='string'&&v.trim()).join(' · ') || '适用范围尚未提供';
}
export function filterMemory(items,{query='',type='all',freshness='all'}={}) {
  const q=String(query).trim().toLocaleLowerCase();
  return list(items).filter(item=>(type==='all'||item.type===type)&&(freshness==='all'||item.freshness?.status===freshness)&&(!q||[item.title,item.content,item.reason,memoryScopeText(item.scope),MEMORY_TYPES[item.type]].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)));
}
export function contextUseText(memory) {
  // Expiry dates never become client-side lifecycle transitions.
  if(memory?.contextUse?.allowed===true) return '后端允许相关工作使用';
  if(memory?.contextUse?.allowed===false) return memory.contextUse.reason || '后端未允许未来工作使用';
  return '未来工作能否使用：尚未提供';
}
export function workEvidence(works,projection) {
  const candidates=[...list(works).map(item=>item.lineage),projection?.primaryWork?.lineage].filter(Boolean);
  const seen=new Set();
  return candidates.filter(lineage=>{
    const id=lineage.work?.workId;
    if(!id||seen.has(id))return false;seen.add(id);return true;
  });
}
export function filterWorkEvidence(items,query='') {
  const q=String(query).trim().toLocaleLowerCase();
  return items.filter(item=>!q||[item.work.title,item.work.intent,...list(item.steps).map(step=>step.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(q));
}
export function safeSourceUrl(value) {
  try {const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;} catch {return null;}
}
