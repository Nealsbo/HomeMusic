let operationsOffset = 0, operationsRequest = 0, operationsBusy = false, lastOperationId = null;
const operationStates = {done:"Available to undo",undone:"Undone",failed:"Failed",pending:"Move in progress",undoing:"Undo in progress",recovery:"Recovery required"};
function rememberOperation(id) {
  lastOperationId = id; $('undoNotice').hidden = false;
}
function clearUndoNotice(id) {
  if (lastOperationId === id) { lastOperationId = null; $('undoNotice').hidden = true; }
}
async function loadOperations(offset = operationsOffset) {
  const request = ++operationsRequest;
  const result = await api('operations?' + new URLSearchParams({offset,limit:30}));
  if (request !== operationsRequest) return;
  if (offset && !result.items.length && result.total) return loadOperations(Math.max(0,offset - 30));
  operationsOffset = result.offset;
  $('operationsStatus').textContent = result.recovery ? tr("An unfinished move exists. Indexing and new moves are paused until recovery.") : tr("Shared log for all connections. Preserved after server restart.");
  $('operationsList').innerHTML = result.items.map(item => `<article class="operation-item"><div class="operation-heading"><b>${escapeHTML(item.labelMessage ? MusicI18n.renderMessage(item.labelMessage) : MusicI18n.message(item.label))}</b><span>${escapeHTML(tr(operationStates[item.state] || item.state))}</span></div><small class="muted">${escapeHTML(new Date(item.created * 1000).toLocaleString(MusicI18n.locale))}</small><ul>${(item.detailMessages || item.details).map(line => `<li>${escapeHTML(typeof line === 'object' ? MusicI18n.renderMessage(line) : MusicI18n.message(line))}</li>`).join('')}</ul>${item.error ? `<p class="operation-error">${escapeHTML(MusicI18n.message(item.error))}</p>` : ''}${item.canUndo ? `<button type="button" class="secondary" data-undo-operation="${escapeHTML(item.id)}" ${operationsBusy ? 'disabled' : ''}>${escapeHTML(tr("Undo operation"))}</button>` : item.canRecover ? `<button type="button" class="secondary" data-recover-operation="${escapeHTML(item.id)}" ${operationsBusy ? 'disabled' : ''}>${escapeHTML(tr("Restore state before attempt"))}</button>` : ''}</article>`).join('') || ('<p class="muted">' + escapeHTML(tr("No operations with undo support yet.")) + '</p>');
  $('operationsPrevious').disabled = operationsBusy || offset === 0;
  $('operationsNext').disabled = operationsBusy || offset + result.items.length >= result.total;
  $('operationsPage').textContent = result.total ? tr('{start}–{end} of {total}', {start:offset + 1,end:offset + result.items.length,total:result.total}) : ('0 ' + tr("operations"));
}
async function undoOperation(id) {
  if (operationsBusy) return;
  operationsBusy = true; $('undoLast').disabled = true;
  try {
    await api('undo',{id}); clearUndoNotice(id); await refresh();
    toast(tr("Operation undone"));
  } finally {
    operationsBusy = false; $('undoLast').disabled = false;
    if (view === 'operations') await loadOperations().catch(e => { $('operationsStatus').textContent = e.message; });
  }
}
async function recoverOperation(id) {
  if (operationsBusy) return;
  operationsBusy = true;
  try {
    await api('operation-recover',{id}); clearUndoNotice(id); await refresh();
    toast(tr("State restored to before the interrupted attempt"));
  } finally {
    operationsBusy = false;
    if (view === 'operations') await loadOperations().catch(e => { $('operationsStatus').textContent = e.message; });
  }
}
$('undoLast').onclick = handle(() => lastOperationId ? undoOperation(lastOperationId) : undefined);
$('openOperations').onclick = () => showView('operations');
$('openRecoveryOperations').onclick = () => showView('operations');
$('operationsRefresh').onclick = handle(() => loadOperations());
$('operationsPrevious').onclick = handle(() => loadOperations(Math.max(0,operationsOffset - 30)));
$('operationsNext').onclick = handle(() => loadOperations(operationsOffset + 30));
$('operationsList').onclick = handle(event => {
  const button = event.target.closest('[data-undo-operation],[data-recover-operation]'); if (!button) return;
  return button.dataset.undoOperation ? undoOperation(button.dataset.undoOperation) : recoverOperation(button.dataset.recoverOperation);
});
setInterval(() => {
  if (view === 'operations' && !document.hidden && !operationsBusy) loadOperations().catch(e => { $('operationsStatus').textContent = (tr("Could not refresh the operation log:") + " ") + e.message; });
},3000);
