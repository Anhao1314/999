// Static frontend preview only. Never imports the Runtime or opens a database.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root=new URL('../apps/company/',import.meta.url);
const portraits=new URL('../apps/employee/assets/',import.meta.url);
const employeeRoot=new URL('../apps/employee/',import.meta.url);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8',png:'image/png'};
const files=new Set(['index.html','styles.css','app.mjs','demo-adapter.mjs','hiring-store.mjs','hiring-ui.mjs','hiring.css','lobby-adapter.mjs','lobby-entry.mjs','assets/alpine-wallpaper.png']);
const employeeFiles=new Set(['app.mjs','adapter.mjs','domain.mjs','avatar.mjs','styles.css',...Array.from({length:8},(_,i)=>`assets/portrait-${i+1}.png`),...Array.from({length:8},(_,i)=>`assets/sprite-${i+1}.png`)]);
const port=Number(process.env.FLOWCREDIT_COMPANY_PREVIEW_PORT??4320);
const server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
  const lobby=['/employees','/employees/'].includes(path);
  if(lobby&&url.searchParams.get('demo')!=='1'){res.writeHead(302,{location:'/employees?demo=1&companyPreview=1'});res.end();return;}
  let file,pathName;
  if(lobby){pathName='index.html';file=new URL(pathName,employeeRoot);}
  else if(path==='/employee-assets/demo.mjs'){pathName='lobby-adapter.mjs';file=new URL(pathName,root);}
  else if(path==='/employee-assets/base-demo.mjs'){pathName='demo.mjs';file=new URL(pathName,employeeRoot);}
  else if(path.startsWith('/employee-assets/')&&employeeFiles.has(path.slice('/employee-assets/'.length))){pathName=path.slice('/employee-assets/'.length);file=new URL(pathName,employeeRoot);}
  else if(/^\/employee\/assets\/portrait-[1-8]\.png$/.test(path)){pathName=path.split('/').at(-1);file=new URL(pathName,portraits);}
  else {pathName=path==='/'||path==='/company'||path==='/company/'?'index.html':path.replace(/^\/(?:company\/)?/,'');if(!files.has(pathName)){res.writeHead(404);res.end('Not found');return;}file=new URL(pathName,root);}
  try{let bytes=await readFile(file);if(lobby)bytes=Buffer.from(bytes.toString('utf8').replace('src="/employee-assets/app.mjs"','src="/company/lobby-entry.mjs"'));res.writeHead(200,{'content-type':types[pathName.split('.').at(-1)],'content-length':bytes.length,'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404);res.end('Not found');}
});
server.on('error',error=>{process.stderr.write(`Company UI preview: ${error.message}\n`);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`FlowCredit company UI preview: http://127.0.0.1:${server.address().port}/company/\nDemo UI only — no Runtime, database, model or external network.\n`));
