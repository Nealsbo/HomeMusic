const {test} = require('node:test');
const assert = require('node:assert/strict');
const {CDMotion} = require('../web/cd-view.js');
const {cdFixture} = require('./cd-fixture.cjs');

test('disc motion accelerates, coasts to a stop and bounds manual rotation', () => {
  const motion = new CDMotion();
  for (let i=0; i<30; i++) motion.step(1/30,true,true);
  assert.ok(motion.speed > 2); const angle = motion.spin;
  motion.step(1/30,false,true); assert.ok(motion.speed > 0 && motion.speed < 2.1); assert.notEqual(motion.spin, angle);
  for (let i=0; i<90; i++) motion.step(1/30,false,true);
  assert.equal(motion.speed,0); assert.equal(motion.step(1/30,false,true),false);
  motion.open = true; motion.step(1/30,true,false);
  assert.equal(motion.lid,-Math.PI * .82); assert.equal(motion.speed,0);
  motion.rotate(100,-100); assert.equal(motion.yaw,1.5); assert.equal(motion.pitch,-.8);
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

test('a paused scene renders on demand, not on repeated playback reports', async () => {
  const f = cdFixture(); await f.start();
  assert.equal(f.counts.imports,1); assert.equal(f.counts.models,1); assert.equal(f.tasks.size,1);
  f.frame(); assert.equal(f.tasks.size,0);
  const renders = f.models[0].poses.length;
  for (let i=0; i<20; i++) f.view.update({...f.snapshot(),position:i});
  assert.equal(f.tasks.size,0); assert.equal(f.models[0].poses.length,renders);
  assert.equal(f.models[0].art.length,1);
});

test('lid, drag and keyboard interactions work without closing the view', async () => {
  const f = cdFixture(); await f.start(); f.frame();
  f.view.setAppearance({motionEnabled:false}); f.frame();
  f.view.lidButton.onclick(); f.frame();
  assert.equal(f.models[0].poses.at(-1).lid,-Math.PI * .82); assert.equal(f.tasks.size,0);
  const canvas = f.view.canvas;
  canvas.onpointerdown({button:0,pointerId:1,clientX:0,clientY:0,preventDefault(){}});
  canvas.onpointermove({pointerId:1,clientX:40,clientY:20}); f.frame();
  assert.notEqual(f.models[0].poses.at(-1).yaw,-.28);
  canvas.onpointerup({pointerId:1}); assert.equal(canvas.capture,null);
  let prevented = false;
  canvas.onkeydown({key:'Home',preventDefault(){prevented = true;}}); f.frame();
  assert.equal(prevented,true); assert.equal(f.models[0].poses.at(-1).yaw,-.28);
  assert.equal(f.view.active,true);
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
