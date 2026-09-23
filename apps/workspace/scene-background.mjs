import { scenePaused, saveScenePaused } from './scene-preference.mjs';
const query = matchMedia('(prefers-reduced-motion: reduce)');
const embedded = window.self !== window.top;
let paused = scenePaused(query.matches), stopped = false;
document.body.classList.add('fc-scene-theme');
const backdrop = document.createElement('div');
backdrop.className = 'fc-dynamic-backdrop'; backdrop.setAttribute('aria-hidden','true');
let video;
if (!embedded) {
  video = document.createElement('video');
  video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'auto';
  video.src = new URL('./launch-mars.mp4', import.meta.url).href; video.playbackRate = .65;
  backdrop.append(video); document.body.prepend(backdrop);
} else document.body.classList.add('fc-scene-embedded');
const existing = document.getElementById('reduce-motion');
let control;
if (existing) {
  control = existing; control.checked = paused || query.matches;
  control.dispatchEvent(new Event('change'));
} else {
  control = document.createElement('button'); control.type = 'button';
  control.className='fc-scene-toggle'; control.innerHTML='<span aria-hidden="true">Ⅱ</span>';
  (document.querySelector('.fc-topbar, .fc-top') || document.body).append(control);
}
function update() {
  if(stopped) return;
  const effective = paused || query.matches;
  document.body.dataset.scenePaused=String(effective);
  if(!existing) {
    control.setAttribute('aria-pressed',String(effective));
    control.setAttribute('aria-label',effective?'播放背景动态':'暂停背景动态');
    control.title=effective?'播放背景动态':'暂停背景动态';
    control.firstElementChild.textContent=effective?'▷':'Ⅱ';
  }
  if(video) {
    if(effective || document.hidden) video.pause();
    else video.play().catch(()=>{document.body.dataset.scenePaused='true';control.title='点击播放背景动态';});
  }
  // Embedded staff pages share the host backdrop and do not decode another video.
  if(embedded) parent.document.dispatchEvent(new CustomEvent('flowcredit-scene-motion',{detail:paused}));
  else for(const iframe of document.querySelectorAll('iframe')) {
    try {iframe.contentDocument?.dispatchEvent(new CustomEvent('flowcredit-scene-sync',{detail:paused}));} catch { /* External frames are not controlled. */ }
  }
}
control.addEventListener(existing?'change':'click',()=>{
  paused=existing?control.checked:!paused;saveScenePaused(paused);update();
});
query.addEventListener('change',()=>{if(existing)control.checked=paused||query.matches;update();});
document.addEventListener('visibilitychange',update);
document.addEventListener('flowcredit-scene-motion',event=>{paused=event.detail===true;saveScenePaused(paused);update();});
document.addEventListener('flowcredit-scene-sync',event=>{
  paused=event.detail===true;
  if(existing){control.checked=paused||query.matches;document.body.classList.toggle('fc-reduced',control.checked);}
});
video?.addEventListener('loadeddata',update,{once:true});
video?.addEventListener('error',()=>{backdrop.dataset.failed='true';control.title='背景影像暂不可用';});
addEventListener('pagehide',()=>{stopped=true;video?.pause();},{once:true});
addEventListener('pageshow',event=>{if(event.persisted){stopped=false;update();}});
update();
