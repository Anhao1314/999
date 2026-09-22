// Read/transport adapter only. No scheduling, schema migration or synthetic production data.
import { readFile } from 'node:fs/promises';
const ROOT = new URL('./', import.meta.url);
const ASSETS = new Set(['app.mjs','adapter.mjs','domain.mjs','demo.mjs','avatar.mjs','styles.css', ...Array.from({length:8},(_,i)=>`assets/portrait-${i+1}.png`), ...Array.from({length:8},(_,i)=>`assets/sprite-${i+1}.png`)]);
const TYPES = { mjs:'text/javascript; charset=utf-8', css:'text/css; charset=utf-8', png:'image/png', html:'text/html; charset=utf-8' };
export const LIVE_CAPABILITIES = Object.freeze({ assign:true, start:true, enabled:true, config:false, archive:false, pause:false, resume:false, cancel:false, upload:false, tokens:false, model:false, tools:false, messages:false });
const failure = (code,message,status=400) => Object.assign(new Error(message),{code,status});
const publicText = value => String(value??'').replace(/(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g,'[redacted]').replace(/(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'[redacted]').slice(0,300);
function requireCompany(kernel,companyId) { if(!companyId||!kernel.company(companyId))throw failure('COMPANY_NOT_FOUND','公司不存在',404); }
const RUN_STATUS = { RUNNING:'running', COMPLETED:'completed', CANCELLED:'cancelled', INTERRUPTED:'failed' };
const LABELS = { EMPLOYEE_CREATED:'员工已创建', EMPLOYEE_UPDATED:'员工状态已更新', TASK_ASSIGNED:'任务已指派', WORKER_RUN_STARTED:'运行已开始', WORKER_RUN_COMPLETED:'运行已完成', WORKER_RUN_CANCELLED:'运行已取消', WORKER_RUN_INTERRUPTED:'运行已中断', 'artifact.recorded':'产物已记录', 'checkpoint.written':'检查点已记录', 'task.completed':'任务已完成', 'task.cancelled':'任务已取消', REVIEW_SUBMITTED:'评审已提交', REVIEW_PASSED:'评审已通过（不等于 Founder 接受）', WORK_ACCEPTED:'Founder 已接受', REPAIR_TASK_CREATED:'修复任务已创建', TASK_REQUIREMENTS_SET:'任务能力要求已更新', ARTIFACT_HANDED_OFF:'产物已交付', ARTIFACT_SUPERSEDED:'产物已产生新版本', POSITION_CREATED:'岗位已创建', 'task.created':'任务已创建', 'work.created':'工作已创建', 'company.created':'公司已创建' };
function publicActivity(row) {
  const detail = JSON.parse(row.detail);
  return { id:String(row.sequence), at:row.created_at, employeeId:detail.employeeId??null, taskId:row.task_id, runId:detail.workerRunId??null, kind:row.kind, summary:LABELS[row.kind]??publicText(row.kind), source:'live' };
}
function readActivity(kernel,companyId,employeeId=null,before=null,limit=20) {
  // Read-only SQL projection: bounded pagination over existing persisted Activity.
  const clauses=['a.company_id = ?'], params=[companyId];
  if(before!==null){clauses.push('a.sequence < ?');params.push(before);}
  if(employeeId){
    clauses.push(`(json_extract(a.detail, '$.employeeId') = ? OR json_extract(a.detail, '$.workerRunId') IN (SELECT id FROM worker_runs WHERE employee_id = ?) OR (a.task_id IN (SELECT task_id FROM assignments WHERE employee_id = ?) AND json_extract(a.detail, '$.employeeId') IS NULL AND json_extract(a.detail, '$.workerRunId') IS NULL))`);
    params.push(employeeId,employeeId,employeeId);
  }
  return kernel.store.db.prepare(`SELECT a.* FROM activity a WHERE ${clauses.join(' AND ')} ORDER BY a.sequence DESC LIMIT ?`).all(...params,limit).map(publicActivity);
}
export function employeeSnapshot(kernel,companyId) {
  requireCompany(kernel,companyId);
  // One synchronous call in the same process as the kernel. No await between reads.
  const positions=new Map(kernel.positions(companyId).map(p=>[p.id,p]));
  const employees=kernel.employees(companyId).map(e=>({id:e.id,displayName:publicText(e.displayName),role:publicText(positions.get(e.positionId)?.title),enabled:e.enabled,lifecycle:'active',taskGroupId:null,positionId:e.positionId,capabilities:(positions.get(e.positionId)?.capabilities??[]).map(publicText),configVersion:null,description:'真实 Runtime 员工 · 模型执行尚未接入'}));
  const runs=employees.flatMap(e=>kernel.workerRuns({employeeId:e.id})).map(r=>({id:r.id,employeeId:r.employeeId,taskId:r.taskId,status:RUN_STATUS[r.state],generation:r.generation,startedAt:r.startedAt,endedAt:r.endedAt,endReason:r.endReason?publicText(r.endReason):null,configVersion:null,tokenUsed:null,tokenLimit:null})).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id));
  const tasks=kernel.works(companyId).flatMap(w=>kernel.tasks(w.id)).map(t=>({id:t.id,title:publicText(t.title),state:t.state,workId:t.workId,employeeId:kernel.assignment(t.id)?.employeeId??null,assignmentId:kernel.assignment(t.id)?.id??null,requiredCapabilities:kernel.taskRequirements(t.id)?.requiredCapabilities??[],dependencies:null,artifacts:kernel.store.listArtifacts({taskId:t.id}).map(a=>({id:a.id,title:publicText(a.title),kind:publicText(a.kind),workerRunId:a.workerRunId,createdAt:a.createdAt}))}));
  const activity=readActivity(kernel,companyId,null,null,30);
  // Fill employee attribution only from a real run/assignment; never invent people.
  for(const event of activity)if(!event.employeeId){event.employeeId=runs.find(r=>r.id===event.runId)?.employeeId??null;}
  // Activity head is a snapshot revision, NOT a contiguous per-company SSE cursor.
  return { companyId,source:'live',revision:Number(activity[0]?.id??0),capturedAt:new Date().toISOString(),transport:'snapshot-poll',capabilities:LIVE_CAPABILITIES,employees,runs,tasks,activity };
}
export function employeeHistory(kernel,companyId,employeeId,before) {
  requireCompany(kernel,companyId);const e=kernel.employee(employeeId);
  if(!e||e.companyId!==companyId)throw failure('EMPLOYEE_NOT_FOUND','此公司中不存在该员工',404);
  const cursor=before===null||before===undefined?null:Number(before);
  if(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<1))throw failure('INVALID_CURSOR','无效历史游标');
  const rows=readActivity(kernel,companyId,employeeId,cursor,21),items=rows.slice(0,20);
  return {items,nextCursor:rows.length>20?items.at(-1).id:null};
}
export function executeEmployeeCommand(kernel,{companyId,kind,input={}}) {
  requireCompany(kernel,companyId);const e=kernel.employee(input.employeeId);
  if(!e||e.companyId!==companyId)throw failure('EMPLOYEE_NOT_FOUND','此公司中不存在该员工',404);
  if(!['assign','start','enabled'].includes(kind))throw failure('UNSUPPORTED_CAPABILITY','Runtime 未支持此能力',501);
  let result;
  if(kind==='enabled')result=kernel.setEmployeeEnabled({employeeId:e.id,enabled:input.enabled});
  else {
    const task=kernel.task(input.taskId),work=task&&kernel.work(task.workId);
    if(!task||work?.companyId!==companyId)throw failure('TASK_NOT_FOUND','此公司中不存在该任务',404);
    if(kernel.workerRuns({employeeId:e.id}).some(r=>r.state==='RUNNING'))throw failure('EMPLOYEE_BUSY','员工已有活跃运行，无法从此界面覆盖派工',409);
    if(kind==='assign' && Object.hasOwn(input,'expectedAssignmentId') && (kernel.assignment(task.id)?.id??null)!==input.expectedAssignmentId)throw failure('ASSIGNMENT_CHANGED','任务指派已改变；请刷新后确认',409);
    if(kind==='assign')result=kernel.assignTask({taskId:task.id,employeeId:e.id,reason:'Founder assignment from employee UI'});
    else {if(kernel.assignment(task.id)?.employeeId!==e.id)throw failure('ASSIGNMENT_CHANGED','指派已改变；请刷新确认',409);result=kernel.startWorkerRun({taskId:task.id});}
  }
  return {state:'confirmed',kind,employeeId:e.id,runId:result?.workerRun?.id??null};
}
export function isLocalBrowserRequest(request) {
  const host=request.headers.host;
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host??''))return false;
  if(request.headers['sec-fetch-site']==='cross-site')return false;
  return !request.headers.origin||request.headers.origin===`http://${host}`;
}
export function createEmployeeRoutes(kernel,{enabled=true}={}) {
  const commands=new Map();
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
  return async(request,response,url)=>{
    if(!enabled||!(['/employees','/employees/'].includes(url.pathname)||url.pathname.startsWith('/employee-assets/')||url.pathname.startsWith('/employee-api/')))return false;
    if(!isLocalBrowserRequest(request)){json(response,403,{error:{code:'LOCAL_ORIGIN_REQUIRED',message:'仅允许同源本地请求'}});return true;}
    try{
      if(request.method==='GET'&&(url.pathname==='/employees'||url.pathname==='/employees/'||url.pathname.startsWith('/employee-assets/'))){
        const file=url.pathname.startsWith('/employee-assets/')?url.pathname.slice('/employee-assets/'.length):'index.html';
        if(file!=='index.html'&&!ASSETS.has(file))throw failure('NOT_FOUND','资源不存在',404);
        const body=await readFile(new URL(file,ROOT));response.writeHead(200,{'content-type':TYPES[file.split('.').at(-1)],'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});response.end(body);return true;
      }
      if(request.method==='GET'&&url.pathname==='/employee-api/snapshot'){json(response,200,employeeSnapshot(kernel,url.searchParams.get('companyId')));return true;}
      if(request.method==='GET'&&url.pathname==='/employee-api/history'){json(response,200,employeeHistory(kernel,url.searchParams.get('companyId'),url.searchParams.get('employeeId'),url.searchParams.get('before')));return true;}
      if(request.method==='POST'&&url.pathname==='/employee-api/commands'){
        if(!request.headers['content-type']?.startsWith('application/json'))throw failure('JSON_REQUIRED','必须使用 JSON 请求',415);
        let size=0,body='';for await(const chunk of request){size+=chunk.length;if(size>8192)throw failure('BODY_TOO_LARGE','命令请求过大',413);body+=chunk.toString();}
        let payload;try{payload=JSON.parse(body);}catch{throw failure('INVALID_JSON','无效 JSON');}
        if(typeof payload?.idempotencyKey!=='string'||payload.idempotencyKey.length<8||payload.idempotencyKey.length>100)throw failure('IDEMPOTENCY_REQUIRED','需要幂等命令标识');
        const key=`${payload.companyId}/${payload.idempotencyKey}`,signature=JSON.stringify([payload.kind,payload.input]);
        const previous=commands.get(key);
        if(previous){if(previous.signature!==signature)throw failure('IDEMPOTENCY_CONFLICT','同一命令标识不能用于不同请求',409);json(response,200,previous.result);return true;}
        const result={...executeEmployeeCommand(kernel,payload),commandId:payload.idempotencyKey};
        commands.set(key,{signature,result});if(commands.size>512)commands.delete(commands.keys().next().value);
        json(response,200,result);return true;
      }
      throw failure('NOT_FOUND','接口不存在',404);
    }catch(error){json(response,error.status??500,{error:{code:error.code??'INTERNAL',message:error.status?publicText(error.message):'员工模块读取失败'}});return true;}
  };
}
