'use strict';
const $ = id => document.getElementById(id);
const audio = $('audio');
let state = {tracks: [], playlists: [], folders: [], settings: {}}, trackMap = new Map();
let view = 'library', playlistId = null, selected = new Set(), visible = [], limit = 150;
let queue = [], currentId = null, shuffled = false, repeating = false, dragId = null, uploading = false;
let toastTimer;
let editingTrackSnapshot = null;
const queueModel = new MusicQueue();
let queueLimit = 150, queueDragId = null, playbackGeneration = 0;
let queuePlaylistId = null, queueName = 'Медиатека', playbackState = 'idle', playbackError = '';
const clientId = globalThis.crypto?.randomUUID?.() || ('web-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
let reportSeq = 0, reportedQueue = null;
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' ГБ' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1024).toFixed(0) + ' КБ';
const clock = s => Number.isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00';
const folderOf = t => t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500); }
async function api(action, data) {
  const response = await fetch('/api/' + action, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) { const error = Error(result.error || 'Ошибка сервера'); error.status = response.status; throw error; }
  if (result.operationId && typeof rememberOperation === 'function') rememberOperation(result.operationId);
  return result;
}
function handle(fn) { return async event => { try { await fn(event); } catch (error) { toast(error.message); } }; }
function options(element, entries, fallback = '') {
  const previous = element.options.length ? element.value : null;
  element.innerHTML = entries.map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join('');
  element.value = entries.some(e => e[0] === previous) ? previous : entries.some(e => e[0] === fallback) ? fallback : (entries[0]?.[0] ?? '');
}

const savedDevice = stored('device',{});
const deviceId = /^[A-Za-z0-9_-]{1,80}$/.test(savedDevice.id || '') ? savedDevice.id :
  (globalThis.crypto?.randomUUID?.() || 'device-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
let deviceName = typeof savedDevice.name === 'string' && savedDevice.name.trim() ? savedDevice.name.slice(0,80) :
  'Браузер · ' + (navigator.platform || 'устройство');
store('device',{id:deviceId,name:deviceName});
let historyItems = [], historyCursor = null, historyRequest = 0, historyTotal = 0;
const favoriteBusy = new Set();

let homeMode = stored('homeMode','table') === 'collection' ? 'collection' : 'table';
let catalog = new MusicCatalog();
let collectionRoute = {page:'overview'}, collectionLimit = 48, tableScope = null;
