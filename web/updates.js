// Update controls never modify the queue, audio source, or playback preferences.
(() => {
  const group = $('updatesSettingsGroup');
  let status = null, polling = false, pending = false, restarting = false;
  const phases = {
    idle:'Updates have not been checked yet', checking:'Checking for updates',
    available:'An update is available', current:'You have the latest version',
    downloading:'Downloading and verifying the update', restarting:'Restarting the server',
    error:'Update failed', unmanaged:'Start the server using main.py to enable updates',
    no_release:'No published release was found. Check the update repository in the server config.'
  };
  function render() {
    const phase = status?.phase || 'idle';
    $('updateStatus').textContent = tr(phases[phase] || phases.idle);
    $('updateCurrent').textContent = status?.current || '—';
    $('updateLatest').textContent = status?.latest?.version || '—';
    $('updateNotes').textContent = status?.latest?.notes || '';
    $('updateChecked').textContent = status?.checkedAt ? new Date(status.checkedAt * 1000).toLocaleString(MusicI18n.locale) : '—';
    $('updateError').textContent = status?.error ? MusicI18n.message(status.error) : '';
    const busy = pending || ['checking','downloading','restarting'].includes(phase);
    $('checkUpdates').disabled = busy || phase === 'unmanaged';
    $('installUpdate').disabled = busy || phase !== 'available' || !status?.managed || !$('updateRestartConsent').checked;
    const outcome = status?.lastResult?.outcome;
    $('updateResult').textContent = outcome === 'rolled_back' ? tr('The previous version was restored after an unsuccessful update') :
      outcome === 'installed' ? tr('The update was installed successfully') : outcome === 'failed' ? tr('Update failed') : '';
    $('reloadAfterUpdate').hidden = !restarting || busy;
  }
  async function refresh() {
    if (polling || !group.open || view !== 'settings' || document.hidden) return;
    polling = true;
    try {
      const response = await fetch('/api/updates');
      if (!response.ok) throw Error(tr('Could not read update status'));
      status = await response.json();
      if (status.phase === 'restarting') restarting = true;
      render();
    } catch (error) {
      $('updateStatus').textContent = restarting ? tr('Waiting for the server to restart') : error.message;
    } finally { polling = false; }
  }
  async function run(action) {
    if (pending) return;
    pending = true; render();
    try {
      const response = await fetch('/api/updates/' + action, {method:'POST',
        headers:{'Content-Type':'application/json',Authorization:'Bearer ' + $('updateOwnerKey').value.trim()}, body:'{}'});
      const result = await response.json();
      if (!response.ok) throw Error(MusicI18n.message(result.error || 'Update failed'));
      status = result;
      if (action === 'install') { restarting = true; $('updateRestartConsent').checked = false; }
    } catch (error) { toast(error.message); }
    finally { pending = false; render(); }
  }
  group.addEventListener('toggle', refresh);
  $('checkUpdates').onclick = () => run('check');
  $('installUpdate').onclick = () => run('install');
  $('updateRestartConsent').onchange = render;
  $('reloadAfterUpdate').onclick = () => location.reload();
  setInterval(refresh, 2000);
  globalThis.serverUpdates = {render, refresh};
})();
