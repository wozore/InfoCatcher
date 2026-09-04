import { request, writeRequest, listFrom } from '../api.js';
import {
  state,
  $,
  addText,
  addBadge,
  clearChildren,
  setLoadState,
  showNotice,
} from '../state.js';
import {
  itemTitle,
  handleMutationError,
} from './common.js';

const PENDING_STATE_ZH = Object.freeze({
  pending_review: '待审核',
  approved_pending: '待生成',
  discarded: '已丢弃',
  completed: '已完成',
  approved: '待生成',
});

const BLOCKING_ZH = Object.freeze({
  NOT_REVIEWED: '尚未审核',
  DISCARDED: '已丢弃',
  ALREADY_EXISTS: '正式知识库已存在',
});

export async function reviewPending(kind, candidateKey, decision, button, onRefreshAll) {
  const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
  const route = `feedback/${kind}/${encodeURIComponent(candidateKey)}/review`;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    await writeRequest(route, resource, { candidate_key: candidateKey, decision });
    showNotice(decision === 'approved' ? '待补卡已批准，可进入生成计划。' : '待补卡已丢弃，后续提取不会复活它。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, resource, kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', button);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export function renderPendingCards(kind, payload, onRefreshAll) {
  const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
  const root = $(`#${resource}List`);
  if (!root) return;
  clearChildren(root);
  const items = listFrom(payload, ['items']);
  state.items[resource] = items;
  if (!items.length) addText(root, 'p', '当前没有待补卡。', 'empty-state');
  for (const item of items) {
    const article = document.createElement('article');
    article.className = 'queue-item';
    const content = document.createElement('div');
    content.className = 'item-content';
    addText(content, 'h3', itemTitle(item), 'item-title');
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    addBadge(meta, item.review_status || 'pending', item.review_status || 'pending');
    const stateName = PENDING_STATE_ZH[item.workflow_state] || item.workflow_state || '待审核';
    addBadge(meta, stateName, String(item.workflow_state || 'pending_review'));
    if (kind === 'tools' && item.detail_kind_hint) addText(meta, item.detail_kind_hint);
    content.appendChild(meta);
    if (item.candidate_key) addText(content, 'p', `candidate_key：${item.candidate_key}`, 'item-id');
    const blockedText = (Array.isArray(item.blocking_reasons) ? item.blocking_reasons : [])
      .map(reason => BLOCKING_ZH[reason] || reason).join('；');
    if (blockedText) addText(content, 'p', blockedText, 'item-blocked');
    if (item.review_status === 'pending' && item.workflow_state !== 'completed') {
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'button button-danger';
      discard.textContent = '丢弃';
      discard.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'discarded', discard, onRefreshAll));
      actions.appendChild(discard);
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'button button-primary';
      approve.textContent = '批准';
      approve.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'approved', approve, onRefreshAll));
      actions.appendChild(approve);
      content.appendChild(actions);
    }
    article.appendChild(document.createElement('span'));
    article.appendChild(content);
    root.appendChild(article);
  }
  setLoadState(kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', `${items.length} 条`, 'success');
}

export async function extractKnowledge(button, onRefreshAll) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '提取中…';
  try {
    const result = await writeRequest('knowledge/extract', 'news', {});
    showNotice(`提取完成：新增/更新工具 ${Number(result?.tools_pending || 0)}、概念 ${Number(result?.concepts_pending || 0)}。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'news', 'knowledgeLoopState', button);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export function setupKnowledgePanel(onRefreshAll) {
  const extractBtn = $('#knowledgeExtractButton');
  if (extractBtn) {
    extractBtn.addEventListener('click', (event) => extractKnowledge(event.currentTarget, onRefreshAll));
  }
}
