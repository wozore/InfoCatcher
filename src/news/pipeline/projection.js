/**
 * projection.js —— 公开热点投影、关联与去重层
 *
 * 在热点管线中的位置：为写出 hotspots.json 前的最终投影补充公开契约字段
 * （hot_score / evidence_excerpt / related_resources），构建溯源关系（provenance）、
 * 事件聚合（events）与内容去重（dedupeItems）。
 *
 * 模块边界：
 *   - 只依赖 feed-parser.js（normalizeUrl/hash）与 scoring.js（interactionValue/HEAT_DEFINITION）；
 *   - 惰性加载工具目录 URL 索引 / 标题匹配词表（一次构建只读一次）；
 *   - upgradeHotspotsProjection / migrateContentTypeProjection 为就地迁移工具。
 */

'use strict';

const fs = require('fs');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { normalizeUrl, hash } = require('./feed-parser');
const { NEWS_FILES, CATALOG_FILES } = require('../../shared/paths');
const { catalog } = require('../../catalog-interface');

const OUTPUT_PATH = NEWS_FILES.hotspots; // 前端热点投影（就地升级/迁移的目标文件）

// ── 互动量级换算（自 v1 scoring.js 内联，v2 保留给 computeHotScores 使用）──
/** 互动量级：对公开互动数据（浏览/点赞/评论/转发/回复）加权后取对数；无任何互动数据返回 null。 */
function interactionValue(item) {
  const metrics = item.metrics || {};
  const weights = { views: 0.02, likes: 1, comments: 2, reposts: 2, replies: 2 };
  let total = 0;
  let available = false;
  for (const [key, weight] of Object.entries(weights)) {
    if (Number.isFinite(metrics[key])) {
      available = true;
      total += metrics[key] * weight;
    }
  }
  return available ? Math.log10(total + 1) : null;
}

/** 热度定义文案（随 hotspots.json schema 记录，前端解释 hot_score 口径）。 */
const HEAT_DEFINITION = 'hot_score 表示条目在其来源平台内的相对互动量级（0–100），由公开互动数据（浏览/点赞/评论/转发）的加权对数指数按平台归一化得到；仅在平台内可比，跨平台不构成权威综合热度。无互动数据时为 null，前端按"最近"时间回退排序。';

// ═══════════════════════════════════════════════════════════════
// 公开热点数据契约补充（B16 决策 74/77/78/85/88/89）
// ═══════════════════════════════════════════════════════════════

/** 依据片段：取来源原文（描述优先，标题兜底）的受控节选；纯链接或空文本返回 null，不伪造原文。 */
function buildEvidenceExcerpt(item) {
  const raw = String(item.description || item.title || '').trim();
  if (!raw) return null;
  if (/^(?:https?:\/\/\S+\s*)+$/.test(raw)) return null; // 纯链接不能当作可定位依据片段
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const max = 160;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('.'), cut.lastIndexOf(' '), cut.lastIndexOf('?'), cut.lastIndexOf('!'));
  return (boundary > 60 ? cut.slice(0, boundary + 1) : cut).trim() + '…';
}

/** 工具目录规范 URL → 工具 的索引（用于精确身份匹配）。 */
function buildToolUrlIndex(toolData) {
  const index = new Map();
  for (const tool of toolData || []) {
    if (!tool || !tool.url) continue;
    const normalized = normalizeUrl(tool.url);
    if (normalized) index.set(normalized, tool);
  }
  return index;
}

/** 稳定关联 ID：仅当条目 URL 或显式链接与工具目录的规范 URL 完全一致时匹配，避免模糊匹配误关联。 */
function resolveRelatedResources(item, toolUrlIndex) {
  const resources = [];
  const seen = new Set();
  for (const raw of [item.url, ...(item.explicit_links || [])]) {
    const normalized = normalizeUrl(raw);
    if (!normalized) continue;
    const tool = toolUrlIndex.get(normalized);
    if (tool && !seen.has(tool.id)) {
      seen.add(tool.id);
      resources.push({ type: 'tool', id: tool.id, label: tool.name });
    }
  }
  return resources;
}

// ═══════════════════════════════════════════════════════════════
// B16-R7 词边界标题匹配（方案 A）：热点标题 ↔ 工具/概念/场景 name/aliases。
//
// 设计（用户 2026-08-05 拍板）：
//   - URL 精确身份匹配（决策 89）与标题词边界匹配为两个独立维度，合并输出；
//   - 标题匹配用于在 URL 匹配空转时兜底，命中工具/概念/场景稳定 ID；
//   - 词边界控制：英文/数字按 \b 边界（"ChatGPT"不命中"ChatGPTX"）；
//     中文按子串包含但要求前后非中文连续字符，避免"写作论文"误命中"写论文"；
//   - 纯泛词（长度过短、常见词）不进匹配词表，控制误报；
//   - 每热点标题匹配结果上限 RELATED_TITLE_MATCH_MAX 条，按 工具→概念→场景 优先级截断；
//   - 匹配结果确定性（同输入同输出），保证 upgrade 幂等。
// ═══════════════════════════════════════════════════════════════

