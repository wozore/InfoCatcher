import { request, unwrap } from '../api.js';
import {
  state,
  $,
  text,
  first,
  itemId,
  addText,
  clearChildren,
  showNotice,
} from '../state.js';
import {
  queueItem,
  renderQueue,
} from './common.js';

const HISTORY_REASON_ZH = Object.freeze({
  newer_evidence: '已被后续证据替代',
  source_replaced: '来源已被登记表替换',
  up_to_date: '当前来源暂无新的更新',
  completed: '已完成人工处理',
  not_actionable: '当前不是可操作待办',
});

export function renderToolPreview(payload) {
  const root = $('#toolPreview');
  if (!root) return;
  clearChildren(root);
  state.toolPreview = payload && payload.ok === true ? payload : null;
  const apply = $('#toolApplyButton');
  if (apply) apply.disabled = !state.toolPreview;
  if (!state.toolPreview) {
    addText(root, 'p', payload?.code ? `无法生成预览：${text(payload.code)}` : '当前没有可 Apply 的已批准工具更新。', 'muted');
    const stateEl = $('#toolPreviewState');
    if (stateEl) stateEl.textContent = '无可用预览';
    return;
  }
  const stateEl = $('#toolPreviewState');
  if (stateEl) stateEl.textContent = `${state.toolPreview.count} 项待确认`;
  addText(root, 'p', `Catalog revision：${state.toolPreview.expected_revision}`, 'muted');
  addText(root, 'p', `确认语句：APPLY TOOL-UPDATES ${state.toolPreview.preview_hash}`, 'muted');
  const list = document.createElement('ol');
  list.className = 'preview-list';
  for (const change of state.toolPreview.changes || []) {
    const row = document.createElement('li');
    addText(row, 'span', `${text(change.title || change.detail_id || change.id || '工具')}：${text(change.before || change.previous_date || '—')} → ${text(change.after || change.proposed_date || '—')}`);
    list.appendChild(row);
  }
  root.appendChild(list);
}

export async function reviewToolUpdate(id, decision, button, onRefreshAll) {
  const item = state.items.toolUpdates.find((candidate) => itemId(candidate) === id);
  const rawStatus = first(item, ['status', 'review_status', 'state'], '');
  if (decision === 'approved' && (String(rawStatus).toLowerCase() === 'blocked' || item?.blocked === true || item?.is_blocked === true)) {
    showNotice('该条目属于 blocked 状态，不能直接批准。', 'error');
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    const result = await request(`tool-updates/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, expected_revision: state.revisions.toolUpdates }),
    });
    if (!result?.ok) throw new Error(result?.code || '审核状态更新失败');
    showNotice(decision === 'approved' ? '已批准该条更新，可生成更新预览。' : '已拒绝该条更新。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || '工具更新审核失败。', 'error');
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export function renderToolUpdates(payload, onRefreshAll) {
  const value = unwrap(payload) || {};
  const items = Array.isArray(value.items) ? value.items : [];
  renderQueue('toolUpdates', 'toolUpdatesList', items, 'toolUpdatesState', {
    actions: true,
    empty: '当前没有工具更新审核项。',
    onAction: (id, decision, button) => reviewToolUpdate(id, decision, button, onRefreshAll),
  });
  const history = Array.isArray(value.history) ? value.history : [];
  if (!history.length) return;
  const root = $('#toolUpdatesList');
  if (!root) return;
  const details = document.createElement('details');
  details.className = 'queue-history';
  addText(details, 'summary', `历史证据（${history.length}）`);
  const list = document.createElement('div');
  list.className = 'item-list';
  for (const item of history) {
    const wrapper = document.createElement('div');
    const reason = HISTORY_REASON_ZH[item.history_reason] || '已归入历史记录';
    addText(wrapper, 'p', reason, 'history-reason');
    wrapper.appendChild(queueItem(item, 'toolUpdates', { actions: false }));
    list.appendChild(wrapper);
  }
  details.appendChild(list);
  root.appendChild(details);
}

export async function previewToolUpdates(button) {
  button.disabled = true;
  try {
    const result = await request('tool-updates/preview');
    renderToolPreview(result);
    showNotice(result?.ok ? '工具更新预览已就绪，请输入确认语句后 Apply。' : (result?.code || '无法生成工具更新预览。'), result?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || '工具更新预览失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function applyToolUpdates(button, onRefreshAll) {
  const preview = state.toolPreview;
  if (!preview?.preview_hash) {
    showNotice('请先生成更新预览。', 'error');
    return;
  }
  const confirm = $('#toolApplyConfirm').value.trim();
  if (!confirm) {
    showNotice('请输入确认语句以确认正式写入。', 'error');
    return;
  }
  const expected = `APPLY TOOL-UPDATES ${preview.preview_hash}`;
  if (confirm !== expected) {
    showNotice('确认语句不匹配，未执行 Apply。', 'error');
    return;
  }
  const originalLabel = button.textContent;
  button.textContent = 'Apply 中…';
  button.disabled = true;
  try {
    const result = await request('tool-updates/apply', {
      method: 'POST',
      body: JSON.stringify({ expected_revision: preview.expected_revision, preview_hash: preview.preview_hash, confirm }),
    });
    if (!result?.ok) throw new Error(result?.code || '工具更新 Apply 被拒绝');
    $('#toolApplyConfirm').value = '';
    state.toolPreview = null;
    showNotice(`已 Apply ${Number(result.applied || result.count || preview.count)} 项工具更新。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || '工具更新 Apply 失败。', 'error');
  } finally {
    button.textContent = originalLabel;
    button.disabled = !state.toolPreview;
  }
}

export function setupToolUpdatePanel(onRefreshAll) {
  const prevBtn = $('#toolPreviewButton');
  if (prevBtn) prevBtn.addEventListener('click', (event) => previewToolUpdates(event.currentTarget));
  const applyBtn = $('#toolApplyButton');
  if (applyBtn) applyBtn.addEventListener('click', (event) => applyToolUpdates(event.currentTarget, onRefreshAll));
}
