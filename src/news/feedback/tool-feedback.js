/**
 * tool-feedback.js —— 工具库/概念库反哺（热点管线 v2 收尾环节）
 *
 * 在热点管线 v2 中的位置：收尾环节之一，与 transcript-notify / keyword-refine 并列，
 * **独立于主链、互相不依赖**。吃 approved 内容的 summary，反哺两个知识库：
 *   1. 工具反哺（config.feedback.tool_feedback）：从 summary 提取疑似 AI 工具名，
 *      与五模块工具目录的工具卡片比对，缺失 → 生成"待补工具卡"草案（人工补全后导入）。
 *   2. 概念反哺（config.feedback.concept_feedback）：提取疑似 AI 概念名，
 *      与 data/catalog/glossary.json 比对，缺失 → 生成"待补概念卡"草案。
 *
 * 完全分离：只读 min-store + catalog（JSON），只写 manual_folder 下的待补卡文件，
 * 不直接改五模块工具卡或 glossary.json —— 补全由维护者人工确认后导入。
 *
 * 提取方式：默认用正则匹配大写品牌名/知名模型名（DeepSeek/Ollama/Claude/GPT…）；
 * 需要更智能的语义提取时由调用方注入 options.llmExtract（LLM 提取函数）。
 *
 * 数据文件（manual_folder/，文件名固定去掉日期后缀）：
 *   tool-cards-pending.json      待补工具卡草案
 *   concept-cards-pending.json   待补概念卡草案
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { readMinStore } = require('../min/min-store');
const { catalog } = require('../../catalog-interface');
const { CATALOG_FILES, CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../../shared/paths');
const { beijingDateKey } = require('../../shared/beijing-time');

// ═══════════════════════════════════════════════════════════════
// 默认实体提取（正则）
// ═══════════════════════════════════════════════════════════════

// 知名 AI 工具 / 模型名（大小写不敏感匹配；词边界）。后续可按需扩充。
const KNOWN_AI_NAMES = [
  'DeepSeek', 'Ollama', 'Claude', 'ChatGPT', 'GPT', 'Gemini', 'OpenAI',
  'Anthropic', 'Copilot', 'Midjourney', 'Stable Diffusion', 'Llama', 'Mistral',
  'Qwen', '通义千问', 'Kimi', '智谱', 'GLM', '豆包', '即梦', '可灵', 'Sora',
  'Cursor', 'Trae', 'NotebookLM', 'Perplexity', 'Hugging Face', 'vLLM',
  'Runway', 'Suno', '可灵', 'Cerebras', 'Groq', 'Deep Research',
];

/** 从一段文本提取疑似 AI 工具/概念名（默认正则实现，去重保序）。 */
function extractEntitiesDefault(text) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const name of KNOWN_AI_NAMES) {
    if (lower.includes(name.toLowerCase())) {
      found.push(name);
    }
  }
  // 补充：正则抓"大写品牌名"（3~12 位字母，首字母大写），排除常见英文词。
  const brandRe = /\b[A-Z][a-z0-9]{2,11}\b/g;
  const matches = String(text || '').match(brandRe) || [];
  for (const m of matches) {
    const l = m.toLowerCase();
    // 排除词典常见词与口语词，避免误报
    if (COMMON_ENGLISH_WORDS.has(l)) continue;
    if (!found.some(name => name.toLowerCase() === l)) found.push(m);
  }
  return found;
}

// 常见英文词表（大写品牌正则误报过滤）
const COMMON_ENGLISH_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was',
  'not', 'but', 'you', 'your', 'they', 'them', 'there', 'here', 'what', 'when',
  'where', 'which', 'will', 'would', 'could', 'should', 'into', 'about', 'their',
  'these', 'those', 'after', 'before', 'during', 'because', 'through', 'between',
  'news', 'video', 'tools', 'tool', 'open', 'used', 'use', 'using', 'like', 'make',
  'made', 'model', 'models', 'made', 'recent', 'using', 'still', 'over', 'also',
  'very', 'just', 'than', 'then', 'they', 'what', 'when', 'where', 'which', 'how',
]);

/**
 * 提取总结文本里的疑似 AI 工具/概念名。
 * 默认正则实现；调用方可注入 options.llmExtract(text) → string[] 覆盖。
 */
async function extractEntities(text, options) {
  if (typeof options.llmExtract === 'function') {
    const result = await options.llmExtract(text);
    return (result || []).filter(Boolean);
  }
  return extractEntitiesDefault(text);
}

// ═══════════════════════════════════════════════════════════════
// 知识库比对
// ═══════════════════════════════════════════════════════════════

/** 工具库已有判定：name 或 id 子串匹配（双向，大小写不敏感）。 */
function toolExists(toolName, tools) {
  const needle = String(toolName || '').toLowerCase();
  if (!needle) return false;
  return (tools || []).some(tool =>
    (tool.title && String(tool.title).toLowerCase().includes(needle)) ||
    (tool.tool_key && String(tool.tool_key).toLowerCase().includes(needle)) ||
    (tool.vendor_label && String(tool.vendor_label).toLowerCase().includes(needle)) ||
    (needle.includes(String(tool.title || '').toLowerCase()) && tool.title) ||
    (needle.includes(String(tool.tool_key || '').toLowerCase()) && tool.tool_key)
  );
}

