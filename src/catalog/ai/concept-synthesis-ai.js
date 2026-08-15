'use strict';

/**
 * concept-synthesis-ai.js —— DeepSeek 概念合成 Adapter
 *
 * 单段式调用结构化深 Module（requestStructuredJson）：基于 approved 摘要主证据 +
 * vibe-hub 补充证据直接合成一条 glossary 条目。仿 deepseek-catalog-ai.js：
 *   - 成本账本必传 fail-closed；ledger.reserve('synthesis_calls', 1) 预占合成次数
 *     （responses_calls 由 requestStructuredJson 内部统一预占）
 *   - 返回 { ok:true, value:{...正式条目}, usage } 或深 Module 错误
 */

const { requestStructuredJson } = require('./deepseek-structured');
const {
  buildConceptSynthesisInput,
  buildConceptSynthesisInstructions,
} = require('./concept-synthesis-prompt');

/** 校验模型输出：必填字段 term/category/summary/source.name 非空。 */
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateConceptValue(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && isNonEmpty(value.term)
    && isNonEmpty(value.category)
    && isNonEmpty(value.summary)
    && value.source && isNonEmpty(value.source.name),
  );
}

/** 归一化为正式 glossary 条目（7 字段；term 以待补卡为准，防模型改词）。 */
function normalizeConceptEntry(value, card) {
  const term = String(card?.term || value?.term || '').trim();
  return {
    term,
    full_name: String(value?.full_name || '').trim() || term,
    category: String(value?.category || '').trim(),
    summary: String(value?.summary || '').trim(),
    related_terms: Array.isArray(value?.related_terms)
      ? value.related_terms.map(String).map(s => s.trim()).filter(Boolean)
      : [],
    source: {
      name: String(value?.source?.name || '').trim(),
      ...(value?.source?.url && isNonEmpty(value.source.url) ? { url: String(value.source.url).trim() } : {}),
    },
    relevance: String(value?.relevance || '').trim(),
  };
}

/**
 * 合成一条概念的 glossary 字段。
 * @param {object} input { card, evidence, existingCategories, ledger }
 * @param {object} [options] requestStructuredJson 透传（model/timeout 等）
 * @returns {Promise<{ok:true, value:object, usage}|{ok:false, code, error, ...}>}
 */
async function synthesizeConceptFields(input = {}, options = {}) {
  const ledger = input.ledger;
  if (!ledger?.reserve) return { ok: false, code: 'COST_LEDGER_REQUIRED', error: '概念合成缺少成本账本' };
  const synthesisReserved = ledger.reserve('synthesis_calls', 1);
  if (!synthesisReserved.ok) return { ok: false, code: synthesisReserved.code, error: '概念合成次数预算不足' };
  const result = await requestStructuredJson({
    kind: 'concept_synthesis',
    instructions: buildConceptSynthesisInstructions(input.existingCategories),
    input: JSON.stringify(buildConceptSynthesisInput(input.card, input.evidence)),
    maxOutputTokens: options.maxOutputTokens || 1500,
    ledger,
    validate: validateConceptValue,
  }, options);
  if (!result.ok) return result;
  return { ok: true, value: normalizeConceptEntry(result.value, input.card), usage: result.usage };
}

module.exports = {
  validateConceptValue,
  normalizeConceptEntry,
  synthesizeConceptFields,
};
