const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function boot(optional, failedAsset = '/album-view.js') {
  const loaded = [], warnings = [], status = {hidden:true,textContent:''};
  const context = vm.createContext({
    MusicI18n:{initialize:async () => {},translate:key => key},
    console:{warn:message => warnings.push(message),error(){}},
    document:{querySelectorAll:() => [
      {dataset:{appSrc:'/core.js'}},
      {dataset:{appSrc:failedAsset,optional:optional ? 'true' : undefined}},
      {dataset:{appSrc:'/app.js'}}
    ],createElement:() => ({}),getElementById:() => status,
    head:{append(script) {
      if (script.src === failedAsset) script.onerror();
      else { loaded.push(script.src); script.onload(); }
    }}}
  });
  await vm.runInContext(fs.readFileSync('web/bootstrap.js','utf8'),context);
  return {loaded,warnings,status};
}

test('unavailable optional visual scripts do not prevent the application from starting', async () => {
  for (const path of ['/album-view.js','/visualization-presets.js','/effects-view.js','/cd-view.js']) {
    const result = await boot(true,path);
    assert.deepEqual(result.loaded, ['/core.js','/app.js']);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.status.hidden, true);
  }
});

test('required script failures still report a startup error', async () => {
  const result = await boot(false);
  assert.deepEqual(result.loaded, ['/core.js']);
  assert.equal(result.status.hidden, false);
  assert.equal(result.status.textContent, 'Could not start the player. Reload the page.');
});
