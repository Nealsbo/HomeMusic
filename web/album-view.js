/* Artwork presentation. Uses only playback snapshots and existing cover URLs. */
(function(root) {
  class AlbumPlayerView {
    constructor(options = {}) {
      this.document = options.document || root.document;
      this.translate = options.translate || ((key, params) => root.tr(key, params));
      this.motion = options.motion || root.window?.matchMedia?.('(prefers-reduced-motion: reduce)') || {matches:false};
      this.schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay));
      this.cancel = options.cancel || (id => clearTimeout(id));
      this.active = false; this.generation = 0; this.requestedUrl = null;
      this.current = null; this.pending = null; this.outgoing = null; this.fadeTimer = null;
      this.snapshot = null; this.status = 'empty'; this.container = null;
      this.animationsEnabled = true;
    }
    element(tag, className) {
      const element = this.document.createElement(tag);
      element.className = className;
      return element;
    }
    mount(container) {
      this.container = container;
      this.root = this.element('div','album-view');
      this.backdrop = this.element('div','album-artwork-backdrop');
      this.backdrop.setAttribute('aria-hidden','true');
      this.frame = this.element('div','album-artwork-frame');
      const fallback = this.element('div','album-artwork-fallback');
      fallback.setAttribute('aria-hidden','true'); fallback.textContent = '♫';
      this.frame.append(fallback);
      this.label = this.element('p','album-artwork-status');
      this.label.setAttribute('role','status'); this.label.setAttribute('aria-live','polite');
      this.root.append(this.backdrop,this.frame,this.label);
      container.replaceChildren(this.root);
      container.classList.add('album-stage');
    }
    update(snapshot) {
      this.snapshot = snapshot;
      if (!this.container) return;
      this.updateLabels();
      if (!this.active) return;
      const value = snapshot.track?.artwork || '';
      const url = /^\/covers\/[a-f0-9]{64}\.jpg$/.test(value) ? value : '';
      if (url === this.requestedUrl) return;
      this.generation++;
      this.cancelPending(); this.finishFade();
      this.requestedUrl = url;
      if (!url) {
        this.detach(this.current); this.current = null;
        this.backdrop.style.backgroundImage = '';
        this.status = 'empty'; this.updateLabels(); return;
      }
      this.status = 'loading';
      const image = this.element('img','album-artwork-layer');
      const generation = this.generation;
      image.decoding = 'async'; image.draggable = false;
      this.pending = image;
      const relevant = () => this.container && this.active && generation === this.generation && image === this.pending;
      image.onload = () => {
        if (!relevant()) return;
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) { image.onerror(); return; }
        this.finishFade();
        this.outgoing = this.current; this.current = image; this.pending = null;
        image.onload = null; image.onerror = null;
        this.status = 'ready';
        this.backdrop.style.backgroundImage = 'url("' + url + '")';
        void image.offsetWidth;
        image.classList.add('is-visible');
        this.outgoing?.classList.remove('is-visible');
        this.updateLabels();
        if (this.motion.matches || !this.animationsEnabled) this.finishFade();
        else if (this.outgoing) {
          image.ontransitionend = event => {
            if (event.target === image && event.propertyName === 'opacity' && this.current === image) this.finishFade();
          };
          this.fadeTimer = this.schedule(() => this.finishFade(),320);
        }
      };
      image.onerror = () => {
        if (!relevant()) return;
        this.pending = null; this.detach(image); this.detach(this.current); this.current = null;
        this.backdrop.style.backgroundImage = '';
        this.status = 'failed'; this.updateLabels();
      };
      this.frame.append(image); this.updateLabels();
      image.src = url;
    }
    updateLabels() {
      const track = this.snapshot?.track;
      const alt = track ? this.translate('Album artwork: {album}', {album:track.album || track.title}) : this.translate('Album artwork');
      if (this.current && this.current.alt !== alt) this.current.alt = alt;
      if (this.pending && this.pending.alt !== alt) this.pending.alt = alt;
      const key = !track ? 'Play a track to see its album artwork.' : this.status === 'failed' ? 'Artwork unavailable' :
        this.status === 'loading' ? 'Loading artwork…' : this.status === 'ready' ? '' : 'No album artwork';
      const text = key ? this.translate(key) : '';
      if (this.label.textContent !== text) this.label.textContent = text;
      this.root.classList.toggle('is-loading',this.status === 'loading');
      this.root.classList.toggle('has-artwork',!!this.current);
    }
    detach(image) {
      if (!image) return;
      image.onload = null; image.onerror = null; image.ontransitionend = null;
      image.removeAttribute('src'); image.remove();
    }
    cancelPending() { this.detach(this.pending); this.pending = null; }
    finishFade() {
      if (this.fadeTimer !== null) this.cancel(this.fadeTimer);
      this.fadeTimer = null;
      this.detach(this.outgoing); this.outgoing = null;
      if (this.current) this.current.ontransitionend = null;
    }
    setActive(active) {
      this.active = active;
      if (!active) {
        this.generation++;
        if (this.pending) { this.cancelPending(); this.requestedUrl = null; }
        this.finishFade();
      } else if (this.snapshot) this.update(this.snapshot);
    }
    setAppearance(value) {
      this.animationsEnabled = value.motionEnabled;
      if (!this.animationsEnabled) this.finishFade();
    }
    dispose() {
      this.setActive(false);
      this.detach(this.current); this.current = null;
      if (this.container) {
        this.container.classList.remove('album-stage'); this.container.replaceChildren();
      }
      this.container = null; this.snapshot = null;
      this.root = null; this.frame = null; this.backdrop = null; this.label = null;
    }
  }
  root.AlbumPlayerView = AlbumPlayerView;
  if (typeof module !== 'undefined' && module.exports) module.exports = AlbumPlayerView;
  else root.playerViews.register('album',() => new AlbumPlayerView());
})(globalThis);
