import { portalOutline, coverRect, easeInOutCubic } from './portal-geometry.mjs';

import { scenePaused, saveScenePaused } from './scene-preference.mjs';
const CDN = '/workspace-assets/';
const $ = id => document.getElementById(id);
const experience = $('experience'), portal = $('portal'), canvas = $('portal-canvas');
const ctx = canvas.getContext('2d');
const bg = $('background-video'), intro = $('intro-video'), media = $('portal-video');
const preference = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = scenePaused(preference.matches), busy = false, ready = false, disposed = false;
let expansion = 0, maskScale = 0, rx = 0, ry = 0, tx = 0, ty = 0;
let frame = 0, last = 0, width = innerWidth, height = innerHeight, generation = 0;
let pointer = null, cursorX = 0, cursorY = 0, rect = portal.getBoundingClientRect();
let lastDraw = 0, lastMediaTime = -1;

// The entry links work without JavaScript, a network connection, or video playback.
for (const [video, file] of [[bg,'launch-mars.mp4'],[intro,'launch-intro.mp4'],[media,'launch-earth.mp4']]) {
  video.muted = true;
  video.src = CDN + file;
  video.addEventListener('error', () => {
    if (!disposed && !busy) $('status').textContent = '星际影像暂不可用，仍可直接进入';
    if (video === intro) finishIntro();
  });
}
bg.loop = true;
function play(video) { return video.play().catch(() => false); }
function drawCover(video) {
  const box = coverRect(video.videoWidth, video.videoHeight, width, height);
  if (!box || video.readyState < 2) return;
  try { ctx.drawImage(video, ...box); } catch { /* Entry remains usable while decoding. */ }
}
function resize() {
  width = innerWidth; height = innerHeight;
  const d = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * d); canvas.height = Math.round(height * d);
  ctx?.setTransform(d, 0, 0, d, 0, 0);
  rect = portal.getBoundingClientRect();
  lastDraw = 0; paint();
}
function paint() {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (maskScale <= 0 && !expansion) return;
  const points = portalOutline(rect, {width,height}, {expansion,scale:maskScale,rx,ry});
  ctx.save(); ctx.beginPath();
  points.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
  ctx.closePath(); ctx.clip(); ctx.fillStyle = '#111923'; ctx.fillRect(0,0,width,height);
  drawCover(media);
  const shade = ctx.createLinearGradient(0,height*.52,0,height);
  shade.addColorStop(0,'rgba(0,0,0,0)'); shade.addColorStop(1,'rgba(0,0,0,.65)');
  ctx.fillStyle=shade; ctx.fillRect(0,0,width,height); ctx.restore();
  // A restrained rim keeps the target visible when the media is unavailable.
  if (expansion < .9) { ctx.save(); ctx.strokeStyle='#ffffff26'; ctx.lineWidth=1; ctx.stroke(); ctx.restore(); }
}
function draw(now) {
  if (disposed || document.hidden) { frame=0; return; }
  const dt = Math.min(40,now-(last||now)); last=now;
  rx+=(tx-rx)*Math.min(1,dt*.009); ry+=(ty-ry)*Math.min(1,dt*.009);
  if (pointer && !reduced) {
    cursorX+=(pointer.x-cursorX)*.2; cursorY+=(pointer.y-cursorY)*.2;
    $('cursor').style.transform=`translate3d(${cursorX}px,${cursorY}px,0)`;
  }
  // Throttle passive video redraws; no frame loop remains after leaving this page.
  const moving = Math.abs(rx-tx)+Math.abs(ry-ty)>.01;
  if (busy || moving || now-lastDraw>33 && media.currentTime!==lastMediaTime) {
    paint(); lastDraw=now; lastMediaTime=media.currentTime;
  }
  if (!reduced || busy) frame=requestAnimationFrame(draw); else frame=0;
}
function startDraw() { if (!frame && !disposed && !document.hidden) {last=0; frame=requestAnimationFrame(draw);} }
function animate(setter, duration, token=generation) {
  return new Promise(resolve => {
    const start=performance.now();
    const step=now => {
      if (disposed || token!==generation) {resolve(false);return;}
      const p=Math.min(1,(now-start)/duration); setter(easeInOutCubic(p)); paint();
      if(p<1) requestAnimationFrame(step); else resolve(true);
    };
    requestAnimationFrame(step);
  });
}
function finishIntro() {
  if (ready || disposed || busy) return;
  ready=true; clearTimeout(introDeadline);
  $('count').textContent='100'; $('preloader-count').classList.add('is-leaving');
  $('preloader').classList.add('is-finished'); $('floating-logo').classList.add('is-settling');
  intro.pause(); experience.classList.add('ready');
  if (reduced) {maskScale=1;paint();} else {
    void play(bg); void animate(v=>maskScale=v,850);
  }
  setTimeout(()=>{ $('floating-logo').classList.add('is-settled'); },reduced?90:1400);
}
const introDeadline=setTimeout(finishIntro,4500);
intro.addEventListener('loadedmetadata',()=>{
  if (ready || disposed || reduced) return;
  intro.playbackRate=Math.min(16,Math.max(.25,intro.duration/3));
  void play(intro).then(result=>{if(result===false) finishIntro();});
});
intro.addEventListener('timeupdate',()=>{
  if(!ready && Number.isFinite(intro.duration)) $('count').textContent=String(Math.min(99,Math.floor(intro.currentTime/intro.duration*100)));
});
intro.addEventListener('ended',finishIntro);
media.addEventListener('loadeddata',()=>{paint();});
// Park the portal on its first frame; clicking starts the approach footage.
media.addEventListener('loadedmetadata',()=>{media.currentTime=Math.min(.12,media.duration||0);});

