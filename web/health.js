let healthReport = null, healthOffset = 0, healthRequest = 0, healthActionBusy = false;
const healthLabels = {missing:'Отсутствующие файлы',problems:'Доступность и изменения',metadata:'Ошибки тегов и обложек',exact:'Точные дубликаты',similar:'Совпадения названий'};
$('healthCategory').value ||= 'missing';
function renderHealth() {
  const report = healthReport, running = report?.state === 'running';
  $('healthQuick').disabled = healthActionBusy || running;
  $('healthDuplicates').disabled = healthActionBusy || running;
  $('healthCancel').disabled = healthActionBusy || !running;
  $('healthPrevious').disabled = healthActionBusy || !report || healthOffset === 0;
  $('healthNext').disabled = healthActionBusy || !report || healthOffset + report.items.length >= report.categoryTotal;
  if (!report) return;
  const stateText = {idle:'Проверка ещё не запускалась',running:'Проверка выполняется',done:'Проверка завершена',cancelled:'Проверка остановлена; результаты неполные',failed:'Ошибка проверки'}[report.state];
  const phase = {catalog:'Снимок каталога',availability:'Проверка доступности',hashing:'Сравнение содержимого',cancelling:'Остановка проверки'}[report.phase];
  $('healthStatus').textContent = stateText + (running && phase ? ' · ' + phase : '') + (report.error ? ': ' + report.error : '');
  $('healthProgress').max = Math.max(1,report.phase === 'hashing' ? report.hashTotal : report.total);
  $('healthProgress').value = report.phase === 'hashing' ? report.hashed : report.checked;
  $('healthProgress').hidden = report.state === 'idle';
  $('healthInfo').textContent = report.state === 'idle' ? '' : `Проверено файлов: ${report.checked} / ${report.total}. Обработано кандидатов: ${report.hashed} / ${report.hashTotal}. Прочитано для сравнения: ${bytes(report.bytesRead)}.` + (report.started ? ' Начало: ' + new Date(report.started * 1000).toLocaleString('ru-RU') + '.' : '');
  $('healthCounts').innerHTML = Object.entries(healthLabels).map(([key,label]) => {
    const unchecked = key === 'exact' && report.mode === 'quick';
    const detail = unchecked ? ' · не проверялись' : key === 'exact' ? ' · групп: ' + report.exactGroups : key === 'similar' ? ' · групп: ' + report.similarGroups : '';
    return `<div class="stat-card"><b>${unchecked ? '—' : report.counts[key]}</b><span>${label}${detail}</span></div>`;
  }).join('');
  $('healthPage').textContent = report.categoryTotal ? `${healthOffset + 1}–${healthOffset + report.items.length} из ${report.categoryTotal}` : '0 записей';
  $('healthResults').innerHTML = report.items.map(item => `<article class="health-item">${item.group ? `<small>Группа ${item.groupNumber} · файлов: ${item.groupSize}</small>` : ''}<b>${escapeHTML(item.title || item.path)}</b><span>${escapeHTML(item.artist || 'Без исполнителя')}</span><code>${escapeHTML(item.path)}</code><p>${item.reason ? escapeHTML(item.reason) : bytes(item.size)}</p><button type="button" class="text-button" data-health-track="${escapeHTML(item.id)}">Показать в медиатеке</button></article>`).join('');
  $('healthEmpty').hidden = report.items.length > 0;
  $('healthEmpty').textContent = report.state === 'idle' ? 'Запустите проверку коллекции.' : report.category === 'exact' && report.mode === 'quick' ? 'Для сравнения содержимого запустите «Найти дубликаты».' : running ? 'В этом разделе пока нет результатов. Проверка продолжается.' : 'В этом разделе результатов нет.';
}
async function loadHealth(offset = healthOffset) {
  const request = ++healthRequest;
  const query = new URLSearchParams({category:$('healthCategory').value,offset,limit:50});
  const report = await api('health?' + query);
  if (request !== healthRequest) return;
  if (healthReport?.jobId !== report.jobId && offset !== 0) return loadHealth(0);
  healthReport = report; healthOffset = report.offset; renderHealth();
}
async function startHealth(mode) {
  healthActionBusy = true; renderHealth();
  try { await api('health-start',{mode}); await loadHealth(0); }
  finally { healthActionBusy = false; renderHealth(); }
}
$('healthQuick').onclick = handle(() => startHealth('quick'));
$('healthDuplicates').onclick = handle(() => startHealth('duplicates'));
$('healthCancel').onclick = handle(async () => {
  if (!healthReport?.jobId) return;
  await api('health-cancel',{jobId:healthReport.jobId}); await loadHealth();
});
$('healthRefresh').onclick = handle(() => loadHealth());
$('healthCategory').onchange = handle(() => loadHealth(0));
$('healthPrevious').onclick = handle(() => loadHealth(Math.max(0,healthOffset - 50)));
$('healthNext').onclick = handle(() => loadHealth(healthOffset + 50));
$('healthResults').onclick = event => {
  const button = event.target.closest('[data-health-track]'); if (!button) return;
  const track = trackMap.get(button.dataset.healthTrack);
  if (!track) return toast('Запись больше не находится в текущем каталоге. Путь сохранён в отчёте.');
  setHomeMode('table',false); $('folderFilter').value = '*'; $('search').value = track.path; showView('library');
};
setInterval(() => {
  if (view === 'health' && !document.hidden && !healthActionBusy) loadHealth().catch(e => { $('healthStatus').textContent = 'Не удалось обновить отчёт: ' + e.message; });
},2000);
