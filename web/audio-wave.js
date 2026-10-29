class AudioWave {
  constructor(audio, options) {
    this.audio = audio; this.options = options;
    // Height smoothing strength: 0 = instant, 1 = default, 2 = twice as gentle.
    // Public so it can also be adjusted live in the browser console.
    this.smoothing = options.smoothing ?? 1;
    this.mode = 'off'; this.ready = false; this.waiting = false;
    this.context = null; this.source = null; this.analyser = null;
    this.timer = null; this.pending = null; this.failed = false; this.lastFrameTime = null;
    this.bins = new Uint8Array(128); this.samples = new Uint8Array(256);
    this.levels = new Float32Array(40);
    this.paint(false);
  }
  setMode(mode) {
    this.mode = ['off','eco','smooth','high'].includes(mode) ? mode : 'off';
    this.sync();
  }
  // Never attach the media element to a suspended context: that would mute it.
  async unlock() {
    if (this.failed || (!this.context && (this.mode === 'off' || this.options.reduced()))) return;
    if (this.pending) return this.pending;
    this.pending = this.prepare();
    try { await this.pending; } finally { this.pending = null; }
  }
  async prepare() {
    try {
      this.context ||= this.options.createContext();
      if (!this.context) throw Error('Web Audio unavailable');
      if (this.context.state !== 'running') await this.context.resume();
      if (this.context.state !== 'running') return;
      if (!this.source && (this.mode === 'off' || this.options.reduced() || this.options.hidden())) return;
      if (!this.source) {
        // Prepare the optional analysis branch before rerouting the audio.
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256; this.analyser.smoothingTimeConstant = .65;
        this.source = this.context.createMediaElementSource(this.audio);
        // The audible path does not depend on the analyser or the render loop.
        this.source.connect(this.context.destination);
        this.context.onstatechange = () => this.sync();
      }
      this.sync();
    } catch {
      this.failed = true; this.stop(); this.options.status('unavailable');
    }
  }
  active() {
    return this.mode !== 'off' && !this.failed && !this.options.hidden() && !this.options.reduced()
      && this.ready && !this.waiting && !this.audio.paused && !this.audio.ended
      && this.context?.state === 'running';
  }
  sync() {
    this.stop();
    if (this.active()) {
      try {
        if (!this.connected) { this.source.connect(this.analyser); this.connected = true; }
        this.options.status('active'); this.tick();
        return;
      } catch { this.failed = true; }
    }
    this.options.status(this.failed ? 'unavailable' : this.mode === 'off' ? 'off'
      : this.options.reduced() ? 'reduced' : !this.source ? 'gesture' : 'idle');
  }
  stop() {
    if (this.timer !== null) this.options.cancel(this.timer);
    this.timer = null;
    if (this.connected) {
      try { this.source.disconnect(this.analyser); } catch {}
      this.connected = false;
    }
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
      this.analyser.getByteFrequencyData(this.bins);
      this.analyser.getByteTimeDomainData(this.samples);
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
    } catch { this.failed = true; this.sync(); }
  }
  paint(active) { this.options.draw(this.levels, active); }
  media(event) {
    if (['emptied','loadstart','ended','error'].includes(event)) { this.ready = false; this.waiting = false; }
    if (event === 'waiting' || event === 'seeking') this.waiting = true;
    if (event === 'playing' || event === 'seeked') { this.ready = true; this.waiting = false; }
    this.sync();
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = {AudioWave};
