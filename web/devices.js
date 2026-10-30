/* Commands address a browser session, never all tabs sharing a device name. */
const commandResults = new Map(browserSession.commands);
let commandResultsOwner = clientId;
let commandPollBusy = false, devicesRefreshBusy = false, deviceSessions = [], watchedCommand = null;
const deviceStates = {idle:"Idle",playing:"Playing",paused:"Paused",buffering:"Buffering",ended:"Completed",error:"Error"};
function playerSnapshot() {
  return JSON.parse(JSON.stringify({queueModel:queueModel.snapshot(),position:audio.currentTime || 0,
    playing:!audio.paused, repeating,queuePlaylistId,queueName,
    guard:{pageId:browserSession.pageId,generation:playbackGeneration,entryId:queueModel.currentEntryId}}));
}
function applySnapshot(snapshot) {
  queueModel.restore(snapshot.queueModel,trackMap); shuffled = queueModel.shuffled;
  repeating = !!snapshot.repeating; queuePlaylistId = snapshot.queuePlaylistId || null; queueName = snapshot.queueName || tr("Transferred queue");
  for (const [id,value] of [['shuffle',shuffled],['repeat',repeating]]) {
    $(id).classList.toggle('enabled',value); $(id).setAttribute('aria-pressed',String(value));
  }
  syncQueue();
}
function waitForMediaMetadata(generation) {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const finish = error => {
      clearTimeout(timer); audio.removeEventListener?.('loadedmetadata',loaded); audio.removeEventListener?.('error',failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish(generation === playbackGeneration ? null : Error(tr("The track was changed on the device")));
    const failed = () => finish(Error(tr("Could not load the track")));
    const timer = setTimeout(() => finish(Error(tr("The device timed out while loading the track"))),12000);
    audio.addEventListener('loadedmetadata',loaded,{once:true}); audio.addEventListener('error',failed,{once:true});
  });
}
async function importPlayerSnapshot(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.position) || snapshot.position < 0 || typeof snapshot.playing !== 'boolean') throw Error(tr("Invalid playback snapshot"));
  const checked = new MusicQueue();
  if (!checked.restore(snapshot.queueModel,trackMap) || !checked.current ||
      checked.entries.length !== snapshot.queueModel.entries.length) throw Error(tr("Some queue tracks are unavailable. Refresh the library on the device."));
  const previous = playerSnapshot();
  applySnapshot(snapshot);
  const generation = playbackGeneration + 1;
  try {
    let loadTimer;
    try {
      await Promise.race([loadCurrent(snapshot.playing,snapshot.position), new Promise((_,reject) => {
        loadTimer = setTimeout(() => reject(Error(tr("The receiving player timed out while loading"))),12000);
      })]);
    } finally { clearTimeout(loadTimer); }
    if (playbackState === 'error') throw Error(playbackError || tr("Playback error"));
    await waitForMediaMetadata(generation);
    if (generation !== playbackGeneration) throw Error(tr("The track was changed on the device"));
    audio.currentTime = Math.min(snapshot.position,Number.isFinite(audio.duration) ? Math.max(0,audio.duration - .1) : snapshot.position);
    if (snapshot.playing && audio.paused) throw Error(tr("The browser blocked playback. Press play on the receiving device and retry the transfer."));
    persistPlayer(); await reportPlayback();
  } catch (error) {
    // A local action during loading takes precedence over restoring the old queue.
    if (generation === playbackGeneration) {
      applySnapshot(previous);
      if (currentId) {
        await loadCurrent(false,previous.position);
        if (previous.playing) { try { await audio.play(); } catch {} }
      } else stopPlayback();
    }
    throw error;
  }
}
async function executePlayerCommand(command) {
  if (command.expires && Date.now() / 1000 >= command.expires) throw Error(tr("Command expired"));
  switch (command.action) {
    case 'play':
      if (!currentId) {
        if (!queueModel.current && !queueModel.next()) throw Error(tr("The queue is empty"));
        await loadCurrent();
      } else { audioWave.unlock(); await audio.play(); }
      if (audio.paused || playbackState === 'error') throw Error(playbackError || tr("Press play on this device to allow playback"));
      break;
    case 'pause':
      if (command.value?.guard && ((command.value.guard.pageId && command.value.guard.pageId !== browserSession.pageId) || command.value.guard.generation !== playbackGeneration || command.value.guard.entryId !== queueModel.currentEntryId)) throw Error(tr("The source track changed; playback was not stopped"));
      audio.pause(); break;
    case 'next': case 'previous': await step(command.action === 'next' ? 1 : -1); break;
    case 'seek':
      if (!currentId || !Number.isFinite(audio.duration) || audio.duration <= 0) throw Error(tr("Seeking is not available yet"));
      sampleListening(false); audio.currentTime = Math.min(command.value,audio.duration); sampleListening(!audio.paused,true); persistPlayer(); break;
    case 'volume': $('volume').value = command.value; $('volume').oninput(); break;
    case 'export':
      if (!currentId) throw Error(tr("No track selected on the source device"));
      const snapshot = playerSnapshot();
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 6 * 1024 * 1024) throw Error(tr("The queue is too large to transfer (snapshot limit: 6 MB)"));
      return {snapshot};
    case 'import': await importPlayerSnapshot(command.value); break;
    default: throw Error(tr("Unknown command"));
  }
  if (['next','previous'].includes(command.action) && playbackState === 'error') throw Error(playbackError || tr("Playback error"));
  await reportPlayback(); return {};
}
async function pollPlayerCommands() {
  await browserSession.ready;
  if (commandResultsOwner !== clientId) { commandResults.clear(); commandResultsOwner = clientId; }
  if (commandPollBusy) return;
  commandPollBusy = true;
  const targetId = clientId;
  try {
    const {command} = await api('control-poll',{clientId:targetId});
    if (clientId !== targetId) return;
    if (!command) return;
    let result = commandResults.get(command.id);
    if (!result) {
      // If navigation interrupts an asynchronous command, do not execute it again.
      browserSession.rememberCommand(command.id,{ok:false,error:'Command expired'});
      try { result = {ok:true,...await executePlayerCommand(command)}; }
      catch (error) { result = {ok:false,error:MusicI18n.source(error.message)}; }
      commandResults.set(command.id,result);
      browserSession.rememberCommand(command.id,result);
      if (commandResults.size > 100) commandResults.delete(commandResults.keys().next().value);
    }
    await api('control-ack',{clientId:targetId,id:command.id,...result});
    // Confirmed exports no longer need a full queue snapshot in the retry cache.
    commandResults.set(command.id,{ok:result.ok,error:result.error});
  } catch {} // Retrying the acknowledgement does not execute the command again.
  finally { commandPollBusy = false; }
}
function selectedDevice() { return deviceSessions.find(c => c.clientId === $('deviceTarget').value); }
function renderSelectedDevice() {
  const c = selectedDevice(), available = !!c?.connected && c.controlVersion === 1;
  for (const id of ['remotePlay','remotePause','remotePrevious','remoteNext','remoteSeek','remoteVolume']) $(id).disabled = !available;
  $('transferHere').disabled = !available || c.clientId === clientId;
  $('transferThere').disabled = !available || c.clientId === clientId || !currentId;
  $('deviceDetails').textContent = c ? `${c.name} · ${c.clientId === clientId ? tr("This player") : c.clientId.slice(-6)}\n${c.connected ? tr(deviceStates[c.state] || c.state) : tr("No recent report")} · ${c.track?.title || tr("No track selected")}\n${clock(c.position)} / ${clock(c.duration)} · ${c.playlistName} · ${c.queueCount} ${tr("tracks")}` : tr("Open the player on another device or refresh its page.");
  $('deviceQueue').innerHTML = c ? c.queue.map(t => `<li${t.entryId === c.queueEntryId ? ' class="enabled"' : ''}>${escapeHTML(t.title)}</li>`).join('') : '';
  // Do not move a slider while the user is adjusting it.
  if (document.activeElement !== $('remoteSeek')) { $('remoteSeek').max = c?.duration || 0; $('remoteSeek').value = c?.position || 0; }
  if (document.activeElement !== $('remoteVolume')) $('remoteVolume').value = c?.volume ?? .75;
}
async function refreshDevices() {
  if (devicesRefreshBusy) return;
  devicesRefreshBusy = true;
  try {
    const status = await api('status'); deviceSessions = status.clients;
    options($('deviceTarget'),deviceSessions.map(c => [c.clientId,`${c.name}${c.clientId === clientId ? (' · ' + tr("this player")) : ' · ' + c.clientId.slice(-6)}${c.connected ? '' : (' · ' + tr("offline"))}`]),clientId);
    renderSelectedDevice();
  } finally { devicesRefreshBusy = false; }
}
async function sendDeviceCommand(action,value,target = $('deviceTarget').value,source = null) {
  if (!target) throw Error(tr("Select a device"));
  const id = globalThis.crypto?.randomUUID?.() || 'cmd-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const result = await api('control',{id,target,action,value,source});
  watchedCommand = result.id;
  $('deviceCommandStatus').textContent = tr("Command sent. Waiting for device confirmation…");
}
async function refreshCommandResult() {
  const id = watchedCommand; if (!id) return;
  try {
    const result = await api('control-result',{id});
    if (id !== watchedCommand) return;
    if (result.state !== 'pending') {
      watchedCommand = null;
      $('deviceCommandStatus').textContent = result.state === 'done' ? tr("The device confirmed completion.") : (tr("Failed:") + " ") + MusicI18n.message(result.error);
    } else if (result.action === 'transfer') {
      $('deviceCommandStatus').textContent = ({export:tr("Getting the source player’s queue…"),import:tr("Loading the track on the receiving device…"),pause:tr("The new player is ready. Waiting for the source to pause…")})[result.phase] || tr("Waiting for transfer…");
    }
  } catch (error) { if (id === watchedCommand) $('deviceCommandStatus').textContent = (tr("Could not get confirmation:") + " ") + error.message; }
}
$('devicesButton').onclick = handle(async () => { $('devicesDialog').showModal(); await reportPlayback(); await refreshDevices(); });
$('deviceTarget').onchange = renderSelectedDevice;
$('refreshDevices').onclick = handle(refreshDevices);
for (const [id,action] of [['remotePlay','play'],['remotePause','pause'],['remotePrevious','previous'],['remoteNext','next']]) $(id).onclick = handle(() => sendDeviceCommand(action));
$('remoteSeek').onchange = handle(e => sendDeviceCommand('seek',Number(e.target.value)));
$('remoteVolume').onchange = handle(e => sendDeviceCommand('volume',Number(e.target.value)));
$('transferHere').onclick = handle(() => sendDeviceCommand('transfer',null,clientId,$('deviceTarget').value));
$('transferThere').onclick = handle(() => sendDeviceCommand('transfer',null,$('deviceTarget').value,clientId));
setInterval(pollPlayerCommands,1000);
setInterval(() => {
  refreshCommandResult();
  if ($('devicesDialog').open) refreshDevices().catch(e => { $('deviceDetails').textContent = (tr("Disconnected:") + " ") + e.message; });
},2000);
