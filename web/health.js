let healthReport = null, healthOffset = 0, healthRequest = 0, healthActionBusy = false;
const healthLabels = {missing:"Missing files",problems:"Availability and changes",metadata:"Tag and cover errors",exact:"Exact duplicates",similar:"Matching titles"};
$('healthCategory').value ||= 'missing';
function renderHealth() {
  const report = healthReport, running = report?.state === 'running';
  $('healthQuick').disabled = healthActionBusy || running;
  $('healthDuplicates').disabled = healthActionBusy || running;
  $('healthCancel').disabled = healthActionBusy || !running;
  $('healthPrevious').disabled = healthActionBusy || !report || healthOffset === 0;
  $('healthNext').disabled = healthActionBusy || !report || healthOffset + report.items.length >= report.categoryTotal;
  if (!report) return;
  const stateText = {idle:tr("No check has been run yet"),running:tr("Check in progress"),done:tr("Check completed"),cancelled:tr("Check stopped; results are incomplete"),failed:tr("Check error")}[report.state];
  const phase = {catalog:tr("Catalog snapshot"),availability:tr("Availability check"),hashing:tr("Content comparison"),cancelling:tr("Stopping the check")}[report.phase];
  $('healthStatus').textContent = stateText + (running && phase ? ' · ' + phase : '') + (report.error ? ': ' + MusicI18n.message(report.error) : '');
  $('healthProgress').max = Math.max(1,report.phase === 'hashing' ? report.hashTotal : report.total);
  $('healthProgress').value = report.phase === 'hashing' ? report.hashed : report.checked;
  $('healthProgress').hidden = report.state === 'idle';
  $('healthInfo').textContent = report.state === 'idle' ? '' : `${tr("Files checked:")} ${report.checked} / ${report.total}. ${tr("Candidates processed:")} ${report.hashed} / ${report.hashTotal}. ${tr("Read for comparison:")} ${bytes(report.bytesRead)}.` + (report.started ? (' ' + tr("Started:") + " ") + new Date(report.started * 1000).toLocaleString(MusicI18n.locale) + '.' : '');
  $('healthCounts').innerHTML = Object.entries(healthLabels).map(([key,label]) => {
    const unchecked = key === 'exact' && report.mode === 'quick';
    const detail = unchecked ? (' · ' + tr("not checked")) : key === 'exact' ? (' · ' + tr("groups:") + " ") + report.exactGroups : key === 'similar' ? (' · ' + tr("groups:") + " ") + report.similarGroups : '';
    return `<div class="stat-card"><b>${unchecked ? '—' : report.counts[key]}</b><span>${escapeHTML(tr(label))}${escapeHTML(detail)}</span></div>`;
  }).join('');
  $('healthPage').textContent = report.categoryTotal ? `${healthOffset + 1}–${healthOffset + report.items.length} ${tr("of")} ${report.categoryTotal}` : ('0 ' + tr("entries"));
  $('healthResults').innerHTML = report.items.map(item => `<article class="health-item">${item.group ? `<small>${escapeHTML(tr("Group"))} ${item.groupNumber} · ${escapeHTML(tr("files:"))} ${item.groupSize}</small>` : ''}<b>${escapeHTML(item.title || item.path)}</b><span>${escapeHTML(item.artist || tr("No artist"))}</span><code>${escapeHTML(item.path)}</code><p>${item.reason ? escapeHTML(MusicI18n.message(item.reason)) : bytes(item.size)}</p><button type="button" class="text-button" data-health-track="${escapeHTML(item.id)}">${escapeHTML(tr("Show in library"))}</button></article>`).join('');
  $('healthEmpty').hidden = report.items.length > 0;
  $('healthEmpty').textContent = report.state === 'idle' ? tr("Start a collection check.") : report.category === 'exact' && report.mode === 'quick' ? tr("Run “Find duplicates” to compare file contents.") : running ? tr("No results in this category yet. The check is still running.") : tr("No results in this category.");
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
  if (!track) return toast(tr("This entry is no longer in the current catalog. Its path is saved in the report."));
  setHomeMode('table',false); $('folderFilter').value = '*'; $('search').value = track.path; showView('library');
};
setInterval(() => {
  if (view === 'health' && !document.hidden && !healthActionBusy) loadHealth().catch(e => { $('healthStatus').textContent = (tr("Could not refresh the report:") + " ") + e.message; });
},2000);
