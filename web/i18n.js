/* Dictionaries contain plain text. Never insert a translation as HTML. */
(function(root) {
  'use strict';
  let language = 'en', dictionary = {}, fallback = {}, languages = [], requestId = 0;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const valid = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(text => typeof text === 'string');
  function translate(key, params = {}) {
    const text = own(dictionary, key) ? dictionary[key] : own(fallback, key) ? fallback[key] : key;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => own(params, name) ? String(params[name]) : match);
  }
  function message(value) {
    const text = String(value ?? '');
    if (own(dictionary, text) || own(fallback, text)) return translate(text);
    // Only translate known message prefixes, leaving paths and other values intact.
    const key = Object.keys(fallback).filter(key => key.endsWith(':') && text.startsWith(key + ' '))
      .sort((a, b) => b.length - a.length)[0];
    return key ? translate(key) + text.slice(key.length) : text;
  }
  function source(value) {
    const text = String(value ?? '');
    const key = Object.keys(dictionary).find(key => dictionary[key] === text);
    return key || text;
  }
  function use(code, values, english = fallback) {
    if (!valid(values) || !valid(english)) throw Error('Invalid language dictionary');
    language = code; dictionary = values; fallback = english;
  }
  function renderMessage(value) {
    if (!value || typeof value !== 'object' || typeof value.key !== 'string') return String(value ?? '');
    const params = Object.fromEntries(Object.entries(value.params || {}).map(([key, item]) =>
      [key, item && typeof item === 'object' ? renderMessage(item) : item]));
    return translate(value.key, params);
  }
  async function json(path) {
    const response = await fetch(path);
    if (!response.ok) throw Error('Could not load ' + path);
    return response.json();
  }
  function apply(rootElement = document) {
    document.documentElement.lang = language;
    rootElement.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = translate(element.getAttribute('data-i18n'));
    });
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      rootElement.querySelectorAll('[data-i18n-' + attr + ']').forEach(element => {
        element.setAttribute(attr, translate(element.getAttribute('data-i18n-' + attr)));
      });
    }
  }
  async function setLanguage(code, persist = true) {
    const request = ++requestId;
    if (!languages.some(item => item.code === code)) code = 'en';
    const values = code === 'en' ? fallback : await json('/locales/' + code + '.json');
    if (request !== requestId) return;
    use(code, values);
    if (persist) { try { localStorage.setItem('language', JSON.stringify(code)); } catch {} }
    apply();
    if (api.onChange) await api.onChange();
  }
  async function initialize() {
    languages = await json('/locales/languages.json').catch(() => [
      {code:'en', name:'English', locale:'en-US'}, {code:'ru', name:'Russian', locale:'ru-RU'}
    ]);
    fallback = await json('/locales/en.json').catch(() => ({}));
    let saved;
    try { saved = JSON.parse(localStorage.getItem('language')); } catch {}
    const preferred = saved || (root.navigator?.language || 'en').split('-')[0];
    try { await setLanguage(preferred, false); }
    catch (error) { console.warn(error); await setLanguage('en', false); }
  }
  const api = {translate, message, source, renderMessage, use, apply, setLanguage, initialize, onChange:null,
    get language() { return language; },
    get locale() { return languages.find(item => item.code === language)?.locale || language; },
    get languages() { return languages; }};
  root.MusicI18n = api;
  root.tr = translate;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
