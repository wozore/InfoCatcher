'use strict';

/**
 * identity-review.js — 模型名称歧义的离线审计（纯逻辑）
 *
 * 正常重建永远不调用本 Module。它只整理确定性解析无法分类的 token，
 * 通过注入的本地/DeepSeek Adapter 生成“待人工确认”的建议，绝不写 models-alias.json。
 */

const { SOURCE_KEYS, createModelIdentityResolver } = require('./model-identity');

const DEGREE_VALUES = new Set(['high', 'low', 'medium', 'xhigh', 'auto', 'max']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSuggestion(value) {
  return {
    model_key: isNonEmptyString(value?.model_key) ? value.model_key.trim() : null,
    degree: value?.degree == null ? null : String(value.degree).trim().toLowerCase(),
    evaluation_profile: value?.evaluation_profile == null ? null : String(value.evaluation_profile).trim().toLowerCase(),
    confidence: Number(value?.confidence),
    reason: isNonEmptyString(value?.reason) ? value.reason.trim() : null,
  };
}

function validateSuggestion(value) {
  const suggestion = normalizeSuggestion(value);
  return Boolean(
    suggestion.model_key && suggestion.model_key.includes('--')
    && (suggestion.degree == null || DEGREE_VALUES.has(suggestion.degree))
    && (suggestion.evaluation_profile == null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suggestion.evaluation_profile))
    && Number.isFinite(suggestion.confidence) && suggestion.confidence >= 0 && suggestion.confidence <= 1
    && suggestion.reason,
  );
}

function sourceRows(snapshots, source) {
  if (source === 'openrouter') return (snapshots.openrouter?.data || []).map(item => ({ raw_name: item.id, vendor_hint: null }));
  if (source === 'lmarena') return Object.values(snapshots.lmarena?.configs || {}).flat()
    .map(row => ({ raw_name: row.model_name, vendor_hint: row.organization || null }));
  if (source === 'livebench') return (snapshots.livebench?.groups || []).map(row => ({ raw_name: row.model, vendor_hint: null }));
  if (source === 'llm_stats') return (snapshots.llm_stats?.models || [])
    .map(row => ({ raw_name: row.model_id, vendor_hint: row.organization_id || row.organization || null }));
  return [];
}

/** 返回唯一的待审项；已确定名称不会进入清单。 */
function collectReviewCandidates(snapshots = {}, registry = {}) {
  const resolveIdentity = createModelIdentityResolver(registry);
  const candidates = new Map();
  for (const source of SOURCE_KEYS) {
    for (const row of sourceRows(snapshots, source)) {
      if (!isNonEmptyString(row.raw_name)) continue;
      const resolved = resolveIdentity({ source, rawName: row.raw_name, vendorHint: row.vendor_hint });
      if (!resolved.ambiguous_tokens?.length) continue;
      const key = `${source}:${row.raw_name.toLowerCase()}`;
      candidates.set(key, Object.freeze({
        source,
        raw_name: row.raw_name,
        deterministic_parse: {
          model_key: resolved.model_key,
          identity: resolved.identity,
          degree: resolved.degree,
          evaluation_profile: resolved.evaluation_profile,
          ambiguous_tokens: [...resolved.ambiguous_tokens],
        },
        requires_human_approval: true,
      }));
    }
  }
  return [...candidates.values()];
}

function touchesNeverMerge(modelKey, neverMerge = []) {
  return (neverMerge || []).some(pair => Array.isArray(pair) && pair.includes(modelKey));
}

function shouldEscalate(candidate, localResult, neverMerge = [], threshold = 0.9) {
  if (!localResult?.ok || !validateSuggestion(localResult.value)) return true;
  const suggestion = normalizeSuggestion(localResult.value);
  return suggestion.confidence < threshold
    || suggestion.model_key !== candidate.deterministic_parse.model_key
    || touchesNeverMerge(suggestion.model_key, neverMerge);
}

/**
 * 运行已注入的审计 Adapter。localSuggest/deepseekSuggest 的 Interface 均为
 * async candidate => { ok, value }；返回的所有建议都强制 requires_human_approval。
 */
async function reviewCandidates(candidates, { localSuggest, deepseekSuggest, neverMerge = [], threshold = 0.9 } = {}) {
  if (typeof localSuggest !== 'function') throw new Error('identity review 需要 localSuggest Adapter');
  const results = [];
  for (const candidate of candidates || []) {
    const local = await localSuggest(candidate);
    const useDeepSeek = shouldEscalate(candidate, local, neverMerge, threshold);
    const upstream = useDeepSeek && typeof deepseekSuggest === 'function'
      ? await deepseekSuggest(candidate)
      : local;
    results.push(Object.freeze({
      ...candidate,
      adapter: useDeepSeek && typeof deepseekSuggest === 'function' ? 'deepseek' : 'local',
      suggestion: upstream?.ok && validateSuggestion(upstream.value) ? normalizeSuggestion(upstream.value) : null,
      status: upstream?.ok && validateSuggestion(upstream.value) ? 'pending_human_review' : 'unresolved',
      requires_human_approval: true,
    }));
  }
  return results;
}

module.exports = {
  DEGREE_VALUES,
  normalizeSuggestion,
  validateSuggestion,
  collectReviewCandidates,
  shouldEscalate,
  reviewCandidates,
};
