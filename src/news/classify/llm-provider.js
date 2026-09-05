/**
 * llm-provider.js —— news 域 AI 内容加工的任务执行层：分类/总结/审核/本地化/top 挑选/关键词提纯。
 * 传输统一经 src/shared/llm-gateway.js：provider 路由、端点与模型解析、协议适配、
 * 错误分类都由 gateway 与 providers 注册表负责，本文件不重复实现。
 * prompt/payload 构造与输出归一化在 llm-prompts.js 与 llm-selection.js（纯函数层）。
 *
 * 失败语义：任何错误都 resolve { ok:false } 降级对象，绝不 reject、不抛错——调用方
 * （content-classifier / content-summarizer 等）据此回退规则式基线或置 null，保证采集
 * 管线不被 LLM 故障阻塞。错误码为 news 域稳定词汇：
 *   missing_api_key / no_fetch / timeout / http_<status> / unsupported_provider /
 *   LOCAL_MODEL_* / network_error
 *
 * 成本控制：单条输入裁剪见 llm-prompts.js；批量并发由调用方用并发池限制。
 */

'use strict';

const { getProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { requestLlmText } = require('../../shared/llm-gateway');
const {
  buildClassifyPayload,
  normalizeLabel,
  buildSummaryPayload,
  normalizeSummary,
  buildExternalJsonChatPayload,
  buildReviewPayload,
  normalizeReview,
  buildLocalizePayload,
  normalizeLocalization,
} = require('./llm-prompts');
const {
  buildSelectTopPayload,
  normalizeSelectTop,
  buildKeywordRefinePayload,
  normalizeKeywordRefine,
} = require('./llm-selection');

// ── 传输封装（唯一通道：llm-gateway，不开直连） ──
function normalizeGatewayFailure(result) {
  if (result.code === 'missing_api_key' || String(result.code || '').endsWith('_AUTH_REQUIRED')) {
    return { ok: false, error: result.error, code: 'missing_api_key' };
  }
  if (result.status) {
    return { ok: false, error: result.error, code: `http_${result.status}`, status: result.status };
  }
  if (String(result.code || '').endsWith('_TIMEOUT') || result.code === 'timeout') {
    return { ok: false, error: result.error, code: 'timeout' };
  }
  if (result.code === 'AI_PROVIDER_UNSUPPORTED') {
    return { ok: false, error: result.error, code: 'unsupported_provider' };
  }
  if (String(result.code || '').startsWith('LOCAL_MODEL_')) {
    return { ok: false, error: result.error, code: result.code };
  }
  return { ok: false, error: result.error, code: 'network_error' };
}

async function requestExternalChat(payload, options = {}) {
  try {
    const result = await requestLlmText(payload, {
      ...options,
      provider: options.provider || DEFAULT_PROVIDER_NAME,
      timeoutMs: options.timeoutMs ?? 15_000,
    });
    return result.ok ? result : normalizeGatewayFailure(result);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: 'network_error' };
  }
}

async function requestLocalChat(payload, options = {}) {
  try {
    const result = await requestLlmText(payload, {
      ...options,
      provider: 'local',
      timeoutMs: options.timeoutMs ?? 15_000,
    });
    return result.ok ? result : normalizeGatewayFailure(result);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: 'network_error' };
  }
}

function requireFetch(options) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return fetchImpl ? null : { ok: false, error: '当前运行环境无 fetch', code: 'no_fetch' };
}

function requireLocalKey(options) {
  const apiKey = options.apiKey ?? 'local-bonsai';
  return apiKey ? null : { ok: false, error: '缺少 DEEPSEEK_API_KEY', code: 'missing_api_key' };
}

function providerLabel(options) {
  return getProvider(options.provider || DEFAULT_PROVIDER_NAME)?.label || '外部 provider';
}

// ── 任务执行函数 ──

/** L1 内容分类（外部 provider）：成功返回 { ok:true, content_type, ai_confidence, raw }。 */
async function classifyContent(item, options = {}) {
  const blocked = requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildClassifyPayload(item, options.model);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestExternalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: `${providerLabel(options)} 返回空内容`, code: 'empty_content' };
  }
  const label = normalizeLabel(content);
  if (!label) {
    return { ok: false, error: `${providerLabel(options)} 输出无法映射到六类：${content.slice(0, 60)}`, code: 'invalid_label' };
  }
  return { ok: true, content_type: label, ai_confidence: 0.85, raw: content };
}

/** 内容总结（本地）：成功返回 { ok:true, summary, key_points, raw }。 */
async function summarizeContent(item, options = {}) {
  const blocked = requireLocalKey(options) || requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildSummaryPayload(item, options.model, options);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestLocalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: '本地模型返回空内容', code: 'empty_content' };
  }
  const parsed = normalizeSummary(content);
  if (!parsed) {
    return { ok: false, error: `本地模型输出无法解析为 JSON 总结：${content.slice(0, 60)}`, code: 'invalid_summary' };
  }
  return { ok: true, summary: parsed.summary, key_points: parsed.key_points, raw: content };
}

/** 内容总结（外部 provider，绕过本地 Bonsai）：返回结构同 summarizeContent。 */
async function summarizeWithExternal(item, options = {}) {
  const blocked = requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildExternalJsonChatPayload(buildSummaryPayload(item, options.model, options));
  } catch (error) {
    return { ok: false, error: error.message, code: 'payload_error' };
  }
  const result = await requestExternalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (!content) return { ok: false, error: `${providerLabel(options)} 返回空内容`, code: 'empty_content' };
  const parsed = normalizeSummary(content);
  if (!parsed) return { ok: false, error: `${providerLabel(options)} 输出无法解析为 JSON 总结`, code: 'invalid_summary' };
  return { ok: true, summary: parsed.summary, key_points: parsed.key_points, raw: content };
}

