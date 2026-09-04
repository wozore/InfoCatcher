'use strict';

const { getProvider, DEFAULT_PROVIDER_NAME } = require('../shared/providers');
const { loadAiModuleConfig } = require('./ai-config');
const { loadCatalogSnapshot } = require('./catalog-snapshot-store');
const { previewHashOf, revisionOf } = require('./catalog-revision');
const { planCatalogPatches } = require('./catalog-change-planner');
const { createDraft, readDraft, updateDraft, deleteDraft } = require('./catalog-draft-store');
const { commitCatalogChange, recoverCatalogTransaction } = require('./catalog-transaction-store');
const { planCatalogResearch } = require('./catalog-profile-contract');
const { researchCatalog, createCostLedger } = require('./catalog-research');
const { synthesizeCatalog } = require('./catalog-synthesis');
const {
  buildCatalogDraftEnvelope,
  validateCatalogDraftEnvelope,
  classifyFailure,
  failureCodeOf,
} = require('./catalog-draft-envelope');
const {
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('./ai/catalog-adapters');
const {
  loadSharedReleaseIndex,
  buildIntegratedLookup,
  lookupReleaseDateForSeed,
} = require('./catalog-integrated-lookup');
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

function normalizeGeneratorOptions(options = {}) {
  const valueOf = (camel, snake, fallback) => {
    const value = options[camel] ?? options[snake];
    return value === undefined || value === null || value === '' ? fallback : value;
  };
  const defaultProvider = getProvider(DEFAULT_PROVIDER_NAME);
  return {
    provider: valueOf('provider', 'provider', DEFAULT_PROVIDER_NAME),
    model: valueOf('model', 'model', defaultProvider.defaultModel),
    protocol: valueOf('protocol', 'protocol', defaultProvider.protocol),
    retrievalProvider: valueOf('retrievalProvider', 'retrieval_provider', 'tavily'),
    accessMode: valueOf('accessMode', 'access_mode', undefined),
    timeoutMs: valueOf('timeoutMs', 'timeout_ms', undefined),
    maxSearchQueries: valueOf('maxSearchQueries', 'max_search_queries', undefined),
    maxPages: valueOf('maxPages', 'max_pages', undefined),
    maxResponsesCalls: valueOf('maxResponsesCalls', 'max_responses_calls', undefined),
    maxSynthesisCalls: valueOf('maxSynthesisCalls', 'max_synthesis_calls', undefined),
    maxRepairCalls: valueOf('maxRepairCalls', 'max_repair_calls', undefined),
    searchTimeoutMs: valueOf('searchTimeoutMs', 'search_timeout_ms', undefined),
    searchDepth: valueOf('searchDepth', 'search_depth', undefined),
    maxSearchResults: valueOf('maxSearchResults', 'max_search_results', undefined),
    extractDepth: valueOf('extractDepth', 'extract_depth', undefined),
    chunksPerSource: valueOf('chunksPerSource', 'chunks_per_source', undefined),
    ...(options.confirmCost !== undefined ? { confirmCost: options.confirmCost } : {}),
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

// resuming 是恢复过程中的瞬态：本进程在途则拒绝重复恢复；进程重启遗留的孤儿
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
  // 此处 resuming 只可能是进程重启遗留的孤儿状态，允许再次恢复。
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

function normalizeDraftIds(draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length || draftIds.some(id => typeof id !== 'string' || !/^draft-[A-Za-z0-9-]+$/.test(id))) {
    return { ok: false, code: 'DRAFT_IDS_INVALID' };
  }
  const ids = [...new Set(draftIds)].sort();
  if (ids.length !== draftIds.length) return { ok: false, code: 'DRAFT_IDS_INVALID' };
  return { ok: true, ids };
}

function catalogDraftBatchToken({ draftIds, previewHashes, expectedRevision, sourcePendingRevision = null }) {
  return previewHashOf({
    kind: 'catalog-draft-batch-v1',
    draft_ids: [...draftIds].sort(),
    preview_hashes: [...previewHashes].sort((a, b) => a.draft_id.localeCompare(b.draft_id)),
    expected_revision: expectedRevision,
    source_pending_revision: sourcePendingRevision,
  });
}

function mergeBatchPatches(patches = []) {
  const byKey = new Map();
  for (const patch of patches) {
    if (!patch) continue;
    const key = `${patch.area}:${patch.id}`;
    const list = byKey.get(key) || [];
    list.push(patch);
    byKey.set(key, list);
  }
  const merged = [];
  for (const [key, group] of byKey.entries()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const nonNoop = group.filter(p => p.operation !== 'noop');
    if (!nonNoop.length) {
      merged.push(group[0]);
      continue;
    }
    if (nonNoop.length === 1) {
      merged.push(nonNoop[0]);
      continue;
    }
    const base = JSON.parse(JSON.stringify(nonNoop[0]));
    const mergedProvenance = { ...(base.provenance || {}) };
    for (let i = 1; i < nonNoop.length; i++) {
      const other = nonNoop[i];
      if (base.record && other.record) {
        if (Array.isArray(base.record.level2_refs) && Array.isArray(other.record.level2_refs)) {
          const seen = new Set(base.record.level2_refs.map(r => r.id));
          for (const ref of other.record.level2_refs) {
            if (ref?.id && !seen.has(ref.id)) {
              seen.add(ref.id);
              base.record.level2_refs.push(ref);
            }
          }
        }
        if (Array.isArray(base.record.detail_refs) && Array.isArray(other.record.detail_refs)) {
          const seen = new Set(base.record.detail_refs.map(r => r.id));
          for (const ref of other.record.detail_refs) {
            if (ref?.id && !seen.has(ref.id)) {
              seen.add(ref.id);
              base.record.detail_refs.push(ref);
            }
          }
        }
      }
      Object.assign(mergedProvenance, other.provenance || {});
    }
    base.provenance = mergedProvenance;
    merged.push(base);
  }
  return merged;
}

function reviewCatalogDraftBatch(draftIds, options = {}) {
  const normalized = normalizeDraftIds(draftIds);
  if (!normalized.ok) return normalized;
  const current = loadCatalogSnapshot();
  const reviews = [];
  for (const draftId of normalized.ids) {
    const checked = reviewCatalogDraft(draftId);
    if (!checked.ok) return checked;
    reviews.push(checked);
  }
  const rawPatches = reviews.flatMap(review => review.draft.layer_patches || []);
  const patches = mergeBatchPatches(rawPatches);
  let plan;
  try { plan = planCatalogPatches(current.snapshot, patches); }
  catch (error) { return { ok: false, code: error.message.split(':')[0], draft_ids: normalized.ids }; }
  const previewHashes = reviews.map(review => ({ draft_id: review.draft.draft_id, preview_hash: review.previewHash }));
  return {
    ok: true,
    draft_ids: normalized.ids,
    currentRevision: current.revision,
    reviews,
    patches,
    plan,
    batchToken: catalogDraftBatchToken({
      draftIds: normalized.ids,
      previewHashes,
      expectedRevision: current.revision,
      sourcePendingRevision: options.sourcePendingRevision || null,
    }),
  };
}

function applyCatalogDrafts({ draftIds, expectedRevision, batchToken }, options = {}) {
  const normalized = normalizeDraftIds(draftIds);
  if (!normalized.ok) return normalized;
  const currentBeforeReview = loadCatalogSnapshot();
  const drafts = normalized.ids.map(id => {
    try { return readDraft(id); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  });
  const checkpoints = drafts.map(draft => draft?.apply_checkpoint);
  const committedCheckpoint = checkpoints.find(Boolean);
  if (committedCheckpoint?.batch_token === batchToken
    && committedCheckpoint.target_revision
    && checkpoints.every(checkpoint => !checkpoint || (checkpoint.batch_token === batchToken
      && checkpoint.target_revision === committedCheckpoint.target_revision
      && JSON.stringify(checkpoint.draft_ids) === JSON.stringify(normalized.ids)))
    && loadCatalogSnapshot().revision === committedCheckpoint.target_revision) {
    const cleanupPending = [];
    for (const id of normalized.ids) {
      try {
        if (drafts[normalized.ids.indexOf(id)] && !deleteDraft(id)) cleanupPending.push(id);
      } catch { cleanupPending.push(id); }
    }
    return {
      ok: true,
      status: cleanupPending.length ? 'cleanup_pending' : 'completed',
      targetRevision: committedCheckpoint.target_revision,
      appliedDraftIds: normalized.ids,
      cleanupPending,
      cleanupOnly: true,
    };
  }
  if (String(expectedRevision || '') !== currentBeforeReview.revision) return { ok: false, code: 'REVISION_CONFLICT' };
  const checked = reviewCatalogDraftBatch(normalized.ids, { sourcePendingRevision: options.sourcePendingRevision });
  if (!checked.ok) return checked;
  if (String(batchToken || '') !== checked.batchToken) return { ok: false, code: 'BATCH_TOKEN_CHANGED' };
  const checkpoint = {
    batch_token: checked.batchToken,
    draft_ids: checked.draft_ids,
    expected_revision: checked.currentRevision,
    target_revision: revisionOf(checked.plan.snapshot),
    started_at: new Date().toISOString(),
  };
  for (const id of checked.draft_ids) updateDraft(id, { state: 'applying', apply_checkpoint: checkpoint }, 'catalog-batch-apply-start');
  const firstDraft = checked.reviews[0].draft;
  const result = commitCatalogChange(firstDraft.seed, {
    ...options,
    buildDist: false,
    draftId: checked.batchToken,
    expectedRevision: checked.currentRevision,
    layerPatches: checked.patches,
  });
  if (!result.ok) {
    for (const id of checked.draft_ids) updateDraft(id, { state: result.code === 'ROLLBACK_FAILED' ? 'rollback_failed' : 'failed_retryable', last_error: result }, 'catalog-batch-apply-failed');
    return result;
  }
  const committedAt = new Date().toISOString();
  const committed = { ...checkpoint, committed_at: committedAt, target_revision: result.targetRevision };
  for (const id of checked.draft_ids) updateDraft(id, { state: 'cleanup_pending', apply_checkpoint: committed }, 'catalog-batch-committed');
  const cleanupPending = [];
  for (const id of checked.draft_ids) {
    try { if (!deleteDraft(id)) cleanupPending.push(id); }
    catch { cleanupPending.push(id); }
  }
  return {
    ok: true,
    status: cleanupPending.length ? 'cleanup_pending' : 'completed',
    targetRevision: result.targetRevision,
    appliedDraftIds: checked.draft_ids,
    cleanupPending,
  };
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
  recoveryPlanForDraft,
  reviewCatalogDraft,
  applyCatalogDraft,
  reviewCatalogDraftBatch,
  applyCatalogDrafts,
  catalogDraftBatchToken,
  discardCatalogDraft,
  recoverCatalogTransactions,
  probeCatalogCapabilities,
  loadGeneratorConfig,
};
