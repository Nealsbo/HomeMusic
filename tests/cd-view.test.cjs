const {test} = require('node:test');
const assert = require('node:assert/strict');
const {CDMotion} = require('../web/cd-view.js');
const {cdFixture} = require('./cd-fixture.cjs');

test('disc motion accelerates, coasts to a stop and bounds manual rotation', () => {
  const motion = new CDMotion();
  for (let i=0; i<30; i++) motion.step(1/30,true,true);
  assert.ok(Math.abs(motion.speed - 1.05 * (1 - Math.exp(-5))) < .000001); const angle = motion.spin;
  motion.step(1/30,false,true); assert.ok(motion.speed > 0 && motion.speed < 1.05); assert.notEqual(motion.spin, angle);
  for (let i=0; i<90; i++) motion.step(1/30,false,true);
  assert.equal(motion.speed,0); assert.equal(motion.step(1/30,false,true),false);
  motion.open = true; motion.step(1/30,true,false);
  assert.equal(motion.lid,-Math.PI * .82); assert.equal(motion.speed,0);
  motion.rotate(100,-100); assert.equal(motion.yaw,Math.PI * 25 / 180); assert.equal(motion.pitch,-Math.PI * 15 / 180);
});

test('static, weak-device and unsupported configurations never import Three.js', async () => {
  for (const options of [{quality:'static'},{weak:true},{supported:false}]) {
    const f = cdFixture(options); await f.start();
    assert.equal(f.counts.imports,0); assert.equal(f.counts.models,0); assert.equal(f.tasks.size,0);
    assert.equal(f.fallbacks.length,1); assert.equal(f.fallbacks[0].appearance.motionEnabled,false);
    assert.equal(f.view.lidButton.disabled,true);
    f.view.dispose(); assert.equal(f.fallbacks[0].disposed,true);
  }
});

test('CD 30/60 fps switching keeps the current scene, pose and one timer and persists with quality', async () => {
  const f = cdFixture({playing:true}); await f.start(); f.frame();
  const model = f.view.model, spin = f.view.motion.spin, yaw = f.view.motion.yaw;
  f.view.setFrameRate(60);
  assert.equal(f.view.model,model); assert.equal(f.view.motion.spin,spin); assert.equal(f.view.motion.yaw,yaw);
  assert.equal(f.tasks.size,1); assert.ok(Math.abs([...f.tasks.values()][0].delay - 1000/60) < .001);
  f.frame(); assert.equal(f.tasks.size,1); assert.equal(f.counts.imports,1);
  f.view.setQuality('3d'); await f.ready();
  assert.deepEqual(JSON.parse(f.storage.get('expandedPlayerCD')),{quality:'3d',frameRate:60,rotationSpeed:55});
  f.view.setFrameRate(120); assert.equal(f.view.frameRate,30);
  f.visible(false); assert.equal(f.tasks.size,0);
  f.view.dispose();
  const restored = cdFixture({frameRate:60}); await restored.start();
  assert.equal(restored.view.rateSelect.value,'60'); restored.view.dispose();
});

test('CD frame scheduling includes render time in the selected frame budget', async () => {
  const f = cdFixture({playing:true,slow:5}); await f.start(); f.view.setFrameRate(60); f.frame();
  assert.ok(Math.abs([...f.tasks.values()][0].delay - (1000/60 - 5)) < .001);
  assert.equal(f.tasks.size,1); f.view.dispose();
});

test('disc percentage preserves the old pace at 55%, scales linearly and stops at zero at both frame rates', () => {
  for (const fps of [30,60]) {
    const baseline=new CDMotion(), fast=new CDMotion(); fast.rotationSpeed=100;
    for (let i=0; i<fps*3; i++) {baseline.step(1/fps,true,true); fast.step(1/fps,true,true);}
    assert.ok(Math.abs(baseline.speed-1.05)<.00001);
    assert.ok(Math.abs(fast.speed/baseline.speed-100/55)<1e-10);
    const spin=fast.spin; fast.rotationSpeed=0;
    assert.equal(fast.step(1/fps,true,true),false);
    assert.equal(fast.speed,0); assert.equal(fast.spin,spin);
    fast.open=true; assert.equal(fast.step(1/fps,true,true),true);
    assert.ok(fast.lid<0); assert.equal(fast.spin,spin);
  }
});

