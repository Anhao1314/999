// Static frontend preview only. Never imports the Runtime or opens a database.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root=new URL('../apps/company/',import.meta.url);
const portraits=new URL('../apps/employee/assets/',import.meta.url);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8',png:'image/png'};
const files=new Set(['index.html','styles.css','app.mjs','demo-adapter.mjs','assets/alpine-wallpaper.png']);
const port=Number(process.env.FLOWCREDIT_COMPANY_PREVIEW_PORT??4320);
const server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  let file,pathName;
  if(/^\/employee\/assets\/portrait-[1-8]\.png$/.test(path)){pathName=path.split('/').at(-1);file=new URL(pathName,portraits);}
  else {pathName=path==='/'||path==='/company'||path==='/company/'?'index.html':path.replace(/^\/(?:company\/)?/,'');if(!files.has(pathName)){res.writeHead(404);res.end('Not found');return;}file=new URL(pathName,root);}
  try{const bytes=await readFile(file);res.writeHead(200,{'content-type':types[pathName.split('.').at(-1)],'content-length':bytes.length,'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404);res.end('Not found');}
});
server.on('error',error=>{process.stderr.write(`Company UI preview: ${error.message}\n`);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`FlowCredit company UI preview: http://127.0.0.1:${server.address().port}/company/\nDemo UI only — no Runtime, database, model or external network.\n`));
