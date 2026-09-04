'use strict';

/**
 * Pending candidate store.
 *
 * This is the sole writer for the tool and concept pending files.  The files
 * intentionally keep the evidence-enrichment fields needed by the generators,
 * while the workbench must use projectPending() before returning data to a
 * browser.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('../../shared/json-store');
const { CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../../shared/paths');

const SCHEMA_VERSION = 2;
const KINDS = Object.freeze({ tools: 'tool_cards_pending', concepts: 'concept_cards_pending' });
const REVIEW_STATUSES = new Set(['pending', 'approved', 'discarded']);
const LOCK_RETRIES = 20;
const LOCK_DELAY_MS = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * 跨进程互斥写：排他锁文件（wx）＋ EEXIST 短重试，锁内重读→mutation→原子写。
 * 与 review 路径共用同一锁文件，保证工作台审核与管线 merge 不会互相覆盖人工结论。
 */
async function withPendingLock(file, fn) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      acquireLock(lockPath, { run_id: 'pending-review-store', pid: process.pid });
      try { return await fn(); }
      finally { releaseLock(lockPath, 'pending-review-store'); }
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === LOCK_RETRIES - 1) throw error;
      await sleep(LOCK_DELAY_MS);
    }
  }
}

function keyInput(kind, value) {
  const prefix = kind === 'tools' ? 'tool\0' : kind === 'concepts' ? 'concept\0' : null;
  if (!prefix) throw new Error('PENDING_KIND_INVALID');
  return `${prefix}${String(value || '').trim().toLowerCase()}`;
}

function candidateKeyOf(kind, value) {
  const name = typeof value === 'object' && value !== null
    ? (kind === 'tools' ? value.name : value.term)
    : value;
  const normalized = String(name || '').trim();
  if (!normalized) throw new Error('PENDING_CANDIDATE_NAME_REQUIRED');
  return crypto.createHash('sha256').update(keyInput(kind, normalized), 'utf8').digest('base64url');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function hashValue(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}

function fileFor(kind, options = {}) {
  if (kind === 'tools') return options.toolFile || CATALOG_GENERATOR_FILES.pendingTools;
  if (kind === 'concepts') return options.conceptFile || CONCEPT_FILES.pendingConcepts;
  throw new Error('PENDING_KIND_INVALID');
}

function nameField(kind) { return kind === 'tools' ? 'name' : 'term'; }

function readRaw(kind, options = {}) {
  const file = fileFor(kind, options);
  const fallback = { schema_version: SCHEMA_VERSION, kind: KINDS[kind], generated_at: null, count: 0, revision: revisionOfPending([]), cards: [] };
  const payload = readJson(file, fallback);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cards)) throw new Error('PENDING_FILE_INVALID');
  return payload;
}

function businessPayload(kind, card) {
  const fields = kind === 'tools'
    ? ['name', 'url', 'description', 'detail_kind_hint', 'vendor_key', 'tool_key', 'modality', 'official_url', 'official_urls', 'new_group_title', 'existing_level1_ref', 'existing_level2_ref']
    : ['term', 'full_name', 'definition', 'category', 'source', 'related_terms', 'relevance'];
  const result = {};
  for (const field of fields) {
    if (card && card[field] !== undefined) result[field] = card[field];
  }
  return result;
}

function reviewPayload(card) {
  return {
    review_status: REVIEW_STATUSES.has(card?.review_status) ? card.review_status : 'pending',
    reviewed_at: card?.reviewed_at || null,
  };
}

function revisionOfPending(cards) {
  const semantic = (cards || []).map(card => ({
    candidate_key: card.candidate_key,
    business: card.business || card,
    review_status: card.review_status,
    reviewed_at: card.reviewed_at || null,
  })).sort((a, b) => String(a.candidate_key).localeCompare(String(b.candidate_key)));
  return hashValue(semantic);
}

function normalizeCard(kind, input, old = null) {
  const field = nameField(kind);
  const value = String(input?.[field] || old?.[field] || '').trim();
  if (!value) return null;
  const candidateKey = candidateKeyOf(kind, value);
  const merged = { ...(old || {}), ...(input || {}) };
  // Blank feedback placeholders must not erase a manually completed candidate.
  for (const [key, current] of Object.entries(old || {})) {
    if (merged[key] === '' || merged[key] === null || merged[key] === undefined) merged[key] = current;
  }
  merged[field] = value;
  merged.candidate_key = candidateKey;
  const oldBusiness = old ? businessPayload(kind, old) : null;
  const nextBusiness = businessPayload(kind, merged);
  const sameBusiness = oldBusiness && hashValue(oldBusiness) === hashValue(nextBusiness);
  const oldStatus = old ? reviewPayload(old) : null;
  const status = oldStatus && sameBusiness ? oldStatus : (old ? { review_status: 'pending', reviewed_at: null } : reviewPayload(input));
  const normalized = {
    ...merged,
    candidate_key: candidateKey,
    ...status,
    generated_at: merged.generated_at || old?.generated_at || new Date().toISOString(),
    source_hotspot: Boolean(merged.source_hotspot),
    mentioned_in_summaries: Number.isFinite(Number(merged.mentioned_in_summaries)) ? Number(merged.mentioned_in_summaries) : 1,
    workflow_state: status.review_status === 'approved' ? 'approved_pending' : status.review_status === 'discarded' ? 'discarded' : 'pending_review',
    blocking_reasons: Array.isArray(merged.blocking_reasons) ? [...merged.blocking_reasons] : [],
  };
  delete normalized.id;
  delete normalized.pending;
  return normalized;
}