test('rotation speed persists with quality and FPS, and zero stops its loop without replacing the scene', async () => {
  const f=cdFixture({playing:true,frameRate:60}); await f.start(); f.frame();
  assert.equal(f.view.rotationInput.value,'55');
  const model=f.view.model;
  f.view.setRotationSpeed(0); f.frame();
  assert.equal(f.tasks.size,0); assert.equal(f.view.model,model);
  f.view.setRotationSpeed(85); assert.equal(f.tasks.size,1);
  f.view.setFrameRate(30);
  assert.deepEqual(JSON.parse(f.storage.get('expandedPlayerCD')),{quality:'auto',frameRate:30,rotationSpeed:85});
  f.view.setRotationSpeed(200); assert.equal(f.view.rotationSpeed,100);
  f.view.setRotationSpeed(NaN); assert.equal(f.view.rotationSpeed,55);
  f.view.dispose();
  const restored=cdFixture({rotationSpeed:85}); await restored.start();
  assert.equal(restored.view.rotationInput.value,'85'); assert.equal(restored.view.motion.rotationSpeed,85);
  restored.view.dispose();
});

test('mouse interpolation is frame-rate independent and ignores modal overlays and inert scenes', async () => {
  const slow = new CDMotion(), fast = new CDMotion();
  slow.aim(1,-1); fast.aim(1,-1);
  for (let i=0; i<3; i++) slow.step(1/30,false,true);
  for (let i=0; i<6; i++) fast.step(1/60,false,true);
  assert.ok(Math.abs(slow.yaw - fast.yaw) < 1e-10);
  assert.ok(Math.abs(slow.pitch - fast.pitch) < 1e-10);
  const f = cdFixture(); await f.start(); f.frame();
  const move = f.documentEvents.get('pointermove');
  const host = {}, overlay = {};
  f.container.closest = () => host;
  move({pointerType:'mouse',clientX:1000,clientY:500,target:{closest:() => overlay}});
  assert.equal(f.view.motion.targetYaw,0); assert.equal(f.tasks.size,0);
  f.container.inert = true;
  move({pointerType:'mouse',clientX:1000,clientY:500,target:{closest:() => host}});
  assert.equal(f.view.motion.targetYaw,0); assert.equal(f.tasks.size,0);
  f.container.inert = false;
  move({pointerType:'mouse',clientX:1000,clientY:500,target:{closest:() => host}});
  assert.ok(f.view.motion.targetYaw > 0);
  f.view.dispose();
});

test('a paused scene renders on demand, not on repeated playback reports', async () => {
  const f = cdFixture(); await f.start();
  assert.equal(f.counts.imports,1); assert.equal(f.counts.models,1); assert.equal(f.tasks.size,1);
  f.frame(); assert.equal(f.tasks.size,0);
  const renders = f.models[0].poses.length;
  for (let i=0; i<20; i++) f.view.update({...f.snapshot(),position:i});
  assert.equal(f.tasks.size,0); assert.equal(f.models[0].poses.length,renders);
  assert.equal(f.models[0].art.length,1);
});

test('viewport size changes redraw the existing scene and release the observer on disposal', async () => {
  let resized, observed, disconnected = 0;
  class Observer {
    constructor(callback) { resized = callback; }
    observe(element) { observed = element; }
    disconnect() { disconnected++; }
  }
  const f = cdFixture({ResizeObserver:Observer}); await f.start(); f.frame();
  assert.equal(observed,f.view.viewport); const sizes = f.models[0].sizes.length;
  resized(); assert.equal(f.models[0].sizes.length,sizes + 1); assert.equal(f.tasks.size,1);
  f.frame(); assert.equal(f.counts.models,1); assert.equal(f.tasks.size,0);
  f.visible(false); resized(); assert.equal(f.models[0].sizes.length,sizes + 1); assert.equal(f.tasks.size,0);
  f.view.dispose(); assert.equal(disconnected,1);
});

test('lid, drag and keyboard interactions work without closing the view', async () => {
  const f = cdFixture(); await f.start(); f.frame();
  f.view.setAppearance({motionEnabled:false}); f.frame();
  f.view.lidButton.onclick(); f.frame();
  assert.equal(f.models[0].poses.at(-1).lid,-Math.PI * .82); assert.equal(f.tasks.size,0);
  const canvas = f.view.canvas;
  canvas.onpointerdown({button:0,pointerId:1,clientX:0,clientY:0,preventDefault(){}});
  canvas.onpointermove({pointerId:1,clientX:40,clientY:20}); f.frame();
  assert.notEqual(f.models[0].poses.at(-1).yaw,0);
  canvas.onpointerup({pointerId:1}); assert.equal(canvas.capture,null);
  let prevented = false;
  canvas.onkeydown({key:'Home',preventDefault(){prevented = true;}}); f.frame();
  assert.equal(prevented,true); assert.equal(f.models[0].poses.at(-1).yaw,0);
  assert.equal(f.view.active,true);
});

