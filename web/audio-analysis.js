/* Owns the single optional Web Audio graph. Views only receive consumer leases. */
(function(root) {
  class AudioAnalysis {
    constructor(audio, options) {
      this.audio = audio; this.options = options;
      this.context = null; this.source = null; this.analyser = null;
      this.pending = null; this.failed = false; this.connected = false;
      this.audibleConnected = false;
      this.ready = false; this.waiting = false;
      this.consumers = new Set(); this.listeners = new Set(); this.lastStatus = null;
    }
    get status() {
      if (this.failed) return 'unavailable';
      if (!this.consumers.size) return 'idle';
      if (!this.source || this.context?.state !== 'running') return 'gesture';
      return this.ready && !this.waiting && !this.audio.paused && !this.audio.ended ? 'active' : 'idle';
    }
    createConsumer() {
      const owner = this, key = {};
      let disposed = false;
      const subscriptions = new Set();
      return Object.freeze({
        setActive(active) {
          if (disposed || owner.consumers.has(key) === active) return;
          active ? owner.consumers.add(key) : owner.consumers.delete(key);
          owner.sync();
        },
        unlock:() => disposed ? Promise.resolve() : owner.unlock(),
        get status() { return !disposed && owner.consumers.has(key) ? owner.status : 'idle'; },
        read(frequencies, samples) {
          if (disposed || !owner.consumers.has(key) || owner.status !== 'active') return false;
          try {
            owner.analyser.getByteFrequencyData(frequencies);
            owner.analyser.getByteTimeDomainData(samples);
            return true;
          } catch { owner.failed = true; owner.sync(); return false; }
        },
        subscribe(listener) {
          if (disposed) return () => {};
          subscriptions.add(listener); owner.listeners.add(listener);
          return () => { subscriptions.delete(listener); owner.listeners.delete(listener); };
        },
        dispose() {
          if (disposed) return;
          disposed = true; owner.consumers.delete(key);
          for (const listener of subscriptions) owner.listeners.delete(listener);
          subscriptions.clear(); owner.sync();
        }
      });
    }
    async unlock() {
      if (!this.source && (!this.consumers.size || (this.failed && !this.context))) return;
      if (this.pending) return this.pending;
      if (this.failed && this.context && !this.source) this.failed = false;
      this.pending = this.prepare();
      try { await this.pending; } finally { this.pending = null; }
    }
    async prepare() {
      try {
        this.context ||= this.options.createContext();
        if (!this.context) throw Error('Web Audio unavailable');
        if (this.context.state !== 'running') await this.context.resume();
        if (this.context.state !== 'running') return;
        if (!this.source && !this.consumers.size) return;
        if (!this.source) {
          // Prepare optional analysis before routing the media element.
          this.analyser = this.context.createAnalyser();
          this.analyser.fftSize = 256; this.analyser.smoothingTimeConstant = .65;
          this.source = this.context.createMediaElementSource(this.audio);
          this.context.onstatechange = () => this.sync();
        }
        if (!this.audibleConnected) { this.source.connect(this.context.destination); this.audibleConnected = true; }
      } catch (error) { this.failed = error.name !== 'NotAllowedError'; }
      this.sync();
    }
    sync() {
      const wanted = this.status === 'active';
      if (wanted && !this.connected) {
        try { this.source.connect(this.analyser); this.connected = true; }
        catch { this.failed = true; }
      }
      if ((!wanted || this.failed) && this.connected) {
        // Never disconnect the source from the audible destination.
        try { this.source.disconnect(this.analyser); } catch {}
        this.connected = false;
      }
      const status = this.status;
      if (status === this.lastStatus) return;
      this.lastStatus = status;
      for (const listener of this.listeners) {
        try { listener(); } catch (error) { console.error('Audio analysis consumer failed',error); }
      }
    }
    media(event) {
      if (['emptied','loadstart','ended','error'].includes(event)) { this.ready = false; this.waiting = false; }
      if (event === 'waiting' || event === 'seeking') this.waiting = true;
      if (event === 'playing' || event === 'seeked') { this.ready = true; this.waiting = false; }
      this.sync();
    }
  }
  root.AudioAnalysis = AudioAnalysis;
  if (typeof module !== 'undefined' && module.exports) module.exports = {AudioAnalysis};
})(globalThis);
