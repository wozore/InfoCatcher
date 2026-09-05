'use strict';

/**
 * catalog-workbench-view.js — catalog-workbench 的 Draft 视图层
 *
 * 职责（纯函数，无 I/O）：
 *   - 恢复诊断：从 Draft 的 last_error / coverage 推导 recoveryKind、recoveryMode、
 *     缺失字段与给维护者的可读原因（recoveryDiagnostic）；
 *   - DTO 投影：把存储态 Draft 投影为浏览器安全的面板对象（projectDraft，脱敏本地路径）；
 *   - 恢复选项归一化：白名单键 + 数值范围校验（normalizeRecoveryOptions）；
 *   - 稳定 plan 哈希与带 code 的错误构造（planHashOf / codeError）。
 * catalog-workbench.js 是维护者操作协调器，面板展示与诊断细节收敛在本模块。
 */

const crypto = require('crypto');
const { DIRS } = require('../shared/paths');
const { getProvider } = require('../shared/providers');
const assistant = require('./draft/index');

const RETRYABLE_ERROR_CODES = new Set([
  'DEEPSEEK_TIMEOUT', 'DEEPSEEK_RATE_LIMITED', 'DEEPSEEK_PROVIDER_ERROR', 'DEEPSEEK_NETWORK_ERROR',
  'DEEPSEEK_SYNTHESIS_INCOMPLETE', 'DEEPSEEK_SYNTHESIS_EMPTY', 'DEEPSEEK_SYNTHESIS_FAILED',
  'DEEPSEEK_OUTPUT_INVALID', 'DEEPSEEK_SCHEMA_INVALID',
]);

const PROJECT_ROOT = DIRS.project;

const RECOVERY_OPTION_KEYS = Object.freeze([
  'provider', 'model', 'protocol', 'retrieval_provider', 'access_mode', 'timeout_ms',
  'max_search_queries', 'max_pages', 'max_responses_calls', 'max_synthesis_calls',
  'search_depth', 'max_search_results', 'extract_depth', 'chunks_per_source',
]);
const RECOVERY_OPTION_LIMITS = Object.freeze({
  timeout_ms: [1000, 600000], max_search_queries: [1, 20], max_pages: [1, 100],
  max_responses_calls: [1, 50], max_synthesis_calls: [1, 5], max_search_results: [1, 20], chunks_per_source: [1, 10],
});

function normalizeRecoveryOptions(input, defaults) {
  if (input === undefined) return assistant.normalizeGeneratorOptions(defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw codeError('RECOVERY_OPTIONS_INVALID');
  const unknown = Object.keys(input).filter(key => !RECOVERY_OPTION_KEYS.includes(key));
  if (unknown.length) throw codeError('RECOVERY_OPTIONS_INVALID');
  for (const field of ['model', 'provider', 'protocol', 'retrieval_provider', 'access_mode']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw codeError(field === 'model' ? 'MODEL_REQUIRED' : 'RECOVERY_OPTIONS_INVALID');
  }
  for (const [key, range] of Object.entries(RECOVERY_OPTION_LIMITS)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) throw codeError('RECOVERY_OPTIONS_INVALID');
  }
  if (input.access_mode !== undefined && !['keyed', 'keyless'].includes(String(input.access_mode))) throw codeError('RECOVERY_OPTIONS_INVALID');
  const merged = assistant.normalizeGeneratorOptions({ ...defaults, ...input });
  if (!merged.model || typeof merged.model !== 'string') throw codeError('MODEL_REQUIRED');
  const provider = getProvider(merged.provider);
  if (!provider || provider.protocol !== merged.protocol || merged.retrievalProvider !== 'tavily') throw codeError('RECOVERY_OPTIONS_INVALID');
  return merged;
}

