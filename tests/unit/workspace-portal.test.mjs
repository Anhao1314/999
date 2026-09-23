import test from 'node:test';
import assert from 'node:assert/strict';
import { portalOutline, coverRect } from '../../apps/workspace/portal-geometry.mjs';
const bounds = points => ({left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1]))});
test('portal starts at the live target bounds and ends at the entire viewport without tilt',()=>{
  for(const viewport of [{width:1440,height:900},{width:768,height:1024},{width:375,height:667}]){
    const rect={left:viewport.width/2-110,top:180,width:220,height:245};
    const initial=bounds(portalOutline(rect,viewport));
    assert.equal(initial.left,rect.left);assert.equal(initial.right,rect.left+rect.width);
    assert.equal(initial.top,rect.top);assert.equal(initial.bottom,rect.top+rect.height);
    const end=bounds(portalOutline(rect,viewport,{expansion:1,rx:16.5,ry:-18.7}));
    assert.deepEqual(end,{left:0,right:viewport.width,top:0,bottom:viewport.height});
  }
});
test('portal projection remains finite through reversal and narrow layouts',()=>{
  for(const expansion of [0,.2,.5,.8,1,.6,.1,0]){
    const points=portalOutline({left:60,top:90,width:180,height:196},{width:375,height:540},{expansion,rx:16.5,ry:18.7});
    assert.equal(points.length,44);assert.ok(points.flat().every(Number.isFinite));
  }
});
test('screen-locked video covers both portrait and landscape without stretching',()=>{
  assert.deepEqual(coverRect(1920,1080,1440,900),[-80,0,1600,900]);
  const [x,y,w,h]=coverRect(1920,1080,375,844);
  assert.ok(x<0);assert.equal(y,0);assert.ok(w>=375);assert.equal(h,844);
  assert.equal(coverRect(0,0,375,844),null);
});
