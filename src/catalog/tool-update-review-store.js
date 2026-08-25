'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_KIND = 'tool_update_review';
const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const ITEM_STATUSES = Object.freeze(['candidate', 'blocked']);
const MAX_EXCERPT_CHARS = 4000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowOf(value) {
  if (value !== undefined) return String(value);
  return new Date().toISOString();
}

function defaultReviewQueue() {
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: null,
    items: [],
  };
}

function reviewFileOf(file) {
  return file || CATALOG_GENERATOR_FILES.toolUpdateReview;
}

function safeAiSuggestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['verdict', 'matched_surface', 'confidence', 'reason', 'supporting_excerpt'];
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some(field => !keys.includes(field))) return null;
  if (!['approve', 'hold', 'discard'].includes(value.verdict)) return null;
  if (!['product', 'cli', 'desktop', 'ide_extension'].includes(value.matched_surface)) return null;
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
  if (typeof value.reason !== 'string' || !value.reason.trim()) return null;
  if (typeof value.supporting_excerpt !== 'string' || !value.supporting_excerpt.trim() || value.supporting_excerpt.length > 1200) return null;
  return {
    verdict: value.verdict,
    matched_surface: value.matched_surface,
    confidence: value.confidence,
    reason: value.reason,
    supporting_excerpt: value.supporting_excerpt,
  };
}

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
  if (item.evidence?.excerpt && String(item.evidence.excerpt).length > MAX_EXCERPT_CHARS) {
    throw new Error('TOOL_UPDATE_REVIEW_EXCERPT_TOO_LONG');
  }
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
    evidence: safeEvidence,
    ai_suggestion: safeAiSuggestion(item.ai_suggestion),
    blocked_reasons: Array.isArray(item.blocked_reasons) ? [...new Set(item.blocked_reasons.map(String))] : [],
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
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

function readReviewQueue(file = reviewFileOf()) {
  const queue = readJson(file, null);
  if (queue == null) return defaultReviewQueue();
  const errors = validateReviewQueue(queue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: queue.updated_at || null,
    items: queue.items.map(item => clone(item)),
  };
}

function writeReviewQueue(queue, options = {}) {
  const file = reviewFileOf(options.file);
  const now = nowOf(options.now);
  const payload = {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: now,
    items: (queue?.items || []).map(item => normalizeItem(item, now)),
  };
  const errors = validateReviewQueue(payload);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, options.runId || 'tool-update-review');
  return { ok: true, file, queue: payload };
}

function releaseKeyOf(item) {
  return String(item?.release_key || '').trim();
}

function mergeReviewQueue(existing, freshItems, options = {}) {
  const now = nowOf(options.now);
  const existingQueue = existing || defaultReviewQueue();
  const errors = validateReviewQueue(existingQueue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  const merged = existingQueue.items.map(item => clone(item));
  const byCandidate = new Map(merged.map((item, index) => [item.candidate_key, index]));
  const byRelease = new Map(merged.map((item, index) => [releaseKeyOf(item), index]).filter(([key]) => key));
  let appended = 0;
  let refreshed = 0;
  let reopened = 0;

  for (const rawItem of Array.isArray(freshItems) ? freshItems : []) {
    const fresh = normalizeItem(rawItem, now);
    const sameIndex = byCandidate.get(fresh.candidate_key);
    if (sameIndex !== undefined) {
      const previous = merged[sameIndex];
      merged[sameIndex] = {
        ...previous,
        ...fresh,
        created_at: previous.created_at || fresh.created_at,
        review_status: previous.review_status,
        updated_at: now,
      };
      refreshed++;
      continue;
    }

    const releaseKey = releaseKeyOf(fresh);
    const releaseIndex = releaseKey ? byRelease.get(releaseKey) : undefined;
    if (releaseIndex !== undefined) {
      const previous = merged[releaseIndex];
      merged[releaseIndex] = {
        ...fresh,
        created_at: previous.created_at || fresh.created_at,
        review_status: 'pending',
        blocked_reasons: [...new Set([...(fresh.blocked_reasons || []), 'EVIDENCE_HASH_CHANGED'])],
        updated_at: now,
      };
      byCandidate.delete(previous.candidate_key);
      byCandidate.set(fresh.candidate_key, releaseIndex);
      byRelease.set(releaseKey, releaseIndex);
      reopened++;
      continue;
    }

    const index = merged.length;
    merged.push(fresh);
    byCandidate.set(fresh.candidate_key, index);
    if (releaseKey) byRelease.set(releaseKey, index);
    appended++;
  }

  return {
    queue: {
      schema_version: REVIEW_SCHEMA_VERSION,
      kind: REVIEW_KIND,
      updated_at: now,
      items: merged,
    },
    appended,
    refreshed,
    reopened,
    changed: appended + refreshed + reopened,
  };
}

function mergeAndWriteReviewQueue(freshItems, options = {}) {
  const file = reviewFileOf(options.file);
  const merged = mergeReviewQueue(readReviewQueue(file), freshItems, options);
  const written = writeReviewQueue(merged.queue, { ...options, file });
  return { ...merged, ...written };
}

module.exports = {
  REVIEW_SCHEMA_VERSION,
  REVIEW_KIND,
  REVIEW_STATUSES,
  defaultReviewQueue,
  validateReviewQueue,
  readReviewQueue,
  writeReviewQueue,
  mergeReviewQueue,
  mergeAndWriteReviewQueue,
};
