/* Canvas presets consume shared analysis data, never an audio element or queue. */
(function(root) {
  const library = typeof module !== 'undefined' && module.exports ? require('./visualization-presets.js') : root.MusicVisualizationPresets;
  const presets = [{id:'spectrum',label:'Spectrum',description:'Audio-reactive spectrum'},
    {id:'waveform',label:'Waveform',description:'Audio waveform'},...(library?.presets || [])];
  function normalizeEffects(value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      preset:presets.some(preset => preset.id === value.preset) ? value.preset : 'spectrum',
      intensity:typeof value.intensity === 'number' && Number.isFinite(value.intensity) ? Math.round(Math.max(0,Math.min(100,value.intensity))) : 60,
      enabled:typeof value.enabled === 'boolean' ? value.enabled : true
    };
  }
  class EffectsPlayerView {
    constructor(options = {}) {
      this.document = options.document || root.document;
      this.translate = options.translate || (key => root.tr(key));
      this.analysis = options.analysis;
      this.schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay));
      this.cancel = options.cancel || (id => clearTimeout(id));
      this.now = options.now || (() => performance.now());
      this.getColor = options.getColor || (() => root.getComputedStyle?.(this.canvas).color || '#24754b');
      try { this.storage = options.storage || root.localStorage; } catch {}
      let saved;
      try { saved = JSON.parse(this.storage?.getItem('expandedPlayerEffects')); } catch {}
      this.value = normalizeEffects(saved);
      this.renderer = library?.create(this.value.preset,{document:this.document});
      this.elapsed = 0;
      this.transition = null;
      this.appearance = {motionEnabled:true,reducedMotion:false};
      this.active = false; this.failed = false; this.snapshot = null; this.timer = null;
      this.syncing = false; this.drawing = false; this.unlockAttempted = false; this.lastFrame = null;
      this.frequencies = new Uint8Array(128); this.samples = new Uint8Array(256); this.levels = new Float32Array(40);
      this.onVisibility = () => this.sync();
      this.ResizeObserver = options.ResizeObserver || root.ResizeObserver;
      this.pixelRatio = Math.min(1.5,options.pixelRatio || root.devicePixelRatio || 1);
      this.onResize = () => this.resize();
    }
    element(tag, className) {
      const element = this.document.createElement(tag); element.className = className; return element;
    }
    mount(container) {
      this.container = container;
      this.root = this.element('div','effects-view');
      this.controls = this.element('div','effects-controls');
      const presetLabel = this.element('label',''), intensityLabel = this.element('label','');
      this.presetText = this.element('span',''); this.presetSelect = this.element('select','');
      this.presetOptions = presets.map(preset => {
        const option = this.element('option',''); option.value = preset.id; return option;
      });
      this.presetSelect.append(...this.presetOptions);
      presetLabel.append(this.presetText,this.presetSelect);
      this.intensityText = this.element('span',''); this.intensity = this.element('input','');
      this.intensity.type = 'range'; this.intensity.min = '0'; this.intensity.max = '100'; this.intensity.step = '1';
      intensityLabel.append(this.intensityText,this.intensity);
      const enableLabel = this.element('label','effects-enable');
      this.enable = this.element('input',''); this.enable.type = 'checkbox'; this.enableText = this.element('span','');
      enableLabel.append(this.enable,this.enableText);
      this.controls.append(presetLabel,intensityLabel,enableLabel);
      this.canvas = this.element('canvas','effects-canvas'); this.canvas.width = 960; this.canvas.height = 360;
      this.canvas.setAttribute('aria-hidden','true');
      try { this.context = this.canvas.getContext?.('2d'); } catch {}
      this.label = this.element('p','effects-status'); this.label.setAttribute('role','status');
      this.start = this.element('button','secondary'); this.start.type = 'button';
      this.root.append(this.controls,this.canvas,this.label,this.start); container.replaceChildren(this.root);
      container.classList.add('effects-stage');
      this.consumer = this.analysis?.createConsumer();
      this.unsubscribe = this.consumer?.subscribe(() => this.sync());
      this.presetSelect.onchange = event => this.set({preset:event.target.value});
      this.intensity.oninput = event => this.set({intensity:Number(event.target.value)});
      this.enable.onchange = event => this.set({enabled:event.target.checked});
      this.start.onclick = () => { this.unlockAttempted = false; this.sync(); };
      this.document.addEventListener?.('visibilitychange',this.onVisibility);
      if (this.ResizeObserver) {
        this.resizeObserver = new this.ResizeObserver(this.onResize);
        this.resizeObserver.observe(this.canvas);
      }
      this.resize();
      this.refreshLabels(true);
    }
    mountSettings(container) {
      container.append(this.controls); return true;
    }
    resize() {
      if (!this.canvas) return;
      const width = this.canvas.clientWidth || 960, height = this.canvas.clientHeight || 360;
      const ratio = Math.min(this.pixelRatio,1920 / width,1080 / height);
      const nextWidth = Math.max(1,Math.round(width * ratio)), nextHeight = Math.max(1,Math.round(height * ratio));
      if (nextWidth === this.canvas.width && nextHeight === this.canvas.height) return;
      this.clearTransition(); this.canvas.width = nextWidth; this.canvas.height = nextHeight;
      if (this.context && !this.failed) {
        try { this.draw(this.animating()); } catch { this.failed = true; this.consumer?.setActive(false); }
      }
    }
    focusSettings() { this.presetSelect.focus(); return true; }
    set(patch) {
      const previous = this.value.preset;
      const next = normalizeEffects({...this.value,...patch});
      if (previous !== next.preset) this.captureTransition();
      this.value = next;
      if (previous !== this.value.preset) this.renderer = library?.create(this.value.preset,{document:this.document});
      this.renderer?.reset();
      try { this.storage?.setItem('expandedPlayerEffects',JSON.stringify(this.value)); } catch {}
      this.unlockAttempted = false;
      this.refreshLabels(true); this.sync();
    }
    refreshLabels(syncControls = false) {
      const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
      text(this.presetText,this.translate('Visualization preset'));
      this.presetOptions.forEach((option,index) => text(option,this.translate(presets[index].label)));
      text(this.intensityText,this.translate('Effect intensity') + ' · ' + this.value.intensity + '%');
      text(this.enableText,this.translate('Enable visualization'));
      text(this.start,this.translate('Start visualization'));
      if (syncControls) {
        this.presetSelect.value = this.value.preset; this.intensity.value = this.value.intensity;
        this.intensity.setAttribute('aria-valuetext',this.value.intensity + '%');
        this.enable.checked = this.value.enabled; this.intensity.disabled = !this.value.enabled;
      }
      this.color = this.getColor();
    }
    update(snapshot) { this.snapshot = snapshot; this.refreshLabels(); this.sync(); }
    wanted() {
      return !!(this.container && this.active && this.context && this.consumer && !this.failed &&
        !this.document.hidden && this.value.enabled && this.value.intensity > 0 && this.appearance.motionEnabled && this.snapshot?.track);
    }
    animating() {
      return this.wanted() && this.snapshot.playing && this.snapshot.state === 'playing' && this.consumer.status === 'active';
    }
    setStatus(key) {
      const text = this.translate(key);
      if (this.label.textContent !== text) this.label.textContent = text;
    }
    sync() {
      if (!this.container || this.syncing) return;
      this.syncing = true;
      try {
        const wanted = this.wanted(); this.consumer?.setActive(wanted);
        this.start.hidden = !wanted || this.consumer.status !== 'gesture';
        if (this.animating()) {
          this.setStatus(presets.find(preset => preset.id === this.value.preset).description);
          if (this.timer === null && !this.drawing) this.tick();
          return;
        }
        this.stopRendering();
        const key = !this.context || !this.consumer || this.failed || this.consumer.status === 'unavailable' ? 'Visualization is unavailable in this browser' :
          !this.value.enabled ? 'Visualization is off' : !this.appearance.motionEnabled ?
            (this.appearance.reducedMotion ? 'Animation disabled by system preferences' : 'Player animations are disabled') :
          this.value.intensity === 0 ? 'Visualization intensity is zero' : !this.snapshot?.track ? 'Choose music' :
          this.consumer.status === 'gesture' ? 'Press Start visualization to enable audio analysis.' : 'Waiting for playback';
        this.setStatus(key);
        if (wanted && this.consumer.status === 'gesture' && !this.unlockAttempted) {
          this.unlockAttempted = true;
          void this.consumer.unlock().catch(() => {}).finally(() => { if (this.container) this.sync(); });
        }
      } finally { this.syncing = false; }
    }
    stopRendering() {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null; this.lastFrame = null; this.elapsed = 0; this.levels.fill(0); this.renderer?.reset();
      this.clearTransition();
      if (this.context && !this.failed) {
        try { this.draw(false); } catch { this.failed = true; this.consumer?.setActive(false); }
      }
    }
    tick() {
      this.timer = null;
      if (!this.animating()) { this.sync(); return; }
      this.drawing = true;
      try {
        if (!this.consumer.read(this.frequencies,this.samples)) {
          this.stopRendering(); this.setStatus('Visualization is unavailable in this browser'); return;
        }
        const now = this.now(), elapsed = this.lastFrame === null ? 1000 / 30 : Math.max(0,Math.min(250,now - this.lastFrame));
        this.lastFrame = now;
        this.elapsed = elapsed;
        let power = 0;
        for (const value of this.samples) power += ((value - 128) / 128) ** 2;
        const amplitude = Math.min(1,Math.sqrt(power / this.samples.length) * 3);
        const gain = this.value.intensity / 60;
        for (let i = 0; i < this.levels.length; i++) {
          const start = Math.floor((i / this.levels.length) ** 2 * (this.frequencies.length - 1));
          const end = Math.max(start + 1,Math.floor(((i + 1) / this.levels.length) ** 2 * this.frequencies.length));
          let peak = 0;
          for (let j = start; j < end; j++) peak = Math.max(peak,this.frequencies[j]);
          const target = Math.min(1,peak / 255 * amplitude * gain);
          this.levels[i] += (target - this.levels[i]) * (1 - Math.exp(-elapsed / (target > this.levels[i] ? 80 : 200)));
        }
        this.draw(true);
        if (this.animating()) this.timer = this.schedule(() => this.tick(),1000 / 30);
      } catch {
        this.failed = true; this.consumer.setActive(false); this.stopRendering();
        this.setStatus('Visualization is unavailable in this browser');
      }
      finally { this.drawing = false; }
    }
    clearTransition() {
      if (this.transition) this.transition.canvas.width = this.transition.canvas.height = 0;
      this.transition = null;
    }
    captureTransition() {
      if (!this.animating() || typeof this.context.drawImage !== 'function') { this.clearTransition(); return; }
      try {
        const canvas = this.transition?.canvas || this.element('canvas','');
        canvas.width = this.canvas.width; canvas.height = this.canvas.height;
        const context = canvas.getContext('2d');
        context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
        context.drawImage(this.canvas,0,0);
        this.transition = {canvas,started:this.now()};
      } catch { this.clearTransition(); }
    }
    draw(active) {
      this.drawPreset(active);
      if (!active || !this.transition) return;
      const progress = Math.max(0,Math.min(1,(this.now() - this.transition.started) / 300));
      if (progress >= 1) { this.clearTransition(); return; }
      const blend = progress * progress * (3 - 2 * progress);
      // Weighted premultiplied addition also crossfades transparent presets.
      try {
        this.context.globalCompositeOperation = 'destination-in'; this.context.globalAlpha = blend;
        this.context.fillStyle = '#000000'; this.context.fillRect(0,0,this.canvas.width,this.canvas.height);
        this.context.globalCompositeOperation = 'lighter'; this.context.globalAlpha = 1 - blend;
        this.context.drawImage(this.transition.canvas,0,0);
      } finally { this.context.globalAlpha = 1; this.context.globalCompositeOperation = 'source-over'; }
    }
    drawPreset(active) {
      const context = this.context, width = this.canvas.width, height = this.canvas.height;
      context.clearRect(0,0,width,height); context.fillStyle = this.color; context.strokeStyle = this.color;
      if (this.renderer) {
        this.renderer.draw(context,{width,height,active,levels:this.levels,samples:this.samples,
          intensity:this.value.intensity,elapsed:this.elapsed,color:this.color});
        return;
      }
      context.globalAlpha = active ? .85 : .25;
      if (this.value.preset === 'spectrum') {
        const step = width / this.levels.length;
        for (let i = 0; i < this.levels.length; i++) {
          const size = active ? Math.max(3,this.levels[i] * (height - 20)) : 3;
          context.fillRect(i * step + step * .2,height - size - 10,step * .6,size);
        }
      } else {
        context.lineWidth = 3; context.beginPath();
        for (let i = 0; i < this.samples.length; i++) {
          const x = i / (this.samples.length - 1) * width;
          const displacement = (this.samples[i] - 128) / 128 * height * .4 * this.value.intensity / 60;
          const y = height / 2 + (active ? Math.max(-height * .45,Math.min(height * .45,displacement)) : 0);
          i ? context.lineTo(x,y) : context.moveTo(x,y);
        }
        context.stroke();
      }
    }
    setActive(active) { if (active !== this.active) this.unlockAttempted = false; this.active = active; if (active) this.resize(); this.sync(); }
    setAppearance(value) { this.appearance = value; this.sync(); }
    dispose() {
      this.active = false; this.stopRendering(); this.unsubscribe?.(); this.consumer?.dispose();
      this.resizeObserver?.disconnect();
      this.document.removeEventListener?.('visibilitychange',this.onVisibility);
      this.presetSelect.onchange = null; this.intensity.oninput = null; this.enable.onchange = null; this.start.onclick = null;
      this.controls.remove?.();
      this.container?.classList.remove('effects-stage'); this.container?.replaceChildren(); this.container = null; this.consumer = null; this.snapshot = null;
      this.root = null; this.context = null; this.canvas = null;
    }
  }
  root.EffectsPlayerView = EffectsPlayerView;
  if (typeof module !== 'undefined' && module.exports) module.exports = {EffectsPlayerView,normalizeEffects};
  else root.playerViews.register('effects',context => new EffectsPlayerView({analysis:context.analysis}));
})(globalThis);
