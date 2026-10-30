const {test} = require('node:test');
const assert = require('node:assert/strict');
const AlbumView = require('../web/album-view.js');

function fixture({reduced = false} = {}) {
  const loads = [], timers = new Map();
  let nextTimer = 0, language = '';
  class Element {
    constructor(tag) {
      this.tagName = tag; this.nodes = []; this.parentNode = null; this.style = {};
      this.attributes = {}; this.textContent = ''; this.naturalWidth = 0; this.naturalHeight = 0;
      const classes = new Set();
      this.classList = {add:key => classes.add(key), remove:key => classes.delete(key), contains:key => classes.has(key),
        toggle(key, active) { active ? classes.add(key) : classes.delete(key); }};
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...elements) { for (const element of elements) { element.remove(); element.parentNode = this; this.nodes.push(element); } }
    replaceChildren(...elements) { for (const child of [...this.nodes]) child.remove(); this.append(...elements); }
    remove() { if (this.parentNode) this.parentNode.nodes = this.parentNode.nodes.filter(node => node !== this); this.parentNode = null; }
    set src(value) { this._src = value; loads.push(value); }
    get src() { return this._src; }
    removeAttribute(key) { if (key === 'src') this._src = ''; delete this.attributes[key]; }
  }
  const document = {createElement:tag => new Element(tag)};
  const container = new Element('section');
  const view = new AlbumView({document, motion:{matches:reduced},
    translate:(key, params = {}) => language + key.replace(/\{(\w+)\}/g, (_, name) => String(params[name])),
    schedule:fn => { timers.set(++nextTimer, fn); return nextTimer; }, cancel:id => timers.delete(id)});
  view.mount(container); view.setActive(true);
  const nodes = () => { const all = []; const visit = element => { all.push(element); element.nodes.forEach(visit); }; visit(container); return all; };
  return {view,container,loads,timers,
    images:() => nodes().filter(element => element.tagName === 'img'),
    status:() => nodes().find(element => element.className === 'album-artwork-status')?.textContent,
    backdrop:() => nodes().find(element => element.className === 'album-artwork-backdrop'),
    language:value => { language = value; }};
}
const url = letter => '/covers/' + letter.repeat(64) + '.jpg';
const snapshot = (letter, extra = {}) => ({track:{id:letter, title:'Track ' + letter, album:'Album ' + letter, artwork:letter ? url(letter) : '', ...extra}});
function loaded(image, width = 500, height = 500) {
  image.naturalWidth = width; image.naturalHeight = height; image.onload();
}

test('no track or no artwork produces an accessible fallback without requests or timers', () => {
  const f = fixture();
  f.view.update({track:null});
  assert.equal(f.status(), 'Play a track to see its album artwork.');
  f.view.update(snapshot(''));
  assert.equal(f.status(), 'No album artwork');
  assert.deepEqual(f.loads, []); assert.equal(f.timers.size, 0);
  assert.equal(f.images().length, 0);
});

test('cover loads once and metadata or locale changes update literal alt text without reloading', () => {
  const f = fixture(); f.view.update(snapshot('a'));
  assert.equal(f.status(), 'Loading artwork…');
  const image = f.images()[0]; loaded(image, 640, 420);
  assert.equal(image.alt, 'Album artwork: Album a');
  assert.equal(f.status(), ''); assert.equal(image.classList.contains('is-visible'), true);
  for (let i = 0; i < 20; i++) f.view.update(snapshot('a'));
  f.language('Translated: ');
  f.view.update(snapshot('a', {title:'Changed', album:'<img onerror=alert(1)>'}));
  assert.equal(image.alt, 'Translated: Album artwork: <img onerror=alert(1)>');
  assert.deepEqual(f.loads, [url('a')]);
  assert.equal(f.images().length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.backdrop().style.backgroundImage, 'url("' + url('a') + '")');
});

