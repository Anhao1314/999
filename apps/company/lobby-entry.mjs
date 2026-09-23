// Navigation for the static Company preview only; never injected by the Runtime server.
import '/employee-assets/app.mjs';
const top=document.querySelector('.fc-top');
const links=document.createElement('nav');links.className='fc-company-links';
for(const [label,href] of [['← 公司画布','/company/#company'],['＋ 招聘员工','/company/#hiring']]){const a=document.createElement('a');a.textContent=label;a.href=href;links.append(a);}top.append(links);
document.querySelector('.fc-brand').href='/company/';
document.querySelector('.fc-live').textContent='COMPANY DEMO';
document.querySelector('.fc-scene-footer span:last-child').textContent='本地演示团队 · 画面不参与真实调度';
const repairLink=()=>{const link=document.getElementById('mode-link');if(link.getAttribute('href')!=='/company/#hiring'){link.href='/company/#hiring';link.textContent='前往招聘 →';}};
const observer=new MutationObserver(repairLink);observer.observe(document.getElementById('mode-link'),{attributes:true,childList:true});repairLink();
// Loading the app before this module ensures demo state initializes before navigation is decorated.
const hint=document.createElement('p');hint.className='fc-preview-note';hint.textContent='公司 UI 演示 · 招聘确认记录与公司画布共享。大厅内的模拟工作和员工设置仅用于本页体验，刷新后恢复。';document.querySelector('.fc-heading').after(hint);
const params=new URLSearchParams(location.search),id=params.get('focus')??params.get('welcome');
let timer;
if(id){const focus=()=>{const person=[...document.querySelectorAll('.fc-person')].find(el=>el.dataset.employeeId===id);if(!person)return false;person.scrollIntoView({block:'center',inline:'center'});person.focus();if(params.has('focus'))person.click();else{hint.textContent=`欢迎加入团队，${person.textContent}。点击圆桌上的员工即可打开工牌。`;person.classList.add('fc-new-hire');}return true;};const arrivals=new MutationObserver(()=>{if(focus())arrivals.disconnect();});arrivals.observe(document.getElementById('sprites'),{childList:true});timer=setTimeout(()=>{focus();arrivals.disconnect();},6000);}
window.addEventListener('pagehide',()=>{observer.disconnect();clearTimeout(timer);});
