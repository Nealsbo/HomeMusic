const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EffectsPlayerView,normalizeEffects} = require('../web/effects-view.js');
const {AudioAnalysis} = require('../web/audio-analysis.js');
const {audioGraph,drawingContext} = require('./audio-fixture.cjs');
const {presets} = require('../web/visualization-presets.js');

function fixture({canvas = true, saved, ResizeObserver} = {}) {
  const graph = audioGraph(), drawing = drawingContext(), timers = new Map(), listeners = new Set(), storage = new Map();
  let now = 0, next = 0;
  if (saved) storage.set('expandedPlayerEffects',saved);
  class Element {
    constructor(tag) { this.tagName = tag; this.nodes = []; this.parentNode = null; this.attributes = {}; this.style = {}; this.textContent = ''; this.classList = {add(){},remove(){}}; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.nodes.push(node); } }
    replaceChildren(...nodes) { for (const node of this.nodes) node.parentNode = null; this.nodes = []; this.append(...nodes); }
    setAttribute(key,value) { this.attributes[key] = value; }
    getContext() { return canvas ? drawing : null; }
  }
  const document = {hidden:false,createElement:tag => new Element(tag),
    addEventListener(type,fn) { listeners.add(fn); },removeEventListener(type,fn) { listeners.delete(fn); }};
  const analysis = new AudioAnalysis(graph.audio,{createContext:() => graph.createContext()});
  const container = new Element('section');
  const view = new EffectsPlayerView({document,ResizeObserver,analysis:{createConsumer:() => analysis.createConsumer()},translate:key => key,
    getColor:() => '#24754b',now:() => now,
    schedule:(fn,delay) => { timers.set(++next,{fn,delay}); return next; },cancel:id => timers.delete(id),
    storage:{getItem:key => storage.get(key),setItem:(key,value) => storage.set(key,value)}});
  view.mount(container);
  const snapshot = () => ({track:{id:'a',title:'Track'},playing:!graph.audio.paused,state:graph.audio.paused ? 'paused' : 'playing'});
  return {...graph,view,drawing,timers,document,analysis,container,listeners,storage,
    async start() { analysis.media('playing'); view.setActive(true); view.update(snapshot()); await new Promise(resolve => setImmediate(resolve)); },
    update:() => view.update(snapshot()),
    visibility(value) { document.hidden = value; for (const listener of listeners) listener(); },
    frame() { const [id,timer] = timers.entries().next().value; timers.delete(id); now += timer.delay; timer.fn(); }};
}

test('spectrum uses measured samples, has one 30 fps loop, and never changes playback', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.view.label.textContent, 'Audio-reactive spectrum');
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 1000 / 30);
  assert.ok(f.drawing.rects.some(rect => rect[3] > 3));
  for (let i = 0; i < 10; i++) { f.update(); f.frame(); }
  assert.equal(f.timers.size, 1); assert.equal(f.counts.sources, 1);
  assert.equal(f.audio.currentTime, 42); assert.equal(f.audio.paused, false); assert.equal(f.audio.src, '/media/a');
  f.view.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});

test('waveform preset uses the same analysis and persists independent effect controls', async () => {
  const f = fixture(); await f.start();
  f.analyser.getByteTimeDomainData = data => { for (let i = 0; i < data.length; i++) data[i] = 128 + Math.round(Math.sin(i / 10) * 100); };
  f.view.presetSelect.onchange({target:{value:'waveform'}}); f.frame();
  assert.equal(f.view.label.textContent, 'Audio waveform'); assert.equal(f.drawing.points.length, 256);
  assert.ok(f.drawing.points.every(point => point[1] >= 0 && point[1] <= 360));
  assert.ok(new Set(f.drawing.points.map(point => point[1])).size > 1);
  assert.equal(f.counts.sources, 1); assert.equal(JSON.parse(f.storage.get('expandedPlayerEffects')).preset, 'waveform');
});

test('pause, hidden pages, deactivation and motion restrictions stop reads and timers', async () => {
  const f = fixture(); await f.start();
  f.audio.paused = true; f.analysis.media('pause'); f.update(); assert.equal(f.timers.size, 0);
  f.audio.paused = false; f.analysis.media('playing'); f.update(); assert.equal(f.timers.size, 1);
  f.visibility(true); const reads = f.counts.reads;
  f.update(); assert.equal(f.counts.reads, reads); assert.equal(f.timers.size, 0);
  f.visibility(false); assert.equal(f.timers.size, 1);
  f.view.setAppearance({motionEnabled:false,reducedMotion:true});
  assert.equal(f.timers.size, 0); assert.equal(f.view.label.textContent, 'Animation disabled by system preferences');
  assert.ok(f.links.has(f.context.destination)); assert.equal(f.links.has(f.analyser), false);
  f.view.setAppearance({motionEnabled:true,reducedMotion:false}); assert.equal(f.timers.size, 1);
  f.view.setActive(false); assert.equal(f.timers.size, 0);
  f.view.dispose(); assert.equal(f.counts.closes, 0); assert.equal(f.counts.badDisconnects, 0);
});

