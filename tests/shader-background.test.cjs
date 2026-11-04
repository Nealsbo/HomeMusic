const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PlayerBackground} = require('../web/shader-background.js');

function fixture({unavailable = false,compileFailure = false,background = 'northern-lights'} = {}) {
  let now = 0, id = 0, draws = 0, deleted = 0, lost = 0, disconnected = false;
  const tasks = new Map(), listeners = {}, uniforms = {};
  const gl = new Proxy({
    getShaderParameter:() => !compileFailure,getProgramParameter:() => true,
    getUniformLocation:(_,name) => name,
    uniform1f:(name,value) => uniforms[name] = value,
    uniform3fv:(name,value) => uniforms[name] = value,
    drawArrays:() => draws++,deleteBuffer:() => deleted++,deleteProgram:() => deleted++,deleteShader:() => deleted++,
    getExtension:() => ({loseContext:() => lost++})
  },{get:(object,key) => object[key] || (() => ({}))});
  const canvas = {setAttribute(){},getContext:() => unavailable ? null : gl,
    addEventListener:(name,fn) => listeners[name] = fn,
    removeEventListener:name => delete listeners[name],remove() { this.parentNode = null; }};
  const rect = {width:2400,height:1600};
  const host = {dataset:{},append(node) { node.parentNode = this; },getBoundingClientRect:() => rect};
  let resized;
  const env = {document:{createElement:() => canvas},performance:{now:() => now},
    setTimeout:(fn,delay) => { tasks.set(++id,{fn,delay}); return id; },clearTimeout:id => tasks.delete(id),
    ResizeObserver:class { constructor(fn) { resized = fn; } observe(){} disconnect() { disconnected = true; } }};
  const renderer = new PlayerBackground(host,{env});
  const config = {background,visible:true,moving:true,speed:20,primary:'#62eab7',secondary:'#ac81ff'};
  return {renderer,canvas,host,config,tasks,uniforms,listeners,rect,
    tick(ms = 1000/30) { now += ms; const task = tasks.values().next().value; tasks.clear(); task?.fn(); },
    resize() { resized(); },get draws() { return draws; },get deleted() { return deleted; },get lost() { return lost; },get disconnected() { return disconnected; }};
}

test('aurora bounds resolution and frame rate and ignores identical playback snapshots',() => {
  const f = fixture(); f.renderer.update(f.config);
  assert.equal(f.host.dataset.backgroundRenderer,'webgl');
  assert.ok(f.canvas.width <= 960 && f.canvas.height <= 540);
  assert.equal(f.canvas.width/f.canvas.height,1.5);
  assert.equal(f.tasks.size,1); assert.ok([...f.tasks.values()][0].delay >= 1000/30);
  for (let i=0;i<10;i++) f.renderer.update(f.config);
  assert.equal(f.draws,1); assert.equal(f.tasks.size,1);
  f.tick(); assert.equal(f.draws,2);
  f.renderer.dispose(); assert.equal(f.tasks.size,0);
});

test('pause, hidden player, reduced motion and zero speed leave no frame loop; resume has no time jump',() => {
  for (const patch of [{moving:false},{visible:false},{moving:false,speed:20},{speed:0}]) {
    const f = fixture(); f.renderer.update(f.config); f.tick(100);
    f.renderer.update({...f.config,...patch});
    assert.equal(f.tasks.size,0);
    const time = f.renderer.time, draws = f.draws;
    f.tick(60000); assert.equal(f.draws,draws);
    f.renderer.update(f.config); f.tick(100);
    assert.ok(Math.abs(f.renderer.time-time-.1) < 1e-6);
    f.renderer.dispose();
  }
});

test('speed is linear and palette and resize redraw a static frame without a timer',() => {
  const f = fixture(); f.renderer.update(f.config); f.tick(1000);
  assert.equal(f.uniforms.time,1);
  f.renderer.update({...f.config,speed:100}); f.tick(1000);
  assert.equal(f.uniforms.time,6);
  f.renderer.update({...f.config,speed:0,primary:'#ff0000'});
  assert.deepEqual(f.uniforms.primary,[1,0,0]); assert.equal(f.tasks.size,0);
  f.rect.width = 390; f.rect.height = 500; f.resize();
  assert.equal(f.canvas.width,254); assert.equal(f.canvas.height,325);
  assert.equal(f.tasks.size,0); f.renderer.dispose();
});

test('WebGL absence and shader failures use a static fallback without timers',() => {
  for (const options of [{unavailable:true},{compileFailure:true}]) {
    const f = fixture(options); f.renderer.update(f.config);
    assert.equal(f.host.dataset.backgroundRenderer,'fallback');
    assert.equal(f.tasks.size,0); assert.equal(f.draws,0); assert.equal(f.canvas.hidden,true);
    f.renderer.dispose();
  }
});

test('context loss stops rendering, restoration resumes, disposal releases all resources',() => {
  const f = fixture(); f.renderer.update(f.config);
  let prevented = false;
  f.listeners.webglcontextlost({preventDefault:() => prevented = true});
  assert.equal(prevented,true); assert.equal(f.tasks.size,0);
  assert.equal(f.canvas.hidden,true); assert.equal(f.host.dataset.backgroundRenderer,'fallback');
  f.renderer.update(f.config); assert.equal(f.canvas.hidden,true);
  f.listeners.webglcontextrestored(); assert.equal(f.tasks.size,1);
  assert.equal(f.canvas.hidden,false); assert.equal(f.host.dataset.backgroundRenderer,'webgl');
  f.renderer.dispose(); f.renderer.dispose();
  assert.equal(f.tasks.size,0); assert.equal(f.disconnected,true); assert.equal(f.lost,1);
  assert.equal(f.deleted,4); assert.deepEqual(f.listeners,{});
  assert.equal(f.canvas.parentNode,null); assert.equal(f.host.dataset.backgroundRenderer,undefined);
});

test('all shader modes share one canvas and timer and release the preceding program on switch',() => {
  const f = fixture();
  for (const background of ['northern-lights','aurora','gradient','stars','grid','gradient']) {
    assert.equal(PlayerBackground.supports(background),true);
    f.renderer.update({...f.config,background});
    assert.equal(f.host.dataset.backgroundRenderer,'webgl');
    assert.equal(f.canvas.parentNode,f.host); assert.equal(f.tasks.size,1);
    f.tick();
  }
  assert.equal(f.deleted,20);
  assert.equal(PlayerBackground.supports('ambient'),false);
  assert.equal(PlayerBackground.supports('toString'),false);
  f.renderer.dispose(); assert.equal(f.deleted,24); assert.equal(f.lost,1);
});

test('each shader mode retains static frame, resize and fallback lifecycle',() => {
  for (const background of ['aurora','gradient','stars','grid','northern-lights']) {
    const f = fixture({background});
    f.renderer.update({...f.config,speed:0}); assert.equal(f.tasks.size,0);
    f.resize(); assert.equal(f.draws,2); assert.equal(f.tasks.size,0);
    f.renderer.update({...f.config,visible:false}); f.resize(); assert.equal(f.draws,2);
    f.renderer.dispose();
    const fallback = fixture({background,unavailable:true}); fallback.renderer.update(fallback.config);
    assert.equal(fallback.host.dataset.backgroundRenderer,'fallback'); assert.equal(fallback.tasks.size,0);
    fallback.renderer.dispose();
  }
});
