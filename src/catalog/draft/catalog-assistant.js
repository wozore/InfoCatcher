'use strict';

const {
  loadCatalogSnapshot,
  previewHashOf,
  revisionOf,
  planCatalogPatches,
  planCatalogResearch,
  researchCatalog,
  createCostLedger,
  synthesizeCatalog,
} = require('../core');
const {
  normalizeGeneratorOptions,
  requireSeed,
  researchLimits,
  resumeResearchLimits,
  estimateResearchCost,
  loadGeneratorConfig,
} = require('./draft-options');
const { createDraft, readDraft, updateDraft, deleteDraft } = require('./catalog-draft-store');
const { commitCatalogChange, recoverCatalogTransaction } = require('../transaction');
const {
  buildCatalogDraftEnvelope,
  validateCatalogDraftEnvelope,
  classifyFailure,
  failureCodeOf,
} = require('./catalog-draft-envelope');
const {
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('../intake/catalog-adapters');
const { loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed } = require('../catalog-integrated-lookup');
const batchOperations = require('./catalog-batch');
const activeDraftResumes = new Set();

let cachedIntegratedLookup = null;
function getIntegratedLookup() {
  if (!cachedIntegratedLookup) {
    try {
      cachedIntegratedLookup = buildIntegratedLookup(loadSharedReleaseIndex());
    } catch {
      cachedIntegratedLookup = new Map();
    }
  }
  return cachedIntegratedLookup;
}

function enrichSeedWithReleaseDate(seed) {
  if (!seed || typeof seed !== 'object') return seed;
  if (seed.detail_kind !== 'api_model' && seed.detail_kind !== 'product_variant') return seed;
  if (seed.known_fields?.integrated_release_date) return seed;
  const lookup = getIntegratedLookup();
  const hit = lookupReleaseDateForSeed(seed, lookup);
  if (hit && hit.date) {
    seed.known_fields = { ...(seed.known_fields || {}), integrated_release_date: hit.date };
  }
  return seed;
}

function planCatalogDraft(seed, options = {}) {
  options = normalizeGeneratorOptions(options);
  const seedCheck = requireSeed(seed);
  if (!seedCheck.ok) return seedCheck;
  enrichSeedWithReleaseDate(seed);
  const current = loadCatalogSnapshot();
  let researchPlan;
  try { researchPlan = planCatalogResearch(seed, current.snapshot); }
  catch (error) { return { ok: false, code: error.message.split(':')[0], error: error.message }; }
  const limits = researchLimits(options);
  return {
    ok: true,
    base_revision: current.revision,
    research_plan: researchPlan,
    cost_plan: estimateResearchCost(researchPlan, limits, options),
  };
}

function previewFromEnvelope(envelope, snapshot) {
  if (envelope.readiness.status !== 'ready') return { envelope, patchPlan: null };
  const patchPlan = planCatalogPatches(snapshot, envelope.layer_patches);
  return {
    envelope: {
      ...envelope,
      change_preview: patchPlan.changePreview,
      preview_hash: patchPlan.previewHash,
      record_preview: patchPlan.plannedRecords,
    },
    patchPlan,
  };
}

function resultCode(envelope) {
  return envelope.last_error?.code || (envelope.state === 'failed_retryable' ? 'RESEARCH_FAILED' : 'DRAFT_BLOCKED');
}

async function prepareCatalogDraft(seed, options = {}) {
  const runtimeOptions = options;
  options = normalizeGeneratorOptions(options);
  const planned = planCatalogDraft(seed, options);
  if (!planned.ok) return planned;
  if (options.confirmCost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost_plan: planned.cost_plan };
  const current = loadCatalogSnapshot();
  if (current.revision !== planned.base_revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, baseRevision: planned.base_revision };
  const adapters = runtimeOptions.catalogAdapters || createCatalogAiAdapters(options);
  let research;
  let synthesis;
  try {
    research = await researchCatalog(planned.research_plan, adapters, { limits: planned.cost_plan.hard_limits, existingResearch: runtimeOptions.existingResearch });
  } catch (error) {
    research = { ok: false, code: error?.code || 'RESEARCH_FAILED', error: error?.message || '研究失败', official_sources: [], warnings: [] };
  }
  if (research.ok) {
    try { synthesis = await synthesizeCatalog(research, planned.research_plan, adapters); }
    catch (error) { synthesis = { ok: false, code: error?.code || 'SYNTHESIS_FAILED', error: error?.message || '目录合成失败', cost: research.cost }; }
  } else synthesis = research;
  const baseEnvelope = buildCatalogDraftEnvelope({ seed, baseRevision: planned.base_revision, researchPlan: planned.research_plan, research, synthesis });
  let preview;
  try { preview = previewFromEnvelope(baseEnvelope, current.snapshot); }
  catch (error) {
    const blocked = { ...baseEnvelope, state: 'preview_blocked', readiness: { status: 'blocked', blocking_reasons: [error.message], warnings: baseEnvelope.readiness.warnings }, last_error: { code: 'PLANNER_FAILED', error: error.message } };
    preview = { envelope: blocked, patchPlan: null };
  }
  const draft = createDraft(preview.envelope);
  return {
    ok: draft.readiness.status === 'ready',
    ...(draft.readiness.status === 'ready' ? {} : { code: resultCode(draft), error: draft.readiness.blocking_reasons[0] }),
    draft_id: draft.draft_id,
    draft,
    cost: draft.cost,
  };
}

function draftRecoveryOf(draft) {
  const failure = draft?.last_error || {};
  let errorCode = failure.code || 'DRAFT_BLOCKED';
  if (errorCode === 'DEEPSEEK_OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure.error || ''))) errorCode = 'MODEL_REQUIRED';
  const classified = classifyFailure({ ok: false, code: errorCode, error: failure.error }, null);
  const researchComplete = draft?.research?.ok === true
    || (draft?.research?.ok !== false && Array.isArray(draft?.research?.official_sources) && draft.research.official_sources.length > 0 && !draft.research_progress?.failed_scope);
  const synthesisOnly = researchComplete && ['config_required', 'retryable'].includes(classified.recovery_kind)
    && !String(errorCode).startsWith('TAVILY_');
  return {
    ...classified,
    error_code: errorCode,
    mode: synthesisOnly ? 'synthesis_only' : 'research_resume',
    missing_fields: Array.isArray(failure.missing_fields) ? failure.missing_fields : (Array.isArray(draft?.coverage?.missing) ? draft.coverage.missing.map(item => `${item.layer}.${item.field}`) : []),
    missing_config_fields: Array.isArray(failure.missing_config_fields) ? failure.missing_config_fields : (errorCode === 'MODEL_REQUIRED' ? ['model'] : []),
    suggested_detail_kind: failure.suggested_detail_kind || null,
  };
}

function cleanGeneratorOptionsForToken(options = {}) {
  const norm = normalizeGeneratorOptions(options);
  const limits = researchLimits(norm);
  return {
    provider: norm.provider,
    model: norm.model,
    protocol: norm.protocol,
    retrieval_provider: norm.retrievalProvider,
    ...(norm.accessMode ? { access_mode: norm.accessMode } : {}),
    max_search_queries: limits.search_queries,
    max_pages: limits.pages,
    max_responses_calls: limits.responses_calls,
    max_synthesis_calls: limits.synthesis_calls,
  };
}

// resuming 是恢复过程中的瞬态：本进程在途则拒绝重复恢复；进程重启留下的孤儿
// resuming（磁盘 state 卡死）按可恢复处理，否则该 Draft 将永久 DRAFT_RECOVERY_FORBIDDEN。
function recoveryEntryBlocked(draftId, state) {
  if (['preview_blocked', 'failed_retryable'].includes(state)) return null;
  if (state === 'resuming') {
    return activeDraftResumes.has(draftId) ? { ok: false, code: 'DRAFT_RECOVERY_IN_PROGRESS', state } : null;
  }
  return { ok: false, code: 'DRAFT_RECOVERY_FORBIDDEN', state };
}

function recoveryPlanForDraft(draftId, input = {}) {
  const draft = readDraft(draftId);
  if (draft.schema_version !== 3) return { ok: false, code: 'DRAFT_SCHEMA_UNSUPPORTED' };
  const current = loadCatalogSnapshot();
  if (String(input.expectedRevision || '') !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision };
  if (draft.base_revision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, baseRevision: draft.base_revision };
  const blocked = recoveryEntryBlocked(draftId, draft.state);
  if (blocked) return blocked;
  const recovery = draftRecoveryOf(draft);
  if (recovery.recovery_kind === 'manual_required') return { ok: false, code: 'DRAFT_RECOVERY_FORBIDDEN', recovery_kind: recovery.recovery_kind };
  const tokenOptions = cleanGeneratorOptionsForToken(input.generatorOptions || {});
  const limits = researchLimits(tokenOptions);
  const hardLimits = recovery.mode === 'synthesis_only'
    ? { search_queries: 0, pages: 0, responses_calls: limits.responses_calls, synthesis_calls: limits.synthesis_calls }
    : limits;
  const costPlan = { mode: recovery.mode, hard_limits: hardLimits, previous_cost: draft.cost || null };
  const token = previewHashOf({
    kind: 'catalog-draft-recovery-v1',
    draft_id: draft.draft_id,
    draft_updated_at: draft.updated_at,
    draft_state: draft.state,
    expected_revision: current.revision,
    recovery_kind: recovery.recovery_kind,
    mode: recovery.mode,
    generator_options: tokenOptions,
    cost_plan: costPlan,
  });
  return {
    ok: true,
    draft_id: draft.draft_id,
    expected_revision: current.revision,
    recovery_kind: recovery.recovery_kind,
    recovery_mode: recovery.mode,
    error_code: recovery.error_code,
    missing_fields: recovery.missing_fields,
    missing_config_fields: recovery.missing_config_fields,
    suggested_detail_kind: recovery.suggested_detail_kind,
    cost_plan: costPlan,
    generator_options: input.generatorOptions || {},
    recovery_token: token,
  };
}

async function resumeCatalogDraftImpl(draftId, options = {}) {
  const runtimeOptions = options;
  const normalized = normalizeGeneratorOptions(options);
  const previous = readDraft(draftId);
  if (previous.schema_version !== 3) return { ok: false, code: 'DRAFT_SCHEMA_UNSUPPORTED', error: '旧 schema Draft 不能 resume' };
  // 经由 resumeCatalogDraft 进入时 activeDraftResumes 已排除本进程在途恢复，
  // 此处 resuming 只可能是进程重启后留下的孤儿状态，允许再次恢复。
  if (!['preview_blocked', 'failed_retryable', 'resuming'].includes(previous.state)) return { ok: false, code: 'DRAFT_RECOVERY_FORBIDDEN', state: previous.state };
  if (normalized.confirmCost !== true) return {
    ok: false,
    code: 'COST_CONFIRMATION_REQUIRED',
    cost_plan: { hard_limits: researchLimits(normalized), previous_cost: previous.cost || null },
  };
  const current = loadCatalogSnapshot();
  if (runtimeOptions.expectedRevision && runtimeOptions.expectedRevision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, baseRevision: previous.base_revision };
  const recoveryPlan = recoveryPlanForDraft(draftId, { expectedRevision: current.revision, generatorOptions: normalized });
  if (!recoveryPlan.ok) return recoveryPlan;
  if (runtimeOptions.recoveryToken && runtimeOptions.recoveryToken !== recoveryPlan.recovery_token) return { ok: false, code: 'RECOVERY_TOKEN_CHANGED' };
  const claimed = updateDraft(draftId, {
    state: 'resuming',
    recovery_checkpoint: { recovery_token: recoveryPlan.recovery_token, recovery_mode: recoveryPlan.recovery_mode, started_at: new Date().toISOString() },
  }, 'catalog-draft-resume-start');
  const adapters = runtimeOptions.catalogAdapters || createCatalogAiAdapters(normalized);
  const seed = enrichSeedWithReleaseDate(previous.seed);
  if (previous.research_plan?.seed) enrichSeedWithReleaseDate(previous.research_plan.seed);
  let research;
  let synthesis;
  const limits = resumeResearchLimits(normalized, previous.cost);
  try {
    if (recoveryPlan.recovery_mode === 'synthesis_only') {
      const previousSpent = previous.cost?.spent || {};
      const ledger = createCostLedger({ ...limits, search_queries: previousSpent.search_queries || 0, pages: previousSpent.pages || 0 }, previousSpent);
      research = { ...previous.research, ok: true, cost: ledger.snapshot(), _cost_ledger: ledger, research_progress: previous.research_progress || null };
    } else {
      const missingFields = (previous.coverage?.missing || []).map(item => `${item.layer}.${item.field}`);
      const existingResearch = { ...previous.research, cost: previous.cost, research_progress: previous.research_progress };
      research = await researchCatalog(previous.research_plan, adapters, { limits, existingResearch, missingFields });
    }
  } catch (error) {
    research = { ok: false, code: error?.code || 'RESEARCH_RESUME_FAILED', error: error?.message || '研究恢复失败', official_sources: previous.research?.official_sources || [], warnings: previous.research?.warnings || [], cost: previous.cost, research_progress: previous.research_progress || null };
  }
  if (research.ok) {
    try { synthesis = await synthesizeCatalog(research, previous.research_plan, adapters); }
    catch (error) { synthesis = { ok: false, code: error?.code || 'SYNTHESIS_RESUME_FAILED', error: error?.message || '目录合成失败', cost: research.cost }; }
  } else synthesis = research;
  const baseEnvelope = buildCatalogDraftEnvelope({ seed, baseRevision: previous.base_revision, researchPlan: previous.research_plan, research, synthesis });
  let preview;
  try { preview = previewFromEnvelope(baseEnvelope, current.snapshot); }
  catch (error) { preview = { envelope: { ...baseEnvelope, state: 'preview_blocked', readiness: { status: 'blocked', blocking_reasons: [error.message], warnings: baseEnvelope.readiness.warnings }, last_error: { code: 'PLANNER_FAILED', error: error.message } } }; }
  const draft = updateDraft(draftId, { ...preview.envelope, recovery_checkpoint: { ...claimed.recovery_checkpoint, completed_at: new Date().toISOString() } }, 'catalog-draft-resume');
  return { ok: draft.readiness.status === 'ready', ...(draft.readiness.status === 'ready' ? {} : { code: resultCode(draft), error: draft.readiness.blocking_reasons[0] }), draft_id: draftId, draft, cost: draft.cost };
}

async function resumeCatalogDraft(draftId, options = {}) {
  if (activeDraftResumes.has(draftId)) return { ok: false, code: 'DRAFT_RECOVERY_IN_PROGRESS' };
  activeDraftResumes.add(draftId);
  try { return await resumeCatalogDraftImpl(draftId, options); }
  finally { activeDraftResumes.delete(draftId); }
}

function reviewCatalogDraft(draftId) {
  const draft = readDraft(draftId);
  const current = loadCatalogSnapshot();
  if (draft.base_revision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId, currentRevision: current.revision, baseRevision: draft.base_revision };
  const checked = validateCatalogDraftEnvelope(draft);
  if (!checked.ok || draft.readiness?.status !== 'ready') {
    return { ok: false, code: checked.errors?.[0]?.code || 'DRAFT_BLOCKED', draft_id: draftId, draft, errors: checked.errors || [], currentRevision: current.revision };
  }
  let plan;
  try { plan = planCatalogPatches(current.snapshot, draft.layer_patches); }
  catch (error) { return { ok: false, code: 'PLANNER_FAILED', error: error.message, draft_id: draftId, draft, currentRevision: current.revision }; }
  const previewHash = previewHashOf(plan.changePreview);
  if (draft.preview_hash !== previewHash) return { ok: false, code: 'PREVIEW_CHANGED', draft_id: draftId, previewHash };
  return { ok: true, draft, currentRevision: current.revision, plan, previewHash };
}

function applyCatalogDraft({ draftId, previewHash, expectedRevision }, options = {}) {
  const checked = reviewCatalogDraft(draftId);
  if (!checked.ok) return checked;
  if (previewHash !== checked.previewHash) return { ok: false, code: 'PREVIEW_CONFIRMATION_INVALID', expected: checked.previewHash };
  if (expectedRevision !== checked.currentRevision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: checked.currentRevision };
  const draft = updateDraft(draftId, { state: 'applying', apply_checkpoint: { started_at: new Date().toISOString() } }, 'catalog-apply-start');
  const result = commitCatalogChange(draft.seed, { ...options, draftId, expectedRevision, layerPatches: draft.layer_patches });
  if (!result.ok) {
    updateDraft(draftId, { state: result.code === 'ROLLBACK_FAILED' ? 'rollback_failed' : 'failed_retryable', last_error: result }, 'catalog-apply-failed');
    return result;
  }
  try { deleteDraft(draftId); }
  catch (error) {
    updateDraft(draftId, { state: 'cleanup_pending', last_error: { code: 'DRAFT_DELETE_FAILED', error: error.message }, apply_checkpoint: { ...draft.apply_checkpoint, committed_at: new Date().toISOString(), target_revision: result.targetRevision } }, 'catalog-cleanup-pending');
    return { ok: true, cleanup_pending: true, targetRevision: result.targetRevision };
  }
  return { ok: true, targetRevision: result.targetRevision, deleted: true };
}


function discardCatalogDraft(draftId) {
  const draft = readDraft(draftId);
  if (!['researching', 'preview_ready', 'preview_blocked', 'failed_retryable', 'rolled_back'].includes(draft.state)) return { ok: false, code: 'DRAFT_DISCARD_FORBIDDEN', state: draft.state };
  return { ok: deleteDraft(draftId), draft_id: draftId };
}

function recoverCatalogTransactions() {
  return recoverCatalogTransaction();
}

module.exports = {
  planCatalogDraft,
  prepareCatalogDraft,
  resumeCatalogDraft,
  recoveryPlanForDraft,
  reviewCatalogDraft,
  applyCatalogDraft,
  reviewCatalogDraftBatch: batchOperations.reviewCatalogDraftBatch,
  applyCatalogDrafts: batchOperations.applyCatalogDrafts,
  catalogDraftBatchToken: batchOperations.catalogDraftBatchToken,
  discardCatalogDraft,
  recoverCatalogTransactions,
  probeCatalogCapabilities,
};
