class AudioWave {
  constructor(audio, options) {
    this.audio = audio; this.options = options;
    // Height smoothing strength: 0 = instant, 1 = default, 2 = twice as gentle.
    // Public so it can also be adjusted live in the browser console.
    this.smoothing = options.smoothing ?? 1;
    const Analysis = typeof module !== 'undefined' && module.exports ? require('./audio-analysis.js').AudioAnalysis : globalThis.AudioAnalysis;
    this.analysis = options.analysis || new Analysis(audio,{createContext:options.createContext});
    this.consumer = this.analysis.createConsumer();
    this.mode = 'off'; this.localFailed = false; this.blocked = false; this.syncing = false;
    this.timer = null; this.lastFrameTime = null;
    this.bins = new Uint8Array(128); this.samples = new Uint8Array(256);
    this.levels = new Float32Array(40);
    this.paint(false);
    this.unsubscribe = this.consumer.subscribe(() => { if (!this.blocked) this.sync(); });
  }
  get failed() { return this.localFailed || this.analysis.failed; }
  get context() { return this.analysis.context; }
  get source() { return this.analysis.source; }
  get analyser() { return this.analysis.analyser; }
  setMode(mode) {
    this.mode = ['off','eco','smooth','high'].includes(mode) ? mode : 'off';
    this.sync();
  }
  async unlock() {
    this.sync();
    await this.analysis.unlock();
    this.sync();
  }
  active() {
    return this.mode !== 'off' && !this.failed && !this.options.hidden() && !this.options.reduced()
      && this.consumer.status === 'active';
  }
  sync() {
    if (this.syncing) return;
    this.syncing = true; this.blocked = false;
    try {
      this.stopRendering();
      this.consumer.setActive(this.mode !== 'off' && !this.failed && !this.options.hidden() && !this.options.reduced());
      if (this.active()) { this.options.status('active'); this.tick(); }
      else this.options.status(this.failed ? 'unavailable' : this.mode === 'off' ? 'off'
        : this.options.reduced() ? 'reduced' : this.consumer.status === 'gesture' ? 'gesture' : 'idle');
    } catch { this.localFailed = true; this.consumer.setActive(false); this.options.status('unavailable'); }
    finally { this.syncing = false; }
  }
  stop() {
    this.blocked = true; this.consumer.setActive(false); this.stopRendering();
  }
  stopRendering() {
    if (this.timer !== null) this.options.cancel(this.timer);
    this.timer = null;
    this.lastFrameTime = null;
    this.levels.fill(0); this.paint(false);
  }
  tick() {
    this.timer = null;
    if (!this.active()) { this.sync(); return; }
    try {
      const interval = 1000 / ({eco:12,smooth:30,high:60}[this.mode] || 12);
      const now = this.options.now ? this.options.now() : performance.now();
      const elapsed = this.lastFrameTime === null ? interval : Math.max(0, Math.min(250, now - this.lastFrameTime));
      this.lastFrameTime = now;
      // Smooth both attacks and releases in milliseconds, independent of frame rate.
      const smoothing = Number.isFinite(this.smoothing) ? Math.max(0, this.smoothing) : 1;
      const attack = smoothing === 0 ? 1 : 1 - Math.exp(-elapsed / (90 * smoothing));
      const release = smoothing === 0 ? 1 : 1 - Math.exp(-elapsed / (220 * smoothing));
      if (!this.consumer.read(this.bins,this.samples)) { this.sync(); return; }
      let power = 0;
      for (const sample of this.samples) power += ((sample - 128) / 128) ** 2;
      const amplitude = Math.min(1, Math.sqrt(power / this.samples.length) * 3);
      for (let i = 0; i < this.levels.length; i++) {
        const start = Math.floor((i / this.levels.length) ** 2 * (this.bins.length - 1));
        const end = Math.max(start + 1, Math.floor(((i + 1) / this.levels.length) ** 2 * this.bins.length));
        let peak = 0;
        for (let j = start; j < end; j++) peak = Math.max(peak, this.bins[j]);
        const target = peak / 255 * amplitude;
        const blend = target > this.levels[i] ? attack : release;
        this.levels[i] += (target - this.levels[i]) * blend;
      }
      this.paint(true);
      this.timer = this.options.schedule(() => this.tick(), interval);
    } catch { this.localFailed = true; this.sync(); }
  }
  paint(active) { this.options.draw(this.levels, active); }
  media(event) {
    this.analysis.media(event); this.sync();
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = {AudioWave};
