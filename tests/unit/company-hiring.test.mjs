import test from 'node:test';
import assert from 'node:assert/strict';
import {HiringStore,newCandidate,candidateFingerprint,trialIsCurrent,HIRING_KEY,employeeFromHire} from '../../apps/company/hiring-store.mjs';
const memory=()=>{const rows=new Map();return {getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value)};};
function ready(){const c=newCandidate();c.name='Aster';c.trial={source:'demo',verdict:'PASS',fingerprint:candidateFingerprint(c)};return c;}
test('draft and PASS alone do not admit an employee; explicit Founder confirmation is required',()=>{
 const store=new HiringStore(memory()),c=ready();store.save(c);assert.equal(store.hires.length,0);assert.throws(()=>store.confirm(c),/Founder/);assert.equal(store.hires.length,0);
 const hire=store.confirm(c,true);assert.equal(store.hires.length,1);assert.equal(store.drafts.length,0);assert.equal(employeeFromHire(hire).name,'Aster');assert.equal(employeeFromHire(hire).state,'Available');assert.notEqual(hire.employeeId,c.positionId);
 assert.deepEqual(store.confirm(c,true),hire);assert.equal(store.hires.length,1);
});
test('changing identity, scope, criteria or skills invalidates earlier trial evidence',()=>{
 for(const key of ['name','mission','trialTitle','criteria','reviewer','portrait','permissions','skills','knowledge','tools','capabilities','review']){
  const store=new HiringStore(memory()),c=ready();c[key]=Array.isArray(c[key])?[]:key==='portrait'?4:'changed';assert.equal(trialIsCurrent(c),false,key);assert.throws(()=>store.confirm(c,true));assert.equal(store.hires.length,0);
 }
});
test('revision result cannot be hired; retry PASS allows confirmation',()=>{const store=new HiringStore(memory()),c=ready();c.trial.verdict='REQUEST_REVISION';assert.throws(()=>store.confirm(c,true),/试用/);c.trial.verdict='PASS';store.confirm(c,true);assert.equal(store.hires.length,1);});
test('reload preserves confirmed demo hires and separate candidate drafts',()=>{const storage=memory(),store=new HiringStore(storage);store.save(newCandidate('research'));store.confirm(ready(),true);const reloaded=new HiringStore(storage);assert.equal(reloaded.hires.length,1);assert.equal(reloaded.drafts.length,1);assert.equal(reloaded.hires[0].candidate.trial.verdict,'PASS');});
test('malformed local data and forged or unconfirmed records never appear in the roster',()=>{const storage=memory();storage.setItem(HIRING_KEY,'broken');assert.equal(new HiringStore(storage).hires.length,0);const c=ready();storage.setItem(HIRING_KEY,JSON.stringify({hires:[{candidate:c,source:'demo',confirmed:false,employeeId:`hire-${c.id}`},{candidate:{...c,name:'changed'},source:'demo',confirmed:true,employeeId:`hire-${c.id}`}]}));assert.equal(new HiringStore(storage).hires.length,0);});
test('unavailable storage keeps usable in-page demo state and reports non-persistence',()=>{const store=new HiringStore({getItem(){throw new Error('blocked');},setItem(){throw new Error('quota');}});store.save(newCandidate());assert.equal(store.persistent,false);store.confirm(ready(),true);assert.equal(store.hires.length,1);assert.equal(store.persistent,false);});
test('discard removes only the selected draft and capability need is carried into the position',()=>{const store=new HiringStore(memory()),a=newCandidate('engineer','payments.integration'),b=newCandidate('research');store.save(a);store.save(b);assert.ok(a.capabilities.includes('payments.integration'));store.discard(a.id);assert.deepEqual(store.drafts.map(d=>d.id),[b.id]);});