/** 标题词边界匹配的单热点上限。 */
const RELATED_TITLE_MATCH_MAX = 3;

/** 不参与标题匹配的泛词（常见 AI 词/通用词，避免把普通话题误关联为工具）。 */
const RELATED_TITLE_STOPWORDS = new Set([
  'ai', '人工智能', '大模型', 'llm', 'gpt', '模型', '工具', '应用',
  '新闻', '动态', '发布', '更新', '来了', '上线', 'openai', 'deepseek',
  'video', 'photos', 'access', 'news',
]);

/**
 * 构造标题词边界匹配词表（工具 name / 概念 term+full_name / 场景 name+search_terms）。
 * 只收录可用于标题匹配的候选词，短词与泛词剔除；重复词去重。
 */
function buildRelatedTitleLexicon(toolData, glossaryData, scenesData) {
  const lexicon = []; // { text, type, id, label }
  const seenKey = new Set();
  // 工具名是明确品牌身份，不经过 stopword 过滤；概念 full_name / 场景名才做泛词过滤。
  const push = (text, type, id, label, skipStopword = false) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (t.length < 2) return;                 // 单字符太短，匹配噪声大
    if (/^\d+$/.test(t)) return;              // 纯数字不匹配
    if (!skipStopword && RELATED_TITLE_STOPWORDS.has(t.toLocaleLowerCase('zh-CN'))) return;
    const key = `${type}:${t.toLocaleLowerCase('zh-CN')}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    lexicon.push({ text: t, type, id, label });
  };
  for (const tool of toolData || []) {
    if (!tool || !tool.id || !tool.name) continue;
    // 工具名作为匹配词；带括号身份后缀（如“Mistral AI（产品入口）”）时，
    // 同时用剥离括号后的主体做匹配词；主体若含空格则再取第一个品牌 token
    //（标题通常写 Mistral 而非 Mistral AI）。label 统一保留原品牌名。
    const base = String(tool.name);
    const noSuffix = base.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
    const brandToken = noSuffix.split(/\s+/)[0];
    push(base, 'tool', tool.id, base, true);
    if (noSuffix && noSuffix !== base) push(noSuffix, 'tool', tool.id, base, true);
    if (brandToken && brandToken !== noSuffix) push(brandToken, 'tool', tool.id, base, true);
  }
  for (const concept of glossaryData || []) {
    if (!concept || !concept.term) continue;
    push(concept.term, 'concept', searchConceptKey(concept.term), concept.term);
    if (concept.full_name) push(concept.full_name, 'concept', searchConceptKey(concept.term), concept.term);
  }
  for (const scene of scenesData || []) {
    if (!scene || !scene.id || !scene.name) continue;
    // 只收场景 name（12 个核心场景名），不收 search_terms：
    // search_terms 是任务泛化词（如“研究/视频/代码”），用于标题匹配会大量误关联。
    push(scene.name, 'scene', scene.id, scene.name);
  }
  return lexicon;
}

/**
 * 中文子串 + 词边界命中判定。
 * - 含中文词：直接子串包含即命中（中文无空格分词，indexOf 已保证连续子串；
 *   "写作论文"不含连续子串"写论文"，天然不会误命中）；
 * - 纯 ASCII 词：要求两侧为非字母/数字，避免 "ChatGPTX" 误命中 "ChatGPT"。
 */
function titleContainsKeyword(title, keyword) {
  const text = String(title || '');
  const kw = String(keyword || '');
  if (!text || !kw) return false;
  let index = 0;
  while ((index = text.indexOf(kw, index)) !== -1) {
    const before = text[index - 1];
    const after = text[index + kw.length];
    if (/[一-鿿]/.test(kw)) {
      // 中文词：连续子串已出现即命中（不需要额外词边界）
      return true;
    } else {
      // ASCII 词：词边界（前后非字母/数字）
      const isBoundary = (ch) => ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
      if (isBoundary(before) && isBoundary(after)) return true;
    }
    index += kw.length;
  }
  return false;
}

/**
 * 标题词边界匹配：对热点标题匹配工具/概念/场景，输出稳定关联条目。
 * lexicon 可用 buildRelatedTitleLexicon 预构建；结果为确定性、无重复、上限截断。
 */
function matchRelatedByTitle(item, lexicon) {
  const title = String(item?.title || '');
  if (!title) return [];
  const hits = [];
  const seen = new Set();
  const priority = { tool: 0, concept: 1, scene: 2 };
  for (const entry of lexicon) {
    if (hits.length >= RELATED_TITLE_MATCH_MAX) break;
    if (!titleContainsKeyword(title, entry.text)) continue;
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ type: entry.type, id: entry.id, label: entry.label });
  }
  // 若命中超上限，按优先级截断并稳定（lexicon 顺序本身按工具→概念→场景分组）
  return hits.slice(0, RELATED_TITLE_MATCH_MAX).sort((a, b) => priority[a.type] - priority[b.type]);
}

/**
 * 概念稳定 ID 适配层（ADR-007）：与前端 app.js searchConceptKey 同构，
 * 保证前后端对同一概念生成相同的稳定 ID。glossary 无独立 id 字段，
 * 由 term 规范化派生（concept-<term>）。
 */
function searchConceptKey(term) {
  const normalizedTerm = String(term || '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalizedTerm ? 'concept-' + normalizedTerm : 'concept-unknown';
}

let cachedRelatedLexicon = null;
/** 惰性构建标题匹配词表（一次构建只读一次；读取失败时降级为空词表）。 */
function getRelatedLexicon() {
  if (cachedRelatedLexicon === null) {
    const toolResult = catalog({ area: 'tool-card', operation: 'list' });
    const vendorResult = catalog({ area: 'vendor-card', operation: 'list' });
    const toolCards = toolResult.ok ? toolResult.data : [];
    const vendorCards = vendorResult.ok ? vendorResult.data : [];
    const tools = [
      ...vendorCards.map(item => ({ id: item.vendor_key, name: item.title, vendor: item.title, url: item.official_url })),
      ...toolCards.map(item => ({ id: item.tool_key, name: item.title, vendor: item.vendor_label, url: '' })),
    ];
    let glossary = [], scenes = [];
    try { glossary = readJson(CATALOG_FILES.glossary, []); } catch { glossary = []; }
    try {
      const scenesData = readJson(CATALOG_FILES.scenes, { scenes: [] });
      scenes = Array.isArray(scenesData) ? scenesData : (scenesData.scenes || []);
    } catch { scenes = []; }
    cachedRelatedLexicon = buildRelatedTitleLexicon(tools, glossary, scenes);
  }
  return cachedRelatedLexicon;
}

/** 热度：对同一平台内的条目按互动量级归一化到 0–100；无互动数据为 null。 */
function computeHotScores(items) {
  const byPlatform = new Map();
  for (const item of items) {
    if (!byPlatform.has(item.platform)) byPlatform.set(item.platform, []);
    byPlatform.get(item.platform).push(item);
  }
  for (const platformItems of byPlatform.values()) {
    const indexed = platformItems.map(item => ({ item, value: interactionValue(item) }));
    const present = indexed.filter(entry => entry.value !== null).map(entry => entry.value);
    if (!present.length) {
      indexed.forEach(entry => { entry.item.hot_score = null; });
      continue;
    }
    const min = Math.min(...present);
    const max = Math.max(...present);
    const range = max - min;
    indexed.forEach(entry => {
      entry.item.hot_score = entry.value === null
        ? null
        : range > 0 ? Math.round(((entry.value - min) / range) * 100) : 50;
    });
  }
}

let cachedToolUrlIndex = null;
/** 惰性加载工具目录 URL 索引（一次构建只读一次；读取失败时降级为空索引）。 */
function getToolUrlIndex() {
  if (cachedToolUrlIndex === null) {
    const result = catalog({ area: 'tool-card', operation: 'list' });
    const tools = result.ok ? result.data.map(item => ({
      id: item.tool_key,
      name: item.title,
      vendor: item.vendor_label,
      url: item.url || '',
    })) : [];
    cachedToolUrlIndex = buildToolUrlIndex(tools);
  }
  return cachedToolUrlIndex;
}

/**
 * 对一条热点投影的整体 items 应用公开契约补充（热度/依据片段/稳定关联）。
 * toolUrlIndex 可注入（测试用）；缺省时使用工具目录的规范 URL 索引。
 * 对同一批 items 重复调用保持幂等（各字段由现有公开字段确定性推导）。
 */
function enrichHotspotProjection(items, toolUrlIndex = null, relatedLexicon = null) {
  computeHotScores(items);
  const index = toolUrlIndex || getToolUrlIndex();
  const lexicon = relatedLexicon || getRelatedLexicon();
  for (const item of items) {
    item.evidence_excerpt = buildEvidenceExcerpt(item);
    // URL 精确身份匹配 + 标题词边界匹配（B16-R7 方案 A），合并去重、确定性、上限截断。
    const urlMatches = resolveRelatedResources(item, index);
    const titleMatches = matchRelatedByTitle(item, lexicon);
    const merged = [];
    const seen = new Set();
    for (const resource of [...urlMatches, ...titleMatches]) {
      const key = `${resource.type}:${resource.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(resource);
    }
    item.related_resources = merged.slice(0, RELATED_TITLE_MATCH_MAX);
  }
  return items;
}

