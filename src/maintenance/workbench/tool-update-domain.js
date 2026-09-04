'use strict';

const { loadCatalogSnapshot } = require('../../catalog/core/index');
const { loadProductUrlRegistry } = require('../../catalog/url-registry/index');
const toolReviewStore = require('../../catalog/tool-update/index');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');

function requireMutation(name, value) {
  if (typeof value !== 'function') throw new Error(`${name} mutation API 不可用`);
  return value;
}

function previewToolUpdatesDirect(flags = {}, deps = {}) {
  const current = deps.loadSnapshot ? deps.loadSnapshot() : loadCatalogSnapshot();
  const registry = deps.loadRegistry ? deps.loadRegistry() : loadProductUrlRegistry();
  const queue = (deps.readQueue || toolReviewStore.readReviewQueue)(deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview);
  const candidateKeys = Array.isArray(flags.candidate_keys)
    ? flags.candidate_keys
    : (typeof flags.candidate_keys === 'string' ? flags.candidate_keys.split(',').map(s => s.trim()).filter(Boolean) : []);
  const approved = toolReviewStore.approvedRepairsFromReviewQueue(current.snapshot, {
    registry,
    reviewQueue: queue,
    candidateKeys,
    asOf: flags.as_of,
  });
  if (!approved.ok) return { ...approved, command: 'preview' };
  const planned = toolReviewStore.planDateRepairBatch(current.snapshot, approved.repairs, { asOf: flags.as_of });
  if (!planned.ok) return { ...planned, command: 'preview' };
  return {
    ok: true,
    command: 'preview',
    expected_revision: planned.before_revision,
    preview_hash: planned.preview_hash,
    count: planned.count,
    changes: planned.changes,
    catalog_apply: false,
  };
}

function applyToolUpdatesDirect(flags = {}, deps = {}) {
  if (!flags.expected_revision) return { ok: false, command: 'apply', code: 'DATE_REPAIR_EXPECTED_REVISION_REQUIRED' };
  if (!flags.preview_hash) return { ok: false, command: 'apply', code: 'DATE_REPAIR_PREVIEW_REQUIRED' };
  const confirmationValue = `APPLY TOOL-UPDATES ${flags.preview_hash}`;
  const confirmation = String(flags.confirm || '').trim();
  if (confirmation !== confirmationValue) return { ok: false, command: 'apply', code: 'TOOL_UPDATE_REVIEW_CONFIRMATION_REQUIRED' };
  const candidateKeys = Array.isArray(flags.candidate_keys)
    ? flags.candidate_keys
    : (typeof flags.candidate_keys === 'string' ? flags.candidate_keys.split(',').map(s => s.trim()).filter(Boolean) : []);
  const result = (deps.applyBatch || toolReviewStore.applyDateRepairBatch)(undefined, {
    expectedRevision: String(flags.expected_revision),
    previewHash: String(flags.preview_hash),
    candidateKeys,
    asOf: flags.as_of,
    reviewFile: deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview,
    ...(deps.reviewQueue ? { reviewQueue: deps.reviewQueue } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}),
    ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
    ...(deps.commitSnapshotChange ? { commitSnapshotChange: deps.commitSnapshotChange } : {}),
  });
  return { ...result, command: 'apply' };
}

function createDefaultToolsApi() {
  return {
    readQueue: () => requireMutation('readReviewQueueProjection', toolReviewStore.readReviewQueueProjection)(),
    readRegistry: () => loadProductUrlRegistry(),
    review: request => requireMutation('setReviewStatusReviewQueue', toolReviewStore.setReviewStatusReviewQueue)(request),
    preview: () => previewToolUpdatesDirect({}, {}),
    apply: flags => applyToolUpdatesDirect(flags, {}),
  };
}

function toolUpdatesProjection(tools) {
  const queue = tools.readQueue();
  const registry = tools.readRegistry ? tools.readRegistry() : undefined;
  const views = toolReviewStore.reviewQueueViews(queue, { registry });
  const actionableKeys = new Set(views.actionable.map(item => item.candidate_key));
  const history = [
    ...views.history,
    ...views.current_items
      .filter(item => !actionableKeys.has(item.candidate_key))
      .map(item => ({ ...item, history_reason: item.review_status === 'pending' ? 'not_actionable' : 'completed' })),
  ];
  return {
    revision: queue.revision,
    items: views.actionable,
    history,
    history_count: history.length,
  };
}

function handleReviewToolUpdate(key, body, tools, expectedRevision) {
  const request = { candidate_key: key, review_status: body?.decision, expected_revision: expectedRevision(body) };
  if (tools.readRegistry) request.registry = tools.readRegistry();
  return tools.review(request);
}

function handleApplyToolUpdates(body, tools) {
  const expected_revision = String(body?.expected_revision || '').trim();
  const preview_hash = String(body?.preview_hash || '').trim();
  const confirm = String(body?.confirm || '').trim();
  if (!expected_revision || !preview_hash || !confirm) throw new Error('工具更新 Apply 缺少预览 revision、preview hash 或确认语句');
  return tools.apply({ expected_revision, preview_hash, confirm });
}

module.exports = {
  previewToolUpdatesDirect,
  applyToolUpdatesDirect,
  createDefaultToolsApi,
  toolUpdatesProjection,
  handleReviewToolUpdate,
  handleApplyToolUpdates,
};
