/**
 * keyword-refine.js —— 关键词提纯候选（热点管线 v2 收尾环节，每天固定一次）
 *
 * 在热点管线 v2 中的位置：收尾环节之一，与 transcript-notify / tool-feedback 并列，
 * **独立于主链、互相不依赖**。从候选层（非 discarded 条目原文）提炼关键词候选，
 * 输出"关键词提纯候选"清单，**交人工确认** —— 本模块**不直接改 ai_keywords**。
 *
 * 原材料 = 候选层里 review_status !== 'discarded' 的条目原文（title+description+comments）。
 *
 * 两种候选：
 *   1. 高频候选（high_frequency）：词频统计（英文单词 tokenize + 中文 2 字以上片段，
 *      剔除 config.keywords.ai_keywords 已有词），取出现最多前 refine_high_frequency_top_n（5）个。
 *   2. 新兴候选（emerging）：options.refineEmerging 注入函数（缺省用 ai_keywords 历史比对：
 *      词不在当前 ai_keywords 且原文出现 → 候选）。AI 语义判断可后续接 llm，
 *      options.llmRefine 注入。
 *
 * 配置（news-config-v2.json keywords）：
 *   - ai_keywords                   现有关键词表（剔除 + 比对基准）
 *   - refine_high_frequency_top_n   高频候选取前 N（缺省 5）
 *
 * 数据文件（manual_folder/）：
 *   keyword-refine-<YYYYMMDD>.json  关键词提纯候选清单（含来源/频率/为何值得收）
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { writeJsonAtomic } = require('../core/news-storage');
const { readMinStore } = require('./min-store');

// ═══════════════════════════════════════════════════════════════
// 词频统计（纯函数）
// ═══════════════════════════════════════════════════════════════

// 英文停用词（低频噪声过滤，只做基本过滤，精确性由人工确认兜底）
const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was',
  'not', 'but', 'you', 'your', 'they', 'them', 'there', 'here', 'what', 'when',
  'where', 'which', 'will', 'would', 'could', 'should', 'into', 'about', 'their',
  'these', 'those', 'after', 'before', 'during', 'because', 'through', 'between',
  'news', 'video', 'tools', 'tool', 'open', 'used', 'use', 'using', 'like', 'make',
  'made', 'model', 'models', 'recent', 'still', 'over', 'also', 'very', 'just',
  'than', 'then', 'how', 'why', 'who', 'whom', 'what', 'via', 'out', 'all', 'its',
  // URL 与网络噪声（2026-08-08 真实数据暴露：推文里的 https/co 等被当单词切出）
  'https', 'http', 'www', 'com', 'co', 'org', 'net', 'io', 'ai', 'tco', 'bit',
  'the', 'rt', 'amp', 'via', 'gif', 'jpg', 'png', 'webp',
  // 高频虚词（真实数据暴露：can/one 等无提纯价值）
  'can', 'one', 'get', 'got', 'new', 'now', 'may', 'much', 'many', 'well', 'way',
  'also', 'even', 'first', 'last', 'next', 'best', 'good', 'like', 'will', 'would',
]);

// 中文停用词（2026-08-08 真实数据暴露：重叠子串切出大量无意义虚词）
const ZH_STOPWORDS = new Set([
  '一个', '一种', '一些', '这个', '那个', '这些', '那些', '我们', '你们', '他们', '它们',
  '以及', '或者', '但是', '因为', '所以', '如果', '虽然', '然后', '而且', '还有', '其中',
  '就是', '可以', '可能', '已经', '现在', '今天', '昨天', '明天', '目前', '进行', '什么',
  '怎么', '如何', '这样', '那样', '觉得', '感觉', '看到', '知道', '想要', '需要', '应该',
  '能够', '都会', '也有', '没有', '不是', '但是', '什么', '这么', '真的', '特别', '非常',
  '这个', '时候', '东西', '事情', '大家', '地方', '情况', '问题', '方法', '方面', '因为',
]);

// 中文 2 字以上片段提取：遍历连续中文字符串，取所有长度 ≥2 的连续子串
// （去重后加入，避免同一词重复计数）。
const CJK_RE = /[一-鿿]+/g;

// 已知中文 AI 术语词表（tokenize 的中文匹配基准）：
// 无分词器时无法可靠确定中文词边界，重叠子串会产生碎片/整句噪声；
// 改为只在词表中做子串匹配。词表 = 常见 AI 术语，超出词表的中文新词
// 由新兴候选的 AI 语义判断（refineEmerging / llmRefine）兜底。
const ZH_TERM_LEXICON = Object.freeze([
  // 模型/技术
  '大模型', '模型', '人工智能', '机器学习', '深度学习', '神经网络', '推理', '推理能力',
  '多模态', '生成式', '大语言模型', '扩散模型', '强化学习', '训练', '微调', '量化',
  // 产品/工具
  '智能体', '聊天机器人', '代码生成', '图像生成', '语音识别', '语义理解', '对话系统',
  // 行业/概念
  '开源', '算力', '芯片', '数据', '算法', '架构', '上下文', '参数', '机器人',
  '自动驾驶', '数字人', '内容生成', '自动化', '效率', '成本', '产业', '应用场景',
]);

/**
 * 把一段原文切成候选词（英文单词小写 + 中文 2 字以上片段），**保留重复出现次数**，
 * 供词频统计累计（单条内反复出现的词也能体现高频）。
 * 过滤：URL 协议词（https/http/www）与英文/中文停用词剔除，降低噪声候选。
 * 中文：只从**已知词表**（ai_keywords + 常见 AI 术语）中做子串匹配，避免重叠子串
 * 把整句当词、产生碎片（无分词器时无法确定词边界，字面重叠不可靠）。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  // 英文单词
  for (const match of lower.matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const word = match[0];
    if (!EN_STOPWORDS.has(word)) tokens.push(word);
  }
  // 中文：已知词表子串匹配（ai_keywords + 常见 AI 术语，去重）
  const cjkText = String(text || '');
  for (const term of ZH_TERM_LEXICON) {
    if (cjkText.includes(term)) tokens.push(term);
  }
  return tokens;
}

/**
 * 统计原材料词频：{ word: { count: 总出现次数, sources: Set<itemId> } }。
 * count 为所有原文中的总出现次数（不按条去重），保证单条内反复出现的词
 * 也能体现高频；sources 记录分布在几条候选（供"为何值得收"参考）。
 * @param {Array<{id,title,description,comments}>} items
 * @returns {Map<string, { count: number, sources: Set<string> }>}
 */
