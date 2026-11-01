function applyInterfaceSize(kind,value) {
  const size = ['small','medium','large','xlarge'].includes(value) ? value : 'small';
  if (kind !== 'font' && kind !== 'icon') return;
  document.documentElement.dataset[kind + 'Size'] = size;
  $(kind + 'SizeSetting').value = size;
  store(kind + 'Size',size);
}
applyInterfaceSize('font',stored('fontSize','small'));
applyInterfaceSize('icon',stored('iconSize','small'));
$('fontSizeSetting').onchange = event => applyInterfaceSize('font',event.target.value);
$('iconSizeSetting').onchange = event => applyInterfaceSize('icon',event.target.value);

function applyTheme(value) {
  const theme = ['forest', 'midnight', 'sand'].includes(value) ? value : 'forest';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'midnight' ? 'dark' : 'light';
  $('themeSelect').value = theme;
  store('theme', theme);
  globalThis.expandedPlayer?.refresh();
}
applyTheme(stored('theme', 'forest'));
$('themeSelect').onchange = e => applyTheme(e.target.value);

for (const prefix of ['player','expanded']) {
  $(prefix + 'BackgroundSetting').onchange = event => playerAppearance.set({background:event.target.value});
  $(prefix + 'IntensitySetting').oninput = event => playerAppearance.set({intensity:Number(event.target.value)});
  $(prefix + 'AnimationSetting').onchange = event => playerAppearance.set({animation:event.target.checked});
}
playerAppearance.subscribe(value => {
  for (const prefix of ['player','expanded']) {
    $(prefix + 'BackgroundSetting').value = value.background;
    $(prefix + 'IntensitySetting').value = value.intensity;
    $(prefix + 'IntensitySetting').disabled = value.background === 'none';
    $(prefix + 'IntensitySetting').setAttribute('aria-valuetext',value.intensity + '%');
    $(prefix + 'IntensityValue').textContent = value.intensity + '%';
    $(prefix + 'AnimationSetting').checked = value.animation;
    $(prefix + 'ReducedMotionNote').hidden = !value.reducedMotion;
  }
});

options($('languageSetting'), MusicI18n.languages.map(item => [item.code, item.name]), MusicI18n.language);
$('languageSetting').value = MusicI18n.language;
$('languageSetting').onchange = handle(async event => {
  try { await MusicI18n.setLanguage(event.target.value); }
  finally { $('languageSetting').value = MusicI18n.language; }
});
MusicI18n.onChange = async () => {
  // Refresh presentation without replacing the audio source, queue, or form edits.
  catalog = new MusicCatalog(state.tracks);
  renderLibraryMessages();
  renderFolderOptions();
  document.querySelector('.connection').lastChild.textContent = ' ' + tr('Connected');
  renderNav(); renderTracks(); renderFolders(); renderQueue(); updateNowPlaying();
  $('sizeCount').textContent = bytes(state.tracks.reduce((sum, track) => sum + track.size, 0));
  renderHealth(); renderSelectedDevice();
  globalThis.serverUpdates?.render();
  globalThis.serverControl?.render();
  setWaveMode(waveMode);
  audioWave.sync();
  if (view === 'history') await loadHistory(true);
  if (view === 'operations') await loadOperations();
  if (view === 'stats') await updateStats();
  if ($('devicesDialog').open) await refreshDevices();
  globalThis.expandedPlayer?.refresh();
};

$('deviceSettingsForm').onsubmit = handle(async event => {
  event.preventDefault(); const button = $('saveDeviceSettings'); if (button.disabled) return;
  button.disabled = true;
  try {
    const device = await api('device',{id:deviceId,name:$('deviceName').value});
    deviceName = device.name; $('deviceName').value = deviceName;
    store('device',{id:deviceId,name:deviceName}); reportPlayback(); toast(tr('Device name saved'));
  } finally { button.disabled = false; }
});
$('settingsForm').onsubmit = handle(async event => {
  event.preventDefault(); const button = $('saveServerSettings'); if (button.disabled) return;
  button.disabled = true;
  try {
    await api('settings',{title:$('serverTitle').value,defaultVolume:Number($('defaultVolume').value)});
    const updated = await api('state'); state.settings = updated.settings;
    $('serverTitle').value = state.settings.title || tr('Quiet Wave');
    $('defaultVolume').value = state.settings.defaultVolume ?? .75;
    renderLibraryMessages(); toast(tr('Server settings saved'));
  } finally { button.disabled = false; }
});