/** 概念库已有判定：term 或 full_name 子串匹配（双向，大小写不敏感）。 */
function conceptExists(conceptName, glossary) {
  const needle = String(conceptName || '').toLowerCase();
  if (!needle) return false;
  return (glossary || []).some(entry =>
    (entry.term && String(entry.term).toLowerCase().includes(needle)) ||
    (entry.full_name && String(entry.full_name).toLowerCase().includes(needle)) ||
    (needle.includes(String(entry.term || '').toLowerCase()) && entry.term) ||
    (needle.includes(String(entry.full_name || '').toLowerCase()) && entry.full_name)
  );
}

/** 生成 id 占位（英文名 → kebab；中文名原样）。 */
function placeholderId(name) {
  const slug = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'pending';
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

/** 清单日期键（北京时间 YYYYMMDD）。 */
function dateKeyOf(input) {
  return beijingDateKey(input);
}

/**
 * 工具库/概念库反哺：从 approved summary 提取实体 → 与知识库比对 → 待补卡草案。
 *
 * @param {object} [store]  min-store 全文（读 store.candidates）；options.store 优先
 * @param {object} [config] news-config-v2.json（读 feedback / manual_folder）
 * @param {object} [options] { store?, now?, llmExtract?, tools?, glossary? }
 *   - llmExtract  实体提取注入函数 (text) => Promise<string[]>/string[]；缺省正则
 *   - now         清单日期参考（缺省当天）
 *   - tools       工具卡片数据注入（测试用）；缺省通过目录 Interface 读取
 *   - glossary    glossary.json 数据注入（测试用）；缺省读 CATALOG_FILES.glossary
 * @returns {Promise<{
 *   toolsFound: string[], toolsPending: Array<{name,url,description,source_hotspot,pending}>,
 *   conceptsFound: string[], conceptsPending: Array<{term,definition,source_hotspot,pending}>,
 * }>}
 */
async function feedbackFromSummaries(store, config, options = {}) {
  const source = options.store ?? store ?? readMinStore();
  const feedback = (config && config.feedback) || {};
  const candidates = source && Array.isArray(source.candidates) ? source.candidates : [];

  // 1. approved 且有 summary 的条目
  const approvedWithSummary = candidates.filter(
    item => item && item.review_status === 'approved' && item.summary
  );

  // 2. 汇总所有总结文本
  const texts = approvedWithSummary.map(item => String(item.summary || '').trim()).filter(Boolean);
  const allEntities = new Map(); // name -> count
  for (const text of texts) {
    const entities = await extractEntities(text, options);
    for (const name of entities) {
      allEntities.set(name, (allEntities.get(name) || 0) + 1);
    }
  }

  const tools = options.tools ?? (() => {
    const result = catalog({ area: 'tool-card', operation: 'list' });
    return result.ok ? result.data : [];
  })();
  const glossary = options.glossary ?? readJson(CATALOG_FILES.glossary, []);
  const dateKey = dateKeyOf(options && options.now);

  const toolsFound = [];
  const toolsPending = [];
  const conceptsFound = [];
  const conceptsPending = [];

  for (const [name, count] of allEntities) {
    if (feedback.tool_feedback !== false) {
      if (toolExists(name, tools)) toolsFound.push(name);
      else toolsPending.push({
        id: placeholderId(name),
        name,
        url: '', // 占位：待人工补全
        description: '', // 留空：待人工补全
        source_hotspot: true,
        pending: true,
        mentioned_in_summaries: count,
        generated_at: new Date().toISOString(),
      });
    }
    if (feedback.concept_feedback !== false) {
      if (conceptExists(name, glossary)) conceptsFound.push(name);
      else conceptsPending.push({
        term: name,
        full_name: '',
        definition: '', // 留空：待人工补全
        category: '',
        source_hotspot: true,
        pending: true,
        mentioned_in_summaries: count,
        generated_at: new Date().toISOString(),
      });
    }
  }

  if (toolsPending.length > 0) {
    const toolFile = CATALOG_GENERATOR_FILES.pendingTools;
    fs.mkdirSync(path.dirname(toolFile), { recursive: true });
    writeJsonAtomic(toolFile, {
      schema_version: 1,
      kind: 'tool_cards_pending',
      generated_at: new Date().toISOString(),
      date: dateKey,
      count: toolsPending.length,
      cards: toolsPending,
    }, 'tool-feedback');
  }
  if (conceptsPending.length > 0) {
    const conceptFile = CONCEPT_FILES.pendingConcepts;
    fs.mkdirSync(path.dirname(conceptFile), { recursive: true });
    writeJsonAtomic(conceptFile, {
      schema_version: 1,
      kind: 'concept_cards_pending',
      generated_at: new Date().toISOString(),
      date: dateKey,
      count: conceptsPending.length,
      cards: conceptsPending,
    }, 'tool-feedback');
  }

  return { toolsFound, toolsPending, conceptsFound, conceptsPending };
}

module.exports = {
  feedbackFromSummaries,
  extractEntities,
  extractEntitiesDefault,
  toolExists,
  conceptExists,
};
