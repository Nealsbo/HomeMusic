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
}
applyTheme(stored('theme', 'forest'));
$('themeSelect').onchange = e => applyTheme(e.target.value);

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
  setWaveMode(waveMode);
  audioWave.sync();
  if (view === 'history') await loadHistory(true);
  if (view === 'operations') await loadOperations();
  if (view === 'stats') await updateStats();
  if ($('devicesDialog').open) await refreshDevices();
};

$('settingsForm').onsubmit = handle(async e => { e.preventDefault(); const device = await api('device',{id:deviceId,name:$('deviceName').value}); deviceName = device.name; store('device',{id:deviceId,name:deviceName}); await api('settings',{title:$('serverTitle').value,defaultVolume:Number($('defaultVolume').value)}); await refresh(); reportPlayback(); toast(tr("Settings saved")); });
