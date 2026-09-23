import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompanyMemory,filterMemory,workEvidence,filterWorkEvidence,memoryScopeText,contextUseText,safeSourceUrl,MEMORY_CONTRACT} from '../../apps/workspace/company-memory-domain.mjs';
// Contract fixtures are isolated unit inputs; none are served by the product UI.
const company='contract-test-company';
const memory={id:'unit-memory',companyId:company,content:'Explicit evidence limitations',type:'POLICY',admission:{id:'unit-admission',status:'ADMITTED'},scope:{workType:'Market research'},freshness:{status:'CURRENT',expiresAt:'2000-01-01'},contextUse:{allowed:false}};
const projection=items=>({companyMemory:{contract:MEMORY_CONTRACT,companyId:company,memory:{state:'ready',items},candidates:{state:'ready',items:[]},sources:{state:'ready',items:[]}}});
test('missing Memory contract remains unavailable, even with accepted work and artifacts',()=>{
  const result=readCompanyMemory({primaryWork:{lineage:{outcome:{state:'ACCEPTED'}}},recentDeliveries:[{acceptedState:'ACCEPTED'}]},company);
  for(const collection of Object.values(result)){assert.equal(collection.state,'unavailable');assert.equal(collection.reason,'NOT_CONNECTED');}
});
test('only an explicit ready empty collection can establish zero',()=>{
  assert.equal(readCompanyMemory(projection([]),company).memory.state,'ready');
  for(const state of ['unavailable','error',undefined]){
    const p=projection([]);p.companyMemory.memory={state};assert.equal(readCompanyMemory(p,company).memory.state,'unavailable');
  }
});
test('cross-company, mixed-company, duplicate and non-admitted records fail closed',()=>{
  assert.equal(readCompanyMemory(projection([memory]),'other').memory.state,'unavailable');
  for(const items of [[{...memory,companyId:'other'}],[memory,memory],[{...memory,admission:{id:'work-accept',status:'ACCEPTED'}}],[{...memory,admission:null}]])assert.equal(readCompanyMemory(projection(items),company).memory.state,'unavailable');
  assert.equal(readCompanyMemory(projection([memory]),company).memory.items[0],memory);
});
test('freshness and future-context eligibility are never inferred from dates or admission',()=>{
  const row=readCompanyMemory(projection([memory]),company).memory.items[0];
  assert.equal(row.freshness.status,'CURRENT');assert.equal(contextUseText(row),'后端未允许未来工作使用');
  assert.equal(contextUseText({...row,contextUse:undefined}),'未来工作能否使用：尚未提供');
});
test('filtering is literal and limited to loaded content and explicit scope',()=>{
  assert.equal(filterMemory([memory],{query:'market'}).length,1);
  assert.equal(filterMemory([memory],{query:'a plausible semantic answer'}).length,0);
  assert.equal(filterMemory([memory],{freshness:'EXPIRED'}).length,0);
  assert.equal(memoryScopeText(null),'适用范围尚未提供');
});
test('work evidence deduplicates the same Work without manufacturing Memory or candidates',()=>{
  const lineage={work:{workId:'work-1',title:'Research',intent:'Products'},outcome:{state:'ACCEPTED'},steps:[]};
  const items=workEvidence([{lineage}],{primaryWork:{lineage}});
  assert.equal(items.length,1);assert.equal(items[0],lineage);
  assert.equal(filterWorkEvidence(items,'Research').length,1);assert.equal(filterWorkEvidence(items,'unknown').length,0);
});
test('source links reject executable and credential-bearing URLs',()=>{
  for(const url of ['javascript:alert(1)','file:///private/secret','https://user:password@example.com',null])assert.equal(safeSourceUrl(url),null);
  assert.equal(safeSourceUrl('https://example.com/evidence'),'https://example.com/evidence');
});
