import { request, unwrap, listFrom, ApiError } from '../api.js';
import {
  state,
  $,
  first,
  addText,
  addBadge,
  clearChildren,
  setLoadState,
  showNotice,
  uiHelpers,
} from '../state.js';
import { itemTitle } from './common.js';

export async function planConcept(button) {
  button.disabled = true;
  try {
    state.conceptPlan = await request('concepts/plan');
    const prepBtn = $('#conceptPrepareButton');
    if (prepBtn) prepBtn.disabled = !state.conceptPlan.ok;
    showNotice(state.conceptPlan.ok ? '概念计划已生成，请确认成本。' : '当前没有已批准概念待补卡。', state.conceptPlan.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || '概念计划失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function prepareConcept(button, onRefreshAll) {
  const plan = state.conceptPlan;
  if (!plan || !$('#conceptCostConfirm').checked) {
    showNotice('请先生成概念计划并确认成本。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('concepts/prepare', {
      method: 'POST',
      body: JSON.stringify({
        pending_revision: plan.pending_revision,
        glossary_revision: plan.glossary_revision,
        plan_hash: plan.plan_hash,
        confirm_cost: true,
      }),
    });
    if (!result?.ok) throw new Error(result?.code || '概念预览准备被阻断');
    showNotice('概念预览已生成，请逐项核对后 Apply。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || '概念预览准备失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export function renderKnowledgeConceptPreview(payload) {
  const root = $('#conceptPreviewList');
  if (!root) return;
  clearChildren(root);
  const items = listFrom(payload, ['items']);
  if (payload?.status === 'legacy_preview') {
    const completed = Array.isArray(payload.completed_terms) ? payload.completed_terms : [];
    addText(root, 'p', completed.length
      ? `存量概念预览不可提交；${completed.join('、')} 已在正式概念库中，无需再次 Apply。`
      : '存量概念预览缺少当前批次校验信息，不能 Apply；请重新生成概念预览。', 'item-blocked');
  } else if (payload?.status === 'no_preview') {
    addText(root, 'p', '尚未生成概念预览。请先生成计划并确认概念生成成本。', 'muted');
  }
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'concept-item';
    addText(row, 'h3', item.term || '未命名概念', 'item-title');
    addText(row, 'p', item.summary || '暂无摘要', 'concept-definition');
    root.appendChild(row);
  }
  state.conceptPreview = payload?.preview_hash ? payload : null;
  const applyBtn = $('#conceptApplyButton');
  if (applyBtn) applyBtn.disabled = !state.conceptPreview?.preview_hash;
}

export async function applyConcept(button, onRefreshAll) {
  const preview = state.conceptPreview;
  if (!preview?.preview_hash || !preview.items?.length) {
    showNotice('请先生成概念预览。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('concepts/apply', {
      method: 'POST',
      body: JSON.stringify({ apply_all: true, expected_revision: preview.base_revision }),
    });
    if (!result?.ok) throw new Error(result?.code || '概念 Apply 被拒绝');
    state.conceptPreview = null;
    showNotice('全部概念已写入正式知识库，但公开站点仍需显式重建 dist。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    state.conceptPreview = null;
    const applyBtn = $('#conceptApplyButton');
    if (applyBtn) applyBtn.disabled = true;
    showNotice(error instanceof ApiError && error.status === 409 ? '概念预览已过期，请刷新后重新生成。' : (error.message || '概念 Apply 失败。'), error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  } finally {
    if (state.conceptPreview) button.disabled = false;
  }
}

export function renderConcepts(items) {
  state.items.concepts = items;
  const root = $('#conceptsList');
  if (!root) return;
  clearChildren(root);
  if (!items.length) {
    addText(root, 'p', '当前没有概念预览。', 'empty-state');
  }
  for (const item of items) {
    const article = document.createElement('article');
    article.className = 'concept-item';
    const heading = addText(article, 'h3', itemTitle(item), 'item-title');
    const status = first(item, ['status', 'review_status', 'state'], 'preview');
    addBadge(heading, status, String(status).toLowerCase());
    const definition = first(item, ['definition', 'summary', 'description', 'preview'], '暂无摘要');
    addText(article, 'p', definition, 'concept-definition');
    uiHelpers.addSourceLink(article, first(item, ['url', 'source_url', 'official_url'], ''));
    root.appendChild(article);
  }
  setLoadState('conceptsState', `${items.length} 条`, 'success');
}

export function setupConceptPanel(onRefreshAll) {
  const planBtn = $('#conceptPlanButton');
  if (planBtn) planBtn.addEventListener('click', (event) => planConcept(event.currentTarget));
  const prepBtn = $('#conceptPrepareButton');
  if (prepBtn) prepBtn.addEventListener('click', (event) => prepareConcept(event.currentTarget, onRefreshAll));
  const applyBtn = $('#conceptApplyButton');
  if (applyBtn) applyBtn.addEventListener('click', (event) => applyConcept(event.currentTarget, onRefreshAll));
  const costConfirm = $('#conceptCostConfirm');
  if (costConfirm) {
    costConfirm.addEventListener('change', () => {
      const pBtn = $('#conceptPrepareButton');
      if (state.conceptPlan && pBtn) pBtn.disabled = !state.conceptPlan.ok || !costConfirm.checked;
    });
  }
}
