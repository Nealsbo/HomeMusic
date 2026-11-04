/* Local presentation preferences; no playback or server dependencies. */
(function(root) {
  const themes = typeof module !== 'undefined' && module.exports ? require('./themes.js') : root.MusicThemes;
  const backgrounds = Object.freeze(['none','ambient','aurora','gradient','stars','grid','northern-lights']);
  const legacyBackgrounds = Object.freeze({waves:'gradient',texture:'ambient'});
  const defaults = Object.freeze({background:'ambient',intensity:40,backgroundSpeed:20,animation:true,animateWhenPaused:false,palette:'theme',primary:'#62eab7',secondary:'#ac81ff'});
  function normalize(value) {
    value = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      background:backgrounds.includes(value.background) ? value.background :
        Object.hasOwn(legacyBackgrounds,value.background) ? legacyBackgrounds[value.background] : defaults.background,
      intensity:typeof value.intensity === 'number' && Number.isFinite(value.intensity) ?
        Math.round(Math.max(0,Math.min(100,value.intensity))) : defaults.intensity,
      backgroundSpeed:typeof value.backgroundSpeed === 'number' && Number.isFinite(value.backgroundSpeed) ?
        Math.round(Math.max(0,Math.min(100,value.backgroundSpeed))) : defaults.backgroundSpeed,
      animation:typeof value.animation === 'boolean' ? value.animation : defaults.animation,
      animateWhenPaused:typeof value.animateWhenPaused === 'boolean' ? value.animateWhenPaused : defaults.animateWhenPaused,
      palette:['theme','custom'].includes(value.palette) || themes.findPalette(value.palette) ? value.palette : defaults.palette,
      primary:typeof value.primary === 'string' && /^#[a-f\d]{6}$/i.test(value.primary) ? value.primary.toLowerCase() : defaults.primary,
      secondary:typeof value.secondary === 'string' && /^#[a-f\d]{6}$/i.test(value.secondary) ? value.secondary.toLowerCase() : defaults.secondary
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
  if (typeof module !== 'undefined' && module.exports) module.exports = {PlayerAppearance,normalize,backgrounds};
  else root.playerAppearance = new PlayerAppearance();
})(globalThis);