test('zero intensity and disabling effects release analysis without changing global animation', async () => {
  const f = fixture(); await f.start();
  f.view.intensity.oninput({target:{value:'0'}});
  assert.equal(f.timers.size, 0); assert.equal(f.view.label.textContent, 'Visualization intensity is zero');
  f.view.intensity.oninput({target:{value:'80'}}); assert.equal(f.timers.size, 1);
  f.view.enable.onchange({target:{checked:false}}); assert.equal(f.timers.size, 0);
  assert.equal(f.view.appearance.motionEnabled, true);
  assert.ok(f.links.has(f.context.destination)); assert.equal(f.links.has(f.analyser), false);
});

test('unsupported canvas and stored disabled effects never initialize Web Audio', async () => {
  for (const options of [{canvas:false},{saved:'{"enabled":false}'}]) {
    const f = fixture(options); await f.start();
    assert.equal(f.counts.sources, 0); assert.equal(f.counts.contexts, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.audio.paused, false);
  }
});

test('drawing failures disable only the view and preserve audible routing', async () => {
  const f = fixture(); await f.start();
  f.drawing.fillRect = () => { throw Error('canvas lost'); }; f.frame();
  assert.equal(f.view.label.textContent, 'Visualization is unavailable in this browser');
  assert.equal(f.timers.size, 0); assert.ok(f.links.has(f.context.destination));
  assert.equal(f.counts.badDisconnects, 0); assert.equal(f.counts.closes, 0); assert.equal(f.audio.paused, false);
});

test('a gesture-required context exposes a retry without a resume loop', async () => {
  const f = fixture();
  let resumes = 0;
  f.context.resume = async () => { resumes++; throw Object.assign(Error('blocked'),{name:'NotAllowedError'}); };
  await f.start();
  assert.equal(resumes, 1); assert.equal(f.counts.sources, 0); assert.equal(f.view.start.hidden, false);
  f.context.resume = async () => { f.context.state = 'running'; };
  f.view.start.onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.sources, 1); assert.equal(f.timers.size, 1);
});

test('effect preferences validate and restore without starting a hidden view', () => {
  assert.deepEqual(normalizeEffects({preset:'invalid',intensity:NaN,enabled:'false'}),{preset:'spectrum',intensity:60,enabled:true});
  assert.equal(normalizeEffects({intensity:120}).intensity, 100);
  const f = fixture({saved:'{"preset":"waveform","intensity":75,"enabled":true}'});
  assert.equal(f.view.presetSelect.value, 'waveform'); assert.equal(f.view.intensity.value, 75);
  assert.equal(f.counts.contexts, 0); assert.equal(f.timers.size, 0);
  f.view.dispose(); assert.equal(f.listeners.size, 0);
});

test('playback updates do not reset a preset selection before the user commits it', async () => {
  const f = fixture(); await f.start();
  f.view.presetSelect.value = 'waveform';
  f.update(); assert.equal(f.view.presetSelect.value, 'waveform');
  assert.equal(f.view.value.preset, 'spectrum');
  f.view.presetSelect.onchange({target:{value:'waveform'}});
  assert.equal(f.view.value.preset, 'waveform');
});

test('all classic presets share the analysis graph, persist selection and stop on every visibility boundary', async () => {
  const f = fixture(); await f.start();
  for (const preset of presets) {
    f.view.set({preset:preset.id}); f.frame();
    assert.equal(f.view.value.preset,preset.id); assert.equal(f.view.label.textContent,preset.description);
    assert.equal(JSON.parse(f.storage.get('expandedPlayerEffects')).preset,preset.id);
    assert.equal(f.timers.size,1); assert.equal(f.counts.sources,1); assert.equal(f.counts.contexts,1);
    assert.ok(f.drawing.rects.some(rect => rect[2] === 960 && rect[3] === 360));
    f.visibility(true); const reads = f.counts.reads;
    f.update(); assert.equal(f.counts.reads,reads); assert.equal(f.timers.size,0);
    f.visibility(false); assert.equal(f.timers.size,1);
    f.view.setAppearance({motionEnabled:false,reducedMotion:true}); assert.equal(f.timers.size,0);
    f.view.setAppearance({motionEnabled:true}); assert.equal(f.timers.size,1);
    f.audio.paused = true; f.analysis.media('pause'); f.update(); assert.equal(f.timers.size,0);
    f.audio.paused = false; f.analysis.media('playing'); f.update();
    assert.ok(f.links.has(f.context.destination));
  }
  f.view.dispose(); assert.equal(f.timers.size,0); assert.equal(f.counts.badDisconnects,0);
  assert.equal(f.audio.currentTime,42); assert.equal(f.audio.src,'/media/a');
});