test('a stale load cannot replace a newer track cover', () => {
  const f = fixture(); f.view.update(snapshot('a'));
  const old = f.images()[0], oldLoad = old.onload, oldError = old.onerror;
  f.view.update(snapshot('b'));
  const latest = f.images()[0];
  oldLoad(); oldError();
  assert.equal(f.status(), 'Loading artwork…');
  assert.equal(old.parentNode, null); assert.equal(old.onload, null);
  loaded(latest);
  assert.equal(f.images()[0], latest); assert.equal(latest.alt, 'Album artwork: Album b');
  assert.equal(f.backdrop().style.backgroundImage, 'url("' + url('b') + '")');
});

test('failed or invalid images clear old artwork and do not retry on every state update', () => {
  const f = fixture(); f.view.update(snapshot('a')); loaded(f.images()[0]);
  f.view.update(snapshot('b')); f.images()[1].onerror();
  assert.equal(f.images().length, 0); assert.equal(f.status(), 'Artwork unavailable');
  assert.equal(f.backdrop().style.backgroundImage, '');
  for (let i = 0; i < 10; i++) f.view.update(snapshot('b'));
  assert.equal(f.loads.length, 2);
  f.view.update(snapshot('c')); loaded(f.images()[0], 0, 0);
  assert.equal(f.status(), 'Artwork unavailable'); assert.equal(f.images().length, 0);
});

test('crossfade keeps only two covers and releases the old layer after its transition', () => {
  const f = fixture(); f.view.update(snapshot('a')); const first = f.images()[0]; loaded(first);
  f.view.update(snapshot('b')); const second = f.images()[1]; loaded(second);
  assert.equal(f.images().length, 2); assert.equal(f.timers.size, 1);
  second.ontransitionend({target:second,propertyName:'opacity'});
  assert.equal(f.images().length, 1); assert.equal(f.images()[0], second);
  assert.equal(first.src, ''); assert.equal(first.parentNode, null);
  assert.equal(f.timers.size, 0);
});

test('reduced motion changes the image immediately without a cleanup timer', () => {
  const f = fixture({reduced:true});
  f.view.update(snapshot('a')); loaded(f.images()[0]);
  f.view.update(snapshot('b')); loaded(f.images()[1]);
  assert.equal(f.images().length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.images()[0].src, url('b'));
});

test('deactivation cancels pending loads; resumption retries and disposal ignores late callbacks', () => {
  const f = fixture(); f.view.update(snapshot('a'));
  const old = f.images()[0], oldLoad = old.onload;
  f.view.setActive(false); oldLoad();
  assert.equal(f.images().length, 0);
  f.view.setActive(true); const retry = f.images()[0];
  assert.deepEqual(f.loads, [url('a'),url('a')]);
  const lateLoad = retry.onload; f.view.dispose(); lateLoad();
  assert.equal(f.container.nodes.length, 0);
  assert.equal(retry.onload, null); assert.equal(retry.onerror, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.container.classList.contains('album-stage'), false);
});

test('a new request during a crossfade releases old layers and cancels obsolete cleanup', () => {
  const f = fixture(); f.view.update(snapshot('a')); loaded(f.images()[0]);
  f.view.update(snapshot('b')); loaded(f.images()[1]);
  f.view.update(snapshot('c'));
  assert.equal(f.images().length, 2); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.images().map(image => image.src), [url('b'),url('c')]);
  f.view.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.container.nodes.length, 0);
});

test('a track without artwork never retains the preceding album image or accepts other endpoints', () => {
  const f = fixture(); f.view.update(snapshot('a')); loaded(f.images()[0]);
  f.view.update(snapshot('b', {artwork:'/media/b'}));
  assert.equal(f.images().length, 0); assert.equal(f.status(), 'No album artwork');
  assert.deepEqual(f.loads, [url('a')]);
});

test('disabling player animation clears an active fade and changes future covers without timers', () => {
  const f = fixture(); f.view.update(snapshot('a')); loaded(f.images()[0]);
  f.view.update(snapshot('b')); loaded(f.images()[1]);
  assert.equal(f.timers.size, 1);
  f.view.setAppearance({motionEnabled:false});
  assert.equal(f.timers.size, 0); assert.equal(f.images().length, 1);
  f.view.update(snapshot('c')); loaded(f.images()[1]);
  assert.equal(f.timers.size, 0); assert.equal(f.images().length, 1);
  assert.deepEqual(f.loads, [url('a'),url('b'),url('c')]);
});