test('mouse tilt uses the whole window, interpolates and recenters only when leaving the window', async () => {
  const f = cdFixture(); await f.start(); f.frame();
  const move = f.documentEvents.get('pointermove'), original = f.view.motion.yaw;
  // Window corners are outside the smaller canvas rectangle.
  move({pointerType:'mouse',clientX:1000,clientY:500});
  assert.equal(f.view.motion.yaw,original);
  f.frame(); assert.ok(f.view.motion.yaw > original && f.view.motion.yaw < Math.PI * 25 / 180);
  for (let i = 0; i < 90 && f.tasks.size; i++) f.frame();
  assert.equal(f.view.motion.yaw,Math.PI * 25 / 180); assert.equal(f.view.motion.pitch,Math.PI * 15 / 180);
  assert.equal(f.tasks.size,0);
  f.documentEvents.get('pointerout')({pointerType:'mouse',relatedTarget:f.container});
  assert.equal(f.tasks.size,0); // Moving from canvas to another element does not recenter.
  move({pointerType:'touch',clientX:0,clientY:0});
  assert.equal(f.tasks.size,0);
  f.documentEvents.get('pointerout')({pointerType:'mouse',relatedTarget:null});
  f.frame(); assert.ok(f.view.motion.yaw > 0);
  for (let i = 0; i < 90 && f.tasks.size; i++) f.frame();
  assert.equal(f.view.motion.yaw,0); assert.equal(f.view.motion.pitch,0);
  move({pointerType:'mouse',clientX:0,clientY:0}); f.frame();
  f.windowEvents.get('blur')();
  assert.equal(f.view.motion.targetYaw,0);
  f.view.setActive(false);
  assert.equal(f.documentEvents.has('pointermove'),false);
  assert.equal(f.documentEvents.has('pointerout'),false);
  assert.equal(f.windowEvents.has('blur'),false);
  move({pointerType:'mouse',clientX:1000,clientY:500}); assert.equal(f.tasks.size,0);
  f.view.setActive(true); assert.equal(f.documentEvents.has('pointermove'),true);
  f.visible(false); assert.equal(f.documentEvents.has('pointermove'),false);
  f.visible(true); assert.equal(f.documentEvents.has('pointermove'),true);
  f.view.dispose(); assert.equal(f.documentEvents.size,0); assert.equal(f.windowEvents.size,0);
});

test('click and tap toggle a short lid animation while drags and canceled gestures do not', async () => {
  const f = cdFixture(); await f.start(); f.frame();
  const canvas = f.view.canvas;
  const event = (pointerType,x = 500,y = 200) => ({pointerType,pointerId:1,button:0,clientX:x,clientY:y,preventDefault(){}});
  canvas.onpointerdown(event('mouse')); canvas.onpointerup(event('mouse'));
  assert.equal(f.view.motion.open,true); assert.equal(f.view.motion.lid,0);
  f.frame(); assert.ok(f.view.motion.lid < 0 && f.view.motion.lid > -Math.PI * .82);
  for (let i = 0; i < 20 && f.tasks.size; i++) f.frame();
  assert.equal(f.view.motion.lid,-Math.PI * .82); assert.equal(f.tasks.size,0);
  assert.equal(canvas.attributes['aria-pressed'],'true');
  canvas.onpointerdown(event('touch')); canvas.onpointerup(event('touch'));
  assert.equal(f.view.motion.open,false);
  canvas.onpointerdown(event('touch')); canvas.onpointermove(event('touch',540,220)); canvas.onpointerup(event('touch',540,220));
  assert.equal(f.view.motion.open,false); assert.notEqual(f.view.motion.yaw,0);
  canvas.onpointerdown(event('mouse')); canvas.onpointercancel(event('mouse'));
  assert.equal(f.view.motion.open,false);
  canvas.onpointerdown(event('mouse')); canvas.onlostpointercapture(event('mouse')); canvas.onpointerup(event('mouse'));
  assert.equal(f.view.motion.open,false);
  canvas.onkeydown({key:'Enter',preventDefault(){}}); assert.equal(f.view.motion.open,true);
  f.view.setAppearance({motionEnabled:false}); f.frame(); assert.equal(f.tasks.size,0);
  canvas.onkeydown({key:' ',preventDefault(){}}); f.frame(); assert.equal(f.view.motion.lid,0);
  assert.equal(f.view.active,true); f.view.dispose();
});

