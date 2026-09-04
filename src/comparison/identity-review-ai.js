'use strict';

/**
 * identity-review-ai.js — 名称歧义 AI 建议 Adapter
 *
 * 本地 Bonsai 是默认路径；DeepSeek 仅由 identity-review.js 的升级策略调用。
 * 两者都返回建议，绝不写人工登记表。
 */

const { requestStructuredJson } = require('../shared/llm-gateway');
const { resolveProvider } = require('../shared/providers');
const { LOCAL_API_BASE, LOCAL_MODEL } = require('../shared/llm-endpoints');
const { validateSuggestion } = require('./identity-review');

function buildInstructions() {
  return [
    '你是模型名称身份审计助手。只输出一个 JSON 对象，不要输出 Markdown。',
    '任务：根据原始模型名称和确定性解析，建议 model_key、degree、evaluation_profile。',
    'degree 只能是 high、low、medium、xhigh、auto、max 或 null。',
    'evaluation_profile 是评测运行环境，例如 codex-harness；它不是模型名，也不是 degree。',
    'high-fidelity、Qwen Max、Thinking、参数规模、MoE、模型日期不是 degree，不能删除。',
    '如果无法安全判断，保留 deterministic_parse.model_key，confidence 设低，并解释原因。',
    '返回字段：model_key、degree、evaluation_profile、confidence（0 至 1）、reason。',
  ].join('\n');
}

function buildInput(candidate) {
  return JSON.stringify({
    source: candidate?.source || null,
    raw_name: candidate?.raw_name || null,
    deterministic_parse: candidate?.deterministic_parse || null,
    requires_human_approval: true,
  });
}

/**
 * @param {object} candidate identity-review.collectReviewCandidates 返回项
 * @param {object} options { provider:'local'|'deepseek'|'zhipu', ledger, model, endpoint, apiKey, fetchImpl }
 */
async function suggestIdentityReview(candidate, options = {}) {
  const provider = options.provider || 'local';
  if (!['local', 'deepseek', 'zhipu'].includes(provider)) {
    return { ok: false, code: 'IDENTITY_REVIEW_PROVIDER_UNSUPPORTED', error: `不支持的 identity review provider: ${provider}` };
  }
  const isLocal = provider === 'local';
  const externalProvider = isLocal ? null : resolveProvider(provider);
  return requestStructuredJson({
    kind: 'identity_review',
    instructions: buildInstructions(),
    input: buildInput(candidate),
    maxOutputTokens: options.maxOutputTokens || 500,
    ledger: options.ledger,
    validate: validateSuggestion,
  }, {
    ...options,
    ...(isLocal ? { provider: 'deepseek' } : { provider }),
    endpoint: options.endpoint || (isLocal ? LOCAL_API_BASE : undefined),
    model: options.model
      || (isLocal ? LOCAL_MODEL : (externalProvider?.ok ? externalProvider.provider.defaultModel : 'deepseek-v4-flash')),
    // 本地 llama-server 不鉴权；transport 仍需非空值以通过统一安全门禁。
    ...(isLocal && !options.apiKey ? { apiKey: 'local' } : {}),
  });
}

module.exports = {
  buildInstructions,
  buildInput,
  suggestIdentityReview,
};
