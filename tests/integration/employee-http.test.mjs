import test from 'node:test';
import assert from 'node:assert/strict';
import { tempStoreDir } from '../support/kernel.mjs';
import { startRuntime } from '../../scripts/lib/runtime-process.mjs';
import { rmSync } from 'node:fs';
test('employee module shares real runtime: route, commands, idempotency and history',async()=>{
  const dir=tempStoreDir();let runtime;try{
    runtime=await startRuntime({dir});
    const company=await runtime.command('createCompany',{name:'UI integration'}),position=await runtime.command('createPosition',{companyId:company.id,title:'Builder',capabilities:['build']}),employee=await runtime.command('createEmployee',{companyId:company.id,positionId:position.id,displayName:'Actual employee'});
    const work=await runtime.command('createWork',{companyId:company.id,title:'Actual work',intent:'verify UI transport'}),task=await runtime.command('createTask',{workId:work.id,title:'Actual task',intent:'verify',requiredCapabilities:['build']});
    const html=await fetch(runtime.base+'/employees');assert.equal(html.status,200);assert.match(await html.text(),/团队大厅/);
    assert.equal((await fetch(runtime.base+'/employee-assets/server.mjs')).status,404);
    const command=async(kind,input,key=crypto.randomUUID(),origin=runtime.base)=>{const response=await fetch(runtime.base+'/employee-api/commands',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({companyId:company.id,kind,input,idempotencyKey:key})});return {status:response.status,body:await response.json()};};
    assert.equal((await command('assign',{employeeId:employee.id,taskId:task.id})).status,200);
    const key=crypto.randomUUID(),input={employeeId:employee.id,taskId:task.id};const started=await command('start',input,key);assert.equal(started.status,200);assert.ok(started.body.runId);
    assert.deepEqual((await command('start',input,key)).body,started.body);
    assert.equal((await command('enabled',{employeeId:employee.id,enabled:false},key)).status,409);
    assert.equal((await command('enabled',{employeeId:employee.id,enabled:false},crypto.randomUUID(),'https://evil.invalid')).status,403);
    assert.equal((await command('pause',{employeeId:employee.id})).status,501);
    let snapshot=await runtime.json(`/employee-api/snapshot?companyId=${company.id}`);assert.equal(snapshot.runs[0].id,started.body.runId);assert.equal(snapshot.runs[0].status,'running');
    const artifact=await runtime.command('recordArtifact',{taskId:task.id,generation:snapshot.runs[0].generation,workerRunId:started.body.runId,kind:'document',title:'Integration output',content:'real test content'});
    snapshot=await runtime.json(`/employee-api/snapshot?companyId=${company.id}`);assert.equal(snapshot.tasks[0].artifacts[0].id,artifact.id);
    const history=await runtime.json(`/employee-api/history?companyId=${company.id}&employeeId=${employee.id}`);assert.ok(history.items.some(e=>e.kind==='WORKER_RUN_STARTED'));
  }finally{await runtime?.stop();rmSync(dir,{recursive:true,force:true});}
});
