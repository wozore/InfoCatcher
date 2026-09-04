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

const { readJson } = require('../../shared/json-store');
const { readMinStore } = require('../min/min-store');
const { catalog } = require('../../catalog/interface');
const { CATALOG_FILES } = require('../../shared/paths');
const { beijingDateKey } = require('../../shared/beijing-time');
const {
  mergePending,
  candidateKeyOf,
  isVagueName,
  toolExists,
  conceptExists,
} = require('../../pending');

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

// 默认实体提取（正则）
// ═══════════════════════════════════════════════════════════════
const AI_MODEL_PATTERN = /\b(?:GPT|Claude|Gemini|Qwen|Llama|Kling|GLM|Mistral|DeepSeek|MiniMax|Grok)[-\s]?[vV]?\d+(?:\.\d+)?(?:[-\s]?(?:Pro|Max|Ultra|Plus|Flash|Mini|Turbo|Preview|Instruct|Reasoning))?\b/gi;

function matchWordOrChinese(text, name) {
  const isAscii = /^[\x00-\x7F]+$/.test(name);
  if (isAscii) {
    const re = new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    return re.test(text);
  }
  return String(text || '').toLowerCase().includes(name.toLowerCase());
}

/** 从一段文本提取疑似 AI 工具/概念名（默认正则实现，去重保序）。 */
function extractEntitiesDefault(text) {
  const found = [];
  // 1. 优先匹配明确带版本/系列号的 AI 模型名称
  const patternMatches = String(text || '').match(AI_MODEL_PATTERN) || [];
  for (const m of patternMatches) {
    const trimmed = m.trim();
    if (trimmed && !found.some(name => name.toLowerCase() === trimmed.toLowerCase())) {
      found.push(trimmed);
    }
  }
  // 2. 匹配知名 AI 品牌/工具名单（英文词边界，中文包含）
  for (const name of KNOWN_AI_NAMES) {
    if (matchWordOrChinese(text, name) && !found.some(n => n.toLowerCase() === name.toLowerCase())) {
      found.push(name);
    }
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
 * 提取总结文本里的疑似 AI 工具/模型/概念实体（带类型）。
 * 默认正则实现；调用方可注入 options.llmExtract(text) → [{name,type}]/string[] 覆盖。
 * 返回 [{name, type}]，type ∈ tool/model/concept/vague。
 */
async function extractEntities(text, options) {
  if (typeof options.llmExtract === 'function') {
    const result = await options.llmExtract(text);
    return normalizeEntities(result);
  }
  return extractEntitiesDefault(text).map(name => ({ name, type: isVagueName(name) ? 'vague' : 'tool' }));
}

/** 归一化提取结果为 [{name,type}]；兼容 [{name,type}]、裸 string[]（兜底 tool）与 {names|entities}。 */
function normalizeEntities(result) {
  const list = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.names) ? result.names
      : (result && Array.isArray(result.entities) ? result.entities : []));
  const entities = [];
  for (const item of list) {
    if (item && typeof item === 'object' && typeof item.name === 'string') {
      const type = ['tool', 'model', 'concept', 'vague'].includes(item.type) ? item.type : 'tool';
      const name = item.name.trim();
      if (name) entities.push({ name, type });
    } else {
      const name = String(item).trim();
      if (name) entities.push({ name, type: 'tool' });
    }
  }
  return entities;
}

/** 生成 id 占位（英文名 → kebab；中文名原样）。 *//** 生成 id 占位（英文名 → kebab；中文名原样）。 */
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

  // 2. 汇总所有总结文本（实体带类型，name -> {count, type}）
  const texts = approvedWithSummary.map(item => String(item.summary || '').trim()).filter(Boolean);
  const allEntities = new Map(); // name -> {count, type}
  for (const text of texts) {
    const entities = await extractEntities(text, options);
    for (const entity of entities) {
      const key = entity.name;
      const existing = allEntities.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.type === 'vague' && entity.type !== 'vague') existing.type = entity.type;
      } else {
        allEntities.set(key, { name: entity.name, type: entity.type, count: 1 });
      }
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

  for (const [name, { count, type }] of allEntities) {
    // 笼统名兜底拦截：即使 LLM/正则把笼统名标成 tool，也绝不生成待补工具卡
    if (isVagueName(name) || type === 'vague') continue;
    if (type === 'concept') {
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
      continue;
    }
    // tool / model：进待补工具卡；具体模型带 api_model 提示，供批量生成器定 detail_kind
    if (feedback.tool_feedback !== false) {
      if (toolExists(name, tools)) toolsFound.push(name);
      else toolsPending.push({
        id: placeholderId(name),
        name,
        url: '', // 占位：待人工补全
        description: '', // 留空：待人工补全
        detail_kind_hint: type === 'model' ? 'api_model' : 'tool',
        source_hotspot: true,
        pending: true,
        mentioned_in_summaries: count,
        generated_at: new Date().toISOString(),
      });
    }
  }

  if (toolsPending.length > 0) {
    const pending = await mergePending('tools', toolsPending, {
      toolFile: options.pendingToolFile,
      generatedAt: new Date().toISOString(),
      runId: 'tool-feedback',
    });
    const keys = new Set(toolsPending.map(card => candidateKeyOf('tools', card.name)));
    // Return only candidates discovered in this run; the store itself retains all history.
    toolsPending.splice(0, toolsPending.length, ...pending.cards.filter(card => keys.has(card.candidate_key)));
  }
  if (conceptsPending.length > 0) {
    const pending = await mergePending('concepts', conceptsPending, {
      conceptFile: options.pendingConceptFile,
      generatedAt: new Date().toISOString(),
      runId: 'tool-feedback',
    });
    const keys = new Set(conceptsPending.map(card => candidateKeyOf('concepts', card.term)));
    conceptsPending.splice(0, conceptsPending.length, ...pending.cards.filter(card => keys.has(card.candidate_key)));
  }

  return { toolsFound, toolsPending, conceptsFound, conceptsPending };
}

module.exports = {
  feedbackFromSummaries,
  extractEntities,
  extractEntitiesDefault,
  normalizeEntities,
  isVagueName,
  toolExists,
  conceptExists,
};