async function enter(event) {
  if(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button>0) return;
  event.preventDefault(); if(busy || disposed) return;
  finishIntro(); busy=true; const token=++generation;
  const href=event.currentTarget.getAttribute('href');
  tx=ty=0; experience.classList.add('is-travelling'); $('status').textContent='正在进入…';
  if(!reduced) {media.currentTime=0;media.playbackRate=1.3;void play(media);startDraw();}
  const complete=await animate(v=>{expansion=reduced?0:v;canvas.style.opacity=reduced?String(1-v):'1';},reduced?120:1100,token);
  if(complete && token===generation) {cleanup(); location.assign(href);}
}
for(const link of document.querySelectorAll('[data-enter]')) link.addEventListener('click',enter);
function applyMotion() {
  experience.classList.toggle('reduced',reduced);
  $('motion-toggle').setAttribute('aria-pressed',String(reduced));
  $('motion-label').textContent=reduced?'动态已暂停':'暂停动态';
  $('motion-toggle').setAttribute('aria-label',reduced?'开启动画':'暂停动态');
  if(reduced){ tx=ty=rx=ry=0;pointer=null;$('cursor').classList.remove('visible');bg.pause();intro.pause();media.pause();finishIntro();paint(); }
  else {if(ready) void play(bg);startDraw();}
}
$('motion-toggle').addEventListener('click',()=>{reduced=!reduced;saveScenePaused(reduced);applyMotion();});
preference.addEventListener('change',event=>{reduced=event.matches;applyMotion();});
experience.addEventListener('pointermove',event=>{
  if(busy || reduced || event.pointerType!=='mouse') return;
  tx=(event.clientY/height-.5)*-33;ty=(event.clientX/width-.5)*37.4;
  pointer={x:event.clientX,y:event.clientY}; startDraw();
});
experience.addEventListener('pointerleave',()=>{tx=ty=0;pointer=null;$('cursor').classList.remove('visible');});
portal.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'&&!reduced){cursorX=event.clientX;cursorY=event.clientY;$('cursor').classList.add('visible');}});
portal.addEventListener('pointerleave',()=>{$('cursor').classList.remove('visible');});
document.addEventListener('keydown',event=>{
  $('cursor').classList.remove('visible');
  if(event.key==='Escape'&&busy){generation++;busy=false;expansion=0;maskScale=1;canvas.style.opacity='1';media.pause();experience.classList.remove('is-travelling');$('status').textContent='';portal.focus();paint();}
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){bg.pause();intro.pause();media.pause();cancelAnimationFrame(frame);frame=0;}
  else if(!disposed){if(!ready)finishIntro();if(!reduced){void play(bg);if(busy)void play(media);startDraw();}paint();}
});
function cleanup(){disposed=true;generation++;clearTimeout(introDeadline);cancelAnimationFrame(frame);bg.pause();intro.pause();media.pause();}
addEventListener('pagehide',cleanup,{once:true});
addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
addEventListener('resize',resize);
resize();applyMotion();startDraw();
if(!ctx){maskScale=1;portal.style.border='1px solid #ffffff4d';finishIntro();}