/** 审核建议（本地）：成功返回 { ok:true, verdict, reasons, confidence, confidence_range, raw }。 */
async function reviewContent(item, options = {}) {
  const blocked = requireLocalKey(options) || requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildReviewPayload(item, options.model, options);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestLocalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: '本地模型返回空内容', code: 'empty_content' };
  }
  const parsed = normalizeReview(content);
  if (!parsed) {
    return { ok: false, error: `本地模型输出无法解析为审核建议：${content.slice(0, 60)}`, code: 'invalid_review' };
  }
  return { ok: true, verdict: parsed.verdict, reasons: parsed.reasons, confidence: parsed.confidence, confidence_range: parsed.confidence_range || null, raw: content };
}

/** 审核建议（外部 provider）：返回结构同 reviewContent。 */
async function reviewWithExternal(item, options = {}) {
  const blocked = requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildExternalJsonChatPayload(buildReviewPayload(item, options.model, options));
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestExternalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: `${providerLabel(options)} 返回空内容`, code: 'empty_content' };
  }
  const parsed = normalizeReview(content);
  if (!parsed) {
    return { ok: false, error: `${providerLabel(options)} 输出无法解析为审核建议：${content.slice(0, 60)}`, code: 'invalid_review' };
  }
  return { ok: true, verdict: parsed.verdict, reasons: parsed.reasons, confidence: parsed.confidence, confidence_range: parsed.confidence_range || null, raw: content };
}

/** 内容本地化翻译（本地）：成功返回 { ok:true, title, description, raw }。 */
async function localizeContent(item, options = {}) {
  const blocked = requireLocalKey(options) || requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildLocalizePayload(item, options.model, options);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestLocalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: '本地模型返回空内容', code: 'empty_content' };
  }
  const parsed = normalizeLocalization(content);
  if (!parsed) {
    return { ok: false, error: `本地模型输出无法解析为翻译：${content.slice(0, 60)}`, code: 'invalid_translation' };
  }
  return { ok: true, title: parsed.title, description: parsed.description, raw: content };
}

/** 内容本地化翻译（外部 provider）：返回结构同 localizeContent。 */
async function localizeWithExternal(item, options = {}) {
  const blocked = requireFetch(options);
  if (blocked) return blocked;
  let payload;
  try {
    payload = buildExternalJsonChatPayload(buildLocalizePayload(item, options.model, options));
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestExternalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: `${providerLabel(options)} 返回空内容`, code: 'empty_content' };
  }
  const parsed = normalizeLocalization(content);
  if (!parsed) {
    return { ok: false, error: `${providerLabel(options)} 输出无法解析为翻译：${content.slice(0, 60)}`, code: 'invalid_translation' };
  }
  return { ok: true, title: parsed.title, description: parsed.description, raw: content };
}

/**
 * 从一批 approved 候选中挑选 top N 待选项（AI 语义判断，N 在区间内由 AI 定）。
 * 成功返回 { ok:true, count, ids, raw }。
 */
async function selectTopItems(candidates, options = {}) {
  const blocked = requireLocalKey(options) || requireFetch(options);
  if (blocked) return blocked;
  if (!Array.isArray(candidates) || !candidates.length) {
    return { ok: false, error: '无 approved 候选可供挑选', code: 'empty_candidates' };
  }
  let payload;
  try {
    payload = buildSelectTopPayload(candidates, options.min ?? 3, options.max ?? 5, options.model);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestLocalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: '本地模型返回空内容', code: 'empty_content' };
  }
  const parsed = normalizeSelectTop(content);
  if (!parsed) {
    return { ok: false, error: `本地模型输出无法解析为 top 选择：${content.slice(0, 60)}`, code: 'invalid_select_top' };
  }
  return { ok: true, count: parsed.count, ids: parsed.ids, raw: content };
}

/** 关键词提纯（本地）：成功返回 { ok:true, keywords, raw }。 */
async function refineKeywords(approvedItems, ruleCandidates, options = {}) {
  const blocked = requireLocalKey(options) || requireFetch(options);
  if (blocked) return blocked;
  if (!Array.isArray(approvedItems) || !approvedItems.length) {
    return { ok: false, error: '无 approved 候选可供提纯', code: 'empty_candidates' };
  }
  let payload;
  try {
    payload = buildKeywordRefinePayload(approvedItems, ruleCandidates, options.existingKeywords, options.model);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }
  const result = await requestLocalChat(payload, options);
  if (!result.ok) return result;
  const content = result.text;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: '本地模型返回空内容', code: 'empty_content' };
  }
  const keywords = normalizeKeywordRefine(content, options.existingKeywords, { filterExisting: options.filterExisting === true });
  if (!keywords) {
    return { ok: false, error: `本地模型输出无法解析为关键词清单：${content.slice(0, 60)}`, code: 'invalid_keyword_refine' };
  }
  return { ok: true, keywords, raw: content };
}

module.exports = {
  // L1 分类
  classifyContent,
  // 总结
  summarizeContent,
  summarizeWithExternal,
  // 审核建议
  reviewContent,
  reviewWithExternal,
  // 本地化
  localizeContent,
  localizeWithExternal,
  // 每日 top 挑选
  selectTopItems,
  // 关键词提纯
  refineKeywords,
};
