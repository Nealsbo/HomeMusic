/* Playback queue model: unique occurrences, editable order and actual navigation history. */
(function (root) {
  'use strict';
  class MusicQueue {
    constructor(random = Math.random) {
      this.random = random;
      this.entries = [];
      this.order = [];
      this.currentEntryId = null;
      this.history = [];
      this.historyCursor = -1;
      this.shuffled = false;
      this.counter = 0;
    }
    makeEntry(trackId) {
      const id = root.crypto?.randomUUID?.() || `q-${Date.now().toString(36)}-${++this.counter}-${this.random().toString(36).slice(2)}`;
      return {id, trackId};
    }
    get current() { return this.entries.find(e => e.id === this.currentEntryId) || null; }
    get ordered() {
      const entries = new Map(this.entries.map(e => [e.id, e]));
      return this.order.map(id => entries.get(id)).filter(Boolean);
    }
    mix(ids) {
      const result = [...ids];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }
    replace(trackIds, start = 0) {
      this.clear();
      this.entries = trackIds.slice(0,20000).map(id => this.makeEntry(id));
      this.order = this.entries.map(e => e.id);
      const first = this.entries[start];
      if (first) this.select(first.id);
      if (this.shuffled) this.shuffleUpcoming();
      return this.current;
    }
    select(id) {
      if (!this.entries.some(e => e.id === id)) return null;
      if (this.currentEntryId !== id || !this.history.length) {
        this.history = this.history.slice(0, this.historyCursor + 1);
        this.history.push(id);
        if (this.history.length > 20000) this.history.shift();
        this.historyCursor = this.history.length - 1;
      }
      this.currentEntryId = id;
      return this.current;
    }
    next(repeat = false) {
      if (this.historyCursor + 1 < this.history.length) {
        this.currentEntryId = this.history[++this.historyCursor];
        return this.current;
      }
      let index = this.currentEntryId ? this.order.indexOf(this.currentEntryId) + 1 : 0;
      if (index >= this.order.length) {
        if (!repeat || !this.order.length) return null;
        if (this.shuffled) {
          const last = this.currentEntryId;
          this.order = this.mix(this.order);
          if (this.order.length > 1 && this.order[0] === last) [this.order[0],this.order[1]] = [this.order[1],this.order[0]];
        }
        index = 0;
      }
      return this.select(this.order[index]);
    }
    previous() {
      if (this.historyCursor > 0) {
        this.currentEntryId = this.history[--this.historyCursor];
        return this.current;
      }
      // In normal order, a click in the middle must not become a hard boundary.
      // Extend history at the front so Next still retraces the same occurrences.
      if (this.shuffled) return null;
      const index = this.order.indexOf(this.currentEntryId);
      if (index <= 0) return null;
      if (this.historyCursor < 0 || this.history[0] !== this.currentEntryId) this.history = [this.currentEntryId];
      this.currentEntryId = this.order[index - 1];
      this.history.unshift(this.currentEntryId);
      if (this.history.length > 20000) this.history.length = 20000;
      this.historyCursor = 0;
      return this.current;
    }
    shuffleUpcoming() {
      const index = this.currentEntryId ? this.order.indexOf(this.currentEntryId) : -1;
      this.order = [...this.order.slice(0,index + 1), ...this.mix(this.order.slice(index + 1))];
    }
    setShuffle(enabled) {
      if (this.shuffled === enabled) return;
      this.shuffled = enabled;
      this.history = this.history.slice(0,this.historyCursor + 1);
      if (enabled) this.shuffleUpcoming();
      else {
        const index = this.currentEntryId ? this.order.indexOf(this.currentEntryId) : -1;
        const prefix = this.order.slice(0,index + 1), remaining = new Set(this.order.slice(index + 1));
        this.order = [...prefix,...this.entries.filter(e => remaining.has(e.id)).map(e => e.id)];
      }
    }
    add(trackIds, next = false) {
      const added = trackIds.slice(0,Math.max(0,20000 - this.entries.length)).map(id => this.makeEntry(id));
      const index = next && this.currentEntryId ? this.order.indexOf(this.currentEntryId) + 1 : this.order.length;
      this.order.splice(index,0,...added.map(e => e.id));
      const baseIndex = next && this.current ? this.entries.findIndex(e => e.id === this.currentEntryId) + 1 : this.entries.length;
      this.entries.splice(baseIndex,0,...added);
      // Explicit additions take precedence over forward navigation history.
      if (next) this.history = this.history.slice(0,this.historyCursor + 1);
      return added;
    }
    move(id, targetId) {
      const from = this.order.indexOf(id), to = this.order.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return;
      this.order.splice(from,1);
      this.order.splice(to,0,id);
      this.entries = this.ordered;
      this.history = this.history.slice(0,this.historyCursor + 1);
    }
    remove(id) {
      const index = this.order.indexOf(id);
      if (index < 0) return {wasCurrent:false, current:this.current};
      const wasCurrent = id === this.currentEntryId, next = this.order[index + 1];
      const prefix = this.history.slice(0,this.historyCursor + 1).filter(item => item !== id);
      this.history = this.history.filter(item => item !== id);
      this.historyCursor = prefix.length - 1;
      this.entries = this.entries.filter(e => e.id !== id);
      this.order.splice(index,1);
      if (wasCurrent) {
        this.currentEntryId = null;
        if (next) this.select(next);
      }
      return {wasCurrent, current:this.current};
    }
    prune(valid) {
      for (const entry of [...this.entries]) if (!valid.has(entry.trackId)) this.remove(entry.id);
    }
    clear() {
      this.entries = []; this.order = []; this.currentEntryId = null;
      this.history = []; this.historyCursor = -1;
    }
    snapshot() {
      return {version:2, entries:this.entries, order:this.order, currentEntryId:this.currentEntryId,
        history:this.history, historyCursor:this.historyCursor, shuffled:this.shuffled};
    }
    restore(saved, valid) {
      this.clear();
      if (!saved || saved.version !== 2 || !Array.isArray(saved.entries) || !Array.isArray(saved.order)) return false;
      const seen = new Set();
      this.entries = saved.entries.slice(0,20000).filter(e => {
        if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(e.id) || !valid.has(e.trackId) || seen.has(e.id)) return false;
        seen.add(e.id); return true;
      }).map(e => ({id:e.id,trackId:e.trackId}));
      const restoredOrder = [...new Set(saved.order.slice(0,20000).filter(id => seen.has(id)))];
      const orderedIds = new Set(restoredOrder);
      this.order = [...restoredOrder,...this.entries.map(e => e.id).filter(id => !orderedIds.has(id))];
      this.currentEntryId = seen.has(saved.currentEntryId) ? saved.currentEntryId : null;
      const history = Array.isArray(saved.history) ? saved.history.slice(-20000) : [];
      const cursor = Number.isInteger(saved.historyCursor) ? Math.min(saved.historyCursor,history.length - 1) : history.length - 1;
      this.historyCursor = history.slice(0,cursor + 1).filter(id => seen.has(id)).length - 1;
      this.history = history.filter(id => seen.has(id));
      if (this.currentEntryId && this.history[this.historyCursor] !== this.currentEntryId) this.select(this.currentEntryId);
      this.shuffled = !!saved.shuffled;
      return true;
    }
  }
  root.MusicQueue = MusicQueue;
  if (typeof module !== 'undefined' && module.exports) module.exports = MusicQueue;
})(globalThis);
