/* Commands address a browser session, never all tabs sharing a device name. */
const commandResults = new Map();
let commandPollBusy = false, devicesRefreshBusy = false, deviceSessions = [], watchedCommand = null;
const deviceStates = {idle:'Ожидание',playing:'Воспроизведение',paused:'Пауза',buffering:'Буферизация',ended:'Завершено',error:'Ошибка'};
function playerSnapshot() {
  return JSON.parse(JSON.stringify({queueModel:queueModel.snapshot(),position:audio.currentTime || 0,
    playing:!audio.paused, repeating,queuePlaylistId,queueName,
    guard:{generation:playbackGeneration,entryId:queueModel.currentEntryId}}));
}
function applySnapshot(snapshot) {
  queueModel.restore(snapshot.queueModel,trackMap); shuffled = queueModel.shuffled;
  repeating = !!snapshot.repeating; queuePlaylistId = snapshot.queuePlaylistId || null; queueName = snapshot.queueName || 'Перенесённая очередь';
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
    const loaded = () => finish(generation === playbackGeneration ? null : Error('Трек был изменён на устройстве'));
    const failed = () => finish(Error('Не удалось загрузить трек'));
    const timer = setTimeout(() => finish(Error('Устройство не успело загрузить трек')),12000);
    audio.addEventListener('loadedmetadata',loaded,{once:true}); audio.addEventListener('error',failed,{once:true});
  });
}
async function importPlayerSnapshot(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.position) || snapshot.position < 0 || typeof snapshot.playing !== 'boolean') throw Error('Некорректный снимок воспроизведения');
  const checked = new MusicQueue();
  if (!checked.restore(snapshot.queueModel,trackMap) || !checked.current ||
      checked.entries.length !== snapshot.queueModel.entries.length) throw Error('Не все треки очереди доступны. Обновите медиатеку на устройстве.');
  const previous = playerSnapshot();
  applySnapshot(snapshot);
  const generation = playbackGeneration + 1;
  try {
    let loadTimer;
    try {
      await Promise.race([loadCurrent(snapshot.playing,snapshot.position), new Promise((_,reject) => {
        loadTimer = setTimeout(() => reject(Error('Время загрузки принимающего плеера истекло')),12000);
      })]);
    } finally { clearTimeout(loadTimer); }
    if (playbackState === 'error') throw Error(playbackError || 'Ошибка воспроизведения');
    await waitForMediaMetadata(generation);
    if (generation !== playbackGeneration) throw Error('Трек был изменён на устройстве');
    audio.currentTime = Math.min(snapshot.position,Number.isFinite(audio.duration) ? Math.max(0,audio.duration - .1) : snapshot.position);
    if (snapshot.playing && audio.paused) throw Error('Браузер не разрешил запуск. Нажмите воспроизведение на принимающем устройстве и повторите перенос.');
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
  if (command.expires && Date.now() / 1000 >= command.expires) throw Error('Команда устарела');
  switch (command.action) {
    case 'play':
      if (!currentId) {
        if (!queueModel.current && !queueModel.next()) throw Error('Очередь пуста');
        await loadCurrent();
      } else { audioWave.unlock(); await audio.play(); }
      if (audio.paused || playbackState === 'error') throw Error(playbackError || 'Браузер ожидает нажатия воспроизведения на этом устройстве');
      break;
    case 'pause':
      if (command.value?.guard && (command.value.guard.generation !== playbackGeneration || command.value.guard.entryId !== queueModel.currentEntryId)) throw Error('Исходный трек изменился; он не был остановлен');
      audio.pause(); break;
    case 'next': case 'previous': await step(command.action === 'next' ? 1 : -1); break;
    case 'seek':
      if (!currentId || !Number.isFinite(audio.duration) || audio.duration <= 0) throw Error('Перемотка пока недоступна');
      sampleListening(false); audio.currentTime = Math.min(command.value,audio.duration); sampleListening(!audio.paused,true); persistPlayer(); break;
    case 'volume': $('volume').value = command.value; $('volume').oninput(); break;
    case 'export':
      if (!currentId) throw Error('На исходном устройстве не выбран трек');
      const snapshot = playerSnapshot();
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 6 * 1024 * 1024) throw Error('Очередь слишком велика для переноса (лимит снимка — 6 МБ)');
      return {snapshot};
    case 'import': await importPlayerSnapshot(command.value); break;
    default: throw Error('Неизвестная команда');
  }
  if (['next','previous'].includes(command.action) && playbackState === 'error') throw Error(playbackError || 'Ошибка воспроизведения');
  await reportPlayback(); return {};
}
async function pollPlayerCommands() {
  if (commandPollBusy) return;
  commandPollBusy = true;
  try {
    const {command} = await api('control-poll',{clientId});
    if (!command) return;
    let result = commandResults.get(command.id);
    if (!result) {
      try { result = {ok:true,...await executePlayerCommand(command)}; }
      catch (error) { result = {ok:false,error:error.message}; }
      commandResults.set(command.id,result);
      if (commandResults.size > 100) commandResults.delete(commandResults.keys().next().value);
    }
    await api('control-ack',{clientId,id:command.id,...result});
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
  $('deviceDetails').textContent = c ? `${c.name} · ${c.clientId === clientId ? 'Этот плеер' : c.clientId.slice(-6)}\n${c.connected ? deviceStates[c.state] || c.state : 'Нет свежего отчёта'} · ${c.track?.title || 'Трек не выбран'}\n${clock(c.position)} / ${clock(c.duration)} · ${c.playlistName} · ${c.queueCount} треков` : 'Откройте плеер на другом устройстве или обновите страницу.';
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
    options($('deviceTarget'),deviceSessions.map(c => [c.clientId,`${c.name}${c.clientId === clientId ? ' · этот плеер' : ' · ' + c.clientId.slice(-6)}${c.connected ? '' : ' · не в сети'}`]),clientId);
    renderSelectedDevice();
  } finally { devicesRefreshBusy = false; }
}
async function sendDeviceCommand(action,value,target = $('deviceTarget').value,source = null) {
  if (!target) throw Error('Выберите устройство');
  const id = globalThis.crypto?.randomUUID?.() || 'cmd-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const result = await api('control',{id,target,action,value,source});
  watchedCommand = result.id;
  $('deviceCommandStatus').textContent = 'Команда отправлена. Ожидание подтверждения устройства…';
}
async function refreshCommandResult() {
  const id = watchedCommand; if (!id) return;
  try {
    const result = await api('control-result',{id});
    if (id !== watchedCommand) return;
    if (result.state !== 'pending') {
      watchedCommand = null;
      $('deviceCommandStatus').textContent = result.state === 'done' ? 'Устройство подтвердило выполнение.' : 'Не выполнено: ' + result.error;
    } else if (result.action === 'transfer') {
      $('deviceCommandStatus').textContent = ({export:'Получение очереди исходного плеера…',import:'Загрузка трека на принимающем устройстве…',pause:'Новый плеер готов. Ожидание паузы исходного…'})[result.phase] || 'Ожидание переноса…';
    }
  } catch (error) { if (id === watchedCommand) $('deviceCommandStatus').textContent = 'Не удалось получить подтверждение: ' + error.message; }
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
  if ($('devicesDialog').open) refreshDevices().catch(e => { $('deviceDetails').textContent = 'Нет связи: ' + e.message; });
},2000);
