/* Count only media time which actually advanced during playback. No DOM or network. */
(function(root) {
  'use strict';
  class ListeningSession {
    constructor(trackId, now = () => root.performance?.now?.() ?? Date.now(), id = null) {
      this.id = id || root.crypto?.randomUUID?.() || 'listen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      this.trackId = trackId;
      this.now = now;
      this.startedAt = null;
      this.heard = 0; this.position = 0; this.duration = 0; this.ended = false;
      this.lastTime = null; this.lastPlaying = false; this.seq = 0; this.lastQueued = '';
    }
    sample(position, playing, seek = false) {
      const now = this.now() / 1000;
      if (playing && this.startedAt === null) this.startedAt = Date.now() / 1000;
      if (!Number.isFinite(position) || position < 0) return;
      if (!seek && this.lastTime !== null && this.lastPlaying) {
        const elapsed = now - this.lastTime, advanced = position - this.position;
        // Large discontinuities are seeks, not listened time. Seeking events also
        // explicitly reset the baseline, including small forward/backward jumps.
        if (elapsed > 0 && advanced > 0 && advanced <= elapsed * 1.5 + .5) this.heard += Math.min(advanced,elapsed);
      }
      this.position = position; this.lastTime = now; this.lastPlaying = playing;
    }
    payload(deviceId, deviceName, duration, ended = false) {
      this.ended ||= ended;
      if (!this.heard) return null;
      const listened = Math.round(this.heard * 1000) / 1000;
      const position = Math.round(this.position * 1000) / 1000;
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const signature = [listened,position,safeDuration,this.ended,deviceName].join('|');
      if (signature === this.lastQueued) return null;
      this.lastQueued = signature;
      return {id:this.id,trackId:this.trackId,deviceId,deviceName,seq:++this.seq,
        listened,position,startedAt:this.startedAt,duration:safeDuration,ended:this.ended};
    }
  }
  root.ListeningSession = ListeningSession;
  if (typeof module !== 'undefined' && module.exports) module.exports = ListeningSession;
})(globalThis);
