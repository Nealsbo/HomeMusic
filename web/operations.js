let operationsOffset = 0, operationsRequest = 0, operationsBusy = false, lastOperationId = null;
const operationStates = {done:'Можно отменить',undone:'Отменено',failed:'Не выполнено',pending:'Перемещение выполняется',undoing:'Отмена выполняется',recovery:'Требует восстановления'};
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
  $('operationsStatus').textContent = result.recovery ? 'Есть незавершённое перемещение. Индексирование и новые перемещения приостановлены до восстановления.' : 'Общий журнал для всех подключений. Сохраняется после перезапуска сервера.';
  $('operationsList').innerHTML = result.items.map(item => `<article class="operation-item"><div class="operation-heading"><b>${escapeHTML(item.label)}</b><span>${escapeHTML(operationStates[item.state] || item.state)}</span></div><small class="muted">${escapeHTML(new Date(item.created * 1000).toLocaleString('ru-RU'))}</small><ul>${item.details.map(line => `<li>${escapeHTML(line)}</li>`).join('')}</ul>${item.error ? `<p class="operation-error">${escapeHTML(item.error)}</p>` : ''}${item.canUndo ? `<button type="button" class="secondary" data-undo-operation="${escapeHTML(item.id)}" ${operationsBusy ? 'disabled' : ''}>Отменить операцию</button>` : item.canRecover ? `<button type="button" class="secondary" data-recover-operation="${escapeHTML(item.id)}" ${operationsBusy ? 'disabled' : ''}>Восстановить состояние до попытки</button>` : ''}</article>`).join('') || '<p class="muted">Пока нет операций с поддержкой отмены.</p>';
  $('operationsPrevious').disabled = operationsBusy || offset === 0;
  $('operationsNext').disabled = operationsBusy || offset + result.items.length >= result.total;
  $('operationsPage').textContent = result.total ? `${offset + 1}–${offset + result.items.length} из ${result.total}` : '0 операций';
}
async function undoOperation(id) {
  if (operationsBusy) return;
  operationsBusy = true; $('undoLast').disabled = true;
  try {
    await api('undo',{id}); clearUndoNotice(id); await refresh();
    toast('Операция отменена');
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
    toast('Восстановлено состояние до прерванной попытки');
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
  if (view === 'operations' && !document.hidden && !operationsBusy) loadOperations().catch(e => { $('operationsStatus').textContent = 'Не удалось обновить журнал: ' + e.message; });
},3000);
