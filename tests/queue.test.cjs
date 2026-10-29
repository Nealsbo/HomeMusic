const {test} = require('node:test');
const assert = require('node:assert/strict');
const MusicQueue = require('../web/queue.js');
const tracks = q => q.ordered.map(e => e.trackId);

test('duplicate tracks are independent entries and removing one keeps the other', () => {
  const q = new MusicQueue();
  q.replace(['a','a','b']);
  assert.notEqual(q.entries[0].id,q.entries[1].id);
  q.next();
  assert.equal(q.current.id,q.entries[1].id);
  q.remove(q.entries[0].id);
  assert.deepEqual(tracks(q),['a','b']);
  assert.equal(q.current.trackId,'a');
});

test('shuffle visits every occurrence exactly once and previous uses actual history', () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const q = new MusicQueue(); q.setShuffle(true); q.replace(['a','b','c','d','e']);
    const visited = [q.current.id]; let next;
    while ((next = q.next())) visited.push(next.id);
    assert.equal(new Set(visited).size,5);
    assert.equal(visited.length,5);
    assert.equal(q.previous().id,visited[3]);
    assert.equal(q.previous().id,visited[2]);
    assert.equal(q.next().id,visited[3]);
    assert.equal(q.next().id,visited[4]);
    assert.equal(q.next(),null);
    const repeated = q.next(true);
    assert.notEqual(repeated.id,visited[4]);
  }
});

test('play next works in shuffle mode and after navigating back', () => {
  const q = new MusicQueue(); q.replace(['a','b','c']);
  q.next(); q.previous(); q.setShuffle(true);
  q.add(['x','y'],true);
  assert.equal(q.next().trackId,'x');
  assert.equal(q.next().trackId,'y');
});

test('manual reordering leaves current audio entry and history intact', () => {
  const q = new MusicQueue(); q.replace(['a','b','c']); q.next();
  const current = q.current.id;
  q.move(q.entries[2].id,q.entries[1].id);
  assert.deepEqual(tracks(q),['a','c','b']);
  assert.equal(q.current.id,current);
  assert.equal(q.previous().trackId,'a');
});

test('removing current advances to next entry, removing final current leaves queue stopped', () => {
  const q = new MusicQueue(); q.replace(['a','b','c']);
  assert.equal(q.remove(q.current.id).current.trackId,'b');
  q.next(); assert.equal(q.remove(q.current.id).current,null);
  assert.deepEqual(tracks(q),['b']);
});

test('snapshot round trip retains duplicate identity, shuffled order and navigation cursor', () => {
  const q = new MusicQueue(); q.setShuffle(true); q.replace(['a','b','a','c']);
  q.next(); q.next(); q.previous();
  const restored = new MusicQueue();
  assert.equal(restored.restore(JSON.parse(JSON.stringify(q.snapshot())),new Set(['a','b','c'])),true);
  assert.deepEqual(restored.snapshot(),q.snapshot());
  assert.equal(restored.next().id,q.next().id);
});

test('restore rejects invalid identities, prunes missing tracks and repairs incomplete order', () => {
  const q = new MusicQueue();
  q.restore({version:2,entries:[{id:'good',trackId:'a'},{id:'bad"<',trackId:'a'},{id:'other',trackId:'gone'},{id:'good',trackId:'a'}],order:[],history:[]},new Set(['a']));
  assert.deepEqual(tracks(q),['a']);
  assert.deepEqual(q.order,['good']);
});
test('switching shuffle after going back visits the new upcoming order without skipping entries', () => {
  const q = new MusicQueue(() => 0);
  q.replace(['a','b','c','d']); q.next(); q.next(); q.previous();
  q.setShuffle(true);
  const upcoming = []; let next;
  while ((next = q.next())) upcoming.push(next.trackId);
  assert.deepEqual(new Set(upcoming),new Set(['c','d']));
});

test('previous can cross the manually selected start after forward/back navigation', () => {
  const q = new MusicQueue(); q.replace(['1','2','3','4','5','6','7'],3);
  const visited=['4'];
  for(const direction of [1,1,1,-1,-1,1,-1,-1,-1,-1,-1]) {
    const entry=direction>0?q.next():q.previous(); visited.push(entry?.trackId);
  }
  assert.deepEqual(visited,['4','5','6','7','6','5','6','5','4','3','2','1']);
  assert.equal(q.previous(),null);
  assert.equal(q.next().trackId,'2'); assert.equal(q.next().trackId,'3'); assert.equal(q.next().trackId,'4');
});

test('extending history backwards preserves duplicate occurrence identity and snapshot restoration', () => {
  const q = new MusicQueue(); q.replace(['a','a','b'],1);
  const selected=q.current.id, previous=q.entries[0].id;
  assert.equal(q.previous()?.id,previous);
  const restored=new MusicQueue();restored.restore(JSON.parse(JSON.stringify(q.snapshot())),new Set(['a','b']));
  assert.equal(restored.next().id,selected); assert.equal(restored.next().trackId,'b');
});

test('shuffle still goes back through actual history and stops at its beginning', () => {
  const q=new MusicQueue();q.setShuffle(true);q.replace(['1','2','3','4'],2);
  const first=q.current.id, next=q.next().id;
  assert.equal(q.previous().id,first);assert.equal(q.previous(),null);assert.equal(q.next().id,next);
});
