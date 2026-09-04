'use strict';

/**
 * Maintainer-only coordinator for approved pending tool candidates.
 *
 * This module deliberately does not call catalog-batch: that module's contract
 * includes automatic Apply.  Every operation here is a single Catalog
 * Assistant Draft operation and remains reviewable until an explicit Apply.
 */

const crypto = require('crypto');
const { readPending } = require('../news/feedback/pending-review-store');
const { pendingCandidateToSeed } = require('../news/feedback/catalog-draft-adapter');
const { resolveBatchCandidates, estimateResolutionNeed } = require('./catalog-batch');
const { loadCatalogSnapshot } = require('./catalog-snapshot-store');
const { DIRS } = require('../shared/paths');
const { getProvider } = require('../shared/providers');
const assistant = require('./catalog-assistant');
const draftStore = require('./catalog-draft-store');
const { normalizeGatewayErrorCode } = require('./catalog-draft-envelope');

const RETRYABLE_ERROR_CODES = new Set([
  'DEEPSEEK_TIMEOUT', 'DEEPSEEK_RATE_LIMITED', 'DEEPSEEK_PROVIDER_ERROR', 'DEEPSEEK_NETWORK_ERROR',
  'DEEPSEEK_SYNTHESIS_INCOMPLETE', 'DEEPSEEK_SYNTHESIS_EMPTY', 'DEEPSEEK_SYNTHESIS_FAILED',
  'DEEPSEEK_OUTPUT_INVALID', 'DEEPSEEK_SCHEMA_INVALID',
]);

const PROJECT_ROOT = DIRS.project;
// 与 assistant.recoveryEntryBlocked 对齐：孤儿 resuming（进程重启遗留）可复用，
// 否则恢复中途再点 prepare 会绕过复用为同一候选重复建草稿、重复消耗研究成本。
const REUSABLE_DRAFT_STATES = Object.freeze([
  'researching', 'preview_ready', 'preview_blocked', 'failed_retryable', 'rolled_back', 'resuming',
]);
// prepare 是长任务且开局复用检查读不到其他在途调用尚未落盘的草稿；无互斥时
// 并发/重复触发会为同一候选各建一条草稿并各自烧完整研究预算。
let prepareInFlight = false;
const RECOVERY_OPTION_KEYS = Object.freeze([
  'provider', 'model', 'protocol', 'retrieval_provider', 'access_mode', 'timeout_ms',
  'max_search_queries', 'max_pages', 'max_responses_calls', 'max_synthesis_calls',
  'search_depth', 'max_search_results', 'extract_depth', 'chunks_per_source',
]);
const RECOVERY_OPTION_LIMITS = Object.freeze({
  timeout_ms: [1000, 600000], max_search_queries: [1, 20], max_pages: [1, 100],
  max_responses_calls: [1, 50], max_synthesis_calls: [1, 5], max_search_results: [1, 20], chunks_per_source: [1, 10],
});

function normalizeRecoveryOptions(input, defaults) {
  if (input === undefined) return assistant.normalizeGeneratorOptions(defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw codeError('RECOVERY_OPTIONS_INVALID');
  const unknown = Object.keys(input).filter(key => !RECOVERY_OPTION_KEYS.includes(key));
  if (unknown.length) throw codeError('RECOVERY_OPTIONS_INVALID');
  for (const field of ['model', 'provider', 'protocol', 'retrieval_provider', 'access_mode']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw codeError(field === 'model' ? 'MODEL_REQUIRED' : 'RECOVERY_OPTIONS_INVALID');
  }
  for (const [key, range] of Object.entries(RECOVERY_OPTION_LIMITS)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) throw codeError('RECOVERY_OPTIONS_INVALID');
  }
  if (input.access_mode !== undefined && !['keyed', 'keyless'].includes(String(input.access_mode))) throw codeError('RECOVERY_OPTIONS_INVALID');
  const merged = assistant.normalizeGeneratorOptions({ ...defaults, ...input });
  if (!merged.model || typeof merged.model !== 'string') throw codeError('MODEL_REQUIRED');
  const provider = getProvider(merged.provider);
  if (!provider || provider.protocol !== merged.protocol || merged.retrievalProvider !== 'tavily') throw codeError('RECOVERY_OPTIONS_INVALID');
  return merged;
}

