/**
 * projection.js —— 公开热点投影、关联与去重层
 *
 * 在热点管线中的位置：为写出 hotspots.json 前的最终投影补充公开契约字段
 * （hot_score / evidence_excerpt / related_resources）与内容去重（dedupeItems）。
 *
 * 模块边界：
 *   - 只依赖 feed-parser.js（normalizeUrl）与本地 interactionValue；
 *   - 工具目录/概念/场景数据一律经 catalogApi 注入（组合根构造），本模块不做任何
 *     目录文件直读；enrichHotspotProjection 未注入 index/lexicon 时按空词典处理。
 */

'use strict';

const { normalizeUrl } = require('./feed-parser');

/** 生成空投影输入（未注入 catalogApi 时的降级值，等价目录读失败）。 */
function emptyProjectionInputs() {
  return { toolUrlIndex: new Map(), relatedLexicon: [] };
}

/**
 * 由注入的 catalogApi 构建投影输入（工具 URL 索引 + 标题匹配词表）。
 * @param {object} catalogApi 组合根注入的目录查询集
 *   { listToolCards, listVendorCards, readGlossary, readScenes }
 */
function buildProjectionInputs(catalogApi) {
  if (!catalogApi) return emptyProjectionInputs();
  const toolResult = catalogApi.listToolCards ? catalogApi.listToolCards() : [];
  const vendorResult = catalogApi.listVendorCards ? catalogApi.listVendorCards() : [];
  const tools = [
    ...vendorResult.map(item => ({ id: item.vendor_key, name: item.title, vendor: item.title, url: item.official_url })),
    ...toolResult.map(item => ({ id: item.tool_key, name: item.title, vendor: item.vendor_label, url: '' })),
  ];
  const glossary = catalogApi.readGlossary ? catalogApi.readGlossary() : [];
  const scenes = catalogApi.readScenes ? catalogApi.readScenes() : [];
  return {
    toolUrlIndex: buildToolUrlIndex(toolResult.map(item => ({
      id: item.tool_key,
      name: item.title,
      vendor: item.vendor_label,
      url: item.url || '',
    }))),
    relatedLexicon: buildRelatedTitleLexicon(tools, glossary, scenes),
  };
}

// ── 互动量级换算 ──
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
 * 概念稳定 ID 适配层（ADR-007）：与前端 searchConceptKey 同构，
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

/**
 * 对一条热点投影的整体 items 应用公开契约补充（热度/依据片段/稳定关联）。
 * toolUrlIndex / relatedLexicon 由调用方注入（buildProjectionInputs 构建；
 * 未注入时按空词典处理，仅补热度与依据片段）。对同一批 items 重复调用保持幂等。
 */
function enrichHotspotProjection(items, toolUrlIndex = null, relatedLexicon = null) {
  computeHotScores(items);
  const index = toolUrlIndex || new Map();
  const lexicon = relatedLexicon || [];
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

// ═══════════════════════════════════════════════════════════════
// 内容去重
//
// dedupeItems 按 platform:native_id 去重（与 registry 主键一致，N-P6 确认，
//   2026-08-05）。跨平台重复观察保留各自条目（B16 决策 46/47：保留各自观点）；
//   v2 主链（pipeline-min）只调用 dedupeItems，不构建溯源/事件聚合
//   （热点视图 v2 schema 不消费 provenance/events）。保留先出现的条目。
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
  buildProjectionInputs,
  buildEvidenceExcerpt,
  buildToolUrlIndex,
  resolveRelatedResources,
  buildRelatedTitleLexicon,
  titleContainsKeyword,
  matchRelatedByTitle,
  searchConceptKey,
  computeHotScores,
  enrichHotspotProjection,
  dedupeItems,
};