test('moving a pressed mouse is not a lid click, even after returning to its start', async () => {
  const f = cdFixture(); await f.start(); f.frame(); const canvas = f.view.canvas;
  const event = x => ({pointerType:'mouse',pointerId:1,button:0,clientX:x,clientY:200,preventDefault(){}});
  canvas.onpointerdown(event(500)); canvas.onpointermove(event(550)); canvas.onpointermove(event(500)); canvas.onpointerup(event(500));
  assert.equal(f.view.motion.open,false);
  canvas.onpointerdown(event(500)); canvas.onpointerup(event(600)); assert.equal(f.view.motion.open,false);
  f.visible(false); canvas.onpointermove(event(900)); assert.equal(f.tasks.size,0);
  f.view.dispose();
});

test('playback and lid animations use at most one bounded timer and stop when hidden', async () => {
  const f = cdFixture({playing:true}); await f.start();
  for (let i=0; i<30; i++) { f.frame(); assert.equal(f.tasks.size,1); }
  assert.ok([...f.tasks.values()][0].delay >= 1000 / 30 - .001);
  f.visible(false); assert.equal(f.tasks.size,0);
  f.visible(true); assert.equal(f.tasks.size,1);
  f.view.update(f.snapshot(false));
  for (let i=0; i<120 && f.tasks.size; i++) f.frame();
  assert.equal(f.tasks.size,0); assert.equal(f.view.motion.speed,0);
  f.view.setActive(false); assert.equal(f.tasks.size,0);
});

test('closing before the lazy import begins avoids loading it entirely', async () => {
  const f = cdFixture();
  f.view.setActive(true); f.view.setActive(false); await f.ready();
  assert.equal(f.counts.imports,0); assert.equal(f.counts.models,0); assert.equal(f.counts.lost,1);
});

test('a late lazy import cannot construct a GPU scene after disposal', async () => {
  const f = cdFixture({deferred:true}); await f.start();
  assert.equal(f.counts.imports,1); f.view.dispose(); f.resolve(); await f.ready();
  assert.equal(f.counts.models,0); assert.equal(f.counts.lost,1);
  assert.equal(f.tasks.size,0); assert.equal(f.documentEvents.size,0); assert.equal(f.windowEvents.size,0);
});

test('context loss releases graphics and switches to static artwork, with explicit retry', async () => {
  const f = cdFixture({playing:true}); await f.start(); f.frame();
  let prevented = false;
  const canvas = f.view.canvas;
  canvas.listeners.get('webglcontextlost')({preventDefault(){prevented = true;}});
  assert.equal(prevented,true); assert.equal(f.counts.disposed,1); assert.equal(f.tasks.size,0);
  assert.equal(f.fallbacks.length,1); assert.equal(f.view.retry.hidden,false);
  f.view.retry.onclick(); await f.ready();
  assert.equal(f.view.quality,'3d'); assert.equal(f.counts.models,2); assert.equal(f.fallbacks[0].disposed,true);
  assert.equal(JSON.parse(f.storage.get('expandedPlayerCD')).quality,'3d');
});

test('manual static quality disposes the scene and user-selected 3D overrides the weak-device hint', async () => {
  const f = cdFixture({weak:true}); await f.start();
  f.view.select.onchange({target:{value:'3d'}}); await f.ready(); assert.equal(f.counts.models,1);
  f.view.setQuality('static'); assert.equal(f.counts.disposed,1); assert.equal(f.tasks.size,0);
  assert.equal(f.view.retry.hidden,true);
});

test('sustained slow rendering falls back automatically without keeping a render loop', async () => {
  const f = cdFixture({playing:true,slow:100}); await f.start();
  for (let i=0; i<30 && f.tasks.size; i++) f.frame();
  assert.equal(f.tasks.size,0); assert.equal(f.counts.disposed,1); assert.equal(f.fallbacks.length,1);
  assert.equal(f.view.reason,'Static artwork is used on this device to save resources.');
});

test('texture and theme changes reuse the scene and reduced motion keeps explicit interaction', async () => {
  const f = cdFixture({playing:true}); await f.start(); f.frame();
  f.view.update(f.snapshot(true,'/covers/' + 'a'.repeat(64) + '.jpg'));
  f.palette({surface:'#1b2939',accent:'#74b9e8'}); f.view.update(f.snapshot(true,'/covers/' + 'a'.repeat(64) + '.jpg'));
  assert.equal(f.counts.models,1); assert.equal(f.models[0].art.length,2);
  f.view.setAppearance({motionEnabled:false}); f.frame(); assert.equal(f.tasks.size,0);
  f.view.left.onclick(); f.frame(); assert.equal(f.tasks.size,0); assert.equal(f.view.motion.speed,0);
  f.view.dispose(); assert.equal(f.counts.disposed,1); assert.equal(f.tasks.size,0);
});
