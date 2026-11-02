const {test} = require('node:test');
const assert = require('node:assert/strict');
const {presets,create} = require('../web/visualization-presets.js');

function drawing() {
  return {operations:[],globalAlpha:1,
    fillRect(...values) { this.operations.push(['rect',...values,this.fillStyle,this.globalAlpha]); },
    beginPath() {},moveTo(...values) { this.operations.push(['move',...values]); },
    lineTo(...values) { this.operations.push(['line',...values]); },
    stroke() { this.operations.push(['stroke',this.strokeStyle,this.lineWidth,this.globalAlpha]); }};
}
const frame = (active = true) => ({width:960,height:360,levels:new Float32Array(40).fill(active ? .8 : 0),
  samples:Uint8Array.from({length:256},(_,i) => active ? 128 + Math.round(Math.sin(i / 12) * 100) : 128),
  intensity:100,active,elapsed:1000 / 30});

test('each preset renderer responds to sampled audio with bounded drawing work and coordinates', () => {
  for (const preset of presets) {
    const loud = drawing(), quiet = drawing(), input = frame();
    const before = [...input.samples], levels = [...input.levels];
    create(preset.id).draw(loud,input); create(preset.id).draw(quiet,frame(false));
    assert.notDeepEqual(loud.operations,quiet.operations,preset.id);
    assert.ok(loud.operations.length < 2000,preset.id);
    for (const [op,x,y] of loud.operations) {
      if (!['rect','move','line'].includes(op)) continue;
      assert.ok(Number.isFinite(x) && x >= 0 && x <= input.width,preset.id);
      assert.ok(Number.isFinite(y) && y >= 0 && y <= input.height,preset.id);
    }
    assert.deepEqual([...input.samples],before); assert.deepEqual([...input.levels],levels);
    assert.equal(loud.globalAlpha,1);
  }
});

test('peak markers decay after a transient instead of sticking at the previous maximum', () => {
  const renderer = create('classic-bars'), context = drawing();
  renderer.draw(context,frame());
  const markers = () => context.operations.filter(op => op[0] === 'rect' && op[5] === '#e3fff0');
  const initial = markers()[0][2];
  const silent = frame(); silent.levels.fill(0); silent.samples.fill(128);
  context.operations = []; renderer.draw(context,{...silent,elapsed:250});
  assert.ok(markers()[0][2] > initial);
  for (let i = 0; i < 20; i++) { context.operations = []; renderer.draw(context,{...silent,elapsed:250}); }
  assert.equal(markers().length,0);
});

test('preset instances own their state and reset clears accumulated motion and peaks', () => {
  for (const preset of presets) {
    const renderer = create(preset.id), first = drawing(), reset = drawing();
    renderer.draw(first,frame());
    for (let i = 0; i < 60; i++) renderer.draw(drawing(),frame());
    const independent = drawing(); create(preset.id).draw(independent,frame());
    assert.deepEqual(independent.operations,first.operations);
    renderer.reset(); renderer.draw(reset,frame()); assert.deepEqual(reset.operations,first.operations);
  }
  assert.equal(create('missing'),null);
  assert.ok(Object.isFrozen(presets)); assert.ok(presets.every(Object.isFrozen));
});
