/* Owns presentation and view lifecycles; playback stays in the existing player. */
(function(root) {
  const dialog = $('expandedPlayerDialog'), controls = $('compactPlayer');
  const home = $('compactPlayerHome'), slot = $('expandedPlayerControls');
  const tabs = ['album','effects','cd'].map(mode => ({mode, button:$('expandedTab-' + mode)}));
  const saved = stored('expandedPlayerMode','album');
  let mode = tabs.some(tab => tab.mode === saved) && playerViews.has(saved) ? saved : 'album';
  let opened = false, closing = false, closeTimer = null, unsubscribe = null, currentView = null;
  let lastSnapshot = null;

  function updateBackgroundMotion() {
    const value = playerAppearance.get();
    const motion = opened && !closing && !document.hidden && !!lastSnapshot?.playing && lastSnapshot.state === 'playing' &&
      value.motionEnabled && value.background === 'waves' && value.intensity > 0 ? 'on' : 'off';
    if (dialog.dataset.backgroundMotion !== motion) dialog.dataset.backgroundMotion = motion;
  }
  function applyAppearance(value) {
    dialog.dataset.background = value.background;
    dialog.dataset.backgroundVisible = String(value.background !== 'none' && value.intensity > 0);
    dialog.dataset.motion = value.motionEnabled ? 'on' : 'off';
    dialog.style.setProperty('--player-background-opacity',String(value.intensity / 100 * .3));
    try { currentView?.setAppearance?.(value); }
    catch (error) { console.error('Player view appearance update failed',error); }
    updateBackgroundMotion();
    if (closing && !value.motionEnabled) finishClose();
  }

  function updateTabs() {
    for (const tab of tabs) {
      tab.button.setAttribute('aria-selected',String(tab.mode === mode));
      tab.button.tabIndex = tab.mode === mode ? 0 : -1;
    }
    $('expandedPlayerStage').setAttribute('aria-labelledby','expandedTab-' + mode);
  }
  function disposeView() {
    try { currentView?.setActive(false); }
    catch (error) { console.error('Player view could not pause',error); }
    try { currentView?.dispose(); }
    catch (error) { console.error('Player view cleanup failed',error); }
    currentView = null;
  }
  function render(snapshot) {
    lastSnapshot = snapshot;
    updateBackgroundMotion();
    $('expandedTrackTitle').textContent = snapshot.track?.title || tr('Choose music');
    $('expandedTrackArtist').textContent = snapshot.track ? snapshot.track.artist || tr('Unknown artist') : tr('Your collection is waiting');
    $('expandedTrackAlbum').textContent = snapshot.track?.album || '';
    $('expandedPlaybackError').textContent = snapshot.error;
    $('expandedPlaybackError').hidden = !snapshot.error;
    try { currentView?.update(snapshot); }
    catch (error) {
      console.error('Player view failed',error);
      disposeView();
      $('expandedPlayerStage').textContent = tr('This view is unavailable. Playback will continue.');
    }
  }
  function mountView() {
    disposeView();
    try {
      currentView = playerViews.create(mode,{analysis:playbackBridge.analysis,artworkFactory:() => playerViews.create('album')});
      currentView.mount($('expandedPlayerStage'));
      currentView.setAppearance?.(playerAppearance.get());
      currentView.setActive(opened && !closing);
    } catch (error) {
      console.error('Player view could not start',error);
      disposeView();
      $('expandedPlayerStage').textContent = tr('This view is unavailable. Playback will continue.');
    }
  }
  function setMode(value) {
    if (!tabs.some(tab => tab.mode === value) || !playerViews.has(value)) value = 'album';
    if (mode === value) return;
    mode = value; store('expandedPlayerMode',mode); updateTabs();
    if (opened && !closing) { mountView(); render(playbackBridge.getState()); }
  }
  function notifyVisibility() {
    updateBackgroundMotion();
    document.dispatchEvent?.(new Event('expanded-player-change'));
  }
  function finishClose() {
    if (!opened) return;
    clearTimeout(closeTimer); closeTimer = null;
    unsubscribe?.(); unsubscribe = null; disposeView();
    home.append(controls);
    opened = false; closing = false;
    dialog.classList.remove('is-open');
    if (dialog.open) dialog.close();
    document.documentElement.classList.remove('expanded-player-open');
    $('expandPlayer').setAttribute('aria-expanded','false');
    $('expandedAppearancePanel').hidden = true;
    $('expandedAppearanceToggle').setAttribute('aria-expanded','false');
    notifyVisibility();
    $('expandPlayer').focus();
  }
  function open() {
    if (opened && !closing) return;
    const resuming = opened;
    clearTimeout(closeTimer); closeTimer = null; closing = false;
    if (!opened) {
      slot.append(controls);
      try { dialog.showModal(); }
      catch (error) { home.append(controls); throw error; }
      opened = true;
      document.documentElement.classList.add('expanded-player-open');
      $('expandPlayer').setAttribute('aria-expanded','true');
      updateTabs(); mountView();
    }
    try { if (resuming) currentView?.setActive(true); }
    catch (error) {
      console.error('Player view could not resume',error); disposeView();
      $('expandedPlayerStage').textContent = tr('This view is unavailable. Playback will continue.');
    }
    unsubscribe ||= playbackBridge.subscribe(render);
    // Establish the starting position before applying the opening transform.
    void dialog.offsetHeight;
    dialog.classList.add('is-open');
    $('collapsePlayer').focus();
    notifyVisibility();
  }
  function close(immediate = false) {
    if (!opened || closing) return;
    closing = true;
    updateBackgroundMotion();
    unsubscribe?.(); unsubscribe = null;
    try { currentView?.setActive(false); } catch (error) { console.error('Player view could not pause',error); }
    dialog.classList.remove('is-open');
    if (immediate || !playerAppearance.get().motionEnabled || document.hidden) finishClose();
    else closeTimer = setTimeout(finishClose,320);
  }
  $('expandPlayer').onclick = handle(open);
  $('collapsePlayer').onclick = () => close();
  $('expandedAppearanceToggle').onclick = () => {
    const panel = $('expandedAppearancePanel');
    panel.hidden = !panel.hidden;
    $('expandedAppearanceToggle').setAttribute('aria-expanded',String(!panel.hidden));
    if (!panel.hidden) $('expandedBackgroundSetting').focus();
  };
  dialog.oncancel = event => { event.preventDefault(); close(); };
  dialog.onclose = () => { if (!dialog.open) finishClose(); };
  dialog.ontransitionend = event => { if (closing && event.target === dialog && event.propertyName === 'transform') finishClose(); };
  for (const tab of tabs) tab.button.onclick = () => setMode(tab.mode);
  $('expandedPlayerTabs').onkeydown = event => {
    const index = tabs.findIndex(tab => tab.button === event.target);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); setMode(tabs[next].mode); tabs[next].button.focus();
  };
  root.expandedPlayer = Object.freeze({open,close,setMode,
    refresh() { updateTabs(); if (opened && !closing) render(playbackBridge.getState()); },
    get isOpen() { return opened; }, get mode() { return mode; }
  });
  updateTabs();
  playerAppearance.subscribe(applyAppearance);
  document.addEventListener?.('visibilitychange',updateBackgroundMotion);
})(globalThis);
