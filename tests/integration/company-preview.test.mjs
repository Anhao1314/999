import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
test('static company preview serves hiring and the existing demo lobby, with no command routes',async()=>{
 const child=spawn(process.execPath,['scripts/preview-company.mjs'],{cwd:new URL('../../',import.meta.url),env:{...process.env,FLOWCREDIT_COMPANY_PREVIEW_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let output='';
 try{
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('preview startup timed out')),8000);child.on('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`preview exited ${code}`));});});
  const company=await fetch(`${origin}/company/`);assert.equal(company.status,200);assert.match(company.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(await company.text(),/hiring\.css/);
  const redirect=await fetch(`${origin}/employees`,{redirect:'manual'});assert.equal(redirect.status,302);assert.match(redirect.headers.get('location'),/demo=1/);
  const lobby=await fetch(`${origin}/employees?demo=1&companyPreview=1`);assert.match(await lobby.text(),/src="\/company\/lobby-entry.mjs"/);
  for(const path of ['/company/hiring-ui.mjs','/company/hiring-store.mjs','/company/demo-adapter.mjs','/company/lobby-entry.mjs','/employee-assets/demo.mjs','/employee-assets/base-demo.mjs','/employee-assets/app.mjs','/employee-assets/domain.mjs','/employee-assets/avatar.mjs','/employee-assets/adapter.mjs','/employee-assets/styles.css','/employee-assets/assets/sprite-5.png','/employee/assets/portrait-5.png'])assert.equal((await fetch(origin+path)).status,200,path);
  assert.match(await(await fetch(`${origin}/employee-assets/demo.mjs`)).text(),/extends BaseDemoAdapter/);
  for(const path of ['/commands','/api/companies','/employee-assets/server.mjs','/package.json'])assert.equal((await fetch(origin+path)).status,404,path);
  assert.equal((await fetch(`${origin}/commands`,{method:'POST',body:'{}'})).status,405);
 }finally{child.kill();}
});
