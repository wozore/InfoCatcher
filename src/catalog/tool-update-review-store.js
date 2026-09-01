'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { normalizeToolUpdateReviewValue, DECISION_SOURCES } = require('./tool-update-review-contract');
const { sourceForEvidence } = require('./tool-update-review-planner');
const { canonicalizeUrl } = require('../shared/tavily-client');

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_KIND = 'tool_update_review';
const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const ITEM_STATUSES = Object.freeze(['candidate', 'blocked']);
const SUPERSEDED_REASONS = Object.freeze(['newer_evidence', 'source_replaced']);
const MAX_EXCERPT_CHARS = 4000;
const REVIEW_WORKBENCH_FIELDS = Object.freeze([
  'candidate_key',
  'release_key',
  'product_key',
  'product_name',
  'detail_id',
  'evidence_detail_id',
  'previous_date',
  'proposed_date',
  'source_url',
  'source_type',
  'collector',
  'product_surface',
  'repository',
  'localizations',
  'localizations_meta',
  'evidence',
  'ai_suggestion',
  'review_decision',
  'decision_source',
  'blocked_reasons',
  'superseded_by',
  'superseded_at',
  'superseded_reason',
  'review_status',
  'status',
  'created_at',
  'updated_at',
]);

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

function reviewQueueStableValue(value) {
  if (Array.isArray(value)) return value.map(reviewQueueStableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, reviewQueueStableValue(value[key])]));
  }
  return value;
}

