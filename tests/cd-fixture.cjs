const {CDPlayerView} = require('../web/cd-view.js');

function cdFixture({quality,weak = false,supported = true,deferred = false,slow = 0,playing = false,ResizeObserver} = {}) {
  const tasks = new Map(), documentEvents = new Map(), windowEvents = new Map(), storage = new Map(), created = [], models = [], fallbacks = [];
  const counts = {contexts:0,imports:0,models:0,disposed:0,lost:0};
  let now = 0, next = 0, resolveModule, rejectModule;
  let palette = {surface:'#ffffff',accent:'#24754b'};
  if (quality) storage.set('expandedPlayerCD',JSON.stringify({quality}));
  class Element {
    constructor(tag) {
      this.tagName = tag; this.nodes = []; this.parentNode = null; this.attributes = {}; this.style = {}; this.textContent = ''; this.listeners = new Map();
      this.classList = {add(){},remove(){}};
    }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.nodes.push(node); } }
    replaceChildren(...nodes) { for (const node of [...this.nodes]) node.remove(); this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.nodes = this.parentNode.nodes.filter(node => node !== this); this.parentNode = null; }
    setAttribute(key,value) { this.attributes[key] = value; }
    addEventListener(type,fn) { this.listeners.set(type,fn); }
    removeEventListener(type,fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return {left:100,top:50,width:800,height:360}; }
    setPointerCapture(id) { this.capture = id; }
    releasePointerCapture(id) { if (this.capture === id) this.capture = null; }
  }
  const document = {hidden:false,createElement(tag) { const element = new Element(tag); created.push(element); return element; },
    addEventListener:(type,fn) => documentEvents.set(type,fn),removeEventListener:(type,fn) => { if (documentEvents.get(type) === fn) documentEvents.delete(type); }};
  const window = {addEventListener:(type,fn) => windowEvents.set(type,fn),removeEventListener:(type,fn) => { if (windowEvents.get(type) === fn) windowEvents.delete(type); }};
  const module = {createCDScene(canvas,gl,options) {
    counts.models++;
    let disposed = false;
    const model = {poses:[],sizes:[],palettes:[],art:[],fail:false,
      render(pose) { if (model.fail) throw Error('render failed'); model.poses.push({yaw:pose.yaw,pitch:pose.pitch,lid:pose.lid,spin:pose.spin,speed:pose.speed}); now += slow; },
      resize(...size) { model.sizes.push(size); },setPalette(value) { model.palettes.push(value); },
      setArtwork(url) { if (model.art.at(-1) !== url) { model.art.push(url); options.onArtwork(url ? 'ready' : 'empty'); options.onInvalidate(); } },
      dispose() { if (!disposed) { disposed = true; counts.disposed++; gl.getExtension().loseContext(); } }};
    models.push(model); return model;
  }};
  const container = new Element('section');
  const view = new CDPlayerView({document,window,ResizeObserver,translate:key => key,isWeakDevice:() => weak,
    getPalette:() => palette,now:() => now,
    schedule:(fn,delay) => { tasks.set(++next,{fn,delay}); return next; },cancel:id => tasks.delete(id),
    storage:{getItem:key => storage.get(key),setItem:(key,value) => storage.set(key,value)},
    createContext:() => { counts.contexts++; return supported ? {getExtension:() => ({loseContext() { counts.lost++; }})} : null; },
    loadScene:() => { counts.imports++; return deferred ? new Promise((resolve,reject) => { resolveModule = resolve; rejectModule = reject; }) : Promise.resolve(module); },
    createFallback:() => {
      const fallback = {disposed:false,updates:[],appearance:null,active:false,mount(element) { this.parent = element; },
        update(snapshot) { this.updates.push(snapshot); },setAppearance(value) { this.appearance = value; },setActive(value) { this.active = value; },dispose() { this.disposed = true; }};
      fallbacks.push(fallback); return fallback;
    }});
  const snapshot = (value = playing, artwork = '') => ({track:{id:'a',title:'Track',album:'Album',artwork},playing:value,state:value ? 'playing' : 'paused'});
  view.mount(container);
  return {view,counts,tasks,created,models,fallbacks,document,documentEvents,windowEvents,storage,container,snapshot,
    async start() { view.setActive(true); view.update(snapshot()); await new Promise(resolve => setImmediate(resolve)); },
    ready:() => new Promise(resolve => setImmediate(resolve)),
    resolve() { resolveModule(module); },reject() { rejectModule(Error('missing module')); },
    frame() { const [id,task] = tasks.entries().next().value; tasks.delete(id); now += task.delay; task.fn(); },
    visible(value) { document.hidden = !value; documentEvents.get('visibilitychange')?.(); },
    palette(value) { palette = value; }};
}
module.exports = {cdFixture};
