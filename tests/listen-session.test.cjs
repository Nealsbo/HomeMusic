const {test} = require('node:test');
const assert = require('node:assert/strict');
const ListeningSession = require('../web/listen-session.js');

test('metadata/preload and paused wall time do not count as listening', () => {
  let now = 0; const session = new ListeningSession('track',() => now,'event');
  session.sample(0,false);
  now = 60000; session.sample(0,false);
  assert.equal(session.heard,0);
  assert.equal(session.payload('device','PC',100),null);
});

test('actual advancement is accumulated once across timeupdate, pause and reports', () => {
  let now = 0; const s = new ListeningSession('track',() => now,'event');
  s.sample(0,true);
  now = 5000; s.sample(5,true);
  assert.equal(s.heard,5);
  const first = s.payload('device','PC',100);
  assert.equal(first.listened,5);
  assert.equal(s.payload('device','PC',100),null);
  now = 7000; s.sample(7,false);
  assert.equal(s.heard,7);
  now = 17000; s.sample(7,false);
  assert.equal(s.heard,7);
  s.sample(7,true);
  now = 20000; s.sample(10,true);
  assert.equal(s.heard,10);
  assert.equal(s.payload('device','PC',100).seq,2);
});

test('forward/backward seeks and stalls do not add skipped or buffered seconds', () => {
  let now = 0; const s = new ListeningSession('track',() => now);
  s.sample(0,true);
  now = 2000; s.sample(2,true);
  s.sample(90,false,true);
  s.sample(90,true,true);
  now = 3000; s.sample(91,true);
  assert.equal(s.heard,3);
  s.sample(10,true,true);
  now = 13000; s.sample(10,true); // network stall
  assert.equal(s.heard,3);
  now = 14000; s.sample(11,true);
  assert.equal(s.heard,4);
  now = 14100; s.sample(100,true); // missing seek event: discontinuity guard
  assert.equal(s.heard,4);
});

test('resuming at a saved position counts only newly played audio', () => {
  let now = 0; const s = new ListeningSession('track',() => now);
  s.sample(50,false,true); s.sample(50,true);
  now = 1000; s.sample(51,true);
  assert.equal(s.payload('device','PC',100).listened,1);
});

test('ended reports stay ended and repeated occurrences have different event identities', () => {
  let now = 0; const s = new ListeningSession('track',() => now);
  s.sample(0,true); now = 10000; s.sample(10,false);
  const ended = s.payload('device','PC',10,true);
  assert.equal(ended.ended,true);
  now = 11000; s.sample(9,false,true);
  assert.equal(s.payload('device','PC',10).ended,true);
  assert.notEqual(s.id,new ListeningSession('track').id);
});