function reviewQueueRevision(queue) {
  const errors = validateReviewQueue(queue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  const content = JSON.stringify(reviewQueueStableValue({
    schema_version: queue.schema_version,
    kind: queue.kind,
    items: queue.items,
  }));
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

function reviewQueueItemProjection(item) {
  const projection = {};
  for (const field of REVIEW_WORKBENCH_FIELDS) {
    if (item[field] !== undefined) projection[field] = clone(item[field]);
  }
  return projection;
}

function reviewQueueProjection(queue) {
  const errors = validateReviewQueue(queue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: queue.updated_at || null,
    revision: reviewQueueRevision(queue),
    items: queue.items.map(reviewQueueItemProjection),
  };
}

function readReviewQueueProjection(file = reviewFileOf()) {
  return reviewQueueProjection(readReviewQueue(file));
}

function reviewFileOf(file) {
  return file || CATALOG_GENERATOR_FILES.toolUpdateReview;
}

function safeAiSuggestion(value) {
  return normalizeToolUpdateReviewValue(value);
}

function safeLocalizations(value) {
  const zh = value?.zh;
  if (!zh || typeof zh !== 'object') return undefined;
  const title = String(zh.title || '').trim().slice(0, 600);
  const description = String(zh.description || '').trim().slice(0, MAX_EXCERPT_CHARS);
  if (!title && !description) return undefined;
  return { zh: { title, description } };
}

function safeLocalizationsMeta(value) {
  const zh = value?.zh;
  if (!zh || typeof zh !== 'object') return undefined;
  return {
    zh: {
      localizer: String(zh.localizer || '').trim() || null,
      generated_at: zh.generated_at || null,
      input_chars: Number.isFinite(Number(zh.input_chars)) ? Number(zh.input_chars) : 0,
      llm_error: zh.llm_error ? String(zh.llm_error) : null,
      ...(zh.fallback ? { fallback: String(zh.fallback) } : {}),
      ...(Number.isFinite(Number(zh.summary_chars)) ? { summary_chars: Number(zh.summary_chars) } : {}),
    },
  };
}

function safeSupersededFields(item) {
  const supersededBy = String(item?.superseded_by || '').trim();
  const reason = String(item?.superseded_reason || '').trim();
  return {
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    ...(item?.superseded_at ? { superseded_at: String(item.superseded_at) } : {}),
    ...(SUPERSEDED_REASONS.includes(reason) ? { superseded_reason: reason } : {}),
  };
}

function sourceIdentityOf(item, registry) {
  const productKey = String(item?.product_key || '').trim().toLowerCase();
  const url = canonicalizeUrl(item?.source_url) || String(item?.source_url || '').trim();
  const collector = String(item?.collector || '').trim().toLowerCase();
  if (!productKey || !url || !collector) return null;
  if (registry) {
    const source = sourceForEvidence(productKey, { url, collector }, registry);
    if (!source) return null;
    const sourceUrl = canonicalizeUrl(source.url) || String(source.url || '').trim();
    return `${productKey}|${source.collector}|${sourceUrl}|${source.repository || ''}`;
  }
  return `${productKey}|${collector}|${url}|${item.repository || ''}`;
}

function dateRankOf(item) {
  const date = String(item?.proposed_date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function timestampRankOf(item) {
  const value = Date.parse(String(item?.updated_at || item?.created_at || ''));
  return Number.isFinite(value) ? value : 0;
}

function isUpToDateItem(item) {
  const proposed = dateRankOf(item);
  const previous = String(item?.previous_date || '').trim();
  return Boolean(proposed && /^\d{4}-\d{2}-\d{2}$/.test(previous) && proposed <= previous);
}

function newerItem(left, right) {
  const leftDate = dateRankOf(left);
  const rightDate = dateRankOf(right);
  if (leftDate !== rightDate) return leftDate > rightDate ? left : right;
  const leftTime = timestampRankOf(left);
  const rightTime = timestampRankOf(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return String(left?.candidate_key || '') >= String(right?.candidate_key || '') ? left : right;
}

function reviewQueueViews(queue, options = {}) {
  const registry = options.registry;
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const groups = new Map();
  const history = [];
  for (const item of items) {
    if (item?.superseded_by) {
      history.push({ item, reason: item.superseded_reason || 'newer_evidence' });
      continue;
    }
    const identity = sourceIdentityOf(item, registry);
    if (!identity) {
      history.push({ item, reason: 'source_replaced' });
      continue;
    }
    const group = groups.get(identity) || [];
    group.push(item);
    groups.set(identity, group);
  }

  const currentItems = [];
  for (const group of groups.values()) {
    const upToDateDates = group.filter(isUpToDateItem).map(dateRankOf).sort();
    const latestKnownDate = upToDateDates[upToDateDates.length - 1] || '';
    let winner = null;
    for (const item of group) {
      if (isUpToDateItem(item)) {
        history.push({ item, reason: 'up_to_date' });
        continue;
      }
      const proposed = dateRankOf(item);
      const previous = String(item?.previous_date || '').trim();
      if (!proposed && latestKnownDate && /^\d{4}-\d{2}-\d{2}$/.test(previous) && previous <= latestKnownDate) {
        history.push({ item, reason: 'up_to_date' });
        continue;
      }
      winner = winner ? newerItem(winner, item) : item;
    }
    if (winner) currentItems.push(winner);
  }

  const currentKeys = new Set(currentItems.map(item => item.candidate_key));
  for (const item of items) {
    if (currentKeys.has(item.candidate_key)) continue;
    if (item?.superseded_by || history.some(entry => entry.item === item)) continue;
    history.push({ item, reason: 'newer_evidence' });
  }
  const actionable = currentItems.filter(item => item.review_status === 'pending' && ITEM_STATUSES.includes(item.status));
  return {
    current_items: currentItems,
    actionable,
    history: history.map(({ item, reason }) => ({ ...clone(item), history_reason: reason })),
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

function writeReviewQueuePreservingItems(queue, options = {}) {
  const file = reviewFileOf(options.file);
  const payload = {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: nowOf(options.now),
    items: queue.items.map(item => clone(item)),
  };
  const errors = validateReviewQueue(payload);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, options.runId || 'tool-update-review-workbench');
  return { ok: true, file, queue: payload };
}

function reviewStatusMutationArgs(candidateKeyOrRequest, reviewStatusOrOptions, maybeOptions) {
  if (candidateKeyOrRequest && typeof candidateKeyOrRequest === 'object' && !Array.isArray(candidateKeyOrRequest)) {
    const request = candidateKeyOrRequest;
    const options = { ...(maybeOptions || {}), ...(reviewStatusOrOptions || {}) };
    if (options.expectedRevision === undefined && options.expected_revision === undefined) {
      options.expected_revision = request.expected_revision ?? request.expectedRevision;
    }
    for (const key of ['file', 'now', 'runId', 'registry']) {
      if (options[key] === undefined && request[key] !== undefined) options[key] = request[key];
    }
    return {
      candidateKey: request.candidate_key ?? request.candidateKey,
      reviewStatus: request.review_status ?? request.reviewStatus,
      options,
    };
  }
  return {
    candidateKey: candidateKeyOrRequest,
    reviewStatus: reviewStatusOrOptions,
    options: maybeOptions || {},
  };
}

/**
 * 维护者工作台的唯一状态 mutation：请求只接受 candidate_key、review_status 和 expected revision。
 * 队列 revision 不匹配、candidate 不存在、非当前证据或 blocked 项请求 approved 时，均不写入。
 */
function setReviewStatusReviewQueue(candidateKeyOrRequest, reviewStatusOrOptions, maybeOptions) {
  const request = reviewStatusMutationArgs(candidateKeyOrRequest, reviewStatusOrOptions, maybeOptions);
  const candidateKey = typeof request.candidateKey === 'string' ? request.candidateKey.trim() : '';
  const reviewStatus = request.reviewStatus;
  const options = request.options || {};
  const expectedRevision = options.expectedRevision ?? options.expected_revision;
  const file = reviewFileOf(options.file);

  if (!candidateKey) return { ok: false, code: 'TOOL_UPDATE_REVIEW_CANDIDATE_KEY_REQUIRED' };
  if (!REVIEW_STATUSES.includes(reviewStatus)) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_STATUS_INVALID' };
  }
  if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_EXPECTED_REVISION_REQUIRED' };
  }

  const current = readReviewQueue(file);
  const currentRevision = reviewQueueRevision(current);
  if (currentRevision !== expectedRevision) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      revision: currentRevision,
      current_revision: currentRevision,
      expected_revision: expectedRevision,
    };
  }

  const index = current.items.findIndex(item => item.candidate_key === candidateKey);
  if (index < 0) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_CANDIDATE_NOT_FOUND', candidate_key: candidateKey, revision: currentRevision };
  }
  if (current.items[index].status === 'blocked' && reviewStatus === 'approved') {
    return {
      ok: false,
      code: 'TOOL_UPDATE_REVIEW_BLOCKED_CANNOT_APPROVE',
      candidate_key: candidateKey,
      revision: currentRevision,
    };
  }
  const views = reviewQueueViews(current, { registry: options.registry });
  if (!views.current_items.some(item => item.candidate_key === candidateKey)) {
    return {
      ok: false,
      code: 'TOOL_UPDATE_REVIEW_NOT_CURRENT',
      candidate_key: candidateKey,
      revision: currentRevision,
    };
  }

  const next = {
    ...current,
    items: current.items.map(item => clone(item)),
  };
  next.items[index] = {
    ...next.items[index],
    review_status: reviewStatus,
  };
  const written = writeReviewQueuePreservingItems(next, options);
  const revision = reviewQueueRevision(written.queue);
  return {
    ok: true,
    updated: 1,
    candidate_key: candidateKey,
    review_status: reviewStatus,
    revision,
    projection: reviewQueueProjection(written.queue),
  };
}

function releaseKeyOf(item) {
  return String(item?.release_key || '').trim();
}

function comparableItem(item) {
  const value = clone(item) || {};
  delete value.created_at;
  delete value.updated_at;
  return JSON.stringify(value);
}


function mergeReviewQueue(existing, freshItems, options = {}) {
  const now = nowOf(options.now);
  const existingQueue = existing || defaultReviewQueue();
  const errors = validateReviewQueue(existingQueue);
  if (errors.length) throw new Error(`TOOL_UPDATE_REVIEW_QUEUE_INVALID: ${errors.join(',')}`);
  const merged = existingQueue.items.map(item => clone(item));
  const byCandidate = new Map();
  const byRelease = new Map();
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index].superseded_by) continue;
    byCandidate.set(merged[index].candidate_key, index);
    const releaseKey = releaseKeyOf(merged[index]);
    if (releaseKey) byRelease.set(releaseKey, index);
  }
  let appended = 0;
  let refreshed = 0;
  let reopened = 0;
  let superseded = 0;

  function removeIndex(index) {
    const item = merged[index];
    if (byCandidate.get(item.candidate_key) === index) byCandidate.delete(item.candidate_key);
    const releaseKey = releaseKeyOf(item);
    if (releaseKey && byRelease.get(releaseKey) === index) byRelease.delete(releaseKey);
  }

  function markSuperseded(index, replacement, reason) {
    const item = merged[index];
    if (!item || item.superseded_by) return false;
    merged[index] = {
      ...item,
      superseded_by: replacement.candidate_key,
      superseded_at: now,
      superseded_reason: reason,
      updated_at: now,
    };
    removeIndex(index);
    superseded++;
    return true;
  }

  function activeIndexesForSource(identity, productKey) {
    if (!identity) return [];
    return merged
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.superseded_by
        && String(item.product_key || '').trim().toLowerCase() === String(productKey || '').trim().toLowerCase()
        && sourceIdentityOf(item, options.registry) === identity)
      .map(({ index }) => index);
  }

  for (const rawItem of Array.isArray(freshItems) ? freshItems : []) {
    const fresh = normalizeItem(rawItem, now);
    const knownCandidate = merged.find(item => item.candidate_key === fresh.candidate_key);
    if (knownCandidate?.superseded_by) continue;
    const sameIndex = byCandidate.get(fresh.candidate_key);
    if (sameIndex !== undefined) {
      const previous = merged[sameIndex];
      if (comparableItem(previous) === comparableItem(fresh)) continue;
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
      markSuperseded(releaseIndex, fresh, 'newer_evidence');
      const index = merged.length;
      merged.push({ ...fresh, review_status: 'pending', updated_at: now });
      byCandidate.set(fresh.candidate_key, index);
      byRelease.set(releaseKey, index);
      reopened++;
      continue;
    }

    const freshIdentity = sourceIdentityOf(fresh, options.registry);
    const sameSourceIndexes = activeIndexesForSource(freshIdentity, fresh.product_key);
    const olderIndexes = [];
    const newerIndexes = [];
    for (const index of sameSourceIndexes) {
      const previousDate = dateRankOf(merged[index]);
      const freshDate = dateRankOf(fresh);
      if (freshDate > previousDate || (freshDate === previousDate && timestampRankOf(fresh) >= timestampRankOf(merged[index]))) olderIndexes.push(index);
      else newerIndexes.push(index);
    }

    const index = merged.length;
    let nextFresh = fresh;
    if (olderIndexes.length) {
      for (const oldIndex of olderIndexes) markSuperseded(oldIndex, fresh, 'newer_evidence');
    } else if (newerIndexes.length) {
      const replacement = merged[newerIndexes[0]];
      nextFresh = {
        ...fresh,
        superseded_by: replacement.candidate_key,
        superseded_at: now,
        superseded_reason: 'newer_evidence',
      };
    }

    if (options.registry && freshIdentity) {
      for (let oldIndex = 0; oldIndex < merged.length; oldIndex += 1) {
        const oldItem = merged[oldIndex];
        if (oldItem.superseded_by || String(oldItem.product_key || '').trim().toLowerCase() !== String(fresh.product_key || '').trim().toLowerCase()) continue;
        if (!sourceIdentityOf(oldItem, options.registry)) markSuperseded(oldIndex, fresh, 'source_replaced');
      }
    }

    merged.push(nextFresh);
    if (!nextFresh.superseded_by) {
      byCandidate.set(nextFresh.candidate_key, index);
      if (releaseKey) byRelease.set(releaseKey, index);
    }
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
    superseded,
    changed: appended + refreshed + reopened + superseded,
  };
}

