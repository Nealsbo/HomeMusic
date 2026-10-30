/* Keep a tab's identity across navigation without sharing it with live copies. */
(function(root) {
  'use strict';
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const randomId = () => root.crypto?.randomUUID?.() ||
    'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  class MusicClientSession {
    constructor(options = {}) {
      this.newId = options.newId || randomId;
      this.pageId = this.newId();
      this.schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay));
      try { this.storage = options.storage || root.sessionStorage; } catch {}
      let saved;
      try { saved = JSON.parse(this.storage?.getItem('playerSession')); } catch {}
      this.id = validId(saved?.id) ? saved.id : this.newId();
      this.seq = Number.isSafeInteger(saved?.seq) && saved.seq >= 0 ? saved.seq : 0;
      this.commands = new Map(Array.isArray(saved?.commands) ? saved.commands.filter(entry =>
        Array.isArray(entry) && validId(entry[0]) && entry[1] && typeof entry[1].ok === 'boolean').slice(-100) : []);
      this.onIdentityChange = null;
      this.established = false;
      this.save();
      this.channelFactory = options.channelFactory || (root.BroadcastChannel ?
        () => new root.BroadcastChannel('homemusic-player-sessions') : null);
      this.ready = this.connect();
      root.addEventListener?.('pagehide', () => this.close());
      root.addEventListener?.('pageshow', event => {
        if (event.persisted) this.ready = this.connect();
      });
    }
    save() {
      try { this.storage?.setItem('playerSession', JSON.stringify({id:this.id, seq:this.seq, commands:[...this.commands]})); } catch {}
    }
    nextSequence() {
      this.seq++;
      this.save();
      return this.seq;
    }
    rememberCommand(id, result) {
      // A full export snapshot may exceed browser storage limits. If reloaded
      // before its acknowledgement, fail the transfer rather than replay it.
      this.commands.set(id, result.snapshot ? {ok:false, error:'Command expired'} :
        {ok:result.ok, ...(result.error ? {error:String(result.error).slice(0,1000)} : {})});
      if (this.commands.size > 100) this.commands.delete(this.commands.keys().next().value);
      this.save();
    }
    rotate() {
      this.id = this.newId(); this.seq = 0; this.commands.clear(); this.save();
      this.onIdentityChange?.();
      this.claim();
    }
    claim() {
      try { this.channel?.postMessage({type:'claim', id:this.id, pageId:this.pageId}); } catch {}
    }
    connect() {
      this.established = false;
      try { this.channel = this.channelFactory?.(); } catch {}
      if (!this.channel) { this.established = true; return Promise.resolve(); }
      this.channel.onmessage = ({data}) => {
        if (!data || data.id !== this.id || !validId(data.pageId) || data.pageId === this.pageId) return;
        if (data.type === 'occupied' && data.target === this.pageId) this.rotate();
        else if (data.type === 'claim') {
          if (this.established || this.pageId < data.pageId) {
            this.channel.postMessage({type:'occupied', id:this.id, pageId:this.pageId, target:data.pageId});
          } else this.rotate();
        }
      };
      this.claim();
      return new Promise(resolve => this.schedule(() => { this.established = true; resolve(); }, 150));
    }
    close() { this.channel?.close(); this.channel = null; }
  }
  root.MusicClientSession = MusicClientSession;
  if (typeof module !== 'undefined' && module.exports) module.exports = MusicClientSession;
  else root.browserSession = new MusicClientSession();
})(globalThis);
