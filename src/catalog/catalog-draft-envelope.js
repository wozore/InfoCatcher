'use strict';

const { validatePlannedRecords } = require('./catalog-record-completeness');
const { fieldCoverageOf } = require('./catalog-synthesis');

function envelopeBlockingReasons(research, synthesis) {
  if (!research?.ok) return [research?.error || research?.code || '研究失败'];
  if (!synthesis?.ok) {
    if (Array.isArray(synthesis?.errors) && synthesis.errors.length) return synthesis.errors.map(item => `${item.path || item.code}: ${item.message || item.code}`);
    return [synthesis?.error || synthesis?.code || '目录合成失败'];
  }
  const missing = (synthesis?.coverage?.missing || []).map(item => `${item.layer}.${item.field}`);
  if (missing.length) return [`缺少必需目录字段: ${[...new Set(missing)].join(', ')}`];
  return [];
}

function failureDetailsOf(research, synthesis, fallbackError) {
  const failure = !research?.ok ? research : !synthesis?.ok ? synthesis : null;
  if (!failure) return { code: 'DRAFT_BLOCKED', error: fallbackError };
  const details = {};
  for (const key of ['response_status', 'incomplete_reason', 'output_types', 'output_preview', 'output_keys']) {
    if (failure[key] !== undefined) details[key] = failure[key];
  }
  return { code: failure.code || 'DRAFT_BLOCKED', error: failure.error || fallbackError, ...details };
}

function buildCatalogDraftEnvelope({ seed, baseRevision, researchPlan, research, synthesis }) {
  const blockingReasons = envelopeBlockingReasons(research, synthesis);
  const ready = blockingReasons.length === 0 && synthesis?.ok === true;
  return {
    schema_version: 3,
    state: ready ? 'preview_ready' : research?.ok ? 'preview_blocked' : 'failed_retryable',
    base_revision: baseRevision,
    seed,
    research_plan: researchPlan,
    research: {
      official_sources: research?.official_sources || [],
      warnings: research?.warnings || [],
    },
    coverage: synthesis?.coverage || null,
    layer_patches: synthesis?.layer_patches || [],
    synthesis: synthesis?.synthesis || null,
    readiness: { status: ready ? 'ready' : 'blocked', blocking_reasons: blockingReasons, warnings: research?.warnings || [] },
    cost: synthesis?.cost || research?.cost || null,
    last_error: ready ? null : failureDetailsOf(research, synthesis, blockingReasons[0] || 'Draft blocked'),
  };
}

function validateCatalogDraftEnvelope(draft) {
  const errors = [];
  if (draft?.schema_version !== 3) return { ok: false, errors: [{ code: 'DRAFT_SCHEMA_UNSUPPORTED', path: 'schema_version', message: '只允许 schema_version=3 的 CatalogDraft Apply' }] };
  if (!draft.research_plan || !Array.isArray(draft.research_plan.research_scopes)) errors.push({ code: 'RESEARCH_PLAN_MISSING', path: 'research_plan', message: '缺少 ResearchPlan' });
  const sources = draft.research?.official_sources || [];
  const sourceIds = new Set();
  for (const source of sources) {
    if (!source?.source_id || !source?.url || sourceIds.has(source.source_id)) errors.push({ code: 'SOURCE_ID_INVALID', path: 'research.official_sources', message: `source_id 缺失或重复: ${source?.source_id || ''}` });
    sourceIds.add(source?.source_id);
  }
  const recomputed = fieldCoverageOf(draft.synthesis, draft.research_plan);
  if (draft.readiness?.status === 'ready' && recomputed.missing.length) errors.push({ code: 'READINESS_MISMATCH', path: 'readiness.status', message: `仍缺少字段: ${recomputed.missing.map(item => `${item.layer}.${item.field}`).join(', ')}` });
  if (draft.readiness?.status === 'ready' && !Array.isArray(draft.layer_patches)) errors.push({ code: 'LAYER_PATCHES_MISSING', path: 'layer_patches', message: 'ready Draft 必须包含 LayerPatches' });
  const recordsByArea = {};
  for (const patch of draft.layer_patches || []) {
    if (patch.operation === 'noop') continue;
    if (!patch.record || patch.record.id !== patch.id) errors.push({ code: 'PATCH_RECORD_INVALID', path: `${patch.area}:${patch.id}`, message: 'Patch record 缺失或 id 不匹配' });
    else {
      (recordsByArea[patch.area] ||= []).push(patch.record);
      for (const field of Object.keys(patch.record)) if (!patch.provenance?.[field]) errors.push({ code: 'PATCH_PROVENANCE_MISSING', path: `${patch.area}:${patch.id}.${field}`, message: '字段缺少 provenance' });
    }
  }
  const strict = validatePlannedRecords(recordsByArea);
  errors.push(...strict.errors);
  return {
    ok: errors.length === 0,
    errors,
    recomputed_missing: [...new Set(recomputed.missing.map(item => `${item.layer}.${item.field}`))],
  };
}

module.exports = {
  buildCatalogDraftEnvelope,
  validateCatalogDraftEnvelope,
};