test('saved classic selection restores and renderer failures leave the audible connection intact', async () => {
  const f = fixture({saved:'{"preset":"radial-bloom","intensity":75}'});
  assert.equal(f.view.presetSelect.value,'radial-bloom'); assert.equal(f.counts.contexts,0);
  await f.start();
  f.view.renderer.draw = () => { throw Error('renderer failed'); };
  f.frame(); assert.equal(f.timers.size,0);
  assert.equal(f.view.label.textContent,'Visualization is unavailable in this browser');
  assert.ok(f.links.has(f.context.destination)); assert.equal(f.audio.paused,false);
  assert.equal(f.counts.badDisconnects,0); f.view.dispose();
});

test('missing optional preset catalog falls back to the original presets without blocking playback', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const sandbox = {playerViews:{register() {}}};
  vm.runInNewContext(fs.readFileSync('web/effects-view.js','utf8'),sandbox);
  const view = new sandbox.EffectsPlayerView({storage:{getItem:() => '{"preset":"classic-bars"}'}});
  assert.equal(view.value.preset,'spectrum'); assert.equal(view.renderer,undefined);
});

test('preset changes crossfade a frozen frame over 300 ms using the existing render timer', async () => {
  const f = fixture(); await f.start(); f.view.set({preset:'classic-bars'});
  const buffer = f.view.transition.canvas;
  assert.equal(buffer.width,960); assert.equal(buffer.height,360); assert.equal(f.timers.size,1);
  f.frame();
  const overlays = () => f.drawing.images.filter(image => image.composition === 'lighter');
  const first = overlays().at(-1).alpha;
  assert.ok(first > .9 && first < 1);
  for (let i = 0; i < 4; i++) f.frame();
  assert.ok(overlays().at(-1).alpha < first && overlays().at(-1).alpha > 0);
  assert.equal(f.drawing.globalAlpha,1); assert.equal(f.drawing.globalCompositeOperation,'source-over');
  for (let i = 0; i < 5; i++) f.frame();
  assert.equal(f.view.transition,null); assert.equal(buffer.width,0); assert.equal(buffer.height,0);
  assert.equal(f.timers.size,1); assert.equal(f.counts.sources,1); assert.ok(f.links.has(f.context.destination));
  f.view.dispose();
});

test('rapid preset changes retain a single snapshot and do not discard measured spectrum levels', async () => {
  const f = fixture(); await f.start();
  const levels = [...f.view.levels];
  f.view.set({preset:'classic-bars'}); const buffer = f.view.transition.canvas;
  for (const preset of ['waveform','radial-bloom','spectrum','neon-scope','ribbon-waves']) {
    f.view.set({preset}); assert.equal(f.view.transition.canvas,buffer); assert.equal(f.timers.size,1);
  }
  assert.deepEqual([...f.view.levels],levels); f.frame();
  assert.equal(f.counts.contexts,1); assert.equal(f.counts.sources,1);
  f.view.dispose(); assert.equal(buffer.width,0); assert.equal(f.timers.size,0);
});

test('pause, visibility, disabled effects and reduced motion cancel crossfades without new loops', async () => {
  for (const stop of [f => { f.audio.paused = true; f.analysis.media('pause'); f.update(); },
    f => f.visibility(true),f => f.view.set({enabled:false}),f => f.view.setAppearance({motionEnabled:false,reducedMotion:true})]) {
    const f = fixture(); await f.start(); f.view.set({preset:'classic-bars'});
    const buffer = f.view.transition.canvas; stop(f);
    assert.equal(f.view.transition,null); assert.equal(buffer.width,0); assert.equal(f.timers.size,0);
    f.view.set({preset:'waveform'}); assert.equal(f.view.transition,null);
    assert.equal(f.timers.size,0); assert.ok(f.links.has(f.context.destination)); f.view.dispose();
  }
});


test('resizing effects fills the stage with bounded buffers without another analyser or render loop', async () => {
  let resize, disconnected = 0;
  class Observer {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected++; }
  }
  const f = fixture({ResizeObserver:Observer}); await f.start(); f.view.set({preset:'mirror-spectrum'});
  const buffer = f.view.transition.canvas, reads = f.counts.reads;
  f.view.canvas.clientWidth = 3000; f.view.canvas.clientHeight = 1400;
  resize();
  assert.equal(buffer.width,0); assert.equal(f.view.transition,null);
  assert.ok(f.view.canvas.width <= 1920 && f.view.canvas.height <= 1080);
  assert.ok(Math.abs(f.view.canvas.width / f.view.canvas.height - 3000 / 1400) < .01);
  assert.equal(f.counts.reads,reads); assert.equal(f.counts.contexts,1); assert.equal(f.counts.sources,1);
  assert.equal(f.timers.size,1);
  f.view.dispose(); assert.equal(disconnected,1); assert.equal(f.timers.size,0);
});
