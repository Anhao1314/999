(() => {
  const video=document.getElementById('settings-scene-video');
  const toggle=document.getElementById('settings-scene-toggle');
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  let paused=preference.matches;
  function render(){
    const stop=paused||preference.matches;
    toggle.setAttribute('aria-pressed',String(stop));
    toggle.setAttribute('aria-label',stop?'播放背景动态':'暂停背景动态');
    toggle.title=stop?'播放背景动态':'暂停背景动态';toggle.textContent=stop?'▷':'Ⅱ';
    if(stop||document.hidden)video.pause();else video.play().catch(()=>{});
  }
  video.muted=true;video.playbackRate=.65;
  toggle.addEventListener('click',()=>{paused=!paused;render();});
  preference.addEventListener('change',render);
  document.addEventListener('visibilitychange',render);
  addEventListener('pagehide',()=>video.pause(),{once:true});
  render();
})();
