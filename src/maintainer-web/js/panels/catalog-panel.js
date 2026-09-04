import { request, listFrom, ApiError } from '../api.js';
import {
  state,
  $,
  addText,
  addBadge,
  clearChildren,
  showNotice,
} from '../state.js';

export function recoveryControlsFor(draft, content, onRefreshAll) {
  if (!draft.recovery_kind || draft.readiness === 'ready') return;
  const panel = document.createElement('div');
  panel.className = 'recovery-panel';
  addText(panel, 'p', `${draft.error_code || 'DRAFT_BLOCKED'}：${(draft.blocking_reasons || []).join('；')}`, 'item-blocked');
  if (draft.missing_fields?.length) addText(panel, 'p', `缺失官方字段：${draft.missing_fields.join('、')}`, 'item-blocked');
  if (draft.suggested_detail_kind) addText(panel, 'p', `建议候选类型：${draft.suggested_detail_kind}`, 'item-blocked');
  const researchCanResume = draft.recovery_mode === 'research_resume' && ['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind);
  if (draft.recovery_kind === 'manual_required' || (['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind) && !researchCanResume)) {
    addText(panel, 'p', '此 Draft 需要人工补充资料或修正候选信息，不能通过运行配置重试。', 'muted');
    content.appendChild(panel);
    return;
  }
  const controls = document.createElement('div');
  controls.className = 'recovery-controls';
  const configFields = Array.isArray(draft.missing_config_fields) ? draft.missing_config_fields : [];
  const inputs = new Map();
  const defaults = { model: 'glm-5.3-flash', provider: 'zhipu', protocol: 'messages', retrieval_provider: 'tavily', access_mode: 'keyless' };
  for (const field of configFields) {
    if (!['model', 'provider', 'protocol', 'retrieval_provider', 'access_mode'].includes(field)) continue;
    const label = document.createElement('label');
    label.className = 'recovery-field';
    label.textContent = field;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaults[field] || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    controls.appendChild(label);
    inputs.set(field, input);
  }
  const cost = document.createElement('label');
  cost.className = 'cost-check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = true;
  cost.appendChild(checkbox);
  addText(cost, 'span', '确认本次增量 AI 成本');
  controls.appendChild(cost);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'button button-quiet';
  action.textContent = '生成恢复预览';
  controls.appendChild(action);
  const result = document.createElement('p');
  result.className = 'recovery-result';
  panel.appendChild(controls);
  panel.appendChild(result);
  action.addEventListener('click', () => recoverDraft(draft, { action, checkbox, inputs, result }, onRefreshAll));
  content.appendChild(panel);
}

export async function recoverDraft(draft, controls, onRefreshAll) {
  const id = draft.draft_id;
  controls.action.disabled = true;
  try {
    let plan = state.catalogRecovery.get(id);
    if (!plan) {
      const generatorOptions = {};
      for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
      plan = await request(`catalog/drafts/${encodeURIComponent(id)}/recovery-plan`, { method: 'POST', body: JSON.stringify({ expected_revision: state.revisions.catalog, generator_options: generatorOptions }) });
      state.catalogRecovery.set(id, plan);
      controls.checkbox.disabled = false;
      controls.action.textContent = '确认成本并恢复';
      controls.result.textContent = `恢复模式：${plan.recovery_mode}；预计新增 responses ${plan.cost_plan?.hard_limits?.responses_calls || 0}、synthesis ${plan.cost_plan?.hard_limits?.synthesis_calls || 0} 次。`;
      return;
    }
    if (!controls.checkbox.checked) {
      controls.result.textContent = '请先勾选本 Draft 的增量成本确认。';
      return;
    }
    const generatorOptions = {};
    for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
    const response = await request(`catalog/drafts/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ expected_revision: plan.expected_revision, generator_options: generatorOptions, recovery_token: plan.recovery_token, confirm_cost: true }) });
    if (!response?.ok) throw new Error(response?.code || 'Draft 恢复被阻断');
    state.catalogRecovery.delete(id);
    showNotice(`${draft.candidate_name || 'Draft'} 已恢复，正在重新加载列表。`, 'success');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      state.catalogRecovery.delete(id);
      controls.checkbox.checked = false;
      controls.checkbox.disabled = true;
      controls.action.textContent = '重新生成恢复预览';
      const code = error.code || error.payload?.code || error.payload?.error;
      let msg = '恢复已被阻断，请重新生成恢复预览。';
      if (code === 'RECOVERY_TOKEN_CHANGED') {
        msg = '恢复参数或凭据已变化，已重置，请重新生成恢复预览。';
      } else if (code === 'REVISION_CONFLICT') {
        msg = 'Catalog 正式数据已发生变更，请点击顶部“刷新数据”后再试。';
      } else if (code === 'DRAFT_RECOVERY_IN_PROGRESS') {
        msg = '当前 Draft 正在恢复中，请勿重复操作。';
      }
      controls.result.textContent = msg;
      showNotice(msg, 'conflict');
    } else {
      const code = error.code || error.payload?.code || error.payload?.error;
      if (code === 'DRAFT_RECOVERY_FORBIDDEN') {
        controls.result.textContent = '该 Draft 当前状态不支持恢复，请点击顶部“刷新数据”后重试。';
        showNotice(controls.result.textContent, 'conflict');
        return;
      }
      controls.result.textContent = error.message || '恢复失败。';
      showNotice(controls.result.textContent, 'error');
    }
  } finally {
    controls.action.disabled = false;
  }
}

export function renderCatalogDrafts(payload, onRefreshAll) {
  state.catalogDrafts = listFrom(payload, ['items', 'drafts']);
  if (payload?.catalog_revision) state.revisions.catalog = payload.catalog_revision;
  state.catalogRecovery.clear();
  const root = $('#catalogDraftList');
  if (!root) return;
  clearChildren(root);
  if (!state.catalogDrafts.length) addText(root, 'p', '当前没有待审核 Draft。', 'empty-state');
  for (const draft of state.catalogDrafts) {
    const row = document.createElement('article');
    row.className = 'queue-item';
    const content = document.createElement('div');
    content.className = 'item-content';
    addText(content, 'h3', draft.candidate_name || '工具 / 模型 Draft', 'item-title');
    addText(content, 'p', `状态：${draft.state || draft.readiness || 'unknown'}`, 'item-summary');
    if (draft.reused) addBadge(content, '已复用', 'reused');
    recoveryControlsFor(draft, content, onRefreshAll);
    row.appendChild(document.createElement('span'));
    row.appendChild(content);
    root.appendChild(row);
  }
}

export function renderCatalogBatchPreview(payload) {
  const root = $('#catalogBatchPreview');
  if (!root) return;
  clearChildren(root);
  state.catalogBatch = payload?.ok ? payload : null;
  if (!payload?.ok) {
    addText(root, 'p', payload?.code === 'DRAFTS_NOT_READY' ? '暂无可 Apply 的 Draft。' : '批次预览已阻断，请刷新数据后重试。', 'muted');
    const applyBtn = $('#catalogApplyButton');
    if (applyBtn) applyBtn.disabled = true;
    return;
  }
  addText(root, 'p', `本批 ${Number(payload.draft_count || 0)} 个 Draft，将在一次事务中更新正式知识库。`, 'item-summary');
  addText(root, 'p', `Catalog revision：${payload.expected_revision}`, 'item-id');
  const changes = payload.change_preview || {};
  const creates = Object.values(changes.creates || {}).flat();
  const updates = Array.isArray(changes.updates) ? changes.updates : [];
  const noops = Array.isArray(changes.noops) ? changes.noops : [];
  addText(root, 'p', `新增 ${creates.length}，更新 ${updates.length}，无变化 ${noops.length}`, 'item-summary');
  for (const draft of payload.drafts || []) {
    const change = draft.change_preview || {};
    addText(root, 'p', `${draft.candidate_key || draft.draft_id}：新增 ${Object.values(change.creates || {}).flat().length}，更新 ${(change.updates || []).length}`, 'item-summary');
  }
  for (const blocker of payload.blockers || []) {
    const label = blocker.candidate_key || blocker.draft_id || 'Draft';
    const reasons = Array.isArray(blocker.blocking_reasons) && blocker.blocking_reasons.length ? blocker.blocking_reasons.join('；') : '当前不可 Apply';
    addText(root, 'p', `阻断：${label}（${reasons}）`, 'item-blocked');
  }
  const applyBtn = $('#catalogApplyButton');
  if (applyBtn) applyBtn.disabled = false;
}

export async function planCatalog(button) {
  button.disabled = true;
  try {
    state.catalogPlan = await request('catalog/plan');
    state.revisions.catalog = state.catalogPlan.catalog_revision || '';
    const prepBtn = $('#catalogPrepareButton');
    if (prepBtn) prepBtn.disabled = !state.catalogPlan.ok;
    showNotice(state.catalogPlan.ok ? 'Catalog 计划已生成，请核对成本并确认。' : '当前没有可进入 Catalog 的已批准待补卡。', state.catalogPlan.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || 'Catalog 计划失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function prepareCatalog(button, onRefreshAll) {
  const plan = state.catalogPlan;
  if (!plan || !$('#catalogCostConfirm').checked) {
    showNotice('请先生成计划并确认 Catalog 成本。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('catalog/prepare', {
      method: 'POST',
      body: JSON.stringify({ pending_revision: plan.pending_revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, confirm_cost: true })
    });
    if (!result?.ok) throw new Error(result?.code || 'Catalog Draft 准备被阻断');
    showNotice('Catalog Draft 已准备，仍需逐项审核后 Apply。');
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    const msg = (error.code || error.message) === 'PREPARE_IN_PROGRESS'
      ? '已有一轮 Catalog Draft 准备在执行中，请等待完成后点击“刷新数据”查看进度。'
      : (error.message || 'Catalog Draft 准备失败。');
    showNotice(msg, 'error');
  } finally {
    button.disabled = false;
  }
}

export async function previewCatalogBatch(button) {
  button.disabled = true;
  try {
    const result = await request('catalog/batch/preview');
    renderCatalogBatchPreview(result);
    showNotice(result?.ok ? 'Catalog 批次预览已就绪，可核对后一键 Apply。' : (result?.code || '批次预览被阻断。'), result?.ok ? 'success' : 'error');
  } catch (error) {
    showNotice(error.message || 'Catalog 批次预览失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export async function applyCatalog(button, onRefreshAll) {
  const batch = state.catalogBatch;
  if (!batch?.ok || !batch.draft_ids?.length) {
    showNotice('请先生成并确认批次预览。', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('catalog/batch/apply', {
      method: 'POST',
      body: JSON.stringify({
        draft_ids: batch.draft_ids,
        expected_revision: batch.expected_revision,
        batch_token: batch.batch_token,
        confirm: `APPLY CATALOG BATCH ${batch.batch_token}`,
      }),
    });
    if (!result?.ok) throw new Error(result?.code || 'Catalog Apply 被拒绝');
    state.catalogBatch = null;
    clearChildren($('#catalogBatchPreview'));
    addText($('#catalogBatchPreview'), 'p', '准备 Draft 后，可预览整批变更。', 'muted');
    showNotice(`批量写入完成：成功 ${Number(result.applied || 0)} 个 Draft。公开站点仍需显式重建 dist。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    showNotice(error.message || '批量 Catalog Apply 失败。', 'error');
  } finally {
    button.disabled = false;
  }
}

export function setupCatalogPanel(onRefreshAll) {
  const planBtn = $('#catalogPlanButton');
  if (planBtn) planBtn.addEventListener('click', (event) => planCatalog(event.currentTarget));
  const prepBtn = $('#catalogPrepareButton');
  if (prepBtn) prepBtn.addEventListener('click', (event) => prepareCatalog(event.currentTarget, onRefreshAll));
  const prevBtn = $('#catalogBatchPreviewButton');
  if (prevBtn) prevBtn.addEventListener('click', (event) => previewCatalogBatch(event.currentTarget));
  const applyBtn = $('#catalogApplyButton');
  if (applyBtn) applyBtn.addEventListener('click', (event) => applyCatalog(event.currentTarget, onRefreshAll));
  const costConfirm = $('#catalogCostConfirm');
  if (costConfirm) {
    costConfirm.addEventListener('change', () => {
      const pBtn = $('#catalogPrepareButton');
      if (state.catalogPlan && pBtn) pBtn.disabled = !state.catalogPlan.ok || !costConfirm.checked;
    });
  }
}