function buildWordFreq(items) {
  const freq = new Map();
  for (const item of items) {
    const text = [
      item && item.title,
      item && item.description,
      Array.isArray(item && item.comments) ? item.comments.join('\n') : (item && item.comments) || '',
    ].filter(Boolean).join('\n');
    const words = tokenize(text);
    for (const word of words) {
      if (!freq.has(word)) freq.set(word, { count: 0, sources: new Set() });
      freq.get(word).count += 1;
      if (item && item.id != null) freq.get(word).sources.add(String(item.id));
    }
  }
  return freq;
}

/** 按出现次数降序 + 来源数降序排序。 */
function rankByFrequency(freq) {
  return [...freq.entries()].sort((a, b) => {
    const diff = b[1].count - a[1].count;
    if (diff !== 0) return diff;
    return b[1].sources.size - a[1].sources.size;
  });
}

// ═══════════════════════════════════════════════════════════════
// 新兴候选默认实现（ai_keywords 历史比对）
// ═══════════════════════════════════════════════════════════════

/**
 * 缺省新兴候选：词不在当前 ai_keywords 且原文出现 → 候选。
 * 取原文中出现（词频 > 0）且不在 ai_keywords 的词，按出现次数取前 N。
 * @param {Map} freq
 * @param {string[]} existingKeywords
 * @param {number} topN
 * @returns {Array<{word, count, sources}>}
 */
