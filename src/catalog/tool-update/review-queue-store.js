'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { normalizeToolUpdateReviewValue, DECISION_SOURCES } = require('./tool-update-review-contract');
const {
  clone,
  nowOf,
  defaultReviewQueue,
  reviewQueueRevision,
  reviewQueueProjection,
  reviewFileOf,
  safeAiSuggestion,
  safeLocalizations,
  safeLocalizationsMeta,
  safeSupersededFields,
} = require('./review-model');

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_KIND = 'tool_update_review';
const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const ITEM_STATUSES = Object.freeze(['candidate', 'blocked']);
const MAX_EXCERPT_CHARS = 4000;

function normalizeItem(item, now) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('TOOL_UPDATE_REVIEW_ITEM_INVALID');
  const candidateKey = String(item.candidate_key || '').trim();
  const productKey = String(item.product_key || '').trim();
  const sourceUrl = String(item.source_url || '').trim();
  if (!candidateKey || !productKey || !sourceUrl) throw new Error('TOOL_UPDATE_REVIEW_ITEM_ID_REQUIRED');
  if (!/^https:\/\//i.test(sourceUrl)) throw new Error('TOOL_UPDATE_REVIEW_SOURCE_URL_INVALID');
  const reviewStatus = item.review_status || 'pending';
  if (!REVIEW_STATUSES.includes(reviewStatus)) throw new Error('TOOL_UPDATE_REVIEW_STATUS_INVALID');
  const status = item.status || 'blocked';
  if (!ITEM_STATUSES.includes(status)) throw new Error('TOOL_UPDATE_REVIEW_ITEM_STATUS_INVALID');
  if (item.evidence?.excerpt && String(item.evidence.excerpt).length > MAX_EXCERPT_CHARS) throw new Error('TOOL_UPDATE_REVIEW_EXCERPT_TOO_LONG');
  const safeEvidence = {
    title: String(item.evidence?.title || '').trim(),
    official_published_at: item.evidence?.official_published_at || null,
    excerpt: String(item.evidence?.excerpt || '').trim().slice(0, MAX_EXCERPT_CHARS),
    content_hash: item.evidence?.content_hash || null,
    status: item.evidence?.status || null,
  };
  return {
    candidate_key: candidateKey,
    release_key: String(item.release_key || '').trim() || null,
    product_key: productKey,
    detail_id: item.detail_id || null,
    evidence_detail_id: item.evidence_detail_id || null,
    previous_date: item.previous_date || null,
    proposed_date: item.proposed_date || null,
    source_url: sourceUrl,
    source_type: item.source_type || null,
    collector: item.collector || null,
    product_surface: item.product_surface || null,
    repository: item.repository || null,
    ...(item.product_name ? { product_name: String(item.product_name) } : {}),
    ...(safeLocalizations(item.localizations) ? { localizations: safeLocalizations(item.localizations) } : {}),
    ...(safeLocalizationsMeta(item.localizations_meta) ? { localizations_meta: safeLocalizationsMeta(item.localizations_meta) } : {}),
    evidence: safeEvidence,
    ai_suggestion: safeAiSuggestion(item.ai_suggestion),
    ...(safeAiSuggestion(item.review_decision) ? { review_decision: safeAiSuggestion(item.review_decision) } : {}),
    ...(DECISION_SOURCES.includes(item.decision_source) ? { decision_source: item.decision_source } : {}),
    blocked_reasons: Array.isArray(item.blocked_reasons) ? [...new Set(item.blocked_reasons.map(String))] : [],
    ...safeSupersededFields(item),
    review_status: reviewStatus,
    status,
    created_at: item.created_at || now,
    updated_at: now,
  };
}

function validateReviewQueue(queue) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return ['QUEUE_INVALID'];
  const errors = [];
  if (queue.schema_version !== REVIEW_SCHEMA_VERSION) errors.push('SCHEMA_VERSION_INVALID');
  if (queue.kind !== REVIEW_KIND) errors.push('KIND_INVALID');
  if (!Array.isArray(queue.items)) return [...errors, 'ITEMS_INVALID'];
  const keys = new Set();
  for (const item of queue.items) {
    try {
      const normalized = normalizeItem(item, item.updated_at || null);
      if (keys.has(normalized.candidate_key)) errors.push('DUPLICATE_CANDIDATE_KEY');
      keys.add(normalized.candidate_key);
    } catch (error) { errors.push(error.message); }
  }
  return errors;
}

function readReviewQueue(file = reviewFileOf()) {
  const queue = readJson(file, null);
  if (queue == null) return defaultReviewQueue();
  const errors = validateReviewQueue(queue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  return { schema_version: REVIEW_SCHEMA_VERSION, kind: REVIEW_KIND, updated_at: queue.updated_at || null, items: queue.items.map(item => clone(item)) };
}

function writeReviewQueue(queue, options = {}) {
  const file = reviewFileOf(options.file);
  const now = nowOf(options.now);
  const payload = { schema_version: REVIEW_SCHEMA_VERSION, kind: REVIEW_KIND, updated_at: now, items: (queue?.items || []).map(item => normalizeItem(item, now)) };
  const errors = validateReviewQueue(payload);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, options.runId || 'tool-update-review');
  return { ok: true, file, queue: payload };
}

function writeReviewQueuePreservingItems(queue, options = {}) {
  const file = reviewFileOf(options.file);
  const payload = { schema_version: REVIEW_SCHEMA_VERSION, kind: REVIEW_KIND, updated_at: nowOf(options.now), items: queue.items.map(item => clone(item)) };
  const errors = validateReviewQueue(payload);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, options.runId || 'tool-update-review-workbench');
  return { ok: true, file, queue: payload };
}

function readReviewQueueProjection(file = reviewFileOf()) {
  return reviewQueueProjection(readReviewQueue(file));
}

module.exports = {
  REVIEW_SCHEMA_VERSION,
  REVIEW_KIND,
  REVIEW_STATUSES,
  ITEM_STATUSES,
  defaultReviewQueue,
  validateReviewQueue,
  reviewQueueRevision,
  readReviewQueueProjection,
  readReviewQueue,
  writeReviewQueue,
  writeReviewQueuePreservingItems,
  normalizeItem,
  reviewFileOf,
};
