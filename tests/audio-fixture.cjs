const assert = require('node:assert/strict');
function audioGraph(audio = {paused:false,ended:false,src:'/media/a',currentTime:42,volume:.5}) {
  const links = new Set(), counts = {contexts:0,sources:0,analysers:0,reads:0,badDisconnects:0,closes:0};
  const analyser = {getByteFrequencyData(data) { counts.reads++; data.fill(220); },getByteTimeDomainData(data) { data.fill(170); }};
  const source = {connect:node => links.add(node),disconnect(node) {
    if (node !== analyser) counts.badDisconnects++;
    assert.equal(node,analyser); links.delete(node);
  }};
  const context = {state:'suspended',destination:{},
    async resume() { this.state = 'running'; },
    createAnalyser() { counts.analysers++; return analyser; },
    createMediaElementSource(element) { if (audio === null) audio = element; assert.equal(element,audio); counts.sources++; return source; },
    close() { counts.closes++; },suspend() { counts.closes++; }};
  return {get audio() { return audio; },context,analyser,source,links,counts,createContext() { counts.contexts++; return context; }};
}
function drawingContext() {
  return {rects:[],points:[],strokes:0,
    clearRect() { this.rects = []; this.points = []; },
    fillRect(...values) { this.rects.push(values); },beginPath() { this.points = []; },
    moveTo(...values) { this.points.push(values); },lineTo(...values) { this.points.push(values); },stroke() { this.strokes++; }};
}
module.exports = {audioGraph,drawingContext};
