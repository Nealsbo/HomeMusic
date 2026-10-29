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

$('settingsForm').onsubmit = handle(async e => { e.preventDefault(); const device = await api('device',{id:deviceId,name:$('deviceName').value}); deviceName = device.name; store('device',{id:deviceId,name:deviceName}); await api('settings',{title:$('serverTitle').value,defaultVolume:Number($('defaultVolume').value)}); await refresh(); reportPlayback(); toast('Настройки сохранены'); });
