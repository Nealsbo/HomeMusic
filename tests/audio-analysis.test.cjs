const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AudioAnalysis} = require('../web/audio-analysis.js');
const {audioGraph} = require('./audio-fixture.cjs');

function fixture() {
  const graph = audioGraph();
  const analysis = new AudioAnalysis(graph.audio,{createContext:() => graph.createContext()});
  analysis.media('playing');
  return {...graph,analysis};
}
const buffers = () => [new Uint8Array(128),new Uint8Array(256)];

test('disabled analysis never constructs or routes audio', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  await consumer.unlock();
  assert.equal(consumer.read(...buffers()), false);
  assert.equal(f.counts.contexts, 0); assert.equal(f.counts.sources, 0);
  assert.equal(f.audio.currentTime, 42); assert.equal(f.audio.src, '/media/a');
});

test('concurrent consumers share one context, source and analyser', async () => {
  const f = fixture(), wave = f.analysis.createConsumer(), effects = f.analysis.createConsumer();
  wave.setActive(true); effects.setActive(true);
  await Promise.all([wave.unlock(),effects.unlock()]);
  assert.equal(f.counts.contexts, 1); assert.equal(f.counts.sources, 1); assert.equal(f.counts.analysers, 1);
  assert.equal(wave.read(...buffers()), true); assert.equal(effects.read(...buffers()), true);
  wave.setActive(false); assert.equal(effects.status, 'active');
  assert.ok(f.links.has(f.context.destination)); assert.ok(f.links.has(f.analyser));
  effects.dispose(); assert.ok(f.links.has(f.context.destination)); assert.equal(f.links.has(f.analyser), false);
  wave.setActive(true); await wave.unlock();
  assert.equal(f.counts.sources, 1); assert.equal(f.counts.contexts, 1);
  assert.equal(f.counts.closes, 0); assert.equal(f.counts.badDisconnects, 0);
  assert.deepEqual(Object.keys(wave).sort(), ['dispose','read','setActive','status','subscribe','unlock']);
});

test('consumers disappearing during resume cannot reroute the native element', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  let resume;
  f.context.resume = () => new Promise(resolve => { resume = () => { f.context.state = 'running'; resolve(); }; });
  consumer.setActive(true); const pending = consumer.unlock(); consumer.dispose(); resume(); await pending;
  assert.equal(f.counts.sources, 0); assert.equal(f.links.size, 0); assert.equal(f.audio.paused, false);
});

test('an analyser read failure detaches analysis while preserving audible routing', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  consumer.setActive(true); await consumer.unlock();
  f.analyser.getByteFrequencyData = () => { throw Error('analysis failed'); };
  assert.equal(consumer.read(...buffers()), false); assert.equal(consumer.status, 'unavailable');
  assert.ok(f.links.has(f.context.destination)); assert.equal(f.links.has(f.analyser), false);
  consumer.dispose();
  assert.equal(f.counts.closes, 0); assert.equal(f.counts.badDisconnects, 0);
  assert.equal(f.audio.paused, false); assert.equal(f.audio.currentTime, 42);
});

test('a suspended attached context can resume with all renderers disabled', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  consumer.setActive(true); await consumer.unlock(); consumer.setActive(false);
  f.context.state = 'suspended'; await f.analysis.unlock();
  assert.equal(f.context.state, 'running'); assert.equal(f.counts.sources, 1);
  assert.ok(f.links.has(f.context.destination)); assert.equal(f.links.has(f.analyser), false);
});

test('autoplay permission refusal can be retried without creating a source prematurely', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  f.context.resume = async () => { throw Object.assign(Error('gesture required'),{name:'NotAllowedError'}); };
  consumer.setActive(true); await consumer.unlock();
  assert.equal(consumer.status, 'gesture'); assert.equal(f.counts.sources, 0);
  f.context.resume = async () => { f.context.state = 'running'; };
  await consumer.unlock(); assert.equal(f.counts.sources, 1); assert.equal(consumer.status, 'active');
});

test('pause, buffering and seeks disconnect analysis but retain sound and consumer identity', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  consumer.setActive(true); await consumer.unlock();
  for (const event of ['waiting','seeking','loadstart','emptied','ended','error']) {
    f.analysis.media(event); assert.equal(consumer.read(...buffers()), false);
    assert.equal(f.links.has(f.analyser), false); assert.ok(f.links.has(f.context.destination));
    f.analysis.media('playing'); assert.equal(consumer.read(...buffers()), true);
  }
  assert.equal(f.counts.sources, 1);
});

test('disposed consumers cannot keep subscriptions, enable analysis or read frames', async () => {
  const f = fixture(), consumer = f.analysis.createConsumer();
  let updates = 0; consumer.subscribe(() => updates++);
  consumer.dispose(); consumer.setActive(true); await consumer.unlock(); f.analysis.media('waiting');
  assert.equal(consumer.read(...buffers()), false); assert.equal(updates, 0); assert.equal(f.counts.contexts, 0);
});
