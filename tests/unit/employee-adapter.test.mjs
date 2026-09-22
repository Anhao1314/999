import test from 'node:test';
import assert from 'node:assert/strict';
import { openTempKernel, seedStaffedTask } from '../support/kernel.mjs';
import { employeeSnapshot, employeeHistory, executeEmployeeCommand, isLocalBrowserRequest, createEmployeeRoutes } from '../../apps/employee/server.mjs';
import { DemoEmployeeAdapter } from '../../apps/employee/demo.mjs';
import { HttpEmployeeAdapter } from '../../apps/employee/adapter.mjs';
import { EmployeeStore } from '../../apps/employee/domain.mjs';

test('real kernel start → read projection → activity → artifact; no confidential payloads', () => {
  const {kernel,cleanup}=openTempKernel();try {
    const {company,task,employee}=seedStaffedTask(kernel);
    const ack=executeEmployeeCommand(kernel,{companyId:company.id,kind:'start',input:{employeeId:employee.id,taskId:task.id}});
    assert.equal(ack.state,'confirmed');assert.ok(ack.runId);
    let snapshot=employeeSnapshot(kernel,company.id);assert.equal(snapshot.runs[0].status,'running');
    assert.equal(snapshot.runs[0].tokenUsed,null);assert.equal(snapshot.capabilities.pause,false);
    assert.ok(snapshot.activity.some(e=>e.kind==='WORKER_RUN_STARTED'&&e.employeeId===employee.id));
    const artifact=kernel.recordArtifact({taskId:task.id,generation:snapshot.runs[0].generation,workerRunId:ack.runId,kind:'document',title:'Validated output',content:'private body never shown by employee API'});
    snapshot=employeeSnapshot(kernel,company.id);assert.equal(snapshot.tasks[0].artifacts[0].id,artifact.id);
    assert.ok(!JSON.stringify(snapshot).includes('private body'));assert.ok(!JSON.stringify(snapshot).includes('workPacket'));
    const history=employeeHistory(kernel,company.id,employee.id);assert.ok(history.items.some(e=>e.kind==='WORKER_RUN_STARTED'));
    kernel.completeWorkerRun({taskId:task.id,generation:snapshot.runs[0].generation});
    assert.equal(employeeSnapshot(kernel,company.id).runs[0].status,'completed');
  }finally{kernel.close();cleanup();}
});
test('live company isolation, unsupported commands and assignment races fail closed', () => {
  const {kernel,cleanup}=openTempKernel();try{
    const {company,task,employee}=seedStaffedTask(kernel);const other=kernel.createCompany({name:'Other'});
    assert.throws(()=>executeEmployeeCommand(kernel,{companyId:other.id,kind:'enabled',input:{employeeId:employee.id,enabled:false}}),e=>e.status===404);
    assert.throws(()=>employeeHistory(kernel,other.id,employee.id),e=>e.status===404);
    assert.throws(()=>executeEmployeeCommand(kernel,{companyId:company.id,kind:'archive',input:{employeeId:employee.id}}),e=>e.status===501);
    assert.throws(()=>employeeHistory(kernel,company.id,employee.id,'oops'),e=>e.code==='INVALID_CURSOR');
    assert.throws(()=>executeEmployeeCommand(kernel,{companyId:company.id,kind:'assign',input:{employeeId:employee.id,taskId:task.id,expectedAssignmentId:null}}),e=>e.code==='ASSIGNMENT_CHANGED');
    executeEmployeeCommand(kernel,{companyId:company.id,kind:'start',input:{employeeId:employee.id,taskId:task.id}});
    assert.throws(()=>executeEmployeeCommand(kernel,{companyId:company.id,kind:'assign',input:{employeeId:employee.id,taskId:task.id}}),e=>e.status===409);
  }finally{kernel.close();cleanup();}
});
test('history pages persist and do not overlap; only public summaries exposed',()=>{
  const {kernel,cleanup}=openTempKernel();try{
    const {company,employee}=seedStaffedTask(kernel);
    for(let i=0;i<45;i++)kernel.setEmployeeEnabled({employeeId:employee.id,enabled:i%2!==0});
    const first=employeeHistory(kernel,company.id,employee.id),next=employeeHistory(kernel,company.id,employee.id,first.nextCursor);
    assert.equal(first.items.length,20);assert.equal(next.items.length,20);assert.equal(new Set([...first.items,...next.items].map(e=>e.id)).size,40);
    assert.equal(first.items[0].summary,'员工状态已更新');assert.equal(first.items[0].detail,undefined);
  }finally{kernel.close();cleanup();}
});
test('browser mutation origin/host and cross-site guards',()=>{
  const req=headers=>({headers});assert.ok(isLocalBrowserRequest(req({host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000'})));
  assert.ok(!isLocalBrowserRequest(req({host:'evil.invalid'})));assert.ok(!isLocalBrowserRequest(req({host:'localhost:3000',origin:'https://evil.invalid'})));
  assert.ok(!isLocalBrowserRequest(req({host:'localhost:3000','sec-fetch-site':'cross-site'})));
});
test('feature flag leaves both page and API unhandled',async()=>{
  const route=createEmployeeRoutes(null,{enabled:false});
  assert.equal(await route({},null,new URL('http://localhost/employees')),false);
  assert.equal(await route({},null,new URL('http://localhost/employee-api/snapshot')),false);
});
test('demo config version conflicts and in-flight version freeze',()=>{
  const d=new DemoEmployeeAdapter();const e=d.data.employees[0],run=d.data.runs[0];
  d.updateConfig(e.id,{displayName:'Changed',instructions:'Next instructions',tokenLimitPerRun:20},1);
  assert.equal(e.configVersion,2);assert.equal(run.configVersion,1);assert.equal(run.tokenLimit,40000);
  assert.throws(()=>d.updateConfig(e.id,{displayName:'Other'},1),e=>e.status===409);assert.equal(e.displayName,'Changed');
  assert.throws(()=>d.archive(e.id,e.displayName,2),e=>e.code==='AGENT_HAS_ACTIVE_RUNS');
});
test('demo pending command is not completion; cancelled run allows name-checked archive',async()=>{
  const d=new DemoEmployeeAdapter();const e=d.data.employees[0];const promise=d.command('demo','cancel',{employeeId:e.id});
  assert.equal(d.data.runs[0].status,'running');assert.throws(()=>d.archive(e.id,e.displayName,1),e=>e.code==='AGENT_HAS_ACTIVE_RUNS');
  await promise;assert.equal(d.data.runs[0].status,'cancelled');assert.throws(()=>d.archive(e.id,'wrong',1),e=>e.code==='NAME_MISMATCH');
  d.archive(e.id,e.displayName,1);assert.equal(e.lifecycle,'archived');assert.equal(e.suppressedImport,true);assert.ok(d.data.runs.length);
});
test('HTTP adapter never treats 202 as confirmation',async()=>{
  const a=new HttpEmployeeAdapter({fetcher:async()=>new Response(JSON.stringify({state:'accepted'}),{status:202})});
  await assert.rejects(()=>a.command('c','pause',{}),/尚未确认/);
});
test('poll reconnect replaces full snapshot; stopping aborts active fetch and suppresses late writes',async()=>{
  let count=0,resolve;
  const a=new HttpEmployeeAdapter({interval:5,fetcher:async(_,options)=>{count++;if(count===1)throw new Error('offline');return new Promise((res,rej)=>{resolve=()=>res(new Response(JSON.stringify({companyId:'c',source:'live',employees:[],runs:[],tasks:[],activity:[]})));options.signal.addEventListener('abort',()=>rej(new Error('aborted')));});}});
  const store=new EmployeeStore();const offline=new Promise(done=>{const off=store.subscribe(s=>{if(s.connection==='offline'){off();done();}});});
  const stop=a.subscribe('c',store);await offline;
  while(!resolve)await new Promise(r=>setTimeout(r,2));resolve();
  await new Promise(r=>setTimeout(r,2));assert.equal(store.state.connection,'live');stop();
  const gen=store.generation;await new Promise(r=>setTimeout(r,15));assert.equal(store.generation,gen);
});