function normalizeLegacyCards(kind, cards) {
  const byKey = new Map();
  for (const card of cards || []) {
    const normalized = normalizeCard(kind, card);
    if (normalized) byKey.set(normalized.candidate_key, normalized);
  }
  return [...byKey.values()];
}

function readPending(kind, options = {}) {
  const payload = readRaw(kind, options);
  const cards = normalizeLegacyCards(kind, payload.cards);
  return {
    schema_version: SCHEMA_VERSION,
    kind: KINDS[kind],
    generated_at: payload.generated_at || null,
    count: cards.length,
    revision: revisionOfPending(cards),
    cards,
  };
}

function projectionItem(kind, card) {
  const field = nameField(kind);
  return {
    candidate_key: card.candidate_key || candidateKeyOf(kind, card[field]),
    [field]: card[field],
    ...(kind === 'tools' && card.detail_kind_hint ? { detail_kind_hint: card.detail_kind_hint } : {}),
    source_hotspot: Boolean(card.source_hotspot),
    mentioned_in_summaries: Number(card.mentioned_in_summaries || 0),
    generated_at: card.generated_at || null,
    review_status: REVIEW_STATUSES.has(card.review_status) ? card.review_status : 'pending',
    reviewed_at: card.reviewed_at || null,
    workflow_state: card.workflow_state || 'pending_review',
    blocking_reasons: Array.isArray(card.blocking_reasons) ? [...card.blocking_reasons] : [],
  };
}

function projectPending(kind, value) {
  const payload = Array.isArray(value) ? { cards: value } : (value || { cards: [] });
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  return {
    revision: payload.revision || revisionOfPending(cards),
    items: cards.map(card => projectionItem(kind, card)),
  };
}

function writePending(kind, cards, options = {}) {
  const normalized = normalizeLegacyCards(kind, cards);
  const payload = {
    schema_version: SCHEMA_VERSION,
    kind: KINDS[kind],
    generated_at: options.generatedAt || new Date().toISOString(),
    count: normalized.length,
    revision: revisionOfPending(normalized),
    cards: normalized,
  };
  const file = fileFor(kind, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, options.runId || 'pending-review-store');
  return payload;
}

async function mergePending(kind, candidates, options = {}) {
  const file = fileFor(kind, options);
  return withPendingLock(file, () => {
    const current = readPending(kind, options);
    const byKey = new Map(current.cards.map(card => [card.candidate_key, card]));
    const added = [];
    const updated = [];
    for (const candidate of candidates || []) {
      const normalized = normalizeCard(kind, candidate);
      if (!normalized) continue;
      const old = byKey.get(normalized.candidate_key);
      const next = normalizeCard(kind, candidate, old);
      if (!old) added.push(next.candidate_key);
      else if (hashValue(businessPayload(kind, old)) !== hashValue(businessPayload(kind, next))) updated.push(next.candidate_key);
      byKey.set(next.candidate_key, next);
    }
    const payload = writePending(kind, [...byKey.values()], options);
    return { ...payload, added, updated, skipped: Math.max(0, (candidates || []).length - added.length - updated.length) };
  });
}

async function reviewPending(kind, candidateKey, decision, expectedRevision, options = {}) {
  if (!REVIEW_STATUSES.has(decision) || decision === 'pending') throw new Error('PENDING_REVIEW_DECISION_INVALID');
  const file = fileFor(kind, options);
  return withPendingLock(file, () => {
    const current = readPending(kind, options);
    if (expectedRevision !== current.revision) {
      const error = new Error('REVISION_CONFLICT'); error.code = 'REVISION_CONFLICT'; throw error;
    }
    const index = current.cards.findIndex(card => card.candidate_key === candidateKey);
    if (index < 0) { const error = new Error('PENDING_CANDIDATE_NOT_FOUND'); error.code = 'PENDING_CANDIDATE_NOT_FOUND'; throw error; }
    const next = [...current.cards];
    next[index] = { ...next[index], review_status: decision, reviewed_at: new Date().toISOString(), workflow_state: decision === 'approved' ? 'approved_pending' : 'discarded' };
    return writePending(kind, next, options);
  });
}

function pendingByKey(kind, candidateKey, options = {}) {
  return readPending(kind, options).cards.find(card => card.candidate_key === candidateKey) || null;
}

module.exports = {
  SCHEMA_VERSION,
  KINDS,
  candidateKeyOf,
  revisionOfPending,
  readPending,
  writePending,
  mergePending,
  reviewPending,
  pendingByKey,
  projectPending,
  fileFor,
  // Explicit aliases make the ownership boundary discoverable to callers.
  readPendingCandidates: readPending,
  mergePendingCandidates: mergePending,
  reviewPendingCandidate: reviewPending,
};
