/* CD presentation controller. No audio element, queue, analyser, or server API. */
(function(root) {
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const percent = (value,fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.round(clamp(value,0,100)) : fallback;
  const yawLimit = Math.PI * 25 / 180, pitchLimit = Math.PI * 15 / 180;
  class CDMotion {
    constructor() { this.reset(); this.lid = 0; this.spin = 0; this.speed = 0; this.rotationSpeed = 55; this.open = false; }
    rotate(x,y) {
      this.yaw = this.targetYaw = clamp(this.yaw + x,-yawLimit,yawLimit);
      this.pitch = this.targetPitch = clamp(this.pitch + y,-pitchLimit,pitchLimit);
    }
    aim(x,y) { this.targetYaw = clamp(x,-1,1) * yawLimit; this.targetPitch = clamp(y,-1,1) * pitchLimit; }
    rest() { this.targetYaw = 0; this.targetPitch = 0; }
    reset() { this.yaw = this.targetYaw = 0; this.pitch = this.targetPitch = 0; }
    step(seconds, playing, animate) {
      const target = this.open ? -Math.PI * .82 : 0;
      if (!animate) { this.lid = target; this.speed = 0; this.yaw = this.targetYaw; this.pitch = this.targetPitch; return false; }
      seconds = clamp(seconds,0,.1);
      for (const [key,targetKey] of [['yaw','targetYaw'],['pitch','targetPitch']]) {
        this[key] += (this[targetKey] - this[key]) * (1 - Math.exp(-seconds * 4));
        if (Math.abs(this[targetKey] - this[key]) < .001) this[key] = this[targetKey];
      }
      this.lid += (target - this.lid) * (1 - Math.exp(-seconds * 14));
      if (Math.abs(target - this.lid) < .001) this.lid = target;
      this.speed += ((playing ? 1.05 * this.rotationSpeed / 55 : 0) - this.speed) * (1 - Math.exp(-seconds * 5));
      if (this.rotationSpeed === 0 || (!playing && this.speed < .005)) this.speed = 0;
      this.spin = (this.spin - this.speed * seconds) % (Math.PI * 2);
      return this.lid !== target || this.yaw !== this.targetYaw || this.pitch !== this.targetPitch || this.speed > 0 || (playing && this.rotationSpeed > 0);
    }
  }
  class CDPlayerView {
    constructor(options = {}) {
      this.document = options.document || root.document;
      this.window = options.window || root.window;
      this.translate = options.translate || (key => root.tr(key));
      this.loadScene = options.loadScene || (() => import('/cd-scene.mjs'));
      this.createFallback = options.createFallback || (() => root.playerViews.create('album'));
      this.createContext = options.createContext || (canvas => {
        const gl = canvas.getContext?.('webgl2',{alpha:true,antialias:false,powerPreference:'low-power',failIfMajorPerformanceCaveat:this.quality !== '3d'});
        return gl && typeof gl.getParameter === 'function' && typeof gl.createVertexArray === 'function' ? gl : null;
      });
      this.isWeakDevice = options.isWeakDevice || (() => {
        const navigator = root.navigator || {};
        return (navigator.deviceMemory > 0 && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2);
      });
      this.getPalette = options.getPalette || (() => {
        const style = root.getComputedStyle?.(this.root);
        return {surface:style?.getPropertyValue?.('--surface').trim() || '#ffffff',accent:style?.getPropertyValue?.('--green').trim() || '#24754b'};
      });
      this.schedule = options.schedule || ((fn, delay) => setTimeout(fn,delay));
      this.cancel = options.cancel || (id => clearTimeout(id));
      this.now = options.now || (() => performance.now());
      this.ResizeObserver = options.ResizeObserver || root.ResizeObserver;
      try { this.storage = options.storage || root.localStorage; } catch {}
      let saved;
      try { saved = JSON.parse(this.storage?.getItem('expandedPlayerCD')); } catch {}
      this.quality = ['auto','static','3d'].includes(saved?.quality) ? saved.quality : 'auto';
      this.frameRate = saved?.frameRate === 60 ? 60 : 30;
      this.rotationSpeed = percent(saved?.rotationSpeed,55);
      this.motion = new CDMotion(); this.appearance = {motionEnabled:true};
      this.motion.rotationSpeed = this.rotationSpeed;
      this.active = false; this.container = null; this.model = null; this.job = null; this.canvas = null;
      this.snapshot = null; this.fallback = null; this.timer = null; this.lastFrame = null; this.lastRender = -Infinity;
      this.generation = 0; this.reason = ''; this.artworkStatus = ''; this.paletteKey = ''; this.drag = null;
      this.frameCount = 0; this.slowFrames = 0;
      this.trackingPointer = false;
      this.onWindowPointer = event => {
        if (!this.visible() || !this.model || this.container.inert ||
            (event.pointerType && event.pointerType !== 'mouse')) return;
        const host = this.container.closest?.('dialog'), targetHost = event.target?.closest?.('dialog');
        if (host && targetHost && host !== targetHost) return;
        const width = this.window?.innerWidth, height = this.window?.innerHeight;
        if (width > 0 && height > 0) {
          this.motion.aim(event.clientX / width * 2 - 1,event.clientY / height * 2 - 1);
          this.requestRender();
        }
      };
      this.onWindowLeave = event => {
        if (event?.relatedTarget || (event?.pointerType && event.pointerType !== 'mouse')) return;
        if (this.model && this.visible()) { this.motion.rest(); this.requestRender(); }
      };
      this.onVisibility = () => {
        if (this.document.hidden) { this.stop(); this.cancelJob(); this.motion.rest(); this.fallback?.setActive(false); }
        else if (this.active) { this.ensureScene(); this.fallback?.setActive(true); this.syncModel(); this.requestRender(); }
        this.syncPointerTracking();
      };
      this.onResize = () => { if (this.visible() && this.model) { this.resize(); this.requestRender(); } };
    }
    element(tag,className) { const element = this.document.createElement(tag); element.className = className; return element; }
    mount(container) {
      this.container = container; this.root = this.element('div','cd-view');
      this.controls = this.element('div','cd-controls');
      this.lidButton = this.element('button','secondary'); this.lidButton.type = 'button';
      this.left = this.element('button','text-button'); this.left.type = 'button';
      this.right = this.element('button','text-button'); this.right.type = 'button';
      this.reset = this.element('button','text-button'); this.reset.type = 'button';
      const qualityLabel = this.element('label',''); this.qualityText = this.element('span',''); this.select = this.element('select','');
      this.qualityOptions = ['auto','3d','static'].map(value => { const option = this.element('option',''); option.value = value; return option; });
      this.select.append(...this.qualityOptions); qualityLabel.append(this.qualityText,this.select);
      this.controls.append(this.lidButton,this.left,this.right,this.reset,qualityLabel);
      const rateLabel = this.element('label',''); this.rateText = this.element('span','');
      this.rateSelect = this.element('select','');
      this.rateOptions = [30,60].map(value => { const option = this.element('option',''); option.value = String(value); return option; });
      this.rateSelect.append(...this.rateOptions); rateLabel.append(this.rateText,this.rateSelect); this.controls.append(rateLabel);
      const rotationLabel = this.element('label',''), rotationHeading = this.element('span','');
      this.rotationText = this.element('span',''); this.rotationValue = this.element('output','');
      this.rotationInput = this.element('input',''); this.rotationInput.type = 'range';
      this.rotationInput.id = 'cdRotationSpeed'; this.rotationInput.min = '0'; this.rotationInput.max = '100'; this.rotationInput.step = '1';
      this.rotationValue.setAttribute('for','cdRotationSpeed');
      rotationHeading.append(this.rotationText,this.rotationValue); rotationLabel.append(rotationHeading,this.rotationInput); this.controls.append(rotationLabel);
      this.viewport = this.element('div','cd-viewport');
      this.status = this.element('p','cd-status'); this.status.setAttribute('role','status');
      this.artworkLabel = this.element('p','cd-artwork-status');
      this.retry = this.element('button','secondary'); this.retry.type = 'button'; this.retry.hidden = true;
      this.root.append(this.controls,this.viewport,this.status,this.artworkLabel,this.retry);
      container.replaceChildren(this.root); container.classList.add('cd-stage');
      this.lidButton.onclick = () => this.toggleLid();
      this.left.onclick = () => { this.motion.rotate(-.18,0); this.requestRender(); };
      this.right.onclick = () => { this.motion.rotate(.18,0); this.requestRender(); };
      this.reset.onclick = () => { this.motion.reset(); this.requestRender(); };
      this.select.onchange = event => this.setQuality(event.target.value);
      this.rateSelect.onchange = event => this.setFrameRate(Number(event.target.value));
      this.rotationInput.oninput = event => this.setRotationSpeed(Number(event.target.value));
      this.retry.onclick = () => this.setQuality('3d');
      this.document.addEventListener?.('visibilitychange',this.onVisibility);
      this.window?.addEventListener?.('resize',this.onResize);
      if (this.ResizeObserver) {
        this.resizeObserver = new this.ResizeObserver(this.onResize);
        this.resizeObserver.observe(this.viewport);
      }
      this.refreshLabels(true);
    }
    mountSettings(container) {
      container.append(this.controls); return true;
    }
    focusSettings() { (this.lidButton.disabled ? this.select : this.lidButton).focus(); return true; }
    visible() { return !!(this.container && this.active && !this.document.hidden); }
    syncPointerTracking() {
      const enabled = this.visible() && !!this.model;
      if (enabled === this.trackingPointer) return;
      this.trackingPointer = enabled;
      const method = enabled ? 'addEventListener' : 'removeEventListener';
      this.document[method]?.('pointermove',this.onWindowPointer);
      this.document[method]?.('pointerout',this.onWindowLeave);
      this.window?.[method]?.('blur',this.onWindowLeave);
    }
    setQuality(value) {
      this.quality = ['auto','3d','static'].includes(value) ? value : 'auto';
      this.savePreferences();
      this.clearGraphics(); this.clearFallback(); this.reason = ''; this.paletteKey = '';
      this.refreshLabels(true); this.ensureScene();
    }
    savePreferences() {
      try { this.storage?.setItem('expandedPlayerCD',JSON.stringify({quality:this.quality,frameRate:this.frameRate,rotationSpeed:this.rotationSpeed})); } catch {}
    }
    setFrameRate(value) {
      this.frameRate = value === 60 ? 60 : 30;
      this.savePreferences(); this.refreshLabels(true);
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null; this.requestRender();
    }
    setRotationSpeed(value) {
      this.rotationSpeed = percent(value,55); this.motion.rotationSpeed = this.rotationSpeed;
      if (this.rotationSpeed === 0) this.motion.speed = 0;
      this.savePreferences(); this.refreshLabels(true); this.requestRender();
    }
    release(job) {
      if (!job || job.released || job.owned) return;
      job.released = true;
      try { job.gl.getExtension?.('WEBGL_lose_context')?.loseContext(); } catch {}
    }
    cancelJob() {
      if (!this.job) return;
      this.generation++; this.release(this.job); this.job = null;
      this.detachCanvas();
    }
    detachCanvas() {
      if (!this.canvas) return;
      this.canvas.onpointerdown = this.canvas.onpointermove = this.canvas.onpointerup = this.canvas.onpointercancel =
        this.canvas.onpointerleave = this.canvas.onlostpointercapture = this.canvas.onkeydown = null;
      this.canvas.removeEventListener?.('webglcontextlost',this.onContextLost);
      this.canvas.remove(); this.canvas = null; this.drag = null;
    }
    stop() {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null; this.lastFrame = null; this.motion.speed = 0;
      if (this.drag && this.canvas) { try { this.canvas.releasePointerCapture?.(this.drag.id); } catch {} }
      this.drag = null;
    }
    clearGraphics() {
      this.stop(); this.cancelJob(); this.generation++;
      this.detachCanvas();
      try { this.model?.dispose(); } catch (error) { console.error('CD scene cleanup failed',error); }
      this.model = null;
      this.syncPointerTracking();
    }
    clearFallback() { this.fallback?.dispose(); this.fallback = null; }
    showFallback(reason) {
      if (!this.container) return;
      this.clearGraphics(); this.reason = reason; this.artworkStatus = '';
      if (!this.fallback) {
        try { this.fallback = this.createFallback(); this.fallback.mount(this.viewport); }
        catch { this.fallback = null; this.viewport.textContent = this.translate('This view is unavailable. Playback will continue.'); }
      }
      this.fallback?.setAppearance?.({...this.appearance,motionEnabled:false});
      this.fallback?.setActive(this.visible());
      if (this.snapshot) this.fallback?.update(this.snapshot);
      this.refreshLabels();
    }
    ensureScene() {
      if (!this.visible() || this.model || this.job || this.fallback) return;
      if (this.quality === 'static') { this.showFallback('Static artwork is enabled.'); return; }
      if (this.quality === 'auto' && this.isWeakDevice()) { this.showFallback('Static artwork is used on this device to save resources.'); return; }
      this.canvas = this.element('canvas','cd-canvas'); this.canvas.tabIndex = 0;
      this.canvas.width = 800; this.canvas.height = 360;
      this.viewport.replaceChildren(this.canvas); this.bindCanvas();
      let gl;
      try { gl = this.createContext(this.canvas); } catch {}
      if (!gl) { this.showFallback('3D is unavailable. Showing static artwork.'); return; }
      const job = {token:++this.generation,canvas:this.canvas,gl,released:false,owned:false}; this.job = job;
      this.reason = 'Loading 3D scene…'; this.refreshLabels();
      Promise.resolve().then(() => this.job === job && this.visible() ? this.loadScene() : null).then(module => {
        if (this.job !== job || job.token !== this.generation || !this.visible()) { this.release(job); return; }
        if (typeof module.createCDScene !== 'function') throw Error('Invalid CD renderer module');
        job.owned = true;
        this.model = module.createCDScene(job.canvas,job.gl,{
          palette:this.getPalette(),pixelRatio:Math.min(1.25,root.devicePixelRatio || 1),
          onInvalidate:() => { if (this.visible() && job.token === this.generation) this.requestRender(); },
          onArtwork:status => { if (this.container && job.token === this.generation) { this.artworkStatus = status; this.refreshLabels(); } }
        });
        this.job = null; this.reason = ''; this.frameCount = this.slowFrames = 0;
        this.resize(); this.refreshLabels(); this.syncModel(); this.syncPointerTracking(); this.requestRender();
      }).catch(error => {
        if (this.job === job || job.token === this.generation) {
          console.warn('CD scene unavailable',error); this.showFallback('3D is unavailable. Showing static artwork.');
        } else this.release(job);
      });
    }
    toggleLid() {
      if (!this.model || !this.visible()) return;
      this.motion.open = !this.motion.open; this.refreshLabels(); this.requestRender();
    }
    bindCanvas() {
      this.onContextLost = event => { event.preventDefault(); this.showFallback('WebGL context was lost. Showing static artwork.'); };
      this.canvas.addEventListener('webglcontextlost',this.onContextLost);
      this.canvas.onpointerdown = event => {
        if (!this.model || !this.visible() || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault(); this.canvas.focus();
        this.drag = {id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};
        try { this.canvas.setPointerCapture?.(event.pointerId); } catch {}
      };
      this.canvas.onpointermove = event => {
        if (!this.model || !this.visible() || (this.drag && this.drag.id !== event.pointerId)) return;
        if (!this.drag && event.pointerType === 'touch') return;
        if (this.drag) {
          this.drag.moved ||= Math.hypot(event.clientX - this.drag.startX,event.clientY - this.drag.startY) > 6;
          if (event.pointerType !== 'mouse') this.motion.rotate((event.clientX - this.drag.x) * .008,(event.clientY - this.drag.y) * .006);
          this.drag.x = event.clientX; this.drag.y = event.clientY;
        }
        this.requestRender();
      };
      const release = (event,activate) => {
        if (this.drag?.id !== event.pointerId) return;
        const drag = this.drag; this.drag = null;
        try { this.canvas.releasePointerCapture?.(event.pointerId); } catch {}
        const distance = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? Math.hypot(event.clientX - drag.startX,event.clientY - drag.startY) : 0;
        if (activate && !drag.moved && distance <= 6) this.toggleLid();
      };
      this.canvas.onpointerup = event => release(event,true);
      this.canvas.onpointercancel = this.canvas.onlostpointercapture = event => release(event,false);
      this.canvas.onkeydown = event => {
        const actions = {ArrowLeft:() => this.motion.rotate(-.15,0),ArrowRight:() => this.motion.rotate(.15,0),
          ArrowUp:() => this.motion.rotate(0,-.12),ArrowDown:() => this.motion.rotate(0,.12),Home:() => this.motion.reset(),
          Enter:() => this.toggleLid(),' ':() => this.toggleLid()};
        if (!actions[event.key] || !this.model || !this.visible()) return;
        event.preventDefault(); actions[event.key](); this.requestRender();
      };
    }
    refreshLabels(syncControls = false) {
      if (!this.container) return;
      const text = (element,key) => { const value = this.translate(key); if (element.textContent !== value) element.textContent = value; };
      text(this.lidButton,this.motion.open ? 'Close CD case' : 'Open CD case'); this.lidButton.setAttribute('aria-pressed',String(this.motion.open));
      text(this.left,'Rotate left'); text(this.right,'Rotate right'); text(this.reset,'Reset view'); text(this.qualityText,'CD view quality');
      ['Automatic','3D scene','Static artwork'].forEach((key,index) => text(this.qualityOptions[index],key));
      text(this.rateText,'CD frame rate');
      text(this.rotationText,'Disc rotation speed');
      this.rotationValue.textContent = ' ' + this.rotationSpeed + '%';
      ['30 fps','60 fps'].forEach((key,index) => text(this.rateOptions[index],key));
      if (syncControls) { this.select.value = this.quality; this.rateSelect.value = String(this.frameRate); this.rotationInput.value = String(this.rotationSpeed); }
      this.rotationInput.setAttribute('aria-valuetext',this.rotationSpeed + '%');
      this.rotationInput.disabled = !this.model;
      this.rateSelect.disabled = !this.model;
      this.canvas?.setAttribute('role','button'); this.canvas?.setAttribute('aria-pressed',String(this.motion.open));
      this.canvas?.setAttribute('aria-label',this.translate('Interactive CD case. Move the pointer to tilt. Click or press Enter to open or close.'));
      for (const button of [this.lidButton,this.left,this.right,this.reset]) button.disabled = !this.model;
      text(this.status,this.reason || 'Move the pointer to tilt. Click or tap to open or close. Drag on touch screens; arrow keys also rotate.');
      const key = {empty:'No album artwork',loading:'Loading artwork…',failed:'Artwork unavailable'}[this.artworkStatus];
      this.artworkLabel.textContent = key ? this.translate(key) : '';
      text(this.retry,'Try 3D'); this.retry.hidden = !this.fallback || this.quality === 'static';
    }
    syncModel() {
      if (!this.visible() || !this.model) return;
      const palette = this.getPalette(), key = JSON.stringify(palette);
      if (key !== this.paletteKey) { this.paletteKey = key; this.model.setPalette(palette); this.requestRender(); }
      this.model.setArtwork(this.snapshot?.track?.artwork || '');
    }
    update(snapshot) {
      const wasPlaying = this.snapshot?.playing && this.snapshot?.state === 'playing';
      this.snapshot = snapshot; this.refreshLabels();
      this.fallback?.update(snapshot);
      this.ensureScene();
      try { this.syncModel(); } catch { this.showFallback('3D is unavailable. Showing static artwork.'); }
      if (wasPlaying !== (snapshot.playing && snapshot.state === 'playing')) this.requestRender();
    }
    resize() {
      const width = this.canvas.clientWidth || 800, height = this.canvas.clientHeight || 360;
      this.model.resize(width,height);
    }
    requestRender() {
      if (!this.visible() || !this.model || this.timer !== null) return;
      this.timer = this.schedule(() => this.frame(),Math.max(0,1000 / this.frameRate - (this.now() - this.lastRender)));
    }
    frame() {
      this.timer = null; if (!this.visible() || !this.model) return;
      const started = this.now(), elapsed = this.lastFrame === null ? 1 / this.frameRate : (started - this.lastFrame) / 1000;
      this.lastFrame = started;
      const moving = this.motion.step(elapsed,!!this.snapshot?.playing && this.snapshot.state === 'playing',this.appearance.motionEnabled);
      try {
        this.model.render(this.motion);
        const finished = this.now(); this.lastRender = started;
        if (this.quality === 'auto' && ++this.frameCount > 3) this.slowFrames = finished - started > 80 ? this.slowFrames + 1 : 0;
        if (this.slowFrames >= 8) { this.showFallback('Static artwork is used on this device to save resources.'); return; }
        if (moving) this.requestRender();
      } catch { this.showFallback('3D is unavailable. Showing static artwork.'); }
    }
    setAppearance(value) {
      const changed = this.appearance.motionEnabled !== value.motionEnabled;
      this.appearance = value; this.fallback?.setAppearance?.({...value,motionEnabled:false});
      if (!value.motionEnabled) this.motion.speed = 0;
      if (changed) this.requestRender();
    }
    setActive(active) {
      this.active = active;
      if (!active) { this.stop(); this.cancelJob(); this.fallback?.setActive(false); }
      else { this.ensureScene(); this.fallback?.setActive(this.visible()); this.syncModel(); this.requestRender(); }
      this.syncPointerTracking();
    }
    dispose() {
      this.resizeObserver?.disconnect();
      this.active = false; this.clearGraphics(); this.clearFallback();
      this.document.removeEventListener?.('visibilitychange',this.onVisibility); this.window?.removeEventListener?.('resize',this.onResize);
      for (const button of [this.lidButton,this.left,this.right,this.reset,this.retry]) button.onclick = null;
      this.select.onchange = null;
      this.rateSelect.onchange = null;
      this.rotationInput.oninput = null;
      this.controls.remove?.();
      this.container?.classList.remove('cd-stage'); this.container?.replaceChildren();
      this.container = null; this.snapshot = null; this.root = null; this.viewport = null;
    }
  }
  root.CDPlayerView = CDPlayerView;
  if (typeof module !== 'undefined' && module.exports) module.exports = {CDPlayerView,CDMotion};
  else root.playerViews.register('cd',context => new CDPlayerView({createFallback:context.artworkFactory}));
})(globalThis);
