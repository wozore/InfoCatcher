'use strict';

const queueStore = require('./review-queue-store');
const { clone, nowOf, reviewQueueViews, reviewQueueProjection, sourceIdentityOf, dateRankOf, timestampRankOf } = require('./review-model');
const {
  REVIEW_SCHEMA_VERSION,
  REVIEW_KIND,
  REVIEW_STATUSES,
  defaultReviewQueue,
  validateReviewQueue,
  reviewQueueRevision,
  readReviewQueueProjection,
  readReviewQueue,
  writeReviewQueue,
  writeReviewQueuePreservingItems,
  normalizeItem,
  reviewFileOf,
} = queueStore;
const ITEM_STATUSES = Object.freeze(['candidate', 'blocked']);
const SUPERSEDED_REASONS = Object.freeze(['newer_evidence', 'source_replaced']);

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
  defaultReviewQueue,
  validateReviewQueue,
  reviewQueueRevision,
  reviewQueueViews,
  readReviewQueueProjection,
  readReviewQueue,
  writeReviewQueue,
  mergeReviewQueue,
  mergeAndWriteReviewQueue,
  setReviewStatusReviewQueue,
  removePendingBlockedReviewItems,
};
