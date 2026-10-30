const {test} = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../web/client-session.js');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {getItem:key => values.get(key), setItem:(key,value) => values.set(key,value)};
}
let unique = 0;
const options = extra => ({newId:() => 'id-' + (++unique), storage:storage(), channelFactory:() => null, ...extra});

test('repeated reloads retain the client ID and strictly increase report sequences', async () => {
  const saved = storage();
  let id, previous = 0;
  for (let reload = 0; reload < 6; reload++) {
    const session = new Session(options({storage:saved}));
    await session.ready;
    id ||= session.id;
    assert.equal(session.id, id);
    const seq = session.nextSequence();
    assert.ok(seq > previous);
    previous = seq;
    session.close();
  }
});

test('separate tabs have independent IDs and sequence counters', () => {
  const first = new Session(options()), second = new Session(options());
  assert.notEqual(first.id, second.id);
  assert.equal(first.nextSequence(), 1);
  assert.equal(first.nextSequence(), 2);
  assert.equal(second.nextSequence(), 1);
});

function bus() {
  const peers = new Set(), messages = [], timers = [];
  return {
    channelFactory:() => {
      const channel = {postMessage(data) {
        for (const target of peers) if (target !== channel) messages.push(() => target.onmessage?.({data}));
      }, close() { peers.delete(channel); }};
      peers.add(channel); return channel;
    },
    schedule:fn => timers.push(fn),
    settle() { while (messages.length) messages.shift()(); while (timers.length) timers.shift()(); }
  };
}

test('duplicating a live tab claims a new ID without changing the original player', async () => {
  const network = bus();
  const firstStorage = storage();
  const first = new Session(options({...network,storage:firstStorage}));
  network.settle(); await first.ready;
  first.nextSequence(); first.rememberCommand('old-command', {ok:true});
  const copiedStorage = storage({playerSession:firstStorage.getItem('playerSession')});
  const copy = new Session(options({...network,storage:copiedStorage}));
  const originalId = first.id;
  network.settle(); await copy.ready;
  assert.equal(first.id, originalId);
  assert.notEqual(copy.id, first.id);
  assert.equal(copy.nextSequence(), 1);
  assert.equal(copy.commands.size, 0);
  first.close(); copy.close();
});

test('simultaneously restored copies resolve an inherited ID collision', async () => {
  const network = bus();
  const initial = {playerSession:JSON.stringify({id:'copied',seq:5})};
  const first = new Session(options({...network,storage:storage(initial)}));
  const second = new Session(options({...network,storage:storage(initial)}));
  network.settle(); await Promise.all([first.ready,second.ready]);
  assert.notEqual(first.id, second.id);
  assert.ok(first.id === 'copied' || second.id === 'copied');
  first.close(); second.close();
});

test('completed commands survive reload and export snapshots never fill session storage', () => {
  const saved = storage();
  const first = new Session(options({storage:saved}));
  first.rememberCommand('next-command', {ok:true});
  first.rememberCommand('export-command', {ok:true,snapshot:{large:'snapshot'}});
  const second = new Session(options({storage:saved}));
  assert.deepEqual(second.commands.get('next-command'), {ok:true});
  assert.deepEqual(second.commands.get('export-command'), {ok:false,error:'Command expired'});
  assert.notEqual(first.pageId, second.pageId);
  for (let i = 0; i < 110; i++) second.rememberCommand('command-' + i, {ok:true});
  assert.equal(second.commands.size, 100);
});

test('corrupted or inaccessible storage does not prevent playback sessions', () => {
  for (const saved of [storage({playerSession:'broken'}), storage({playerSession:'{"id":"bad id","seq":-1}'}),
    {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }}]) {
    const session = new Session(options({storage:saved}));
    assert.match(session.id, /^id-/);
    assert.equal(session.nextSequence(), 1);
  }
});
