// Server lifecycle controls use the existing owner key; credentials stay in memory.
(() => {
  const group = $('serverSettingsGroup');
  let status = null, polling = false, pending = false, restarting = null, message = '';
  function render() {
    $('restartServer').disabled = pending || !!restarting || !status?.restartSupported || !!status?.busy;
    $('serverRestartStatus').textContent = message ? tr(message) :
      status && !status.restartSupported ? tr('Start the server with a restart-capable main.py launcher') : '';
  }
  async function refresh() {
    if (polling || document.hidden || (!restarting && (view !== 'settings' || !group.open))) return;
    polling = true;
    try {
      const response = await fetch('/api/server');
      if (!response.ok) throw Error(tr('Could not read server status'));
      status = await response.json();
      if (restarting && status.instance && status.instance !== restarting.instance) {
        restarting = null; message = 'Server restarted';
        render(); location.reload(); return;
      }
    } catch (error) {
      if (!restarting) message = error.message;
    } finally {
      if (restarting && Date.now() > restarting.deadline) {
        restarting = null;
        message = 'The server did not return in time. Check its console and configured URL.';
      }
      polling = false; render();
    }
  }
  async function restart() {
    if (pending || restarting || !status?.restartSupported || status.busy) return;
    const key = $('restartOwnerKey').value.trim();
    if (!key) { toast(tr('Enter the server owner key')); return; }
    if (!confirm(tr('Restart the server now? Playback may be interrupted. Unsaved settings will be lost.'))) return;
    pending = true; message = ''; render();
    try {
      const response = await fetch('/api/server/restart', {method:'POST',
        headers:{'Content-Type':'application/json', Authorization:'Bearer ' + key}, body:'{}'});
      const result = await response.json();
      if (!response.ok) throw Error(MusicI18n.message(result.error || 'Server restart failed'));
      restarting = {instance:result.instance, deadline:Date.now() + ((status.startupTimeout || 90) + 10) * 1000};
      message = 'Waiting for the server to restart';
    } catch (error) { message = error.message; }
    finally { $('restartOwnerKey').value = ''; pending = false; render(); }
  }
  group.addEventListener('toggle', refresh);
  $('restartServer').onclick = restart;
  setInterval(refresh, 2000);
  globalThis.serverControl = {render, refresh};
  render();
})();