function emergingByHistory(freq, existingKeywords, topN) {
  const exclude = new Set((existingKeywords || []).map(word => String(word).toLowerCase()));
  const candidates = [];
  for (const [word, stat] of freq) {
    if (!exclude.has(word.toLowerCase())) {
      candidates.push({ word, ...stat });
    }
  }
  candidates.sort((a, b) => b.count - a.count || b.sources.size - a.sources.size);
  return candidates.slice(0, topN);
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

/** 文件名日期键（本地时区 YYYYMMDD）。 */
function dateKeyOf(input) {
  const d = input == null || !Number.isFinite(new Date(input).getTime()) ? new Date() : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 组装候选清单条目（含来源/频率/为何值得收，供人工确认）。 */
function toCandidateEntry(candidate, source) {
  const reasons = {
    high_frequency: `高频出现：原文出现 ${candidate.count} 次，分布在 ${candidate.sources.size} 条候选`,
    emerging: '新兴词：不在现有 ai_keywords，且近期候选原文中出现（建议 AI 语义复核后确认）',
  };
  return {
    word: candidate.word,
    source,
    frequency: candidate.count,
    source_count: candidate.sources.size,
    why: reasons[source],
    example_ids: [...candidate.sources].slice(0, 3),
  };
}

/**
 * 关键词提纯候选生成（交人工确认，不直接改 ai_keywords）。
 *
 * @param {object} [store]  min-store 全文（读 store.candidates）；options.store 优先
 * @param {object} [config] news-config-v2.json（读 keywords / manual_folder）
 * @param {object} [options] { store?, now?, refineEmerging?, llmRefine? }
 *   - store          候选层覆盖（缺省 store 入参 → 缺省 readMinStore()）
 *   - now            清单日期参考（缺省当天）
 *   - refineEmerging 新兴候选注入函数 (freq, existingKeywords, topN) => Array<{word,count,sources}>；
 *                    缺省用 ai_keywords 历史比对
 *   - llmRefine      可选 AI 语义判断注入函数（可对 emerging 候选做筛选/打标）
 * @returns {Promise<{
 *   highFreqCandidates: Array<{word, source, frequency, source_count, why, example_ids}>,
 *   emergingCandidates: Array<{word, source, frequency, source_count, why, example_ids}>,
 *   file: string,
 * }>}
 */
async function refineKeywords(store, config, options = {}) {
  const source = options.store ?? store ?? readMinStore();
  const keywords = (config && config.keywords) || {};
  const existingKeywords = keywords.ai_keywords || [];
  const topN = Number(keywords.refine_high_frequency_top_n) || 5;
  const manualFolder = (config && config.manual_folder) || 'data/manual';

  // 1. 原材料 = 非 discarded 候选原文
  const items = (source && Array.isArray(source.candidates) ? source.candidates : [])
    .filter(item => item && item.review_status !== 'discarded');

  // 2. 高频候选：词频统计 → 剔除已有 ai_keywords → 取前 topN
  const freq = buildWordFreq(items);
  const exclude = new Set(existingKeywords.map(word => String(word).toLowerCase()));
  const highFreqRaw = rankByFrequency(freq)
    .filter(([word]) => !exclude.has(word.toLowerCase()))
    .slice(0, topN)
    .map(([word, stat]) => ({ word, ...stat }));
  const highFreqCandidates = highFreqRaw.map(candidate => toCandidateEntry(candidate, 'high_frequency'));

  // 3. 新兴候选：注入函数或缺省历史比对；可选 llmRefine AI 语义判断
  let emergingRaw;
  if (typeof options.refineEmerging === 'function') {
    emergingRaw = await options.refineEmerging(freq, existingKeywords, topN);
  } else {
    emergingRaw = emergingByHistory(freq, existingKeywords, topN);
  }
  if (typeof options.llmRefine === 'function') {
    emergingRaw = (await options.llmRefine(emergingRaw, { existingKeywords })) || emergingRaw;
  }
  const emergingCandidates = (emergingRaw || []).map(candidate =>
    toCandidateEntry({ ...candidate }, 'emerging')
  );

  // 4. 写"关键词提纯候选"清单（交人工确认）
  const dateKey = dateKeyOf(options && options.now);
  const file = path.join(manualFolder, `keyword-refine-${dateKey}.json`);
  const payload = {
    schema_version: 1,
    kind: 'keyword_refine_candidates',
    generated_at: new Date().toISOString(),
    date: dateKey,
    note: '本清单为候选，请人工确认后才更新 keywords.ai_keywords；本模块不直接改 ai_keywords。',
    existing_keywords: existingKeywords,
    high_frequency_candidates: highFreqCandidates,
    emerging_candidates: emergingCandidates,
  };

  fs.mkdirSync(manualFolder, { recursive: true });
  writeJsonAtomic(file, payload, 'keyword-refine');

  return { highFreqCandidates, emergingCandidates, file };
}

module.exports = { refineKeywords, tokenize, buildWordFreq, emergingByHistory, dateKeyOf };