function mergeAndWriteReviewQueue(freshItems, options = {}) {
  const file = reviewFileOf(options.file);
  const existing = readReviewQueue(file);
  const merged = mergeReviewQueue(existing, freshItems, options);
  if (!merged.changed) return { ...merged, ok: true, file, queue: existing, unchanged: true };
  const written = writeReviewQueue(merged.queue, { ...options, file });
  return { ...merged, ...written, unchanged: false };
}

function removePendingBlockedReviewItems(options = {}) {
  const file = reviewFileOf(options.file);
  const expectedCount = Number(options.expectedCount);
  const current = readReviewQueue(file);
  const revision = reviewQueueRevision(current);
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    return { ok: false, code: 'REVISION_CONFLICT', revision, expected_revision: options.expectedRevision };
  }
  const removed = current.items.filter(item => item.review_status === 'pending' && item.status === 'blocked');
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_REMOVE_EXPECTED_COUNT_REQUIRED', revision, matched: removed.length };
  }
  if (removed.length !== expectedCount) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_REMOVE_COUNT_MISMATCH', revision, expected: expectedCount, matched: removed.length };
  }
  const next = { ...current, items: current.items.filter(item => !(item.review_status === 'pending' && item.status === 'blocked')) };
  const written = writeReviewQueuePreservingItems(next, { ...options, file, runId: options.runId || 'tool-update-review-remove-pending-blocked' });
  return {
    ok: true,
    removed: removed.length,
    removed_candidate_keys: removed.map(item => item.candidate_key),
    revision: reviewQueueRevision(written.queue),
  };
}

module.exports = {
  REVIEW_SCHEMA_VERSION,
  REVIEW_KIND,
  REVIEW_STATUSES,
  SUPERSEDED_REASONS,
  defaultReviewQueue,
  validateReviewQueue,
  reviewQueueRevision,
  reviewQueueViews,
  sourceIdentityOf,
  readReviewQueueProjection,
  readReviewQueue,
  writeReviewQueue,
  mergeReviewQueue,
  mergeAndWriteReviewQueue,
  setReviewStatusReviewQueue,
  removePendingBlockedReviewItems,
};
