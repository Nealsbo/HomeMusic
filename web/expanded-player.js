/* Owns presentation and view lifecycles; playback stays in the existing player. */
(function(root) {
  const dialog = $('expandedPlayerDialog'), controls = $('compactPlayer');
  const home = $('compactPlayerHome'), slot = $('expandedPlayerControls');
  const tabs = ['album','effects','cd'].map(mode => ({mode, button:$('expandedTab-' + mode)}));
  const saved = stored('expandedPlayerMode','album');
  let mode = tabs.some(tab => tab.mode === saved) && playerViews.has(saved) ? saved : 'album';
  let opened = false, closing = false, closeTimer = null, unsubscribe = null, currentView = null;
  let lastSnapshot = null, shaderBackground = null;
  const settings = $('expandedAppearancePanel'), settingsSlot = $('expandedSceneSettings');
  const narrow = window.matchMedia?.('(max-width: 960px)');
  function updateSettingsLayout() {
    const visible = !settings.hidden;
    dialog.dataset.settingsOpen = String(visible);
    $('expandedPlayerStage').inert = visible && !!narrow?.matches;
    $('expandedSettingsBackdrop').hidden = !visible || !narrow?.matches;
  }
  function setSettingsOpen(value,focus = true) {
    if (value && (!opened || closing)) return;
    settings.hidden = !value;
    if (value) settings.scrollTop = 0;
    $('expandedAppearanceToggle').setAttribute('aria-expanded',String(value));
    updateSettingsLayout();
    if (focus) {
      if (value && !$('expandedSceneSettingsSection').hidden && currentView?.focusSettings?.() === true) return;
      (value ? $('expandedBackgroundSetting') : $('expandedAppearanceToggle')).focus();
    }
  }
  function updateSettingsTitle() {
    $('expandedSceneSettingsTitle').textContent = tr(mode === 'cd' ? 'CD controls' : 'Visualization controls');
  }

  function updateBackgroundMotion() {
    const value = playerAppearance.get();
    const shader = ['aurora','gradient','stars','grid','northern-lights'].includes(value.background);
    const motion = opened && !closing && !document.hidden && (value.animateWhenPaused || (!!lastSnapshot?.playing && lastSnapshot.state === 'playing')) &&
      value.motionEnabled && value.backgroundSpeed > 0 && shader && value.intensity > 0 ? 'on' : 'off';
    if (dialog.dataset.backgroundMotion !== motion) dialog.dataset.backgroundMotion = motion;
    const visible = opened && !closing && !document.hidden && shader && value.intensity > 0;
    if (visible && !shaderBackground && root.PlayerBackground) shaderBackground = new root.PlayerBackground($('expandedPlayerStage'));
    if (shaderBackground) {
      if (!opened || !shader) {
        shaderBackground.dispose(); shaderBackground = null;
      } else shaderBackground.update({background:value.background,visible,moving:motion === 'on',speed:value.backgroundSpeed,
        primary:dialog.style.getPropertyValue('--player-color-primary'),secondary:dialog.style.getPropertyValue('--player-color-secondary')});
    }
  }
  function applyAppearance(value) {
    dialog.dataset.background = value.background;
    dialog.dataset.palette = value.palette;
    dialog.dataset.backgroundVisible = String(value.background !== 'none' && value.intensity > 0);
    dialog.dataset.motion = value.motionEnabled ? 'on' : 'off';
    dialog.style.setProperty('--player-background-opacity',String(value.intensity / 100));
    const palette = MusicThemes.findPalette(value.palette === 'theme' ? document.documentElement.dataset.theme : value.palette);
    dialog.style.setProperty('--player-color-primary',value.palette === 'custom' ? value.primary : palette?.primary || '#24754b');
    dialog.style.setProperty('--player-color-secondary',value.palette === 'custom' ? value.secondary : palette?.secondary || '#a5bc77');
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
    settingsSlot.replaceChildren(); $('expandedSceneSettingsSection').hidden = true;
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
      const hasSettings = currentView.mountSettings?.(settingsSlot) === true;
      $('expandedSceneSettingsSection').hidden = !hasSettings; updateSettingsTitle();
      settings.scrollTop = 0;
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
    setSettingsOpen(false,false);
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
  $('expandedAppearanceToggle').onclick = () => setSettingsOpen(settings.hidden);
  $('closeExpandedAppearance').onclick = $('expandedSettingsBackdrop').onclick = () => setSettingsOpen(false);
  dialog.oncancel = event => { event.preventDefault(); if (!settings.hidden) setSettingsOpen(false); else close(); };
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
  root.expandedPlayer = Object.freeze({open,close,setMode,setSettingsOpen,
    applyPalette() { applyAppearance(playerAppearance.get()); },
    refresh() { updateTabs(); updateSettingsTitle(); if (opened && !closing) render(playbackBridge.getState()); },
    get isOpen() { return opened; }, get mode() { return mode; }
  });
  updateTabs();
  setSettingsOpen(false,false); updateSettingsTitle();
  narrow?.addEventListener?.('change',updateSettingsLayout);
  playerAppearance.subscribe(applyAppearance);
  document.addEventListener?.('visibilitychange',updateBackgroundMotion);
})(globalThis);