/** 就地升级现有 hotspots.json 的公开投影（无需 API secrets，供开发/数据契约补齐使用）。 */
function upgradeHotspotsProjection() {
  const data = readJson(OUTPUT_PATH, null);
  if (!data || !Array.isArray(data.items)) throw new Error('--upgrade-hotspots：无法读取现有 hotspots.json');
  enrichHotspotProjection(data.items, getToolUrlIndex(), getRelatedLexicon());
  data.schema_version = 2;
  data.heat_definition = HEAT_DEFINITION;
  writeJsonAtomic(OUTPUT_PATH, data, `upgrade-${Date.now()}`);
  const filled = (data.items || []).filter(item => Array.isArray(item.related_resources) && item.related_resources.length).length;
  console.log(`✅ hotspots.json 公开投影已升级：${data.items.length} 条内容（schema_version=${data.schema_version}；新增 hot_score/evidence_excerpt/related_resources；词边界标题匹配填充 ${filled} 条）`);
}

// B16 决策 65：内容类型枚举（决策 65 六类 + unclassified 占位）。
const CONTENT_TYPE_VALUES = new Set([
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified'
]);

/**
 * 就地迁移现有 hotspots.json（B16 决策 65/66，路径 B）：
 *   - 旧 content_type（来源媒体类型，如 x_post/youtube_video）→ 移到 source_type；
 *   - content_type 统一置 unclassified + content_type_status=unclassified（AI 分类+审核确认未上线前的诚实占位）；
 *   - schema_version 2 → 3（content_type 语义变化）。
 * 幂等：source_type 已存在或 content_type 已是内容类型时不做重复迁移。
 */
