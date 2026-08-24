'use strict';

const { loadAiModuleConfig } = require('../shared/ai-config');
const { loadCatalogSnapshot } = require('./catalog-snapshot-store');
const { previewHashOf } = require('./catalog-revision');
const { planCatalogPatches } = require('./catalog-change-planner');
const { createDraft, readDraft, updateDraft, deleteDraft } = require('./catalog-draft-store');
const { commitCatalogChange, recoverCatalogTransaction } = require('./catalog-transaction-store');
const { planCatalogResearch } = require('./catalog-profile-contract');
const { researchCatalog } = require('./catalog-research');
const { synthesizeCatalog } = require('./catalog-synthesis');
const {
  buildCatalogDraftEnvelope,
  validateCatalogDraftEnvelope,
} = require('./catalog-draft-envelope');
const {
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('./ai/catalog-adapters');

function normalizeGeneratorOptions(options = {}) {
  return {
    ...options,
    provider: options.provider || 'deepseek',
    model: options.model,
    protocol: options.protocol || 'responses',
    timeoutMs: options.timeoutMs ?? options.timeout_ms,
    maxSearchQueries: options.maxSearchQueries ?? options.max_search_queries,
    maxPages: options.maxPages ?? options.max_pages,
    maxResponsesCalls: options.maxResponsesCalls ?? options.max_responses_calls,
    maxSynthesisCalls: options.maxSynthesisCalls ?? options.max_synthesis_calls,
    maxRepairCalls: options.maxRepairCalls ?? options.max_repair_calls,
    retrievalProvider: options.retrievalProvider ?? options.retrieval_provider ?? 'tavily',
    accessMode: options.accessMode ?? options.access_mode,
    searchTimeoutMs: options.searchTimeoutMs ?? options.search_timeout_ms,
    searchDepth: options.searchDepth ?? options.search_depth,
    maxSearchResults: options.maxSearchResults ?? options.max_search_results,
    extractDepth: options.extractDepth ?? options.extract_depth,
    chunksPerSource: options.chunksPerSource ?? options.chunks_per_source,
  };
}

function requireSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.detail_kind || !seed.name || !seed.vendor_name) {
    return { ok: false, code: 'SEED_INVALID', error: 'Seed 必须包含 detail_kind/name/vendor_name' };
  }
  if (seed.operation && !['create', 'replace'].includes(seed.operation)) {
    return { ok: false, code: 'SEED_INVALID', error: 'operation 只允许 create 或 replace；新流程优先使用 repair_layers' };
  }
  return { ok: true };
}

function researchLimits(options = {}) {
  return {
    search_queries: options.maxSearchQueries ?? 4,
    pages: options.maxPages ?? 8,
    responses_calls: options.maxResponsesCalls ?? 12,
    synthesis_calls: options.maxSynthesisCalls ?? 1,
  };
}

function resumeResearchLimits(options = {}, previousCost = {}) {
  const incremental = researchLimits(options);
  const spent = previousCost?.spent || {};
  return Object.fromEntries(Object.entries(incremental).map(([category, limit]) => [category, Number(spent[category] || 0) + limit]));
}

function estimateResearchCost(plan, limits, options = {}) {
  const scopes = plan.research_scopes.length;
  const searchQueries = Math.min(scopes, limits.search_queries);
  return {
    hard_limits: { ...limits },
    planned_scopes: scopes,
    estimated_search_queries: searchQueries,
    estimated_synthesis_calls: scopes ? 1 : 0,
    worst_case_responses_calls: Math.min(limits.responses_calls, (scopes ? 1 : 0) + (options.maxRepairCalls ?? 1)),
  };
}

function planCatalogDraft(seed, options = {}) {
  options = normalizeGeneratorOptions(options);
  const seedCheck = requireSeed(seed);
  if (!seedCheck.ok) return seedCheck;
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
  options = normalizeGeneratorOptions(options);
  const planned = planCatalogDraft(seed, options);
  if (!planned.ok) return planned;
  if (options.confirmCost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost_plan: planned.cost_plan };
  const current = loadCatalogSnapshot();
  if (current.revision !== planned.base_revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, baseRevision: planned.base_revision };
  const adapters = options.catalogAdapters || createCatalogAiAdapters(options);
  const research = await researchCatalog(planned.research_plan, adapters, { limits: planned.cost_plan.hard_limits, existingResearch: options.existingResearch });
  const synthesis = research.ok
    ? await synthesizeCatalog(research, planned.research_plan, adapters)
    : research;
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

async function resumeCatalogDraft(draftId, options = {}) {
  options = normalizeGeneratorOptions(options);
  const previous = readDraft(draftId);
  if (previous.schema_version !== 3) return { ok: false, code: 'DRAFT_SCHEMA_UNSUPPORTED', error: '旧 schema Draft 不能 resume' };
  if (options.confirmCost !== true) return {
    ok: false,
    code: 'COST_CONFIRMATION_REQUIRED',
    cost_plan: { hard_limits: researchLimits(options), previous_cost: previous.cost || null },
  };
  const current = loadCatalogSnapshot();
  if (previous.base_revision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', currentRevision: current.revision, baseRevision: previous.base_revision };
  const adapters = options.catalogAdapters || createCatalogAiAdapters(options);
  const limits = resumeResearchLimits(options, previous.cost);
  const missingFields = (previous.coverage?.missing || []).map(item => `${item.layer}.${item.field}`);
  const existingResearch = { ...previous.research, cost: previous.cost };
  const research = await researchCatalog(previous.research_plan, adapters, { limits, existingResearch, missingFields });
  const synthesis = research.ok ? await synthesizeCatalog(research, previous.research_plan, adapters) : research;
  const baseEnvelope = buildCatalogDraftEnvelope({ seed: previous.seed, baseRevision: previous.base_revision, researchPlan: previous.research_plan, research, synthesis });
  let preview;
  try { preview = previewFromEnvelope(baseEnvelope, current.snapshot); }
  catch (error) { preview = { envelope: { ...baseEnvelope, state: 'preview_blocked', readiness: { status: 'blocked', blocking_reasons: [error.message], warnings: baseEnvelope.readiness.warnings }, last_error: { code: 'PLANNER_FAILED', error: error.message } } }; }
  const draft = updateDraft(draftId, preview.envelope, 'catalog-draft-resume');
  return { ok: draft.readiness.status === 'ready', ...(draft.readiness.status === 'ready' ? {} : { code: resultCode(draft), error: draft.readiness.blocking_reasons[0] }), draft_id: draftId, draft, cost: draft.cost };
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

function loadGeneratorConfig() {
  return loadAiModuleConfig('catalog');
}

module.exports = {
  normalizeGeneratorOptions,
  researchLimits,
  resumeResearchLimits,
  estimateResearchCost,
  planCatalogDraft,
  prepareCatalogDraft,
  resumeCatalogDraft,
  reviewCatalogDraft,
  applyCatalogDraft,
  discardCatalogDraft,
  recoverCatalogTransactions,
  probeCatalogCapabilities,
  loadGeneratorConfig,
};
