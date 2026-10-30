const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PlayerAppearance,normalize} = require('../web/player-appearance.js');

function storage(value) {
  const values = new Map(value === undefined ? [] : [['expandedPlayerAppearance',value]]);
  return {values,getItem:key => values.get(key),setItem:(key,value) => values.set(key,value)};
}
function motion(matches = false) {
  const listeners = new Set();
  return {matches,addEventListener(type,fn) { listeners.add(fn); },removeEventListener(type,fn) { listeners.delete(fn); },
    change(value) { this.matches = value; for (const listener of listeners) listener(); },get count() { return listeners.size; }};
}

test('appearance validation preserves valid choices and constrains intensity', () => {
  assert.deepEqual(normalize(null), {background:'ambient',intensity:40,animation:true});
  assert.deepEqual(normalize({background:'invalid',intensity:'90',animation:'false'}), normalize(null));
  assert.equal(normalize({intensity:150}).intensity, 100);
  assert.equal(normalize({intensity:-20}).intensity, 0);
  assert.equal(normalize({intensity:42.6}).intensity, 43);
  assert.equal(normalize({intensity:NaN}).intensity, 40);
  for (const background of ['none','ambient','waves','texture']) assert.equal(normalize({background}).background, background);
});

test('preferences persist independently from effective system motion', () => {
  const saved = storage(), system = motion(true);
  const first = new PlayerAppearance({storage:saved,motion:system});
  first.set({background:'waves',intensity:75,animation:true});
  assert.equal(first.get().motionEnabled, false);
  assert.equal(first.get().animation, true);
  assert.deepEqual(JSON.parse(saved.values.get('expandedPlayerAppearance')), {background:'waves',intensity:75,animation:true});
  const restored = new PlayerAppearance({storage:saved,motion:motion(false)});
  assert.equal(restored.get().motionEnabled, true);
  assert.equal(restored.get().background, 'waves');
  assert.equal(restored.get().intensity, 75);
  first.dispose(); restored.dispose();
});

test('live reduced motion changes are published without overwriting manual preference', () => {
  const saved = storage(), system = motion();
  const appearance = new PlayerAppearance({storage:saved,motion:system});
  const updates = [];
  const unsubscribe = appearance.subscribe(value => updates.push(value.motionEnabled));
  system.change(true); system.change(false);
  appearance.set({animation:false}); system.change(true); system.change(false);
  assert.deepEqual(updates, [true,false,true,false,false,false]);
  assert.equal(appearance.get().animation, false);
  unsubscribe(); appearance.set({animation:true});
  assert.equal(updates.length, 6);
  appearance.dispose(); assert.equal(system.count, 0);
});

test('corrupt or unavailable local storage falls back without blocking preference changes', () => {
  for (const saved of [storage('broken'),storage('null'),{getItem() { throw Error('blocked'); },setItem() { throw Error('blocked'); }}]) {
    const appearance = new PlayerAppearance({storage:saved,motion:motion()});
    assert.equal(appearance.get().background, 'ambient');
    appearance.set({background:'none',intensity:0});
    assert.equal(appearance.get().background, 'none'); assert.equal(appearance.get().intensity, 0);
    appearance.dispose();
  }
});
