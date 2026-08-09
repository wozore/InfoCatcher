/**
 * keyword-refine.js —— 关键词提纯候选（热点管线 v2 人工审核后收尾环节）
 *
 * 仅从候选层中 review_status === 'approved' 的原始 title、description、comments
 * 提取跨语言初始候选，再由 DeepSeek 批量完成语义筛选、同义归并和 English 规范化。
 * 产物只供维护者填写 adopted_keywords；本模块绝不直接修改 keywords.ai_keywords。
 * 清单文件名固定 keyword-refine.json（去掉日期后缀）；文件已存在时抛错拒绝覆盖，
 * 保留维护者的 adopted_keywords。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { writeJsonAtomic } = require('../core/news-storage');
const { readMinStore } = require('./min-store');
const { refineKeywordsWithDeepSeek } = require('../classify/llm-provider');
const { beijingDateKey } = require('../../shared/beijing-time');

const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was',
  'not', 'but', 'you', 'your', 'they', 'them', 'there', 'here', 'what', 'when',
  'where', 'which', 'will', 'would', 'could', 'should', 'into', 'about', 'their',
  'these', 'those', 'after', 'before', 'during', 'because', 'through', 'between',
  'news', 'video', 'tools', 'tool', 'open', 'used', 'use', 'using', 'like', 'make',
  'made', 'model', 'models', 'recent', 'still', 'over', 'also', 'very', 'just',
  'than', 'then', 'how', 'why', 'who', 'whom', 'what', 'via', 'out', 'all', 'its',
  'https', 'http', 'www', 'com', 'co', 'org', 'net', 'io', 'ai', 'tco', 'bit',
  'rt', 'amp', 'gif', 'jpg', 'png', 'webp', 'can', 'one', 'get', 'got', 'new', 'now',
  'may', 'much', 'many', 'well', 'way', 'even', 'first', 'last', 'next', 'best', 'good',
]);

const ZH_STOPWORDS = new Set([
  '一个', '一种', '一些', '这个', '那个', '这些', '那些', '我们', '你们', '他们', '它们',
  '以及', '或者', '但是', '因为', '所以', '如果', '虽然', '然后', '而且', '还有', '其中',
  '就是', '可以', '可能', '已经', '现在', '今天', '昨天', '明天', '目前', '进行', '什么',
  '怎么', '如何', '这样', '那样', '觉得', '感觉', '看到', '知道', '想要', '需要', '应该',
  '能够', '都会', '也有', '没有', '不是', '这么', '真的', '特别', '非常', '时候', '东西',
  '事情', '大家', '地方', '情况', '问题', '方法', '方面',
]);

const ZH_TERM_LEXICON = Object.freeze([
  '大模型', '模型', '人工智能', '机器学习', '深度学习', '神经网络', '推理', '推理能力',
  '多模态', '生成式', '大语言模型', '扩散模型', '强化学习', '训练', '微调', '量化',
  '智能体', '聊天机器人', '代码生成', '图像生成', '语音识别', '语义理解', '对话系统',
  '开源', '算力', '芯片', '数据', '算法', '架构', '上下文', '参数', '机器人',
  '自动驾驶', '数字人', '内容生成', '自动化', '效率', '成本', '产业', '应用场景',
]);

/** 把原文切成跨语言初始候选；保留重复次数供规则预筛选。 */
function tokenize(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  for (const match of lower.matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const word = match[0];
    if (!EN_STOPWORDS.has(word)) tokens.push(word);
  }
  const original = String(text || '');
  for (const term of ZH_TERM_LEXICON) {
    if (!ZH_STOPWORDS.has(term) && original.includes(term)) tokens.push(term);
  }
  return tokens;
}