/** 脱敏本地路径，避免把绝对路径/临时路径泄露进浏览器 DTO。 */
function sanitizeReason(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const root of [PROJECT_ROOT, PROJECT_ROOT.replace(/\\/g, '/'), PROJECT_ROOT.toLowerCase(), PROJECT_ROOT.replace(/\\/g, '/').toLowerCase()]) {
    out = out.split(root).join('<project>');
  }
  return out.replace(/[A-Za-z]:\\[^\s'"<>]*/g, '<path>');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}
function codeError(code, message = code) {
  const error = new Error(message); error.code = code; return error;
}
function planHashOf(value) { return hash({ kind: 'catalog-workbench-plan', ...value }); }

function recoveryDiagnostic(draft) {
  if (draft?.readiness?.status === 'ready') return { recoveryKind: null, errorCode: null, missingFields: [], missingConfigFields: [], suggestedDetailKind: null, reason: null };
  const failure = draft?.last_error || {};
  let errorCode = assistant.normalizeGatewayErrorCode(failure.code);
  if (errorCode === 'DEEPSEEK_OUTPUT_INVALID' && /missing field [`']?model/i.test(String(failure.error || ''))) errorCode = 'MODEL_REQUIRED';
  const missingFields = [...new Set([
    ...(Array.isArray(failure.missing_fields) ? failure.missing_fields : []),
    ...(Array.isArray(draft?.coverage?.missing) ? draft.coverage.missing.map(item => `${item.layer}.${item.field}`) : []),
  ].filter(field => typeof field === 'string' && field.trim()))];
  const missingConfigFields = [...new Set((Array.isArray(failure.missing_config_fields) ? failure.missing_config_fields : []).filter(field => typeof field === 'string' && field.trim()))];
  // 存储 last_error 里的 recovery_kind 可能因既往误分类而失真（如 kind 段错误码被判成
  // manual_required），已知 retryable 码强制覆盖，否则该 Draft 在面板上永久丢失恢复入口。
  let recoveryKind = RETRYABLE_ERROR_CODES.has(errorCode) ? 'retryable' : (failure.recovery_kind || null);
  if (!recoveryKind) {
    if (errorCode === 'MODEL_REQUIRED' || ['DEEPSEEK_AUTH_REQUIRED', 'DEEPSEEK_ENDPOINT_INVALID', 'AI_PROVIDER_UNSUPPORTED', 'AI_PROTOCOL_MISMATCH', 'RETRIEVAL_PROVIDER_UNSUPPORTED', 'TAVILY_ACCESS_MODE_REQUIRED'].includes(errorCode)) recoveryKind = 'config_required';
    else if (RETRYABLE_ERROR_CODES.has(errorCode)) recoveryKind = 'retryable';
    else if (errorCode === 'PROFILE_MISMATCH_SUSPECTED' || errorCode.startsWith('PLACEMENT_') || errorCode === 'SEED_INVALID') recoveryKind = 'seed_or_profile_required';
    else if (missingFields.length || errorCode === 'SYNTHESIS_COVERAGE_INCOMPLETE') recoveryKind = 'evidence_required';
    else recoveryKind = 'manual_required';
  }
  const suggestedDetailKind = typeof failure.suggested_detail_kind === 'string' ? failure.suggested_detail_kind : null;
  const researchComplete = draft?.research?.ok === true
    || (draft?.research?.ok !== false && Array.isArray(draft?.research?.official_sources) && draft.research.official_sources.length > 0 && !draft.research_progress?.failed_scope);
  const recoveryMode = researchComplete && ['config_required', 'retryable'].includes(recoveryKind) && !errorCode.startsWith('TAVILY_') ? 'synthesis_only' : 'research_resume';
  const reason = {
    MODEL_REQUIRED: '缺少 model 配置，请填写模型名后重试。',
    DEEPSEEK_AUTH_REQUIRED: '缺少 DeepSeek 凭据，请在仓库根目录 .env 配置对应 key。',
    TAVILY_ACCESS_MODE_REQUIRED: '缺少 Tavily access mode 配置。',
    SYNTHESIS_COVERAGE_INCOMPLETE: missingFields.length ? `缺少官方证据字段：${missingFields.join('、')}` : '官方证据字段不完整。',
    PROFILE_MISMATCH_SUSPECTED: suggestedDetailKind ? `候选类型可能应为 ${suggestedDetailKind}，请修正候选资料。` : '候选类型或 Profile 不匹配。',
  }[errorCode] || (errorCode ? `恢复被阻断（${errorCode}）。` : 'Draft 当前不可恢复。');
  return { recoveryKind, recoveryMode, errorCode: errorCode || 'DRAFT_BLOCKED', missingFields, missingConfigFields: missingConfigFields.length ? missingConfigFields : (errorCode === 'MODEL_REQUIRED' ? ['model'] : []), suggestedDetailKind, reason };
}

function projectDraft(draft, extra = {}) {
  if (!draft) return null;
  const readiness = draft.readiness || {};
  const diagnostic = recoveryDiagnostic(draft);
  return {
    draft_id: draft.draft_id,
    candidate_name: String(draft.seed?.name || '').trim() || null,
    state: draft.state,
    base_revision: draft.base_revision || null,
    preview_hash: draft.preview_hash || null,
    readiness: readiness.status || null,
    recovery_kind: diagnostic.recoveryKind,
    recovery_mode: diagnostic.recoveryMode,
    error_code: diagnostic.errorCode,
    missing_fields: diagnostic.missingFields,
    missing_config_fields: diagnostic.missingConfigFields,
    suggested_detail_kind: diagnostic.suggestedDetailKind,
    blocking_reasons: diagnostic.reason ? [diagnostic.reason] : [],
    warnings: Array.isArray(readiness.warnings) ? readiness.warnings.slice(0, 5).map(sanitizeReason) : [],
    updated_at: draft.updated_at || null,
    ...extra,
  };
}

module.exports = {
  normalizeRecoveryOptions,
  codeError,
  planHashOf,
  projectDraft,
};
