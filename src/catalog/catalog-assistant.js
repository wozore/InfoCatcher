'use strict';

const fs = require('fs');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { loadCatalogSnapshot } = require('./catalog-snapshot-store');
const { revisionOf, previewHashOf } = require('./catalog-revision');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');
const { planCatalogChange } = require('./catalog-change-planner');
const { createDraft, readDraft, updateDraft, deleteDraft } = require('./catalog-draft-store');
const { collectEvidence, generateCatalogDraft, probeDeepSeekCapabilities } = require('./ai/deepseek-catalog-ai');
const { commitCatalogChange, recoverCatalogTransaction } = require('./catalog-transaction-store');

const OUTPUT_SCHEMA = Object.freeze({
  allowed_fields: [
    'title', 'vendor_label', 'icon', 'summary', 'description', 'official_url', 'status',
    'theme', 'access_level', 'price_badge', 'tool_key', 'scenes', 'best_for_preview',
    'not_for_preview', 'features', 'one_m_context', 'api_pricing', 'plan',
    'applicable_scenarios', 'inapplicable_scenarios', 'sources', 'official_date',
  ],
});

function normalizeGeneratorOptions(options = {}) {
  return {
    ...options,
    model: options.model,
    timeoutMs: options.timeoutMs ?? options.timeout_ms,
    maxSearchQueries: options.maxSearchQueries ?? options.max_search_queries,
    maxPages: options.maxPages ?? options.max_pages,
    maxAiCalls: options.maxAiCalls ?? options.max_ai_calls,
    maxRepairCalls: options.maxRepairCalls ?? options.max_repair_calls,
  };
}

function requireSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.detail_kind || !seed.name || !seed.vendor_name) {
    return { ok: false, code: 'SEED_INVALID', error: 'Seed 必须包含 detail_kind/name/vendor_name' };
  }
  return { ok: true };
}

function costSummary(options = {}) {
  return {
    max_search_queries: options.maxSearchQueries ?? 4,
    max_pages: options.maxPages ?? 8,
    max_ai_calls: options.maxAiCalls ?? 3,
    max_repair_calls: options.maxRepairCalls ?? 1,
    timeout_ms: options.timeoutMs ?? 180000,
  };
}

async function prepareCatalogDraft(seed, options = {}) {
  options = normalizeGeneratorOptions(options);
  const seedCheck = requireSeed(seed);
  if (!seedCheck.ok) return seedCheck;
  const current = loadCatalogSnapshot();
  const draftBase = { seed, base_revision: current.revision, cost: costSummary(options) };
  let evidenceResult;
  if (Array.isArray(options.evidenceBundle)) evidenceResult = { ok: true, evidence: options.evidenceBundle };
  else if (options.skipAi) evidenceResult = { ok: false, code: 'RESEARCH_INSUFFICIENT', error: '未提供 EvidenceBundle' };
  else evidenceResult = await (options.collectEvidence || collectEvidence)(seed, options);
  if (!evidenceResult.ok) {
    const failed = createDraft({ ...draftBase, state: 'failed_retryable', research: { evidence: [], unresolved_claims: [evidenceResult.code] }, readiness: { status: 'blocked', blocking_reasons: [evidenceResult.error], warnings: [] }, last_error: evidenceResult });
    return { ok: false, ...evidenceResult, draft_id: failed.draft_id };
  }

  let draftResult;
  if (options.catalogDraft) draftResult = { ok: true, catalogDraft: options.catalogDraft };
  else draftResult = await (options.generateCatalogDraft || generateCatalogDraft)({ seed, evidenceBundle: evidenceResult.evidence, outputSchema: OUTPUT_SCHEMA }, options);
  if (!draftResult.ok) {
    const failed = createDraft({ ...draftBase, state: 'failed_retryable', research: { evidence: evidenceResult.evidence, unresolved_claims: [draftResult.code] }, readiness: { status: 'blocked', blocking_reasons: [draftResult.error], warnings: [] }, last_error: draftResult });
    return { ok: false, ...draftResult, draft_id: failed.draft_id };
  }

  let plan;
  try { plan = planCatalogChange(current.snapshot, seed, draftResult.catalogDraft); } catch (error) {
    const failed = createDraft({ ...draftBase, state: 'failed_retryable', research: { evidence: evidenceResult.evidence, unresolved_claims: [] }, catalog_draft: draftResult.catalogDraft, readiness: { status: 'blocked', blocking_reasons: [error.message], warnings: [] }, last_error: { code: 'PLANNER_FAILED', error: error.message } });
    return { ok: false, code: 'PLANNER_FAILED', error: error.message, draft_id: failed.draft_id };
  }
  const validation = validateCatalogSnapshot(plan.snapshot);
  if (!validation.ok) return { ok: false, code: 'SNAPSHOT_INVALID', errors: validation.errors };
  const draft = createDraft({
    ...draftBase,
    state: 'preview_ready',
    research: { evidence: evidenceResult.evidence, unresolved_claims: [] },
    catalog_draft: draftResult.catalogDraft,
    readiness: { status: 'ready', blocking_reasons: [], warnings: [] },
    change_preview: plan.changePreview,
    preview_hash: plan.previewHash,
  });
  return { ok: true, draft_id: draft.draft_id, draft, cost: draftBase.cost };
}

function reviewCatalogDraft(draftId) {
  const draft = readDraft(draftId);
  const current = loadCatalogSnapshot();
  if (draft.base_revision !== current.revision) {
    return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId, currentRevision: current.revision, baseRevision: draft.base_revision };
  }
  const plan = planCatalogChange(current.snapshot, draft.seed, draft.catalog_draft);
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
  const result = commitCatalogChange(draft.seed, { ...options, draftId, expectedRevision, catalogDraft: draft.catalog_draft });
  if (!result.ok) {
    updateDraft(draftId, { state: result.code === 'ROLLBACK_FAILED' ? 'rollback_failed' : 'failed_retryable', last_error: result }, 'catalog-apply-failed');
    return result;
  }
  try {
    deleteDraft(draftId);
  } catch (error) {
    updateDraft(draftId, { state: 'cleanup_pending', last_error: { code: 'DRAFT_DELETE_FAILED', error: error.message }, apply_checkpoint: { ...draft.apply_checkpoint, committed_at: new Date().toISOString(), target_revision: result.targetRevision } }, 'catalog-cleanup-pending');
    return { ok: true, cleanup_pending: true, targetRevision: result.targetRevision };
  }
  return { ok: true, targetRevision: result.targetRevision, deleted: true };
}

function discardCatalogDraft(draftId) {
  const draft = readDraft(draftId);
  if (!['researching', 'preview_ready', 'failed_retryable', 'rolled_back'].includes(draft.state)) return { ok: false, code: 'DRAFT_DISCARD_FORBIDDEN', state: draft.state };
  return { ok: deleteDraft(draftId), draft_id: draftId };
}

function recoverCatalogTransactions() {
  return recoverCatalogTransaction();
}

function loadGeneratorConfig() {
  try { return JSON.parse(fs.readFileSync(CATALOG_GENERATOR_FILES.localConfig, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { provider: 'deepseek' };
    throw error;
  }
}

module.exports = { OUTPUT_SCHEMA, normalizeGeneratorOptions, prepareCatalogDraft, reviewCatalogDraft, applyCatalogDraft, discardCatalogDraft, recoverCatalogTransactions, probeDeepSeekCapabilities, loadGeneratorConfig };
