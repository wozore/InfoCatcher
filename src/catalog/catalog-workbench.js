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
const assistant = require('./catalog-assistant');
const draftStore = require('./catalog-draft-store');

const PROJECT_ROOT = DIRS.project;

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

function projectDraft(draft, extra = {}) {
  if (!draft) return null;
  const readiness = draft.readiness || {};
  return {
    draft_id: draft.draft_id,
    state: draft.state,
    base_revision: draft.base_revision || null,
    preview_hash: draft.preview_hash || null,
    readiness: readiness.status || null,
    blocking_reasons: Array.isArray(readiness.blocking_reasons) ? readiness.blocking_reasons.slice(0, 5).map(sanitizeReason) : [],
    warnings: Array.isArray(readiness.warnings) ? readiness.warnings.slice(0, 5).map(sanitizeReason) : [],
    updated_at: draft.updated_at || null,
    ...extra,
  };
}

function createCatalogWorkbench(options = {}) {
  const planFn = options.planCatalogDraft || assistant.planCatalogDraft;
  const prepareFn = options.prepareCatalogDraft || assistant.prepareCatalogDraft;
  const resumeFn = options.resumeCatalogDraft || assistant.resumeCatalogDraft;
  const reviewFn = options.reviewCatalogDraft || assistant.reviewCatalogDraft;
  const applyFn = options.applyCatalogDraft || assistant.applyCatalogDraft;
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
        const result = planFn(entry.seed, options.generatorOptions || {});
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: result.ok, cost_plan: result.cost_plan || null, code: result.code || null });
      } catch (error) {
        plans.push({ candidate_key: candidateKey(entry.card), name: entry.card.name, ok: false, code: String(error?.message || 'PLAN_FAILED').split(':')[0] });
      }
    }
    const resolveOptions = { ...(options.resolveOptions || {}), ...(options.generatorOptions || {}) };
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
    const planned = assertPlan(input);
    if (!planned.ok) return planned;
    const { pending, cards } = approvedCandidates(options);
    const resolveOptions = { ...(options.resolveOptions || {}), ...(options.generatorOptions || {}) };
    let resolved;
    try {
      resolved = await (options.resolveBatchCandidates || resolveBatchCandidates)(cards, resolveOptions);
    } catch (error) { return { ok: false, code: 'DRAFT_BLOCKED', blocking_reasons: ['官方来源解析失败'] }; }
    const byName = new Map((resolved.seeds || []).map(seed => [String(seed.name).trim().toLowerCase(), seed]));
    const drafts = [];
    const blocked = [...(resolved.unresolved || []).map(item => ({ name: item.name, code: 'DRAFT_BLOCKED' })), ...(planned.blocked || [])];
    for (const card of cards) {
      const seed = byName.get(String(card.name).trim().toLowerCase());
      if (!seed) continue;
      try {
        const result = await prepareFn(seed, { ...(options.generatorOptions || {}), confirmCost: true, catalogAdapters: options.catalogAdapters });
        if (result && result.draft) drafts.push(projectDraft(result.draft, { candidate_key: candidateKey(card) }));
        else blocked.push({ candidate_key: candidateKey(card), code: result?.code || 'DRAFT_BLOCKED' });
      } catch (error) { blocked.push({ candidate_key: candidateKey(card), code: String(error?.message || 'DRAFT_BLOCKED').split(':')[0] }); }
    }
    return { ok: drafts.length > 0, status: drafts.length ? 'drafts_ready' : 'drafts_blocked', pending_revision: pending.revision, catalog_revision: planned.catalog_revision, plan_hash: planned.plan_hash, drafts, blocked };
  }

  function list() {
    const drafts = listFn();
    return { items: drafts.map(draft => projectDraft(draft)), count: drafts.length };
  }
  function read(draftId) { return projectDraft(readFn(draftId)); }
  function review(draftId) { const result = reviewFn(draftId); return result.ok ? { ok: true, draft_id: draftId, current_revision: result.currentRevision, preview_hash: result.previewHash, status: 'review_ready' } : { ok: false, code: result.code || 'DRAFT_BLOCKED', draft_id: draftId, status: 'blocked' }; }
  async function resume(draftId, input = {}) {
    if (input.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
    const result = await resumeFn(draftId, { ...(options.generatorOptions || {}), confirmCost: true });
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

  return Object.freeze({ plan: buildPlan, prepare, list, read, resume, review, discard, apply });
}

function coordinator(options = {}) { return createCatalogWorkbench(options); }
function planCatalogPending(options = {}) { return coordinator(options).plan(); }
function prepareCatalogPending(input, options = {}) { return coordinator(options).prepare(input); }
function listCatalogDrafts(options = {}) { return coordinator(options).list(); }
function readCatalogDraft(draftId, options = {}) { return coordinator(options).read(draftId); }
function reviewCatalogDraft(draftId, options = {}) { return coordinator(options).review(draftId); }
function resumeCatalogDraft(draftId, input, options = {}) { return coordinator(options).resume(draftId, input); }
function discardCatalogDraft(draftId, input = {}, options = {}) { return coordinator(options).discard(draftId, input); }
function applyCatalogDraft(input, options = {}) { return coordinator(options).apply(input); }

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
  discardCatalogDraft,
  applyCatalogDraft,
};
