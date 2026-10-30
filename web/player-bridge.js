/* The only application-state boundary used by player presentation modules. */
(function(root) {
  const listeners = new Set();
  function getState() {
    const track = trackMap.get(currentId);
    return Object.freeze({
      track:track ? Object.freeze({id:track.id, title:track.title, artist:track.artist || '',
        album:track.album || '', artwork:/^[a-f0-9]{64}$/.test(track.cover_id || '') ? '/covers/' + track.cover_id + '.jpg' : ''}) : null,
      playing:!!currentId && !audio.paused, state:playbackState,
      position:Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration:Number.isFinite(audio.duration) ? audio.duration : 0,
      volume:audio.volume, shuffled, repeating, queueCount:queueModel.order.length,
      error:playbackError
    });
  }
  function publish() {
    if (!listeners.size) return;
    const snapshot = getState();
    for (const listener of listeners) {
      try { listener(snapshot); } catch (error) { console.error('Player view update failed', error); }
    }
  }
  root.playbackBridge = Object.freeze({getState, publish,
    analysis:Object.freeze({createConsumer:() => audioAnalysis.createConsumer()}),
    subscribe(listener) {
      listeners.add(listener);
      try { listener(getState()); } catch (error) { listeners.delete(listener); throw error; }
      return () => listeners.delete(listener);
    },
    commands:Object.freeze({togglePlayback:() => togglePlayback(), next:() => step(1), previous:() => step(-1)})
  });
  for (const event of ['timeupdate','loadedmetadata','play','pause','playing','waiting','ended','error','volumechange','emptied','seeking','seeked']) {
    audio.addEventListener(event,publish);
  }
})(globalThis);
