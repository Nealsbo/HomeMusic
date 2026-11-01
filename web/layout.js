/* Layout owns presentation only. Existing controls retain their event handlers. */
(function(root) {
  const dialog = $('navigationDialog'), sidebar = $('appSidebar'), home = $('sidebarHome');
  const toggle = $('navigationToggle'), wave = $('libraryWave');
  const actions = $('trackActionsDialog');
  const routes = [['trackActionNext','enqueueNext'],['trackActionEnd','enqueueEnd'],
    ['trackActionUp','up'],['trackActionDown','down'],['trackActionEdit','edit']];
  const actionButtons = routes.map(([id]) => $(id));
  let actionOrigin = null, actionTrack = null;
  let restoreActionFocus = true;
  let navigationOpen = false;
  function closeNavigation(focusHeading = false) {
    if (!navigationOpen) return;
    navigationOpen = false; home.append(sidebar);
    toggle.setAttribute('aria-expanded','false');
    if (dialog.open) dialog.close();
    if (focusHeading) $('pageTitle').focus(); else toggle.focus();
  }
  function openNavigation() {
    if (navigationOpen) return;
    $('sidebarSlot').append(sidebar);
    try { dialog.showModal(); }
    catch (error) { home.append(sidebar); console.warn('Navigation could not open',error); return; }
    navigationOpen = true; toggle.setAttribute('aria-expanded','true');
    $('closeNavigation').focus();
  }
  function onNavigate() {
    closeTrackActions(false);
    closeNavigation(true); $('appMain').scrollTop = 0; $('pageTitle').focus();
  }
  function closeTrackActions(restoreFocus = true) {
    if (!actions.open) return;
    restoreActionFocus = restoreFocus;
    actions.close();
    if (restoreFocus) actionOrigin?.focus();
  }
  function openTrackActions(id,origin) {
    const track = trackMap.get(id);
    if (!track) return;
    closeTrackActions(false); actionOrigin = origin; actionTrack = id; restoreActionFocus = true;
    $('trackActionsTitle').textContent = track.title;
    for (const [button,route] of routes) $(button).dataset[route] = id;
    const position = visible.findIndex(value => value.id === id), manual = canReorderTracks();
    $('trackActionUp').disabled = !manual || position <= 0;
    $('trackActionDown').disabled = !manual || position < 0 || position === visible.length - 1;
    actions.showModal();
    const anchor = origin?.getBoundingClientRect?.(), bounds = actions.getBoundingClientRect?.();
    if (anchor && bounds) {
      const width = root.innerWidth || document.documentElement.clientWidth;
      const height = root.innerHeight || document.documentElement.clientHeight;
      actions.style.left = Math.max(12,Math.min(anchor.right - bounds.width,width - bounds.width - 12)) + 'px';
      actions.style.top = Math.max(12,Math.min(anchor.bottom + 6,height - bounds.height - 12)) + 'px';
    }
    actionButtons.find(button => !button.disabled)?.focus();
  }
  $('closeTrackActions').onclick = () => closeTrackActions();
  actions.oncancel = event => { event.preventDefault(); closeTrackActions(); };
  actions.onclose = () => { if (restoreActionFocus && !actions.open && !document.querySelector('dialog[open]')) actionOrigin?.focus(); };
  actions.onclick = event => {
    if (event.target !== actions || !Number.isFinite(event.clientX)) return;
    const bounds = actions.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeTrackActions();
  };
  actions.onkeydown = event => {
    const buttons = actionButtons.filter(button => !button.disabled);
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || !buttons.length) return;
    event.preventDefault();
    let index = buttons.indexOf(document.activeElement);
    if (index < 0 && event.key === 'ArrowUp') index = buttons.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  $('trackActionsList').onclick = handle(async event => {
    const button = event.target.closest('button');
    if (!actions.open || !actionButtons.includes(button) || button.disabled) return;
    const id = actionTrack; closeTrackActions();
    await activateTrackButton(button);
    if (!document.querySelector('dialog[open]')) {
      Array.from(document.querySelectorAll('[data-track-actions]')).find(element => element.dataset.trackActions === id)?.focus();
    }
  });
  window.addEventListener('resize',() => closeTrackActions());
  $('appMain').addEventListener('scroll',() => closeTrackActions());
  function refreshFilters() {
    let count = 0;
    if (!playlistId && $('libraryList').value !== 'all') count++;
    if ($('folderFilter').value !== '*') count++;
    if ($('sort').value !== 'manual') count++;
    $('activeFilters').hidden = count === 0;
    $('activeFilters').textContent = String(count);
    $('activeFilters').setAttribute('aria-label',tr('{count} active filters',{count}));
  }
  toggle.onclick = openNavigation;
  $('closeNavigation').onclick = () => closeNavigation();
  dialog.oncancel = event => { event.preventDefault(); closeNavigation(); };
  dialog.onclose = () => { if (navigationOpen && !dialog.open) closeNavigation(); };
  const desktop = window.matchMedia?.('(min-width: 761px)');
  desktop?.addEventListener?.('change',event => { if (event.matches) closeNavigation(true); });
  $('queueShortcut').onclick = () => $('queueButton').onclick();
  const openDevices = $('devicesButton').onclick;
  $('devicesButton').onclick = event => { closeNavigation(); return openDevices(event); };
  wave.open = stored('libraryWaveOpen',false) === true;
  wave.ontoggle = () => {
    store('libraryWaveOpen',wave.open); audioWave.sync();
    if (wave.open && waveMode !== 'off') void audioWave.unlock();
  };
  root.appLayout = Object.freeze({openNavigation,closeNavigation,onNavigate,refreshFilters,openTrackActions,closeTrackActions});
})(globalThis);
