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
  assert.deepEqual(normalize(null), {background:'ambient',intensity:40,backgroundSpeed:20,animation:true,palette:'theme',primary:'#62eab7',secondary:'#ac81ff'});
  assert.deepEqual(normalize({background:'invalid',intensity:'90',animation:'false'}), normalize(null));
  assert.equal(normalize({intensity:150}).intensity, 100);
  assert.equal(normalize({intensity:-20}).intensity, 0);
  assert.equal(normalize({intensity:42.6}).intensity, 43);
  assert.equal(normalize({intensity:NaN}).intensity, 40);
  for (const background of ['none','ambient','waves','texture']) assert.equal(normalize({background}).background, background);
});

test('background and color preferences migrate old values and reject unsafe or unknown input', () => {
  for (const background of ['aurora','gradient','stars','grid','northern-lights']) assert.equal(normalize({background}).background,background);
  assert.equal(normalize({palette:'mocha'}).palette,'mocha');
  assert.equal(normalize({palette:'polar'}).palette,'polar');
  assert.equal(normalize({palette:'invalid'}).palette,'theme');
  assert.equal(normalize({palette:'custom',primary:'#ABCDEF'}).primary,'#abcdef');
  assert.equal(normalize({primary:'url(secret)',secondary:'red; color:black'}).primary,'#62eab7');
  const saved = storage(JSON.stringify({background:'waves',animation:false,intensity:65}));
  const value = new PlayerAppearance({storage:saved,motion:motion()});
  assert.equal(value.get().background,'waves'); assert.equal(value.get().palette,'theme');
  value.set({background:'northern-lights',palette:'custom',primary:'#123456',secondary:'#abcdef'});
  const restored = new PlayerAppearance({storage:saved,motion:motion()});
  assert.equal(restored.get().primary,'#123456'); assert.equal(restored.get().secondary,'#abcdef');
  value.dispose(); restored.dispose();
});

test('background speed migrates to the previous pace at 20% and clamps to integer percentages', () => {
  assert.equal(normalize({}).backgroundSpeed,20);
  assert.equal(normalize({backgroundSpeed:0}).backgroundSpeed,0);
  assert.equal(normalize({backgroundSpeed:120}).backgroundSpeed,100);
  assert.equal(normalize({backgroundSpeed:-10}).backgroundSpeed,0);
  assert.equal(normalize({backgroundSpeed:33.7}).backgroundSpeed,34);
  assert.equal(normalize({backgroundSpeed:NaN}).backgroundSpeed,20);
  const saved=storage(JSON.stringify({background:'northern-lights',intensity:70}));
  const first=new PlayerAppearance({storage:saved,motion:motion()});
  assert.equal(first.get().backgroundSpeed,20);
  first.set({backgroundSpeed:65});
  const second=new PlayerAppearance({storage:saved,motion:motion()});
  assert.equal(second.get().backgroundSpeed,65);
  first.dispose(); second.dispose();
});

test('preferences persist independently from effective system motion', () => {
  const saved = storage(), system = motion(true);
  const first = new PlayerAppearance({storage:saved,motion:system});
  first.set({background:'waves',intensity:75,animation:true});
  assert.equal(first.get().motionEnabled, false);
  assert.equal(first.get().animation, true);
  assert.deepEqual(JSON.parse(saved.values.get('expandedPlayerAppearance')), {background:'waves',intensity:75,backgroundSpeed:20,animation:true,palette:'theme',primary:'#62eab7',secondary:'#ac81ff'});
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
