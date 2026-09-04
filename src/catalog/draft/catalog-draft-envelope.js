'use strict';

const { validatePlannedRecords } = require('../core/catalog-record-completeness');
const { fieldCoverageOf } = require('../core/catalog-synthesis');

const RETRYABLE_CODES = new Set([
  'DEEPSEEK_TIMEOUT', 'DEEPSEEK_RATE_LIMITED', 'DEEPSEEK_PROVIDER_ERROR', 'DEEPSEEK_NETWORK_ERROR',
  'DEEPSEEK_SYNTHESIS_INCOMPLETE', 'DEEPSEEK_SYNTHESIS_EMPTY', 'DEEPSEEK_SYNTHESIS_FAILED',
  'DEEPSEEK_OUTPUT_INVALID', 'DEEPSEEK_SCHEMA_INVALID', 'COST_BUDGET_EXHAUSTED',
]);
const CONFIG_CODES = new Set([
  'MODEL_REQUIRED', 'DEEPSEEK_AUTH_REQUIRED', 'DEEPSEEK_ENDPOINT_INVALID', 'AI_PROVIDER_UNSUPPORTED',
  'AI_PROTOCOL_MISMATCH', 'RETRIEVAL_PROVIDER_UNSUPPORTED', 'TAVILY_AUTH_REQUIRED', 'TAVILY_ACCESS_MODE_REQUIRED',
]);
const PROFILE_CODES = new Set(['PROFILE_MISMATCH_SUSPECTED', 'PLACEMENT_MANUAL_REQUIRED', 'PLACEMENT_AI_FAILED', 'SEED_INVALID']);
const EVIDENCE_CODES = new Set(['SYNTHESIS_COVERAGE_INCOMPLETE', 'SOURCE_ID_INVALID', 'PATCH_PROVENANCE_MISSING', 'OFFICIAL_SOURCE_REQUIRED']);

// llm-gateway 按 DEEPSEEK_<kind>_<reason> 拼码（如 DEEPSEEK_SYNTHESIS_SCHEMA_INVALID），
// 而 retryable 分类字面量无 kind 段；不归一会让模型输出抖动被误判成 manual_required，
// Draft 在面板上永久失去恢复入口。
function normalizeGatewayErrorCode(code) {
  return String(code || '').replace(/^DEEPSEEK_(?:RESEARCH|SYNTHESIS)_(OUTPUT_INVALID|SCHEMA_INVALID)$/, 'DEEPSEEK_$1');
}

function failureCodeOf(failure) {
  const code = normalizeGatewayErrorCode(failure?.code) || 'DRAFT_BLOCKED';
  if (code === 'DEEPSEEK_OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure?.error || ''))) return 'MODEL_REQUIRED';
  return code;
}

function classifyFailure(research, synthesis) {
  const failure = !research?.ok ? research : !synthesis?.ok ? synthesis : null;
  if (!failure && Array.isArray(synthesis?.coverage?.missing) && synthesis.coverage.missing.length) {
    return { recovery_kind: 'evidence_required', error_code: 'SYNTHESIS_COVERAGE_INCOMPLETE' };
  }
  if (!failure) return { recovery_kind: 'manual_required', error_code: 'DRAFT_BLOCKED' };
  const error_code = failureCodeOf(failure);
  if (CONFIG_CODES.has(error_code)) return { recovery_kind: 'config_required', error_code };
  if (RETRYABLE_CODES.has(error_code)) return { recovery_kind: 'retryable', error_code };
  if (EVIDENCE_CODES.has(error_code) || Array.isArray(synthesis?.coverage?.missing)) return { recovery_kind: 'evidence_required', error_code };
  if (PROFILE_CODES.has(error_code)) return { recovery_kind: 'seed_or_profile_required', error_code };
  return { recovery_kind: 'manual_required', error_code };
}

function missingFieldsOf(research, synthesis) {
  const fields = Array.isArray(synthesis?.coverage?.missing) ? synthesis.coverage.missing : [];
  return [...new Set(fields.map(item => `${item.layer}.${item.field}`))];
}

function missingConfigFieldsOf(failure, errorCode) {
  if (errorCode === 'MODEL_REQUIRED') return ['model'];
  if (errorCode === 'AI_PROTOCOL_MISMATCH') return ['protocol'];
  if (errorCode === 'RETRIEVAL_PROVIDER_UNSUPPORTED') return ['retrieval_provider'];
  if (errorCode === 'TAVILY_ACCESS_MODE_REQUIRED') return ['access_mode'];
  return Array.isArray(failure?.missing_config_fields) ? failure.missing_config_fields.filter(field => typeof field === 'string') : [];
}

function suggestedDetailKindOf(failure) {
  return typeof failure?.suggested_detail_kind === 'string' ? failure.suggested_detail_kind : null;
}

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
  const classification = classifyFailure(research, synthesis);
  if (!failure) return {
    code: classification.error_code,
    recovery_kind: classification.recovery_kind,
    error: fallbackError,
    missing_fields: missingFieldsOf(research, synthesis),
    missing_config_fields: [],
    suggested_detail_kind: null,
  };
  const details = {
    code: classification.error_code,
    recovery_kind: classification.recovery_kind,
    error: classification.error_code === 'MODEL_REQUIRED' ? 'DeepSeek 模型配置缺失' : (failure.error || fallbackError),
    missing_fields: missingFieldsOf(research, synthesis),
    missing_config_fields: missingConfigFieldsOf(failure, classification.error_code),
    suggested_detail_kind: suggestedDetailKindOf(failure),
  };
  for (const key of ['response_status', 'incomplete_reason', 'output_types', 'output_preview', 'output_keys']) {
    if (failure[key] !== undefined) details[key] = failure[key];
  }
  return details;
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
      ok: research?.ok === true,
      official_sources: research?.official_sources || [],
      warnings: research?.warnings || [],
    },
    research_progress: research?.research_progress || null,
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
  classifyFailure,
  failureCodeOf,
  normalizeGatewayErrorCode,
};
