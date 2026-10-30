/* Local presentation preferences; no playback or server dependencies. */
(function(root) {
  const defaults = Object.freeze({background:'ambient',intensity:40,animation:true});
  function normalize(value) {
    value = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      background:['none','ambient','waves','texture'].includes(value.background) ? value.background : defaults.background,
      intensity:typeof value.intensity === 'number' && Number.isFinite(value.intensity) ?
        Math.round(Math.max(0,Math.min(100,value.intensity))) : defaults.intensity,
      animation:typeof value.animation === 'boolean' ? value.animation : defaults.animation
    });
  }
  class PlayerAppearance {
    constructor(options = {}) {
      try { this.storage = options.storage || root.localStorage; } catch {}
      let saved;
      try { saved = JSON.parse(this.storage?.getItem('expandedPlayerAppearance')); } catch {}
      this.value = normalize(saved);
      this.motion = options.motion || root.window?.matchMedia?.('(prefers-reduced-motion: reduce)') || {matches:false};
      this.listeners = new Set();
      this.onMotionChange = () => this.publish();
      this.motion.addEventListener?.('change',this.onMotionChange);
    }
    get() {
      return Object.freeze({...this.value,reducedMotion:!!this.motion.matches,
        motionEnabled:this.value.animation && !this.motion.matches});
    }
    set(patch) {
      const next = normalize({...this.value,...patch});
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      this.value = next;
      try { this.storage?.setItem('expandedPlayerAppearance',JSON.stringify(next)); } catch {}
      this.publish();
    }
    publish() {
      const value = this.get();
      for (const listener of this.listeners) {
        try { listener(value); } catch (error) { console.error('Player appearance update failed',error); }
      }
    }
    subscribe(listener) {
      this.listeners.add(listener);
      try { listener(this.get()); } catch (error) { this.listeners.delete(listener); throw error; }
      return () => this.listeners.delete(listener);
    }
    dispose() { this.motion.removeEventListener?.('change',this.onMotionChange); this.listeners.clear(); }
  }
  root.PlayerAppearance = PlayerAppearance;
  if (typeof module !== 'undefined' && module.exports) module.exports = {PlayerAppearance,normalize};
  else root.playerAppearance = new PlayerAppearance();
})(globalThis);
