const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = new Map(), calls = [], messages = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, {value:'', open:true, addEventListener(name, fn) { this[name] = fn; }});
    return elements.get(id);
  };
  let status = {restartSupported:true, instance:'first', busy:false, startupTimeout:10};
  let failure = null, now = 0, reloads = 0, interval;
  const sandbox = {$:get, view:'settings', document:{hidden:false}, Date:{now:() => now},
    tr:value => value, MusicI18n:{message:value => value}, toast:value => messages.push(value),
    confirm:() => true, location:{reload() { reloads++; }}, setInterval:fn => { interval = fn; },
    fetch:async (url, options) => {
      calls.push({url, options});
      if (failure) return {ok:false, json:async () => ({error:failure})};
      return {ok:true, json:async () => options ? {accepted:true,instance:'first'} : status};
    }};
  vm.runInContext(fs.readFileSync('web/server-control.js', 'utf8'), vm.createContext(sandbox));
  return {get, calls, messages, sandbox, tick:() => interval(),
    status:value => { status = value; }, failure:value => { failure = value; },
    advance:ms => { now += ms; }, reloads:() => reloads};
}

test('restart controls only read status while visible and disable unmanaged or busy servers', async () => {
  const f = fixture();
  assert.equal(f.get('restartServer').disabled, true);
  f.sandbox.view = 'library'; await f.tick(); assert.equal(f.calls.length, 0);
  f.sandbox.view = 'settings'; await f.tick(); assert.equal(f.get('restartServer').disabled, false);
  f.status({restartSupported:false}); await f.tick();
  assert.equal(f.get('restartServer').disabled, true);
  f.status({restartSupported:true,busy:true}); await f.tick();
  await f.get('restartServer').onclick();
  assert.ok(f.calls.every(call => !call.options));
});

test('restart requires an owner key and confirmation and sends credentials only in the header', async () => {
  const f = fixture(); await f.tick();
  await f.get('restartServer').onclick();
  assert.equal(f.messages[0], 'Enter the server owner key');
  f.get('restartOwnerKey').value = ' private-key ';
  f.sandbox.confirm = () => false; await f.get('restartServer').onclick();
  assert.equal(f.calls.length, 1);
  f.sandbox.confirm = () => true; await f.get('restartServer').onclick();
  assert.equal(f.calls.at(-1).url, '/api/server/restart');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer private-key');
  assert.equal(f.calls.at(-1).options.body, '{}');
  assert.equal(f.get('restartOwnerKey').value, '');
  assert.equal(f.get('restartServer').disabled, true);
});

test('the page waits through downtime and reloads only after a different server instance responds', async () => {
  const f = fixture(); await f.tick(); f.get('restartOwnerKey').value = 'key';
  await f.get('restartServer').onclick();
  await f.tick(); assert.equal(f.reloads(), 0);
  f.failure('offline'); await f.tick(); assert.equal(f.reloads(), 0);
  f.failure(null); f.status({restartSupported:true,instance:'second',busy:false});
  await f.tick(); assert.equal(f.reloads(), 1);
});

test('authorization errors clear the password and do not start a restart or reload', async () => {
  const f = fixture(); await f.tick(); f.get('restartOwnerKey').value = 'wrong';
  f.failure('Invalid server owner key'); await f.get('restartServer').onclick();
  assert.equal(f.get('serverRestartStatus').textContent, 'Invalid server owner key');
  assert.equal(f.get('restartOwnerKey').value, '');
  assert.equal(f.reloads(), 0);
  assert.equal(f.get('restartServer').disabled, false);
});

test('restart timeout reports a useful error and never stores credentials or changes the player', async () => {
  const f = fixture(); await f.tick(); f.get('restartOwnerKey').value = 'key';
  await f.get('restartServer').onclick();
  f.advance(21000); await f.tick();
  assert.match(f.get('serverRestartStatus').textContent, /did not return in time/);
  assert.equal(f.reloads(), 0);
  assert.doesNotMatch(fs.readFileSync('web/server-control.js','utf8'), /localStorage|sessionStorage|audio\.|queue\./);
});
