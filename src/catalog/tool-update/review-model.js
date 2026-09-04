'use strict';

const crypto = require('crypto');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson } = require('../../shared/json-store');
const { canonicalizeUrl } = require('../../shared/tavily-client');
const { normalizeToolUpdateReviewValue } = require('./tool-update-review-contract');
const { sourceForEvidence } = require('./tool-update-review-planner');

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_KIND = 'tool_update_review';
const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const ITEM_STATUSES = Object.freeze(['candidate', 'blocked']);
const SUPERSEDED_REASONS = Object.freeze(['newer_evidence', 'source_replaced']);
const MAX_EXCERPT_CHARS = 4000;
const REVIEW_WORKBENCH_FIELDS = Object.freeze([
  'candidate_key', 'release_key', 'product_key', 'product_name', 'detail_id', 'evidence_detail_id',
  'previous_date', 'proposed_date', 'source_url', 'source_type', 'collector', 'product_surface',
  'repository', 'localizations', 'localizations_meta', 'evidence', 'ai_suggestion', 'review_decision',
  'decision_source', 'blocked_reasons', 'superseded_by', 'superseded_at', 'superseded_reason',
  'review_status', 'status', 'created_at', 'updated_at',
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

function validateQueueShape(queue) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue) || !Array.isArray(queue.items)) throw new Error('TOOL_UPDATE_REVIEW_QUEUE_INVALID');
}

function reviewQueueRevision(queue) {
  validateQueueShape(queue);
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
  validateQueueShape(queue);
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    kind: REVIEW_KIND,
    updated_at: queue.updated_at || null,
    revision: reviewQueueRevision(queue),
    items: queue.items.map(reviewQueueItemProjection),
  };
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

module.exports = { clone, nowOf, defaultReviewQueue, reviewQueueRevision, reviewQueueProjection, reviewFileOf, reviewQueueViews, sourceIdentityOf, dateRankOf, timestampRankOf, safeAiSuggestion, safeLocalizations, safeLocalizationsMeta, safeSupersededFields };
