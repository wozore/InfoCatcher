'use strict';

const { requestStructuredJson } = require('../../shared/llm-gateway');
const { resolveProvider } = require('../../shared/providers');
const { LOCAL_API_BASE, LOCAL_MODEL } = require('../../shared/llm-endpoints');
const {
  REVIEW_VERDICTS,
  REVIEW_SURFACES,
  REVIEW_FIELDS,
  validateToolUpdateReviewValue,
} = require('../tool-update-review-contract');

function registrySourceForInput(input = {}) {
  const source = input.source || {};
  return {
    kind: source.kind || null,
    collector: source.collector || null,
    product_surface: source.product_surface || null,
    repository: source.repository || null,
    tag_prefix: source.tag_prefix || null,
    include_prerelease: source.include_prerelease ?? null,
  };
}

function buildToolUpdateReviewInput(input = {}) {
  const evidence = input.evidence || {};
  const detail = input.detail || {};
  const product = input.product || {};
  return JSON.stringify({
    evidence: {
      product_key: evidence.product_key || null,
      detail_id: evidence.detail_id || null,
      source_type: evidence.source_type || null,
      collector: evidence.collector || null,
      url: evidence.url || null,
      title: evidence.title || null,
      official_published_at: evidence.official_published_at || null,
      excerpt: String(evidence.excerpt || '').slice(0, 4000),
      content_hash: evidence.content_hash || null,
      status: evidence.status || null,
    },
    registry: {
      product_key: input.product_key || product.product_key || evidence.product_key || null,
      name: product.name || null,
      vendor_key: product.vendor_key || null,
      lifecycle: product.lifecycle || null,
      update_source: registrySourceForInput(input),
    },
    current_detail: {
      id: detail.id || null,
      tool_key: detail.tool_key || null,
      title: detail.title || null,
      vendor_key: detail.vendor_key || null,
      detail_kind: detail.detail_kind || null,
      last_updated_date: detail.last_updated_date || null,
    },
    task: '只判断证据是否属于登记的目标工具及目标组件，并给出语义建议。不得提取、改写或创造 URL、日期、repository、product_key。',
  });
}

function buildToolUpdateReviewInstructions() {
  return [
    '你是 AI 编程工具更新证据的语义审核助手。只输出一个 JSON 对象，不要输出 Markdown 或额外字段。',
    '确定性程序已经提供 product_key、URL、日期元数据、repository 和当前目录记录；不得创建、修改或纠正这些事实。',
    'verdict 只能是 approve、hold、discard：approve 表示正文明确描述目标产品级更新，hold 表示证据不足或边界不清，discard 表示属于别的产品/组件或不是产品级更新。',
    'matched_surface 必须从 product、cli、desktop、ide_extension 中选择，表示正文实际涉及的组件表面；不确定时使用你认为最可能的表面并在 reason 中说明。',
    'confidence 必须是 0 到 1 的数字。supporting_excerpt 必须是输入正文中的短原文摘录，不得编造或改写日期、URL、产品名。',
    '最终只返回字段：verdict、matched_surface、confidence、reason、supporting_excerpt。',
  ].join('\n');
}

function providerOptions(options = {}) {
  const provider = options.provider || 'local';
  if (provider === 'local') {
    return {
      ...options,
      provider: 'deepseek',
      endpoint: options.endpoint || LOCAL_API_BASE,
      model: options.model || LOCAL_MODEL,
      ...(options.apiKey ? {} : { apiKey: 'local' }),
    };
  }
  const resolved = resolveProvider(provider);
  const fallbackModel = resolved.ok ? resolved.provider.defaultModel : 'deepseek-v4-flash';
  return {
    ...options,
    provider,
    model: options.model || fallbackModel,
  };
}

async function suggestToolUpdateReview(input = {}, options = {}) {
  const provider = options.provider || 'local';
  if (!['local', 'deepseek', 'zhipu'].includes(provider)) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_PROVIDER_UNSUPPORTED', error: `不支持的工具更新审核 provider: ${provider}` };
  }
  if (provider !== 'local' && options.confirmCost !== true) {
    return { ok: false, code: 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED', error: `外部 provider=${provider} 的工具更新审核必须显式确认成本` };
  }
  if (!options.ledger?.reserve) {
    return { ok: false, code: 'COST_LEDGER_REQUIRED', error: '工具更新审核缺少成本账本' };
  }
  const result = await requestStructuredJson({
    kind: 'tool_update_review',
    instructions: buildToolUpdateReviewInstructions(),
    input: buildToolUpdateReviewInput(input),
    maxOutputTokens: options.maxOutputTokens || 700,
    ledger: options.ledger,
    validate: validateToolUpdateReviewValue,
  }, providerOptions(options));
  if (!result.ok) return result;
  return {
    ok: true,
    suggestion: { ...result.value },
    provider,
    usage: result.usage || null,
  };
}

module.exports = {
  REVIEW_VERDICTS,
  REVIEW_SURFACES,
  REVIEW_FIELDS,
  validateToolUpdateReviewValue,
  buildToolUpdateReviewInput,
  buildToolUpdateReviewInstructions,
  suggestToolUpdateReview,
};
