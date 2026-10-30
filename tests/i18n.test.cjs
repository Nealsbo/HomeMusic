const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const en = JSON.parse(fs.readFileSync('web/locales/en.json', 'utf8'));
const ru = JSON.parse(fs.readFileSync('web/locales/ru.json', 'utf8'));
const languages = JSON.parse(fs.readFileSync('web/locales/languages.json', 'utf8'));

function runtime({saved, browserLanguage = 'en-US', fetchOverride} = {}) {
  const values = new Map(saved ? [['language', JSON.stringify(saved)]] : []);
  const text = {textContent:'', getAttribute:() => 'Settings'};
  const attr = {attributes:{}, getAttribute:() => 'Search', setAttribute(key, value) { this.attributes[key] = value; }};
  const document = {documentElement:{lang:'en'}, querySelectorAll:selector =>
    selector === '[data-i18n]' ? [text] : selector === '[data-i18n-placeholder]' ? [attr] : []};
  const context = vm.createContext({document, navigator:{language:browserLanguage}, console,
    localStorage:{getItem:key => values.get(key), setItem:(key, value) => values.set(key, value)},
    fetch:fetchOverride || (async path => ({ok:true, json:async () =>
      path.endsWith('languages.json') ? languages : path.endsWith('ru.json') ? ru : en}))});
  vm.runInContext(fs.readFileSync('web/i18n.js', 'utf8'), context);
  return {i18n:context.MusicI18n, values, document, text, attr};
}

test('dictionaries have matching keys, English source text, and matching parameters', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.equal(value, key);
    assert.ok(!/[\u0400-\u04ff]/u.test(key), key);
    const params = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(params(ru[key]), params(value), key);
  }
});

test('saved language overrides browser preference and updates accessible attributes', async () => {
  const r = runtime({saved:'ru', browserLanguage:'en-US'});
  await r.i18n.initialize();
  assert.equal(r.i18n.language, 'ru');
  assert.equal(r.document.documentElement.lang, 'ru');
  assert.equal(r.text.textContent, ru.Settings);
  assert.equal(r.attr.attributes.placeholder, ru.Search);
  await r.i18n.setLanguage('en');
  assert.equal(r.text.textContent, 'Settings');
  assert.equal(JSON.parse(r.values.get('language')), 'en');
});

test('browser language is used initially; unsupported languages fall back to English', async () => {
  const russian = runtime({browserLanguage:'ru-RU'});
  await russian.i18n.initialize();
  assert.equal(russian.i18n.language, 'ru');
  const unsupported = runtime({browserLanguage:'zz-ZZ'});
  await unsupported.i18n.initialize();
  assert.equal(unsupported.i18n.language, 'en');
});

test('partial dictionaries fall back and parameters remain literal text', () => {
  const r = runtime();
  r.i18n.use('ru', {Settings:ru.Settings}, en);
  assert.equal(r.i18n.translate('Search'), 'Search');
  assert.equal(r.i18n.translate('New future key'), 'New future key');
  const name = '<img src=x onerror=alert(1)> $& {name}';
  assert.equal(r.i18n.translate('Playlist: {name}', {name}), 'Playlist: ' + name);
  r.i18n.use('ru', ru, en);
  assert.equal(r.i18n.renderMessage({key:'Playlist: {name}', params:{name}}),
    ru['Playlist: {name}'].replace('{name}', () => name));
  assert.equal(r.i18n.message('Track not found'), ru['Track not found']);
  assert.equal(r.i18n.source(ru['Track not found']), 'Track not found');
  assert.equal(r.i18n.message('Path is already occupied: Music/Settings.mp3'),
    ru['Path is already occupied:'] + ' Music/Settings.mp3');
  assert.equal(r.i18n.message('Custom message Settings'), 'Custom message Settings');
});

test('a slower language response cannot replace a newer choice', async () => {
  let complete;
  const r = runtime({fetchOverride:async path => {
    if (path.endsWith('ru.json')) return new Promise(resolve => { complete = () => resolve({ok:true,json:async () => ru}); });
    return {ok:true,json:async () => path.endsWith('languages.json') ? languages : en};
  }});
  await r.i18n.initialize();
  const older = r.i18n.setLanguage('ru');
  await r.i18n.setLanguage('en');
  complete(); await older;
  assert.equal(r.i18n.language, 'en');
});

test('a failed dictionary load keeps the current language and preference', async () => {
  const r = runtime({fetchOverride:async path => ({ok:!path.endsWith('ru.json'), json:async () =>
    path.endsWith('languages.json') ? languages : en})});
  await r.i18n.initialize();
  await assert.rejects(r.i18n.setLanguage('ru'), /Could not load/);
  assert.equal(r.i18n.language, 'en');
  assert.equal(r.values.get('language'), undefined);
});
