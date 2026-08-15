'use strict';

/**
 * llm-entity-extract.js —— 摘要 AI 实体提取（feedback 反哺的 LLM 提取器）
 *
 * 替代 tool-feedback 默认正则提取：让 DeepSeek 从摘要里找 AI 相关的
 * 概念 / 工具 / 模型 / API / 订阅套餐（用户拍板：方案 A + 检查遗漏，不喂正则候选）。
 *
 * 复用 catalog 的 requestStructuredJson（Responses 协议 + 结构化 JSON 外壳归一化 +
 * ledger fail-closed + 有限响应诊断），比 news 旧 Chat Completions 封装更一致。
 *
 * 降级语义：LLM 调用失败（网络/限流/缺 key/输出非法）时【抛错】，由 cmd-min 的
 * 注入包装层捕获后回退正则提取（extractEntitiesDefault，宁多勿漏），不阻断反哺。
 * 成功但确实没有工具/概念 → 返回 []（AI 判断本段无内容），不回退正则。
 *
 * 注入点（测试用）：options.ledger / model / apiKey / fetchImpl / timeoutMs。
 */

const { requestStructuredJson } = require('../../catalog/ai/deepseek-structured');
const { createCostLedger } = require('../../catalog/catalog-research');
const { loadGeneratorConfig } = require('../../catalog/catalog-assistant');

const DEFAULT_MAX_OUTPUT_TOKENS = 600;

/** 提取 prompt（实测修订版：无明确名称输出 []，排除泛称/机构名，防硬凑）。 */
function buildEntityExtractInstructions() {
  return '这个摘要里好像有 AI 相关的概念、工具、模型、API、订阅套餐什么的，请你找出来。硬性规则：' +
    '1.只找摘要里真实提到的具体名称，禁止编造、禁止硬凑。如果摘要里没有明确的 AI 工具/模型/概念/套餐名称，输出空数组 []。' +
    '2.类型包括：AI 工具/软件（如 Cursor）、AI 模型（如 Qwen3.8-Max）、AI 概念/技术（如 RAG、vibe coding）、' +
    'API 服务（如 OpenAI API）、订阅套餐（如 ChatGPT Plus）。' +
    '3.排除泛称：AI、人工智能、AI 模型、AI 工具、AI 聊天机器人 这类泛指不算名称；' +
    '排除人名；排除机构/公司名（如字节跳动、Meta、三星，除非它的具体 AI 产品被点名）；排除与 AI 无关的普通词。' +
    '4.输出完整名，多词名不拆散（"Claude Code" 是一个整体，不要拆成 "Claude" 和 "Code"）。' +
    '5.找完后把摘要再检查一遍：确认没有遗漏的具体名称，也没有把泛称或无关词误当名称。' +
    '6.只输出名称字符串。输出：一个 JSON 字符串数组，如 ["DeepSeek","RAG"]；没有则 []。';
}

/** validate：接受裸数组或 {names/entities: [...]} 对象（requestStructuredJson 逐候选试）。 */
function validateExtractOutput(value) {
  if (Array.isArray(value)) return value.every(item => typeof item === 'string');
  if (value && typeof value === 'object') {
    for (const key of ['names', 'entities']) {
      if (Array.isArray(value[key])) return value[key].every(item => typeof item === 'string');
    }
  }
  return false;
}

function toNameList(value) {
  const list = Array.isArray(value) ? value : (value && Array.isArray(value.names) ? value.names : (value && Array.isArray(value.entities) ? value.entities : []));
  return list.map(String).map(name => name.trim()).filter(Boolean);
}

function defaultModel() {
  try { return loadGeneratorConfig().model; } catch { return undefined; }
}

/**
 * 用 DeepSeek 从一段摘要提取 AI 实体名。
 * @param {string} text 摘要正文
 * @param {object} [options] { ledger, model, apiKey, fetchImpl, timeoutMs, maxOutputTokens }
 * @returns {Promise<string[]>} 名称数组；调用失败时抛错（调用方据此降级正则）。
 */
async function extractEntitiesWithLlm(text, options = {}) {
  const ledger = options.ledger || createCostLedger({ responses_calls: 1, synthesis_calls: 0 });
  const result = await requestStructuredJson({
    kind: 'entity_extract',
    instructions: buildEntityExtractInstructions(),
    input: JSON.stringify({ text: String(text || '') }),
    maxOutputTokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    ledger,
    validate: validateExtractOutput,
  }, {
    model: options.model || defaultModel(),
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (!result.ok) {
    const error = new Error(result.error || result.code || 'ENTITY_EXTRACT_FAILED');
    error.code = result.code;
    throw error;
  }
  return toNameList(result.value);
}

module.exports = {
  buildEntityExtractInstructions,
  validateExtractOutput,
  toNameList,
  extractEntitiesWithLlm,
};