/** 统计原始内容中的规则候选词频和来源候选 id。 */
function buildWordFreq(items) {
  const freq = new Map();
  for (const item of items || []) {
    const text = [
      item && item.title,
      item && item.description,
      Array.isArray(item && item.comments) ? item.comments.join('\n') : (item && item.comments) || '',
    ].filter(Boolean).join('\n');
    for (const word of tokenize(text)) {
      if (!freq.has(word)) freq.set(word, { count: 0, sources: new Set() });
      const stat = freq.get(word);
      stat.count += 1;
      if (item && item.id != null) stat.sources.add(String(item.id));
    }
  }
  return freq;
}

function rankByFrequency(freq) {
  return [...freq.entries()].sort((a, b) => {
    const countDiff = b[1].count - a[1].count;
    return countDiff || b[1].sources.size - a[1].sources.size || a[0].localeCompare(b[0]);
  });
}

/** 将规则候选转换为可直接交给 AI 的跨语言候选池。 */
function buildRuleCandidates(freq, existingKeywords, topN) {
  const existing = new Set((existingKeywords || []).map(word => String(word).trim().toLowerCase()));
  return rankByFrequency(freq)
    .filter(([word]) => !existing.has(String(word).toLowerCase()))
    .slice(0, topN)
    .map(([word, stat]) => ({ word, count: stat.count }));
}

/** 仅组装 approved 候选的顶层原文，明确不带 localizations。 */
function collectApprovedOriginals(store) {
  const candidates = store && Array.isArray(store.candidates) ? store.candidates : [];
  return candidates
    .filter(item => item && item.review_status === 'approved')
    .map(item => ({
      id: String(item.id || ''),
      title: String(item.title || ''),
      description: String(item.description || ''),
      comments: Array.isArray(item.comments) ? item.comments.map(String) : String(item.comments || ''),
    }));
}

/** 清单日期键（北京时间 YYYYMMDD）。 */
function dateKeyOf(input) {
  return beijingDateKey(input);
}

/**
 * 生成关键词提纯清单。AI 故障必须显式阻断，避免产生未经过 AI 的误导性产物。
 * @param {object} [store]
 * @param {object} [config]
 * @param {{store?: object, now?: Date|string|number, keywordExtractor?: Function, fetchImpl?: Function, apiKey?: string, timeoutMs?: number, model?: string}} [options]
 */
async function refineKeywords(store, config, options = {}) {
  const source = options.store ?? store ?? readMinStore();
  const keywords = (config && config.keywords) || {};
  const existingKeywords = Array.isArray(keywords.ai_keywords) ? keywords.ai_keywords : [];
  const ruleTopN = Number(keywords.refine_high_frequency_top_n) || 5;
  const manualFolder = (config && config.manual_folder) || 'data/manual';
  const approved = collectApprovedOriginals(source);
  const freq = buildWordFreq(approved);
  const ruleCandidates = buildRuleCandidates(freq, existingKeywords, ruleTopN);
  const extract = options.keywordExtractor || refineKeywordsWithDeepSeek;
  const result = await extract(approved, ruleCandidates, {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    model: options.model,
    existingKeywords,
  });
  if (!result || result.ok !== true) {
    throw new Error(`AI 关键词提取失败：${result && result.error ? result.error : '未知错误'}${result && result.code ? `（${result.code}）` : ''}`);
  }

  const date = dateKeyOf(options.now);
  const file = path.join(manualFolder, 'keyword-refine.json');
  if (fs.existsSync(file)) {
    throw new Error(`关键词提纯清单已存在：${file}。为保留维护者的 adopted_keywords，拒绝覆盖；请先处理现有清单。`);
  }
  const payload = {
    schema_version: 2,
    kind: 'keyword_refine_candidates',
    date,
    source_review_status: 'approved',
    candidates: result.keywords,
    adopted_keywords: [],
  };
  fs.mkdirSync(manualFolder, { recursive: true });
  writeJsonAtomic(file, payload, 'keyword-refine');
  return { candidates: result.keywords, file, approvedCount: approved.length, ruleCandidates };
}

module.exports = {
  tokenize,
  buildWordFreq,
  buildRuleCandidates,
  collectApprovedOriginals,
  dateKeyOf,
  refineKeywords,
};