/** 脱敏本地路径，避免把绝对路径/临时路径泄露进浏览器 DTO。 */
function sanitizeReason(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const root of [PROJECT_ROOT, PROJECT_ROOT.replace(/\\/g, '/'), PROJECT_ROOT.toLowerCase(), PROJECT_ROOT.replace(/\\/g, '/').toLowerCase()]) {
    out = out.split(root).join('<project>');
  }
  return out.replace(/[A-Za-z]:\\[^\s'"<>]*/g, '<path>');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}
function codeError(code, message = code) {
  const error = new Error(message); error.code = code; return error;
}
function snapshotOf(options) {
  if (typeof options.loadCatalog === 'function') return options.loadCatalog();
  return loadCatalogSnapshot();
}
function pendingOf(options) {
  if (typeof options.readPending === 'function') return options.readPending(options);
  return readPending('tools', options);
}
function approvedCandidates(options) {
  const pending = pendingOf(options);
  return { pending, cards: pending.cards.filter(card => card.review_status === 'approved') };
}
function candidateKey(card) { return card.candidate_key; }

function planHashOf(value) { return hash({ kind: 'catalog-workbench-plan', ...value }); }

function recoveryDiagnostic(draft) {
  if (draft?.readiness?.status === 'ready') return { recoveryKind: null, errorCode: null, missingFields: [], missingConfigFields: [], suggestedDetailKind: null, reason: null };
  const failure = draft?.last_error || {};
  let errorCode = normalizeGatewayErrorCode(failure.code);
  if (errorCode === 'DEEPSEEK_OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure.error || ''))) errorCode = 'MODEL_REQUIRED';
  const missingFields = [...new Set([
    ...(Array.isArray(failure.missing_fields) ? failure.missing_fields : []),
    ...(Array.isArray(draft?.coverage?.missing) ? draft.coverage.missing.map(item => `${item.layer}.${item.field}`) : []),
  ].filter(field => typeof field === 'string' && field.trim()))];
  const missingConfigFields = [...new Set((Array.isArray(failure.missing_config_fields) ? failure.missing_config_fields : []).filter(field => typeof field === 'string' && field.trim()))];
  // 存储 last_error 里的 recovery_kind 可能来自旧版误分类（如 kind 段错误码被判成
  // manual_required），已知 retryable 码强制覆盖，否则该 Draft 在面板上永久丢失恢复入口。
  let recoveryKind = RETRYABLE_ERROR_CODES.has(errorCode) ? 'retryable' : (failure.recovery_kind || null);
  if (!recoveryKind) {
    if (errorCode === 'MODEL_REQUIRED' || ['DEEPSEEK_AUTH_REQUIRED', 'DEEPSEEK_ENDPOINT_INVALID', 'AI_PROVIDER_UNSUPPORTED', 'AI_PROTOCOL_MISMATCH', 'RETRIEVAL_PROVIDER_UNSUPPORTED', 'TAVILY_ACCESS_MODE_REQUIRED'].includes(errorCode)) recoveryKind = 'config_required';
    else if (RETRYABLE_ERROR_CODES.has(errorCode)) recoveryKind = 'retryable';
    else if (errorCode === 'PROFILE_MISMATCH_SUSPECTED' || errorCode.startsWith('PLACEMENT_') || errorCode === 'SEED_INVALID') recoveryKind = 'seed_or_profile_required';
    else if (missingFields.length || errorCode === 'SYNTHESIS_COVERAGE_INCOMPLETE') recoveryKind = 'evidence_required';
    else recoveryKind = 'manual_required';
  }
  const suggestedDetailKind = typeof failure.suggested_detail_kind === 'string' ? failure.suggested_detail_kind : null;
  const researchComplete = draft?.research?.ok === true
    || (draft?.research?.ok !== false && Array.isArray(draft?.research?.official_sources) && draft.research.official_sources.length > 0 && !draft.research_progress?.failed_scope);
  const recoveryMode = researchComplete && ['config_required', 'retryable'].includes(recoveryKind) && !errorCode.startsWith('TAVILY_') ? 'synthesis_only' : 'research_resume';
  const reason = {
    MODEL_REQUIRED: '缺少 model 配置，请填写模型名后重试。',
    DEEPSEEK_AUTH_REQUIRED: '缺少 DeepSeek 凭据，请在仓库根目录 .env 配置对应 key。',
    TAVILY_ACCESS_MODE_REQUIRED: '缺少 Tavily access mode 配置。',
    SYNTHESIS_COVERAGE_INCOMPLETE: missingFields.length ? `缺少官方证据字段：${missingFields.join('、')}` : '官方证据字段不完整。',
    PROFILE_MISMATCH_SUSPECTED: suggestedDetailKind ? `候选类型可能应为 ${suggestedDetailKind}，请修正候选资料。` : '候选类型或 Profile 不匹配。',
  }[errorCode] || (errorCode ? `恢复被阻断（${errorCode}）。` : 'Draft 当前不可恢复。');
  return { recoveryKind, recoveryMode, errorCode: errorCode || 'DRAFT_BLOCKED', missingFields, missingConfigFields: missingConfigFields.length ? missingConfigFields : (errorCode === 'MODEL_REQUIRED' ? ['model'] : []), suggestedDetailKind, reason };
}

function projectDraft(draft, extra = {}) {
  if (!draft) return null;
  const readiness = draft.readiness || {};
  const diagnostic = recoveryDiagnostic(draft);
  return {
    draft_id: draft.draft_id,
    candidate_name: String(draft.seed?.name || '').trim() || null,
    state: draft.state,
    base_revision: draft.base_revision || null,
    preview_hash: draft.preview_hash || null,
    readiness: readiness.status || null,
    recovery_kind: diagnostic.recoveryKind,
    recovery_mode: diagnostic.recoveryMode,
    error_code: diagnostic.errorCode,
    missing_fields: diagnostic.missingFields,
    missing_config_fields: diagnostic.missingConfigFields,
    suggested_detail_kind: diagnostic.suggestedDetailKind,
    blocking_reasons: diagnostic.reason ? [diagnostic.reason] : [],
    warnings: Array.isArray(readiness.warnings) ? readiness.warnings.slice(0, 5).map(sanitizeReason) : [],
    updated_at: draft.updated_at || null,
    ...extra,
  };
}

function createCatalogWorkbench(options = {}) {
  const configuredGeneratorOptions = assistant.loadGeneratorConfig();
  const generatorOptions = assistant.normalizeGeneratorOptions({ ...configuredGeneratorOptions, ...(options.generatorOptions || {}) });
  const planFn = options.planCatalogDraft || assistant.planCatalogDraft;
  const prepareFn = options.prepareCatalogDraft || assistant.prepareCatalogDraft;
  const resumeFn = options.resumeCatalogDraft || assistant.resumeCatalogDraft;
  const recoveryPlanFn = options.recoveryPlanForDraft || assistant.recoveryPlanForDraft;
  const reviewFn = options.reviewCatalogDraft || assistant.reviewCatalogDraft;
  const batchReviewFn = options.reviewCatalogDraftBatch || assistant.reviewCatalogDraftBatch;
  const applyFn = options.applyCatalogDraft || assistant.applyCatalogDraft;
  const batchApplyFn = options.applyCatalogDrafts || assistant.applyCatalogDrafts;
  const discardFn = options.discardCatalogDraft || assistant.discardCatalogDraft;
  const listFn = options.listDrafts || draftStore.listDrafts;
  const readFn = options.readDraft || draftStore.readDraft;

  function buildPlan() {
    const { pending, cards } = approvedCandidates(options);
    const catalog = snapshotOf(options);
    const seeds = [];
    const blocked = [];
    for (const card of cards) {
      try { seeds.push({ card, seed: pendingCandidateToSeed(card, {}) }); }
      catch (error) { blocked.push({ candidate_key: candidateKey(card), code: String(error?.message || 'PENDING_CANDIDATE_INVALID').split(':')[0] }); }
    }
    if (!cards.length) {
      return { ok: false, code: 'PENDING_CANDIDATE_NOT_APPROVED', pending_revision: pending.revision, catalog_revision: catalog.revision, candidates: [], blocking_reasons: ['没有已批准的工具待补卡'] };
    }
    const plans = [];
    for (const entry of seeds) {
      try {
        const result = planFn(entry.seed, generatorOptions);
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: result.ok, cost_plan: result.cost_plan || null, code: result.code || null });
      } catch (error) {
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: false, code: String(error?.message || 'PLAN_FAILED').split(':')[0] });
      }
    }
    const resolveOptions = { ...generatorOptions, ...(options.resolveOptions || {}) };
    const resolutionNeed = estimateResolutionNeed(cards, resolveOptions);
    const plan = {
      pending_revision: pending.revision,
      catalog_revision: catalog.revision,
      candidates: cards.map(card => candidateKey(card)),
      entries: plans,
      blocked,
      resolution: resolutionNeed,
    };
    return {
      ok: true,
      status: 'cost_confirmation_required',
      ...plan,
      plan_hash: planHashOf(plan),
      cost_plan: {
        ...plans.reduce((total, entry) => {
          for (const [key, value] of Object.entries(entry.cost_plan?.hard_limits || {})) total[key] = Number(total[key] || 0) + Number(value || 0);
          return total;
        }, {}),
        vendor_search_upper_bound: resolutionNeed.vendor_search_upper_bound,
        vendor_responses_upper_bound: resolutionNeed.vendor_responses_upper_bound,
      },
    };
  }

  function assertPlan(input) {
    const current = buildPlan();
    if (!current.ok) return current;
    if (String(input?.pending_revision || '') !== current.pending_revision || String(input?.catalog_revision || '') !== current.catalog_revision) throw codeError('REVISION_CONFLICT');
    if (String(input?.plan_hash || '') !== current.plan_hash) throw codeError('PLAN_CHANGED');
    return current;
  }

  async function prepare(input = {}) {
    if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    if (prepareInFlight) return { ok: false, code: 'PREPARE_IN_PROGRESS', blocking_reasons: ['已有一轮 Catalog Draft 准备在执行中，请等待其完成后再试。'] };
    prepareInFlight = true;
    try {
      const planned = assertPlan(input);
      if (!planned.ok) return planned;
      const { pending, cards } = approvedCandidates(options);
      const reusableOf = () => listFn().filter(draft => draft.schema_version === 3
        && draft.base_revision === planned.catalog_revision
        && REUSABLE_DRAFT_STATES.includes(draft.state));
      const matchReusable = (reusable, key, card) => reusable.find(draft => !used.has(draft.draft_id)
        && (draft.seed?.candidate_key === key
          || (!draft.seed?.candidate_key && String(draft.seed?.name || '').trim().toLowerCase() === String(card.name || '').trim().toLowerCase())));
      const used = new Set();
      const drafts = [];
      const missingCards = [];
      const initialReusable = reusableOf();
      for (const card of cards) {
        const key = candidateKey(card);
        const existing = matchReusable(initialReusable, key, card);
        if (existing) {
          used.add(existing.draft_id);
          drafts.push(projectDraft(existing, { candidate_key: key, reused: true }));
        } else missingCards.push(card);
      }
      const resolveOptions = { ...generatorOptions, ...(options.resolveOptions || {}) };
      let resolved = { seeds: [], unresolved: [] };
      if (missingCards.length) {
        try {
          resolved = await (options.resolveBatchCandidates || resolveBatchCandidates)(missingCards, resolveOptions);
        } catch (error) { return { ok: false, code: 'DRAFT_BLOCKED', blocking_reasons: ['官方来源解析失败'] }; }
      }
      const byName = new Map((resolved.seeds || []).map(seed => [String(seed.name).trim().toLowerCase(), seed]));
      const blocked = [...(resolved.unresolved || []).map(item => ({ name: item.name, code: 'DRAFT_BLOCKED' })), ...(planned.blocked || [])];
      for (const card of missingCards) {
        const key = candidateKey(card);
        // 官方来源解析期间其他入口可能已为同一候选建好草稿，建前再复查一次。
        const again = matchReusable(reusableOf(), key, card);
        if (again) {
          used.add(again.draft_id);
          drafts.push(projectDraft(again, { candidate_key: key, reused: true }));
          continue;
        }
        const resolvedSeed = byName.get(String(card.name).trim().toLowerCase());
        if (!resolvedSeed) continue;
        const seed = { ...resolvedSeed, candidate_key: key };
        try {
          const result = await prepareFn(seed, { ...generatorOptions, confirmCost: true, catalogAdapters: options.catalogAdapters });
          if (result && result.draft) drafts.push(projectDraft(result.draft, { candidate_key: key, reused: false }));
          else blocked.push({ candidate_key: key, code: result?.code || 'DRAFT_BLOCKED' });
        } catch (error) { blocked.push({ candidate_key: key, code: String(error?.message || 'DRAFT_BLOCKED').split(':')[0] }); }
      }
      return { ok: drafts.length > 0, status: drafts.length ? 'drafts_ready' : 'drafts_blocked', pending_revision: pending.revision, catalog_revision: planned.catalog_revision, plan_hash: planned.plan_hash, drafts, reused: drafts.filter(draft => draft.reused).map(draft => draft.draft_id), blocked };
    } finally { prepareInFlight = false; }
  }

  function list() {
    const drafts = listFn();
    return { catalog_revision: snapshotOf(options).revision, items: drafts.map(draft => projectDraft(draft)), count: drafts.length };
  }
  function read(draftId) { return projectDraft(readFn(draftId)); }
  function review(draftId) { const result = reviewFn(draftId); return result.ok ? { ok: true, draft_id: draftId, current_revision: result.currentRevision, preview_hash: result.previewHash, status: 'review_ready' } : { ok: false, code: result.code || 'DRAFT_BLOCKED', draft_id: draftId, status: 'blocked' }; }
  function recoveryPlan(draftId, input = {}) {
    const expectedRevision = String(input.expected_revision || input.expectedRevision || snapshotOf(options).revision || '').trim();
    if (!expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const rawOptions = Object.prototype.hasOwnProperty.call(input, 'generator_options') ? input.generator_options : input.generatorOptions;
    const merged = normalizeRecoveryOptions(rawOptions, generatorOptions);
    const result = recoveryPlanFn(draftId, { expectedRevision, generatorOptions: merged });
    if (!result?.ok) return result;
    return {
      ...result,
      generator_options: {
        model: merged.model,
        provider: merged.provider,
        protocol: merged.protocol,
        retrieval_provider: merged.retrievalProvider,
        ...(merged.accessMode ? { access_mode: merged.accessMode } : {}),
      },
    };
  }
  async function resume(draftId, input = {}) {
    if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    const expectedRevision = String(input.expected_revision || '').trim();
    if (!expectedRevision || !input.recovery_token) return { ok: false, code: 'RECOVERY_TOKEN_REQUIRED' };
    let merged;
    try { merged = normalizeRecoveryOptions(input.generator_options, generatorOptions); }
    catch (error) { return { ok: false, code: error.code || 'RECOVERY_OPTIONS_INVALID' }; }
    const plan = recoveryPlan(draftId, { expected_revision: expectedRevision, generator_options: input.generator_options });
    if (!plan.ok) return plan;
    if (plan.recovery_token !== input.recovery_token) return { ok: false, code: 'RECOVERY_TOKEN_CHANGED' };
    const result = await resumeFn(draftId, { ...merged, confirmCost: true, expectedRevision, recoveryToken: input.recovery_token, catalogAdapters: options.catalogAdapters });
    return result && result.draft ? { ok: result.ok, draft: projectDraft(result.draft), code: result.code || null } : { ok: false, code: result?.code || 'DRAFT_BLOCKED' };
  }
  function discard(draftId, input = {}) {
    const expectedRevision = String(input?.expected_revision || '').trim();
    if (!expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId };
    const catalog = snapshotOf(options);
    if (catalog.revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId };
    const result = discardFn(draftId);
    return { ok: result.ok === true, draft_id: draftId, code: result.ok ? null : result.code || 'OPERATION_FAILED' };
  }
  function apply(input = {}) {
    const draftId = String(input.draft_id || '').trim();
    const expectedRevision = String(input.expected_revision || '').trim();
    const previewHash = String(input.preview_hash || '').trim();
    if (!/^draft-[A-Za-z0-9-]+$/.test(draftId)) return { ok: false, code: 'DRAFT_ID_INVALID' };
    if (!expectedRevision || !previewHash) return { ok: false, code: 'DRAFT_BLOCKED' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFT ${draftId}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    const checked = review(draftId);
    if (!checked.ok) return checked;
    if (checked.preview_hash !== previewHash || checked.current_revision !== expectedRevision) return { ok: false, code: checked.current_revision !== expectedRevision ? 'REVISION_CONFLICT' : 'PREVIEW_CHANGED' };
    const result = applyFn({ draftId, previewHash, expectedRevision }, options.applyOptions || {});
    return result && result.ok ? { ok: true, status: 'completed', draft_id: draftId, target_revision: result.targetRevision } : { ok: false, code: result?.code || 'OPERATION_FAILED' };
  }

  function batchPreview() {
    const { pending } = approvedCandidates(options);
    const allDrafts = listFn().filter(draft => draft.schema_version === 3 && draft.state !== 'cleanup_pending');
    const blockedDrafts = allDrafts.filter(draft => draft.readiness?.status !== 'ready');
    const drafts = allDrafts.filter(draft => draft.readiness?.status === 'ready');
    const draftIds = drafts.map(draft => draft.draft_id).sort();
    const blockers = blockedDrafts.map(draft => projectDraft(draft));
    if (!draftIds.length) return { ok: false, code: 'DRAFTS_NOT_READY', status: 'blocked', draft_count: 0, source_pending_revision: pending.revision, blockers };
    const checked = batchReviewFn(draftIds, { sourcePendingRevision: pending.revision });
    if (!checked.ok) return { ok: false, code: checked.code || 'DRAFT_BATCH_STALE', status: 'blocked', draft_count: draftIds.length, source_pending_revision: pending.revision, blockers: [...blockers, { code: checked.code || 'DRAFT_BATCH_STALE' }] };
    return {
      ok: true,
      status: 'review_ready',
      expected_revision: checked.currentRevision,
      source_pending_revision: pending.revision,
      draft_count: checked.draft_ids.length,
      drafts: checked.reviews.map(review => projectDraft(review.draft, { change_preview: review.plan.changePreview })),
      change_preview: checked.plan.changePreview,
      batch_token: checked.batchToken,
      blockers,
    };
  }
  function applyBatch(input = {}) {
    const draftIds = input.draft_ids;
    const expectedRevision = String(input.expected_revision || '').trim();
    const batchToken = String(input.batch_token || '').trim();
    if (!Array.isArray(draftIds) || !draftIds.length) return { ok: false, code: 'DRAFT_IDS_INVALID' };
    if (!expectedRevision || !batchToken) return { ok: false, code: 'DRAFT_BATCH_STALE' };
    if (String(input.confirm || '') !== `APPLY CATALOG DRAFTS ${batchToken}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    const { pending } = approvedCandidates(options);
    const result = batchApplyFn({ draftIds, expectedRevision, batchToken }, {
      ...(options.applyOptions || {}),
      buildDist: false,
      sourcePendingRevision: pending.revision,
    });
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'OPERATION_FAILED' };
    return {
      ok: true,
      status: result.status || 'completed',
      target_revision: result.targetRevision,
      applied_draft_ids: result.appliedDraftIds || draftIds,
      cleanup_pending: result.cleanupPending || [],
      cleanup_only: result.cleanupOnly === true,
    };
  }

  return Object.freeze({ plan: buildPlan, prepare, list, read, resume, recoveryPlan, review, discard, apply, batchPreview, applyBatch });
}

function coordinator(options = {}) { return createCatalogWorkbench(options); }
function planCatalogPending(options = {}) { return coordinator(options).plan(); }
function prepareCatalogPending(input, options = {}) { return coordinator(options).prepare(input); }
function listCatalogDrafts(options = {}) { return coordinator(options).list(); }
function readCatalogDraft(draftId, options = {}) { return coordinator(options).read(draftId); }
function reviewCatalogDraft(draftId, options = {}) { return coordinator(options).review(draftId); }
function resumeCatalogDraft(draftId, input, options = {}) { return coordinator(options).resume(draftId, input); }
function recoveryPlanCatalogDraft(draftId, input = {}, options = {}) { return coordinator(options).recoveryPlan(draftId, input); }
function discardCatalogDraft(draftId, input = {}, options = {}) { return coordinator(options).discard(draftId, input); }
function applyCatalogDraft(input, options = {}) { return coordinator(options).apply(input); }
function previewCatalogDraftBatch(options = {}) { return coordinator(options).batchPreview(); }
function applyCatalogDraftBatch(input, options = {}) { return coordinator(options).applyBatch(input); }

module.exports = {
  createCatalogWorkbench,
  planHashOf,
  projectDraft,
  planCatalogPending,
  prepareCatalogPending,
  listCatalogDrafts,
  readCatalogDraft,
  reviewCatalogDraft,
  resumeCatalogDraft,
  recoveryPlanCatalogDraft,
  discardCatalogDraft,
  applyCatalogDraft,
  previewCatalogDraftBatch,
  applyCatalogDraftBatch,
};
