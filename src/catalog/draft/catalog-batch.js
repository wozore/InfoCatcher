'use strict';

const { loadCatalogSnapshot, previewHashOf, revisionOf, planCatalogPatches } = require('../core');
const { readDraft, updateDraft, deleteDraft } = require('./catalog-draft-store');
const { validateCatalogDraftEnvelope } = require('./catalog-draft-envelope');
const { commitCatalogChange } = require('../transaction');

function reviewSingleDraft(draftId) {
  const draft = readDraft(draftId);
  const current = loadCatalogSnapshot();
  if (draft.base_revision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', draft_id: draftId, currentRevision: current.revision, baseRevision: draft.base_revision };
  const checked = validateCatalogDraftEnvelope(draft);
  if (!checked.ok || draft.readiness?.status !== 'ready') return { ok: false, code: checked.errors?.[0]?.code || 'DRAFT_BLOCKED', draft_id: draftId, draft, errors: checked.errors || [], currentRevision: current.revision };
  let plan;
  try { plan = planCatalogPatches(current.snapshot, draft.layer_patches); }
  catch (error) { return { ok: false, code: 'PLANNER_FAILED', error: error.message, draft_id: draftId, draft, currentRevision: current.revision }; }
  const previewHash = previewHashOf(plan.changePreview);
  if (draft.preview_hash !== previewHash) return { ok: false, code: 'PREVIEW_CHANGED', draft_id: draftId, previewHash };
  return { ok: true, draft, currentRevision: current.revision, plan, previewHash };
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
    const checked = reviewSingleDraft(draftId);
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

module.exports = { normalizeDraftIds, catalogDraftBatchToken, mergeBatchPatches, reviewCatalogDraftBatch, applyCatalogDrafts };