function migrateContentTypeProjection() {
  const data = readJson(OUTPUT_PATH, null);
  if (!data || !Array.isArray(data.items)) throw new Error('--migrate-content-type：无法读取现有 hotspots.json');
  let changed = 0;
  for (const item of data.items) {
    if (!item.source_type && item.content_type && !CONTENT_TYPE_VALUES.has(item.content_type)) {
      item.source_type = item.content_type;
      item.content_type = 'unclassified';
      item.content_type_status = 'unclassified';
      changed += 1;
    } else if (!item.source_type) {
      // content_type 缺失或已是内容类型但无来源媒体类型 → source_type 置 unknown
      item.source_type = 'unknown';
      changed += 1;
    }
  }
  data.schema_version = 3;
  writeJsonAtomic(OUTPUT_PATH, data, `migrate-content-type-${Date.now()}`);
  console.log(`✅ hotspots.json 内容类型字段已迁移：${changed} 条调整，content_type 统一置 unclassified（schema_version=${data.schema_version}）`);
}

// ═══════════════════════════════════════════════════════════════
// 内容去重
//
// 去重（dedupeItems）：按 platform:native_id 去重（与 registry 主键一致，N-P6 确认，
//   2026-08-05）。跨平台重复观察由 v1 buildProvenance 以 duplicate_observation/repost
//   溯源保留，不在此合并（B16 决策 46/47：保留各自观点）；v2 主链（pipeline-min）
//   只调用 dedupeItems，不构建溯源/事件聚合（热点视图 v2 schema 不再消费 provenance/events）。
//   保留先出现的条目。
//   历史：此处注释曾宣称「按 url + title 组合去重」，与实现不符且语义错误——
//   url+title 会误合并跨平台同标题内容与同平台同标题不同视频。真实数据（候选层/registry）
//   两种键零差异，故保留实现、修正注释。
// ═══════════════════════════════════════════════════════════════

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.platform}:${item.native_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  buildEvidenceExcerpt,
  buildToolUrlIndex,
  resolveRelatedResources,
  buildRelatedTitleLexicon,
  titleContainsKeyword,
  matchRelatedByTitle,
  searchConceptKey,
  computeHotScores,
  enrichHotspotProjection,
  upgradeHotspotsProjection,
  migrateContentTypeProjection,
  dedupeItems,
  getRelatedLexicon,
  getToolUrlIndex,
};
