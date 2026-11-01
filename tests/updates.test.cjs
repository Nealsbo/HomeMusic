const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id,{value:'',checked:false,open:true,addEventListener(type,fn) { this[type] = fn; }});
    return elements.get(id);
  };
  let result = {phase:'available',current:'0.1.0',latest:{version:'0.2.0',notes:'<script>untrusted notes</script>'},managed:true};
  const calls = [], messages = [];
  let interval, reloads = 0;
  const sandbox = { $:get, view:'settings', document:{hidden:false}, MusicI18n:{locale:'en',message:value => value},
    tr:value => value, toast:value => messages.push(value), location:{reload() { reloads++; }},
    setInterval:fn => { interval = fn; },
    fetch:async (url, options) => { calls.push({url,options}); return {ok:true,json:async () => result}; }};
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('web/updates.js','utf8'),context);
  return {get,calls,messages,sandbox, tick:() => interval(), result:value => { result = value; }, reloads:() => reloads};
}

test('update status loads only while settings are visible and never posts automatically', async () => {
  const f = fixture();
  assert.equal(f.calls.length,0);
  f.sandbox.view = 'library'; await f.tick();
  f.sandbox.view = 'settings'; f.sandbox.document.hidden = true; await f.tick();
  assert.equal(f.calls.length,0);
  f.sandbox.document.hidden = false; await f.tick();
  assert.equal(f.get('updateCurrent').textContent,'0.1.0');
  assert.equal(f.get('updateNotes').textContent,'<script>untrusted notes</script>');
  assert.equal(f.get('installUpdate').disabled,true);
  assert.ok(f.calls.every(call => !call.options));
});

test('install requires consent in the UI and sends the owner key only in the request header', async () => {
  const f = fixture(); await f.tick();
  f.get('updateRestartConsent').checked = true;
  f.get('updateRestartConsent').onchange();
  assert.equal(f.get('installUpdate').disabled,false);
  f.get('updateOwnerKey').value = ' private-owner-key ';
  f.result({phase:'downloading',managed:true});
  await f.get('installUpdate').onclick();
  const request = f.calls.at(-1);
  assert.equal(request.url,'/api/updates/install');
  assert.equal(request.options.headers.Authorization,'Bearer private-owner-key');
  assert.equal(request.options.body,'{}');
  assert.equal(f.get('installUpdate').disabled,true);
  assert.equal(f.get('updateRestartConsent').checked,false);
  assert.equal(f.reloads(),0);
});

test('failed health check displays rollback outcome and permits reloading the interface', async () => {
  const f = fixture();
  f.result({phase:'restarting',managed:true}); await f.tick();
  f.result({phase:'idle',managed:true,lastResult:{outcome:'rolled_back'}}); await f.tick();
  assert.equal(f.get('updateResult').textContent,'The previous version was restored after an unsuccessful update');
  assert.equal(f.get('reloadAfterUpdate').hidden,false);
  f.get('reloadAfterUpdate').onclick();
  assert.equal(f.reloads(),1);
});

test('invalid owner key is reported without changing playback or retaining credentials in storage', async () => {
  const f = fixture();
  f.sandbox.fetch = async () => ({ok:false,json:async () => ({error:'Invalid update owner key'})});
  await f.get('checkUpdates').onclick();
  assert.deepEqual(f.messages,['Invalid update owner key']);
  const source = fs.readFileSync('web/updates.js','utf8');
  assert.doesNotMatch(source,/localStorage|sessionStorage|audio\.|queue\./);
});
