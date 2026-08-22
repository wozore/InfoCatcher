/**
 * InfoCatcher — 模型对比（compare-models）：读 data/comparison/integrated/
 *
 * 数据契约唯一事实源：docs/manual/comparison-data-contract.md。
 * 本模块只消费 integrated/index.json（选择器）+ integrated/data.json（懒加载）+
 * view-config.json（展示配置）+ models-alias.json（标题→canonical 桥接兜底）。
 *
 * 功能：
 *   - 模型选择器（搜索 / theme 类别筛选 / 综合分排序，单源模型标「仅 X 源」）
 *   - 已选 chips（上限 model_cap）；点模型 icon → 变体圆圈（360° 平分，顺时针）
 *   - 维度实时渲染（默认仅勾选综合栏：综合分 + 性价比）：无选择显示各维度 Top N 排行；
 *     选择后图块实时收敛到「所有已选模型都有数据」的维度（缺任一即不显示，无「数据不足」噪声）；
 *     勾选面板同步收敛——选择模型后仅公开所选模型共有且不缺省的维度，未公开维度强制不勾选
 *   - 柱状图 ↔ 雷达图 toggle（柱状图 = 竖柱状图：每模型一簇、簇内各维度柱相连无缝、柱顶标真实值、
 *     右上角图例；每维度统一满高——该维度图表内最大值顶到满高，其余按比例量化；
 *     雷达仅 2 模型、维度 ≤ radar_dimension_cap；图表（柱状图/雷达图）与表格视图均放开页面限宽）
 *   - 表格视图（独立，license/open_source/vendor/modalities/is_moe/context/pricing）
 *   - 每图块右对齐来源 footer（平台名 + 许可证 + 链接；OpenRouter 标挂牌参考价）
 *   - 路由桥接：catalog api_model +对比 → 标题→canonical（tool_key → slug → display → alias）
 *
 * 安全：所有外部字段渲染走 escapeHtml；前端只显示归一化 value，不显示 raw。
 */

import { escapeHtml, safeExternalUrl, renderState } from './data.js';
import { t } from './i18n.js';
import { getToolCardItems, getToolLevel3Item } from './data.js';
import { brandIconHtml } from './brand-icons.js';

// ═══════════════════════════════════════════════════════════════
// 源元数据（平台名 + 许可证 + 链接；许可证仅知名可再分发源填，其余留空）
// ═══════════════════════════════════════════════════════════════
const SOURCE_META = {
  openrouter: { label: 'OpenRouter', license: null, url: 'https://openrouter.ai/models', listed: true },
  lmarena: { label: 'LMArena', license: 'CC BY 4.0', url: 'https://arena.ai/leaderboard/agent' },
  livebench: { label: 'LiveBench', license: 'Apache-2.0 / MIT', url: 'https://livebench.ai/' },
  llm_stats: { label: 'LLM Stats', license: null, url: 'https://llm-stats.com/leaderboards/open-llm-leaderboard' },
};
const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

// ═══════════════════════════════════════════════════════════════
// 维度调色板（勾选面板展示顺序；标签走 i18n compare.dimension.<key>）
// ═══════════════════════════════════════════════════════════════
const DIM_GROUPS = [
  { key: 'composite', dims: ['composite', 'value'] },
  { key: 'merged', dims: ['reasoning', 'coding', 'communication', 'instruction_following', 'agentic_coding', 'tool_calling', 'long_context'] },
  { key: 'benchmark', dims: ['expert_knowledge', 'math_reasoning', 'multimodal', 'swe_capability'] },
  { key: 'pro', dims: ['finance', 'legal', 'healthcare'] },
  { key: 'lmarena', dims: ['text', 'vision', 'webdev', 'search', 'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit'] },
  { key: 'agent', dims: ['agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit'] },
];

// 全量维度（浏览态可全部勾选；默认勾选由 view-config.default_dimensions 决定；
// 选择模型后勾选面板收敛到所选模型共有维度，未公开维度强制不勾选）
const ALL_DIMS = DIM_GROUPS.flatMap(group => group.dims);

// 维度调色板（按维度稳定取色：同一维度跨模型同色，图例与柱色共用；暖白浅色主题下可读）
const DIM_PALETTE = [
  '#4a6fa5', '#c05621', '#2f7d6b', '#9c3d54', '#7a6bb5', '#b8860b',
  '#3d7a4f', '#a85a32', '#456d91', '#8a5a9e', '#5d7a3a', '#b04a5a',
];
function dimColor(dim) {
  const index = ALL_DIMS.indexOf(dim);
  return DIM_PALETTE[(index >= 0 ? index : 0) % DIM_PALETTE.length];
}
// 无选择浏览态：每维度 Top N 排行
const BROWSE_TOP_N = 10;

const VENDOR_ICONS = {
  openai: '🤖', anthropic: '✦', google: '✨', meta: '🦙', deepseek: '🐋',
  qwen: '🐉', mistral: '🌀', moonshot: '🌙', midjourney: '🎨', xai: '🕳️', glm: '🧊',
};
const THEME_ICONS = { vision: '🎨', media: '🎬', dev: '💻', general: '🧠' };

// ═══════════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════════
let viewConfig = null;
let indexData = null;
let indexModels = [];
let indexSeries = [];
let indexMap = new Map();
let dataMap = new Map();
let aliasEntries = [];
let comparisonReady = false;
let comparisonFailed = false;

let selected = [];              // canonical id 列表（≤ model_cap）
let activeDims = [];
let viewMode = 'chart';         // 'chart' | 'table'
let chartMode = 'bar';          // 'bar' | 'radar'
let activeVariants = {};        // canonical → { source: degree }
let variantOpenFor = null;
let searchQuery = '';
let filterTheme = 'all';
let expandedSeries = new Set();

const loadingPromise = loadEntry();

async function loadEntry() {
  try {
    const [viewResp, indexResp, aliasResp] = await Promise.all([
      fetch('data/comparison/view-config.json'),
      fetch('data/comparison/integrated/index.json'),
      fetch('data/comparison/models-alias.json'),
    ]);
    if (!viewResp.ok) throw new Error('view-config HTTP ' + viewResp.status);
    if (!indexResp.ok) throw new Error('index HTTP ' + indexResp.status);
    if (!aliasResp.ok) throw new Error('models-alias HTTP ' + aliasResp.status);
    viewConfig = await viewResp.json();
    indexData = await indexResp.json();
    const aliasPayload = await aliasResp.json();
    aliasEntries = Array.isArray(aliasPayload.entries) ? aliasPayload.entries : [];
    indexModels = Array.isArray(indexData.models) ? indexData.models : [];
    indexSeries = Array.isArray(indexData.series) ? indexData.series : buildFallbackSeries(indexModels);
    indexMap = new Map(indexModels.map(model => [model.canonical, model]));
    // 默认勾选来自 view-config（当前仅综合栏：综合分 + 性价比）；其余维度浏览态可手动勾选
    activeDims = Array.isArray(viewConfig.default_dimensions) && viewConfig.default_dimensions.length
      ? [...viewConfig.default_dimensions]
      : [...ALL_DIMS];
    comparisonReady = true;
  } catch (error) {
    comparisonFailed = true;
    console.warn('模型对比数据加载失败:', error.message);
  }
  // 若对比视图已激活（如启动即导航过来），加载完成后补渲染。
  if (typeof document !== 'undefined' && document.getElementById('view-compare')?.classList.contains('active')) {
    renderModelCompare();
  }
}

function buildFallbackSeries(models) {
  const groups = new Map();
  for (const model of models || []) {
    const key = model.series_key || `${model.vendor || 'unknown'}--${model.family || model.identity || model.canonical}`;
    const group = groups.get(key) || { series_key: key, display: model.series_display || model.family || model.display, vendor: model.vendor, theme: model.theme, member_count: 0, model_count: 0, max_composite_score: null, members: [] };
    const memberKey = model.member_key || model.canonical;
    let member = group.members.find(item => item.member_key === memberKey);
    if (!member) {
      member = { member_key: memberKey, display: model.member_display || model.display, order: model.member_order || 9999, default_canonical: model.canonical, variant_count: 0, variants: [] };
      group.members.push(member);
    }
    member.variant_count += 1;
    member.variants.push({ canonical: model.canonical, display: model.display, revision: (model.revisions || []).join(', ') || null, composite_score: model.composite_score ?? null, sources: model.sources || [] });
    group.model_count += 1;
    group.max_composite_score = Math.max(group.max_composite_score ?? -Infinity, model.composite_score ?? -Infinity);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.member_count = group.members.length;
    for (const member of group.members) member.variants.sort((a, b) => (a.revision ? 1 : -1) - (b.revision ? 1 : -1));
  }
  return [...groups.values()];
}


let dataLoading = null;
function ensureData() {
  if (dataMap.size || comparisonFailed) return Promise.resolve();
  if (dataLoading) return dataLoading;
  dataLoading = fetch('data/comparison/integrated/data.json')
    .then(response => {
      if (!response.ok) throw new Error('data HTTP ' + response.status);
      return response.json();
    })
    .then(payload => {
      (Array.isArray(payload.models) ? payload.models : []).forEach(model => dataMap.set(model.canonical, model));
    })
    .catch(error => {
      console.warn('模型对比完整数据加载失败:', error.message);
      comparisonFailed = true;
    });
  return dataLoading;
}

function getModelData(canonical) {
  return dataMap.get(canonical) || null;
}

// ═══════════════════════════════════════════════════════════════
// 路由桥接：catalog api_model 标题/tool_key → canonical（契约 §8）
// ═══════════════════════════════════════════════════════════════
function slugifyModelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-') // 保留点号（gpt-5.6-sol）与 canonical 对齐
    .replace(/^-+|-+$/g, '');
}

function catalogAliasCanonicalFor(toolKey, title) {
  const needles = [toolKey, slugifyModelName(title), String(title || '').trim().toLowerCase()].filter(Boolean);
  for (const entry of aliasEntries) {
    const aliases = entry.catalog_aliases || [];
    if (aliases.some(alias => needles.includes(String(alias).trim().toLowerCase()))) return entry.model_key || entry.canonical;
  }
  return null;
}

function aliasCanonicalFor(toolKey, title) {
  const needles = [toolKey, slugifyModelName(title)].filter(Boolean);
  for (const entry of aliasEntries) {
    for (const source of SOURCE_ORDER) {
      const aliases = entry.aliases?.[source] || [];
      if (aliases.some(alias => needles.includes(String(alias).toLowerCase().replace(/^[^/]+\//, '')))) return entry.model_key || entry.canonical;
    }
  }
  return null;
}

export function bridgeToCanonical(title, toolKey) {
  if (!indexMap.size) return null;
  if (toolKey && indexMap.has(toolKey)) return toolKey;
  const slug = slugifyModelName(title);
  if (slug && indexMap.has(slug)) return slug;
  const catalogAlias = catalogAliasCanonicalFor(toolKey, title);
  if (catalogAlias && indexMap.has(catalogAlias)) return catalogAlias;
  const identityMatch = indexModels.find(model => [toolKey, slug].filter(Boolean).includes(model.identity));
  if (identityMatch) return identityMatch.canonical;
  const displayMatch = indexModels.find(model => String(model.display).toLowerCase() === String(title).trim().toLowerCase());
  if (displayMatch) return displayMatch.canonical;
  return aliasCanonicalFor(toolKey, title);
}

/** 由 compare 引用（toolId/itemId）解析 canonical；非 api_model 或未对齐返回 null。 */
export function canonicalForTool(toolId, itemId) {
  const detail = getToolLevel3Item('', toolId) || getToolLevel3Item(toolId, itemId);
  if (!detail || detail.detail_kind !== 'api_model') return null;
  const card = getToolCardItems().find(cardItem => cardItem.detail_ref?.id === detail.id);
  if (!card) return null;
  return bridgeToCanonical(card.title, card.tool_key);
}

export function modelCompareIsSelected(canonical) {
  return selected.includes(canonical);
}

export function modelCap() {
  return viewConfig && Number.isInteger(viewConfig.model_cap) ? viewConfig.model_cap : 5;
}

function comparisonSeriesIconKey(value) {
  return String(value || '').split('--').pop().replace(/\./g, '-');
}

function modelIcon(model) {
  const catalogCard = getToolCardItems().find(card => card.tool_key === model.canonical || card.tool_key === model.identity);
  if (catalogCard?.icon) return catalogCard.icon;
  return VENDOR_ICONS[model.vendor] || THEME_ICONS[model.theme] || '🧠';
}

function modelIconHtml(model) {
  return brandIconHtml({
    vendorKey: model.vendor,
    seriesKey: comparisonSeriesIconKey(model.series_key || model.family),
    modelKey: model.identity || model.canonical,
    emoji: modelIcon(model),
  });
}

// ═══════════════════════════════════════════════════════════════
// 维度取值（value 维走顶层 model.value，其余走 dimensions.<key>.value）
// ═══════════════════════════════════════════════════════════════
function dimensionValue(model, key) {
  if (key === 'value') return Number.isFinite(model.value?.score) ? model.value.score : null;
  const dim = model.dimensions?.[key];
  return Number.isFinite(dim?.value) ? dim.value : null;
}

// ═══════════════════════════════════════════════════════════════
// 变体切换（源级可见分数更新；merged/composite 不重算 —— 契约 §8）
// ═══════════════════════════════════════════════════════════════
function normalizeLmarena(x) {
  const value = ((Number(x) + 0.3) / 0.5) * 100;
  return Math.max(0, Math.min(100, value));
}

/** 源级主分数（供变体说明使用；前端只用归一化 value，不显示 raw）。 */
function sourcePrimaryScore(model, source, degree) {
  if (source === 'lmarena' && model.lmarena_scores?.agent?.[degree]) {
    return normalizeLmarena(model.lmarena_scores.agent[degree].score);
  }
  if (source === 'livebench' && model.livebench_scores?.[degree]?.reasoning != null) {
    return model.livebench_scores[degree].reasoning;
  }
  return null;
}

/** 可选变体圆圈 = 各「有 ≥2 个挡位」的源并集；单挡位源（如 opus-5 的 livebench
 * 只有 max-effort）不是可切换变体，不列圈——否则点了它只搭着别源上次的挡位，得分随历史漂移。 */
function unionDegrees(model) {
  const seen = new Map();
  for (const source of SOURCE_ORDER) {
    const degrees = model.degrees?.[source] || [];
    if (degrees.length < 2) continue;
    for (const degree of degrees) {
      const key = String(degree).toLowerCase();
      if (!seen.has(key)) seen.set(key, { degree, sources: [] });
      seen.get(key).sources.push(source);
    }
  }
  return [...seen.values()];
}

function setActiveVariants(model, degree) {
  const changes = [];
  for (const source of SOURCE_ORDER) {
    const sourceDegrees = model.degrees?.[source] || [];
    const match = sourceDegrees.find(item => String(item).toLowerCase() === String(degree).toLowerCase());
    if (!match) continue;
    // 未显式切换过时退回该源默认挡位（data 记录带 default_degree；index 记录没有）
    const previous = activeVariants[model.canonical]?.[source] ?? model.default_degree?.[source];
    if (previous === match) continue;
    const beforeScore = sourcePrimaryScore(model, source, previous);
    const afterScore = sourcePrimaryScore(model, source, match);
    activeVariants[model.canonical] = { ...(activeVariants[model.canonical] || {}), [source]: match };
    if (beforeScore != null && afterScore != null) {
      changes.push({ source, previous, beforeScore, afterScore });
    }
  }
  return changes;
}

function variantNoteFor(model, changes) {
  return changes.map(change => t('compare.variantSwitch', {
    model: model.display,
    degree: activeVariants[model.canonical]?.[change.source] || change.previous,
    source: SOURCE_META[change.source]?.label || change.source,
    before: change.beforeScore.toFixed(1),
    after: change.afterScore.toFixed(1),
  })).join(' ');
}

// ═══════════════════════════════════════════════════════════════
// 挡位切换重算（契约为 default_degree 预计算；切挡后按所选挡位的源级数据
// 重算源级维度 + composite + value，写回 dataMap 记录，图表实时反映）
// ═══════════════════════════════════════════════════════════════
const LB_GROUPS = ['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding'];
const AGENT_CONFIGS = new Set(['agent', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit']);

function round1(x) { return Math.round(Number(x) * 10) / 10; }
function hasNum(x) { return x != null && String(x).trim() !== '' && Number.isFinite(Number(x)); }
function normalizeEloRange(x, bounds) {
  if (!bounds || bounds.max <= bounds.min) return 100;
  return Math.max(0, Math.min(100, ((x - bounds.min) / (bounds.max - bounds.min)) * 100));
}

/** LMArena Elo 各榜 min-max 界（跨全部模型/挡位，与管线一致；挡位无关，缓存一次）。 */
let eloBoundsCache = null;
function lmarenaEloBounds() {
  if (eloBoundsCache) return eloBoundsCache;
  const bounds = {};
  for (const model of dataMap.values()) {
    const scores = model.lmarena_scores || {};
    for (const config of Object.keys(scores)) {
      if (AGENT_CONFIGS.has(config)) continue;
      for (const entry of Object.values(scores[config] || {})) {
        if (!hasNum(entry.score)) continue;
        const cur = bounds[config] || (bounds[config] = { min: Infinity, max: -Infinity });
        if (entry.score < cur.min) cur.min = entry.score;
        if (entry.score > cur.max) cur.max = entry.score;
      }
    }
  }
  eloBoundsCache = bounds;
  return bounds;
}

/** 按当前 activeVariants 挡位重算单模型维度/composite/value（写回 dataMap 记录）。 */
function recomputeDegreesFor(model) {
  if (!model) return;
  const active = activeVariants[model.canonical] || {};
  const lmDegree = active.lmarena || model.default_degree?.lmarena || null;
  const lbDegree = active.livebench || model.default_degree?.livebench || null;
  const dims = { ...model.dimensions };
  const scores = model.lmarena_scores || {};
  const bounds = lmarenaEloBounds();
  const entryFor = (config, degree) => {
    const map = scores[config] || {};
    return map[degree] || map[String(degree).toLowerCase()] || null;
  };

  // 1) LMArena 各榜维度（agent 子维度比例分、Elo 榜 min-max）
  if (lmDegree) {
    for (const config of Object.keys(scores)) {
      if (config === 'agent') continue;
      const entry = entryFor(config, lmDegree);
      if (entry && hasNum(entry.score)) {
        const value = AGENT_CONFIGS.has(config)
          ? normalizeLmarena(entry.score)
          : normalizeEloRange(Number(entry.score), bounds[config]);
        dims[config] = { value: round1(value), source: 'lmarena', raw: entry.score };
      } else {
        delete dims[config];
      }
    }
  }

  // 2) LiveBench 组 → merged 维度（LB 优先；communication/math 保持 llm_stats 优先原优先级）
  const lb = lbDegree ? model.livebench_scores?.[lbDegree] : null;
  if (lb) {
    const addLb = (key, dim) => {
      if (hasNum(lb[key])) dims[dim] = { value: round1(Number(lb[key])), source: 'livebench', raw: Number(lb[key]) };
    };
    addLb('reasoning', 'reasoning');
    addLb('coding', 'coding');
    addLb('instruction_following', 'instruction_following');
    addLb('agentic_coding', 'agentic_coding');
    if (!dims.communication || dims.communication.source !== 'llm_stats') addLb('language', 'communication');
    if (!dims.math_reasoning || dims.math_reasoning.source !== 'llm_stats') addLb('math', 'math_reasoning');
  }

  // 3) composite：底座 available（llm_stats 恒定）+ 切挡后的 lmarena/livebench 源级分
  const available = { ...(model.composite?.available || {}) };
  const agentEntry = lmDegree ? entryFor('agent', lmDegree) : null;
  if (agentEntry && hasNum(agentEntry.score)) {
    available.lmarena = normalizeLmarena(agentEntry.score);
  } else if (lmDegree) {
    // 该挡位无 agent 分 → 丢弃源（不沿用旧 available，否则综合分会回显上一挡的分数）
    delete available.lmarena;
  }
  if (lb) {
    const groups = LB_GROUPS.map(key => lb[key]).filter(hasNum).map(Number);
    if (groups.length) available.livebench = groups.reduce((a, b) => a + b, 0) / groups.length;
    else delete available.livebench;
  } else if (lbDegree) {
    delete available.livebench;
  }
  const baseWeights = (model.open_source && available.llm_stats != null)
    ? { lmarena: 0.45, livebench: 0.30, llm_stats: 0.25 }
    : { lmarena: 0.65, livebench: 0.35 };
  const usable = SOURCE_ORDER.filter(source => available[source] != null && baseWeights[source] != null);
  if (usable.length) {
    const total = usable.reduce((sum, source) => sum + baseWeights[source], 0);
    const weights = {};
    usable.forEach(source => { weights[source] = Math.round((baseWeights[source] / total) * 10000) / 10000; });
    const score = usable.reduce((sum, source) => sum + weights[source] * available[source], 0);
    model.composite = {
      score: round1(score),
      weights,
      method: 'proportional_redistribute',
      available,
      note: usable.length !== Object.keys(baseWeights).length ? '缺源，权重按比例重分配' : null,
    };
    dims.composite = { value: model.composite.score, source: 'composite', raw: model.composite.score };
  }

  model.dimensions = dims;
  recomputeValues();
}

/** 性价比：综合分 ÷ 平均每 M 价，全表 min-max（切挡只改该模型 composite，其余记录也随之微调）。 */
function priceAvgPerM(model) {
  const or = model.pricing?.openrouter;
  if (or && (or.prompt || or.completion)) {
    return (Number(or.prompt) * 1e6 + Number(or.completion) * 1e6) / 2;
  }
  const ls = model.pricing?.llm_stats;
  if (ls && (ls.input_per_m != null || ls.output_per_m != null)) {
    const nums = [ls.input_per_m, ls.output_per_m].filter(Number.isFinite);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  return null;
}

function recomputeValues() {
  const rows = [];
  for (const model of dataMap.values()) {
    if (!model.composite) continue;
    const avg = priceAvgPerM(model);
    if (avg == null || avg <= 0) continue;
    rows.push({ model, raw: Math.log(model.composite.score / avg) }); // 与管线口径一致：ln 后 min-max
  }
  if (!rows.length) return;
  const values = rows.map(row => row.raw);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const row of rows) {
    const score = max > min ? ((row.raw - min) / (max - min)) * 100 : 100;
    row.model.value = { score: round1(score), raw: row.raw, note: 'ln(综合分/平均每M价)' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 渲染入口（模型 tab 激活时调用）
// ═══════════════════════════════════════════════════════════════
export function renderModelCompare() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;
  syncChartClass();
  if (!comparisonReady && !comparisonFailed) return; // 加载中：loadingPromise 完成后再渲染
  if (comparisonFailed) {
    document.getElementById('cmpModelList').innerHTML = renderState({ icon: '⚠️', title: t('compare.empty.loadFailed'), message: t('compare.empty.notBuilt'), type: 'error' });
    document.getElementById('cmpChips').innerHTML = '';
    document.getElementById('cmpResults').innerHTML = '';
    return;
  }
  renderFilterCats();
  renderModelList();
  renderChips();
  renderDimPicker();
  syncModeButtons();
  renderResults();
}

function syncChartClass() {
  // 图表模式（柱状图/雷达图）与表格视图均放开页面限宽（同搜索页 :has 法；切走视图由 .active 复原）
  document.getElementById('view-compare')?.classList.add('cmp-wide-active');
}

// ── 选择器 ─────────────────────────────────────────────────────
function renderFilterCats() {
  const box = document.getElementById('cmpFilterCats');
  if (!box) return;
  const themes = [...new Set(indexSeries.map(series => series.theme).filter(Boolean))];
  box.innerHTML = '<button class="filter-chip' + (filterTheme === 'all' ? ' active' : '') + '" type="button" data-cmp-cat="all" aria-pressed="' + (filterTheme === 'all') + '">全部</button>' +
    themes.map(theme => '<button class="filter-chip' + (filterTheme === theme ? ' active' : '') + '" type="button" data-cmp-cat="' + escapeHtml(theme) + '" aria-pressed="' + (filterTheme === theme) + '">' + escapeHtml(theme) + '</button>').join('');
}

function selectedCountForSeries(series) {
  return series.members.reduce((count, member) => count + (member.variants.some(variant => selected.includes(variant.canonical)) ? 1 : 0), 0);
}

function visibleMembersForSeries(series) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return series.members;
  const seriesText = [series.display, series.series_key, series.vendor].filter(Boolean).join(' ').toLowerCase();
  if (seriesText.includes(query)) return series.members;
  return series.members.filter(member => {
    const memberText = [member.display, member.member_key, ...member.variants.flatMap(variant => [variant.display, variant.canonical])].filter(Boolean).join(' ').toLowerCase();
    return memberText.includes(query);
  });
}

function filteredSeries() {
  const query = searchQuery.trim().toLowerCase();
  const list = indexSeries.filter(series => {
    if (filterTheme !== 'all' && series.theme !== filterTheme) return false;
    if (!query) return true;
    return visibleMembersForSeries(series).length > 0;
  });
  list.sort((a, b) => {
    const scoreA = Number.isFinite(a.max_composite_score) ? a.max_composite_score : -1;
    const scoreB = Number.isFinite(b.max_composite_score) ? b.max_composite_score : -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return String(a.display).localeCompare(String(b.display), 'zh-CN');
  });
  return list;
}

function renderMemberVariantSelect(member) {
  if (member.variant_count <= 1) return '';
  const selectedVariant = member.variants.find(variant => selected.includes(variant.canonical));
  return '<select class="cmp-member-revision" data-cmp-revision="' + escapeHtml(member.member_key) + '" aria-label="选择修订版">' +
    member.variants.map(variant => '<option value="' + escapeHtml(variant.canonical) + '"' + (variant.canonical === (selectedVariant?.canonical || member.default_canonical) ? ' selected' : '') + '>' + escapeHtml(variant.revision || '默认') + '</option>').join('') +
    '</select>';
}

function renderModelList() {
  const list = document.getElementById('cmpModelList');
  if (!list) return;
  const groups = filteredSeries();
  if (!groups.length) {
    list.innerHTML = renderState({ icon: '⌕', title: t('compare.empty.noMatch'), message: '', type: 'no-match' });
    return;
  }
  list.innerHTML = groups.map(series => {
    const members = visibleMembersForSeries(series);
    const expanded = expandedSeries.has(series.series_key);
    const selectedCount = selectedCountForSeries(series);
    const memberHtml = expanded ? '<div class="cmp-series-members">' + members.map(member => {
      const isSelected = member.variants.some(variant => selected.includes(variant.canonical));
      const canonical = member.variants.find(variant => selected.includes(variant.canonical))?.canonical || member.default_canonical;
      const model = indexMap.get(canonical) || indexMap.get(member.default_canonical);
      const coverage = model && model.sources?.length ? '<span class="cmp-coverage">' + model.sources.length + ' 源</span>' : '';
      return '<div class="cmp-model-member' + (isSelected ? ' selected' : '') + '">' +
        '<button class="cmp-model-item" type="button" data-cmp-pick="' + escapeHtml(canonical) + '" aria-pressed="' + isSelected + '">' +
          '<span class="cmp-model-icon" aria-hidden="true">' + (model ? modelIconHtml(model) : '') + '</span>' +
          '<span class="cmp-model-text"><span class="cmp-model-name">' + escapeHtml(member.display) + '</span>' +
          '<span class="cmp-model-vendor">' + escapeHtml(model?.display || '') + '</span></span>' +
          coverage +
        '</button>' + renderMemberVariantSelect(member) +
      '</div>';
    }).join('') + '</div>' : '';
    const score = Number.isFinite(series.max_composite_score) ? Number(series.max_composite_score).toFixed(1) : t('compare.noComposite');
    return '<section class="cmp-series' + (expanded ? ' expanded' : '') + '" data-cmp-series="' + escapeHtml(series.series_key) + '">' +
      '<button class="cmp-series-toggle" type="button" data-cmp-series-toggle="' + escapeHtml(series.series_key) + '" aria-expanded="' + expanded + '">' +
        '<span class="cmp-model-icon" aria-hidden="true">' + brandIconHtml({ vendorKey: series.vendor, seriesKey: comparisonSeriesIconKey(series.series_key) }) + '</span>' +
        '<span class="cmp-series-text"><span class="cmp-series-name">' + escapeHtml(series.display) + '</span><span class="cmp-series-meta">' + selectedCount + ' / ' + series.member_count + ' 已选 · ' + series.member_count + ' 个成员</span></span>' +
        '<span class="cmp-score' + (Number.isFinite(series.max_composite_score) ? '' : ' cmp-score-na') + '">' + escapeHtml(score) + '</span>' +
        '<span class="cmp-series-chevron" aria-hidden="true">' + (expanded ? '⌃' : '⌄') + '</span>' +
      '</button>' + memberHtml +
    '</section>';
  }).join('');
}

// ── 已选 chips ─────────────────────────────────────────────────
function degreeLabelFor(model) {
  const active = activeVariants[model.canonical] || {};
  const parts = SOURCE_ORDER.filter(source => model.degrees?.[source]?.length).map(source => {
    const degree = active[source] || model.default_degree?.[source] || model.degrees[source][0];
    return (SOURCE_META[source]?.label || source) + ': ' + degree;
  });
  return parts.join(' · ');
}

function renderChips() {
  const box = document.getElementById('cmpChips');
  const count = document.getElementById('cmpCount');
  if (!box) return;
  const cap = modelCap();
  if (count) count.textContent = t('compare.modelCapLabel', { n: selected.length, cap });
  if (!selected.length) {
    box.innerHTML = '<p class="hint">' + escapeHtml(t('compare.empty.noSelection')) + '</p>';
    return;
  }
  box.innerHTML = selected.map(canonical => {
    const index = indexMap.get(canonical);
    if (!index) return '';
    return '<span class="cmp-chip">' +
      '<button class="cmp-chip-icon" type="button" data-cmp-variant="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.variantOf') + index.display) + '" aria-expanded="' + (variantOpenFor === canonical) + '">' + modelIconHtml(index) + '</button>' +
      '<span class="cmp-chip-body"><span class="cmp-chip-name">' + escapeHtml(index.display) + '</span>' +
      '<span class="cmp-chip-degrees">' + escapeHtml(degreeLabelFor(index)) + '</span></span>' +
      '<button class="cmp-chip-remove" type="button" data-cmp-remove="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.removeModel')) + '">×</button>' +
    '</span>';
  }).join('');
}

// ── 维度勾选 ───────────────────────────────────────────────────
/** 所选模型共同拥有且不缺省（有值）的维度；无选择或数据未就绪返回全量。 */
function availableDims() {
  const models = selected.map(getModelData).filter(Boolean);
  if (!models.length || models.length !== selected.length) return ALL_DIMS;
  return ALL_DIMS.filter(dim => models.every(model => dimensionValue(model, dim) !== null));
}

function renderDimPicker() {
  const box = document.getElementById('cmpDims');
  if (!box) return;
  const available = availableDims();
  const hint = available.length < ALL_DIMS.length
    ? '<p class="cmp-dim-hint" role="note">' + escapeHtml(t('compare.dimsOnlyCommon')) + '</p>'
    : '';
  box.innerHTML = hint + DIM_GROUPS.map(group => {
    const visible = group.dims.filter(dim => available.includes(dim));
    if (!visible.length) return '';
    const chips = visible.map(dim => {
      const checked = activeDims.includes(dim);
      return '<label class="cmp-dim-chip' + (checked ? ' checked' : '') + '">' +
        '<input type="checkbox" data-cmp-dim="' + escapeHtml(dim) + '"' + (checked ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(t('compare.dimension.' + dim)) + '</span></label>';
    }).join('');
    return '<div class="cmp-dim-group"><span class="cmp-dim-group-label">' + escapeHtml(t('compare.dimGroup.' + group.key)) + '</span><div class="cmp-dim-chips">' + chips + '</div></div>';
  }).join('');
}

function syncModeButtons() {
  document.querySelectorAll('#compareModelPanel [data-cmp-view]').forEach(btn => {
    const active = btn.dataset.cmpView === viewMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#compareModelPanel [data-cmp-chart]').forEach(btn => {
    const active = btn.dataset.cmpChart === chartMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

// ═══════════════════════════════════════════════════════════════
// 结果渲染（图表 / 表格；图表 = 柱状图 ↔ 雷达图）
// ═══════════════════════════════════════════════════════════════
function renderUnselectedState() {
  const query = searchQuery.trim();
  const series = filteredSeries();
  const description = query
    ? `已找到 ${series.length} 个匹配系列。请在左侧展开系列并选择具体成员，再查看图表或表格。`
    : '请在左侧展开系列并选择具体成员，再查看图表或表格。';
  return renderState({ icon: '⌕', title: '选择要对比的模型', message: description, type: 'empty' });
}

function renderResults() {
  const out = document.getElementById('cmpResults');
  const status = document.getElementById('cmpStatus');
  if (status) status.textContent = '';
  ensureData().then(() => {
    if (comparisonFailed) {
      out.innerHTML = renderState({ icon: '⚠️', title: t('compare.empty.loadFailed'), message: t('compare.empty.notBuilt'), type: 'error' });
      return;
    }
    // 左侧搜索只负责筛选系列；未选择具体 canonical 时不渲染 Top N 浏览柱图，
    // 避免多结果被 SVG 压缩成一排竖线而误当作搜索结果。
    if (!selected.length) {
      out.innerHTML = renderUnselectedState();
      return;
    }
    const models = selected.map(getModelData).filter(Boolean);
    if (models.length !== selected.length) {
      out.innerHTML = renderState({ icon: '⚠️', title: t('compare.empty.loadFailed'), message: '', type: 'error' });
      return;
    }
    if (viewMode === 'table') {
      out.innerHTML = renderTable(models);
      return;
    }
    if (chartMode === 'radar') {
      if (models.length !== 2) {
        out.innerHTML = renderState({ icon: '◎', title: t('compare.radarRequireTwo', { n: models.length }), message: t('compare.chart.radar'), type: 'empty' });
        return;
      }
      out.innerHTML = renderRadar(models, activeDims);
      return;
    }
    const bars = renderBars(models, activeDims);
    out.innerHTML = bars || renderState({ icon: '↔', title: t('compare.noSharedDims'), message: t('compare.viewLead'), type: 'empty' });
  });
}

// ── 无选择浏览态：每维度 Top N 排行（数据由 dataMap 实时聚合；竖柱状图） ──
function renderBrowse(dims) {
  const lead = '<p class="cmp-browse-lead" role="note">' + escapeHtml(t('compare.browseLead', { n: BROWSE_TOP_N })) + '</p>';
  const blocks = dims.map(dimension => {
    const label = t('compare.dimension.' + dimension);
    const ranked = [...dataMap.values()]
      .map(model => ({ model, value: dimensionValue(model, dimension) }))
      .filter(item => item.value !== null)
      .sort((a, b) => b.value - a.value)
      .slice(0, BROWSE_TOP_N);
    if (!ranked.length) return '';
    const groups = ranked.map(item => ({
      label: item.model.display,
      icon: modelIcon(item.model),
      bars: [{ dim: dimension, value: item.value }],
    }));
    return '<section class="cmp-vchart">' +
      '<div class="cmp-vchart-head"><h3>' + escapeHtml(label) + '</h3>' +
      '<span class="cmp-block-note">' + escapeHtml(t('compare.barSort')) + '</span></div>' +
      renderVerticalPlot(groups) +
      sourceFooterHtml(sourcesForDimension(dimension, ranked.map(item => item.model))) +
    '</section>';
  }).join('');
  return lead + blocks;
}

// ── 来源 footer（每可视化块下右对齐；契约 §8） ─────────────────
function sourcesForDimension(dimension, models) {
  const sources = new Set();
  if (dimension === 'composite') {
    for (const model of models) {
      if (!model.composite || model.composite.method === 'missing') continue;
      Object.keys(model.composite.weights || {}).forEach(source => sources.add(source));
    }
  } else if (dimension === 'value') {
    for (const model of models) {
      if (!model.composite || model.composite.method === 'missing') continue;
      Object.keys(model.composite.weights || {}).forEach(source => sources.add(source));
      Object.keys(model.pricing || {}).forEach(source => sources.add(source));
    }
  } else {
    for (const model of models) {
      const dim = model.dimensions?.[dimension];
      if (dim && dim.source) sources.add(dim.source);
    }
  }
  return sources;
}

function sourceFooterHtml(sources) {
  const items = SOURCE_ORDER.filter(source => sources.has(source)).map(source => {
    const meta = SOURCE_META[source];
    const link = meta.url
      ? '<a href="' + escapeHtml(safeExternalUrl(meta.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(meta.label) + '</a>'
      : escapeHtml(meta.label);
    const template = meta.license ? 'compare.source.footer' : 'compare.source.footerPlain';
    const label = t(template, { name: '{{LINK}}', license: meta.license || '' }).replace('{{LINK}}', link);
    const listed = meta.listed ? ' <span class="cmp-listed-price">' + escapeHtml(t('compare.listedPrice')) + '</span>' : '';
    return '<span class="cmp-source-item">' + label + listed + '</span>';
  });
  if (!items.length) return '';
  return '<div class="cmp-source-footer">' + items.join('') + '</div>';
}

/** 合并多个维度的来源 footer 集合（竖柱状图为单图，来源统一归并到图下）。 */
function sourcesForDims(dims, models) {
  const sources = new Set();
  for (const dim of dims) sourcesForDimension(dim, models).forEach(source => sources.add(source));
  return sources;
}

// ── 竖柱状图（选中模型对比）：多簇并排（每簇一个模型），簇内各维度柱相连无缝；
//    每维度统一最高高度（该维度图表内最大值 = 满高，其余按比例量化），柱顶标真实数值；右上角图例 ──
function renderLegend(dims) {
  const items = dims.map(dim =>
    '<span class="cmp-legend-item" role="listitem"><span class="cmp-legend-swatch" style="background:' + dimColor(dim) + '"></span>' + escapeHtml(t('compare.dimension.' + dim)) + '</span>'
  ).join('');
  return '<div class="cmp-legend" role="list">' + items + '</div>';
}

/** 竖柱状图绘图区（SVG）：groups = [{label, icon, bars:[{dim, value}]}]；每维度最大值顶到统一满高。 */
function renderVerticalPlot(groups) {
  const H = 280;
  const leftPad = 4;
  const rightPad = 8;
  const plotTop = 30;   // 顶部留白（柱顶数值）
  const plotBottom = 250; // 基线
  const labelY = 268;   // 簇底模型名
  const plotH = plotBottom - plotTop;
  const barW = 22;
  const clusterPad = 10;
  const gap = 30;
  const maxDims = Math.max(1, ...groups.map(group => group.bars.length));
  const groupW = maxDims * barW + clusterPad * 2;
  const totalW = leftPad + groups.length * groupW + Math.max(0, groups.length - 1) * gap + rightPad;

  // 每维度统一满高：该维度在图表内的最大值映射到 plotTop，其余按 value/最大值 比例量化
  const dimMax = {};
  for (const group of groups) {
    for (const bar of group.bars) {
      if (bar.value == null) continue;
      dimMax[bar.dim] = Math.max(dimMax[bar.dim] || -Infinity, bar.value);
    }
  }
  const barY = (value, dim) => {
    const max = dimMax[dim] || 0;
    const ratio = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return plotBottom - (ratio / 100) * plotH;
  };

  const baseline = '<line class="cmp-bar-base" x1="' + leftPad + '" y1="' + plotBottom + '" x2="' + totalW + '" y2="' + plotBottom + '"></line>';

  const groupsSvg = groups.map((group, gi) => {
    const groupStart = leftPad + gi * (groupW + gap);
    const n = group.bars.length;
    const barsStart = groupStart + (groupW - n * barW) / 2; // 柱在簇内居中
    const bars = group.bars.map((bar, bi) => {
      const x = barsStart + bi * barW;
      const y = barY(bar.value, bar.dim);
      const h = plotBottom - y;
      const color = dimColor(bar.dim);
      const dimLabel = t('compare.dimension.' + bar.dim);
      return '<rect class="cmp-bar-rect" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barW + '" height="' + h.toFixed(2) + '" fill="' + color + '">' +
          '<title>' + escapeHtml(group.label + ' ' + dimLabel + ' ' + bar.value) + '</title></rect>' +
        '<text class="cmp-bar-val" x="' + (x + barW / 2).toFixed(2) + '" y="' + (y - 5).toFixed(2) + '" text-anchor="middle" fill="' + color + '">' + bar.value.toFixed(1) + '</text>';
    }).join('');
    const cx = groupStart + groupW / 2;
    return bars +
      '<text class="cmp-bar-name" x="' + cx.toFixed(2) + '" y="' + labelY + '" text-anchor="middle">' + escapeHtml(group.icon ? group.icon + ' ' : '') + escapeHtml(group.label) + '</text>';
  }).join('');

  return '<svg class="cmp-vchart-svg" viewBox="0 0 ' + totalW + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + escapeHtml(t('compare.barChartTitle')) + '">' +
    baseline + groupsSvg + '</svg>';
}

function renderBars(models, dims) {
  const plotDims = dims.filter(dim => models.every(model => dimensionValue(model, dim) !== null));
  if (!plotDims.length) return '';
  const groups = models.map(model => ({
    label: model.display,
    icon: modelIcon(model),
    bars: plotDims.map(dim => ({ dim, value: dimensionValue(model, dim) })),
  }));
  return '<section class="cmp-vchart" aria-label="' + escapeHtml(t('compare.barChartTitle')) + '">' +
    '<div class="cmp-vchart-head"><h3>' + escapeHtml(t('compare.barChartTitle')) + '</h3>' + renderLegend(plotDims) + '</div>' +
    renderVerticalPlot(groups) +
    sourceFooterHtml(sourcesForDims(plotDims, models)) +
  '</section>';
}

// ── 雷达图（经典单 N 边形；模型1 左 / 模型2 右；仅两端有值维度） ──
function renderRadar(models, dims) {
  const cap = viewConfig && Number.isInteger(viewConfig.radar_dimension_cap) ? viewConfig.radar_dimension_cap : 12;
  const overCap = dims.length > cap;
  const plotDims = overCap ? dims.slice(0, cap) : dims;
  // 只画两端模型都有值的维度（缺失画 0 会误导），数据不足维度跳过并提示。
  const plot = plotDims.filter(dimension => models.every(model => dimensionValue(model, dimension) !== null));
  const skipped = plotDims.filter(dimension => !plot.includes(dimension));

  const width = 680;
  const height = 480;
  const cx = width / 2;
  const cy = height / 2 - 6;
  const radius = 150;
  const model0 = models[0];
  const model1 = models[1];

  let grid = '';
  for (const level of [25, 50, 75, 100]) {
    grid += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (radius * level / 100) + '" class="cmp-radar-grid"></circle>';
  }
  let axes = '';
  let labels = '';
  for (let i = 0; i < plot.length; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / plot.length;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    axes += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '" class="cmp-radar-axis"></line>';
    const lx = cx + (radius + 24) * Math.cos(angle);
    const ly = cy + (radius + 24) * Math.sin(angle);
    const anchor = Math.abs(lx - cx) < 14 ? 'middle' : (lx > cx ? 'start' : 'end');
    labels += '<text x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '" class="cmp-radar-label">' + escapeHtml(t('compare.dimension.' + plot[i])) + '</text>';
  }

  const polygonAttr = model => plot.map((dimension, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / plot.length;
    const value = dimensionValue(model, dimension);
    const r = (Math.max(0, Math.min(100, value)) / 100) * radius;
    return (cx + r * Math.cos(angle)) + ',' + (cy + r * Math.sin(angle));
  }).join(' ');

  const ringHtml = (model, color, side) =>
    '<div class="cmp-radar-model cmp-radar-model-' + side + '"><span class="cmp-radar-dot" style="background:' + color + '"></span>' + escapeHtml(model.display) + '</div>';

  const sources = new Set();
  for (const dimension of plot) {
    sourcesForDimension(dimension, models).forEach(source => sources.add(source));
  }

  const warning = [];
  if (overCap) warning.push(t('compare.radarCapExceed', { n: dims.length, cap }));
  if (skipped.length) warning.push(t('compare.radarSkipInsufficient'));

  return '<div class="cmp-radar">' +
    ringHtml(model0, 'var(--primary)', 'left') +
    ringHtml(model1, 'var(--accent)', 'right') +
    '<svg class="cmp-radar-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(model0.display + ' vs ' + model1.display + ' 雷达图') + '">' +
      grid + axes +
      '<polygon points="' + polygonAttr(model0) + '" class="cmp-radar-shape cmp-radar-shape-a"></polygon>' +
      '<polygon points="' + polygonAttr(model1) + '" class="cmp-radar-shape cmp-radar-shape-b"></polygon>' +
      labels +
    '</svg>' +
    (warning.length ? '<p class="cmp-radar-warn" role="note">' + warning.map(w => escapeHtml(w)).join('；') + '</p>' : '') +
    sourceFooterHtml(sources) +
  '</div>';
}

// ── 表格视图（独立，不参与柱状图/雷达图 toggle） ───────────────
function formatPricing(model) {
  const parts = [];
  const or = model.pricing?.openrouter;
  if (or && or.currency === 'USD') {
    const inPerM = Number(or.prompt) * 1e6;
    const outPerM = Number(or.completion) * 1e6;
    parts.push('$' + Number(inPerM).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输入 · $' + Number(outPerM).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输出' + (or.is_listed_price ? '（挂牌参考价）' : ''));
  }
  const ls = model.pricing?.llm_stats;
  if (ls && (ls.input_per_m != null || ls.output_per_m != null)) {
    parts.push('$' + Number(ls.input_per_m ?? '—').toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输入 · $' + Number(ls.output_per_m ?? '—').toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输出');
  }
  return parts.length ? parts.join('<br>') : t('compare.table.noPricing');
}

function renderTable(models) {
  const header = '<th>' + escapeHtml(t('compare.table.row')) + '</th>' + models.map(model => '<th>' + escapeHtml(model.display) + '</th>').join('');
  const boolCell = value => value == null ? escapeHtml(t('compare.table.unknown')) : escapeHtml(value ? t('compare.table.yes') : t('compare.table.no'));
  const rows = [
    [t('compare.table.license'), model => escapeHtml(model.license || t('compare.table.unknown'))],
    [t('compare.table.openSource'), model => boolCell(model.open_source)],
    [t('compare.table.vendor'), model => escapeHtml(model.vendor || '—')],
    [t('compare.table.modalities'), model => Array.isArray(model.modalities) && model.modalities.length ? escapeHtml(model.modalities.join('、')) : escapeHtml(t('compare.table.unknown'))],
    [t('compare.table.isMoe'), model => boolCell(model.is_moe)],
    [t('compare.table.context'), model => model.context_length ? escapeHtml(Number(model.context_length).toLocaleString('zh-CN') + ' tokens') : escapeHtml(t('compare.table.unknown'))],
    [t('compare.table.pricing'), model => formatPricing(model)],
  ];
  const body = rows.map(row => '<tr><td class="dim">' + escapeHtml(row[0]) + '</td>' + models.map(model => '<td>' + row[1](model) + '</td>').join('')).join('');
  return '<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody></table>' +
    '<p class="faint cmp-generated">' + escapeHtml(t('compare.generatedAt', { time: indexData?.generated_at || '—' })) + '</p></div>';
}

// ═══════════════════════════════════════════════════════════════
// 变体圆圈（点模型 icon → icon 周围顺时针 360° 平分圆圈）
// ═══════════════════════════════════════════════════════════════
function degreeIsActive(canonical, degree) {
  const model = indexMap.get(canonical);
  if (!model) return false;
  return SOURCE_ORDER.some(source => {
    const active = activeVariants[canonical]?.[source] || model.default_degree?.[source];
    return active && String(active).toLowerCase() === String(degree).toLowerCase();
  });
}

function renderVariantPopover(trigger, canonical) {
  const model = indexMap.get(canonical);
  const existing = document.getElementById('cmpVariantPopover');
  if (existing) existing.remove();
  if (!model) return;
  const circle = unionDegrees(model);
  if (!circle.length) return;

  const pop = document.createElement('div');
  pop.id = 'cmpVariantPopover';
  pop.dataset.model = canonical;
  pop.className = 'cmp-variant-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('compare.variantOf') + model.display);

  const N = circle.length;
  const size = 280; // SVG 画布：容纳挡位标签（原 200 时 0°/90° 标签落在画布外被裁剪）
  const cx = size / 2;
  const cy = size / 2;
  const inner = 34;
  const outer = 82;
  const labelR = 104;
  let sectors = '';
  for (let i = 0; i < N; i++) {
    const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / N;
    const selectedDegree = degreeIsActive(canonical, circle[i].degree);
    const x0 = cx + inner * Math.cos(a0); const y0 = cy + inner * Math.sin(a0);
    const x1 = cx + outer * Math.cos(a0); const y1 = cy + outer * Math.sin(a0);
    const x2 = cx + outer * Math.cos(a1); const y2 = cy + outer * Math.sin(a1);
    const x3 = cx + inner * Math.cos(a1); const y3 = cy + inner * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const path = 'M' + x1 + ',' + y1 + ' A' + outer + ',' + outer + ' 0 ' + large + ' 1 ' + x2 + ',' + y2 +
      ' L' + x3 + ',' + y3 + ' A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + x0 + ',' + y0 + ' Z';
    const am = (a0 + a1) / 2;
    const lx = cx + labelR * Math.cos(am);
    const ly = cy + labelR * Math.sin(am);
    sectors += '<g class="cmp-variant-sector' + (selectedDegree ? ' selected' : '') + '" data-cmp-variant-slot="' + escapeHtml(circle[i].degree) + '" data-cmp-variant-model="' + escapeHtml(canonical) + '" role="button" tabindex="0" aria-label="' + escapeHtml(circle[i].degree) + '">' +
      '<path d="' + path + '"></path>' +
      '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(circle[i].degree) + '</text></g>';
  }
  pop.innerHTML = '<button class="cmp-variant-close" type="button" data-cmp-variant-close aria-label="' + escapeHtml(t('compare.removeModel')) + '">×</button>' +
    '<p class="cmp-variant-hint">' + escapeHtml(t('compare.variantHint', { n: N })) + '</p>' +
    '<svg class="cmp-variant-svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + escapeHtml(model.display + ' 变体选择') + '">' + sectors + '</svg>';

  document.getElementById('compareModelPanel').appendChild(pop);
  positionPopover(pop, trigger, 306); // 弹窗宽 = SVG 280 + 水平 padding 24 + 边距
}

function positionPopover(pop, trigger, size) {
  const panel = document.getElementById('compareModelPanel');
  const panelRect = panel.getBoundingClientRect();
  const iconRect = trigger.getBoundingClientRect();
  const left = iconRect.left - panelRect.left + iconRect.width / 2 - size / 2;
  const top = iconRect.bottom - panelRect.top + 10;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = (top + size + 16 > panelRect.height ? Math.max(8, iconRect.top - panelRect.top - size - 8) : top) + 'px';
}

// ═══════════════════════════════════════════════════════════════
// 选择 / 取消选择 + 跨模块通知
// ═══════════════════════════════════════════════════════════════
function setCompareModelStatus(message) {
  const el = document.getElementById('cmpStatus');
  if (el) el.textContent = message;
}

function dispatchModelSelection() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('cmp-model-selection'));
}

function selectModel(canonical) {
  if (!indexMap.has(canonical)) return;
  if (selected.includes(canonical)) {
    selected = selected.filter(item => item !== canonical);
    delete activeVariants[canonical];
    if (variantOpenFor === canonical) variantOpenFor = null;
    document.getElementById('cmpVariantPopover')?.remove();
  } else {
    if (selected.length >= modelCap()) {
      setCompareModelStatus(t('compare.modelCapReached', { n: modelCap() }));
      return;
    }
    selected.push(canonical);
    activeVariants[canonical] = { ...(indexMap.get(canonical).default_degree || {}) };
  }
  renderAll();
  dispatchModelSelection();
}

function selectSeriesVariant(memberKey, canonical) {
  if (!indexMap.has(canonical)) return;
  const series = indexSeries.find(item => item.members.some(member => member.member_key === memberKey));
  const member = series?.members.find(item => item.member_key === memberKey);
  if (!member) return;
  const previous = member.variants.find(variant => selected.includes(variant.canonical))?.canonical;
  if (previous && previous !== canonical) {
    selected = selected.map(item => item === previous ? canonical : item);
    delete activeVariants[previous];
    activeVariants[canonical] = { ...(indexMap.get(canonical).default_degree || {}) };
    renderAll();
    dispatchModelSelection();
    return;
  }
  if (!previous) selectModel(canonical);
}

function renderAll() {
  renderChips();
  renderModelList();
  syncActiveDimsToSelection();
  renderResults();
}

/** 选择变化后把勾选集收敛到所选模型共有维度（未公开维度强制不勾选），并重绘勾选面板。 */
function syncActiveDimsToSelection() {
  ensureData().then(() => {
    const available = availableDims();
    activeDims = activeDims.filter(dim => available.includes(dim));
    renderDimPicker();
  });
}

// ═══════════════════════════════════════════════════════════════
// 外部路由入口：catalog api_model 卡 +对比 → 模型 tab
// 返回 true = 已处理（加入/移除模型选择）；false = 未对齐，调用方走工具对比兜底。
// ═══════════════════════════════════════════════════════════════
export async function routeApiModelToCompare(card) {
  await loadingPromise;
  if (comparisonFailed || !card) return false;
  const canonical = bridgeToCanonical(card.title, card.tool_key);
  if (!canonical) return false;
  const adding = !selected.includes(canonical);
  if (adding && selected.length >= modelCap()) {
    setCompareModelStatus(t('compare.modelCapReached', { n: modelCap() }));
    return true;
  }
  if (adding) {
    selected.push(canonical);
    activeVariants[canonical] = { ...(indexMap.get(canonical).default_degree || {}) };
  } else {
    selected = selected.filter(item => item !== canonical);
    delete activeVariants[canonical];
    document.getElementById('cmpVariantPopover')?.remove();
  }
  const seriesKey = indexMap.get(canonical)?.series_key;
  if (seriesKey) expandedSeries.add(seriesKey);
  renderAll();
  dispatchModelSelection();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 事件绑定（对比视图内委托；由 main.js 在 DOMContentLoaded 注册）
// ═══════════════════════════════════════════════════════════════
export function bindModelCompareEvents() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;

  const cmpSearch = document.getElementById('cmpModelSearch');
  const cmpSearchClear = document.getElementById('cmpModelSearchClear');
  let timer;
  cmpSearch?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchQuery = cmpSearch.value;
      expandedSeries.clear();
      renderModelList();
      renderResults();
    }, 150);
    cmpSearchClear.style.display = cmpSearch.value ? 'block' : 'none';
  });
  cmpSearchClear?.addEventListener('click', () => {
    cmpSearch.value = '';
    searchQuery = '';
    expandedSeries.clear();
    cmpSearchClear.style.display = 'none';
    renderModelList();
    renderResults();
    cmpSearch.focus();
  });

  panel.addEventListener('click', event => {
    const seriesToggle = event.target.closest('[data-cmp-series-toggle]');
    if (seriesToggle) {
      const key = seriesToggle.dataset.cmpSeriesToggle;
      if (expandedSeries.has(key)) expandedSeries.delete(key);
      else expandedSeries.add(key);
      renderModelList();
      return;
    }
    const pick = event.target.closest('[data-cmp-pick]');
    if (pick) {
      selectModel(pick.dataset.cmpPick);
      return;
    }
    const remove = event.target.closest('[data-cmp-remove]');
    if (remove) {
      selectModel(remove.dataset.cmpRemove);
      return;
    }
    const variantTrigger = event.target.closest('[data-cmp-variant]');
    if (variantTrigger) {
      const canonical = variantTrigger.dataset.cmpVariant;
      const pop = document.getElementById('cmpVariantPopover');
      if (pop && pop.dataset.model === canonical) {
        pop.remove();
        variantOpenFor = null;
      } else {
        variantOpenFor = canonical;
        // 先弹窗并定位（用仍挂载的 trigger 取坐标），再重建 chips 反映展开态；
        // 顺序颠倒会先销毁 trigger，getBoundingClientRect 返回 0 导致弹窗定位到左上角。
        renderVariantPopover(variantTrigger, canonical);
        renderChips();
      }
      return;
    }
    const slot = event.target.closest('[data-cmp-variant-slot]');
    if (slot) {
      const canonical = slot.dataset.cmpVariantModel;
      const degree = slot.dataset.cmpVariantSlot;
      // 用 data 记录（含源级分数）计算说明与重算；未加载则退回 index 记录
      const model = getModelData(canonical) || indexMap.get(canonical);
      let note = '';
      if (model) {
        const changes = setActiveVariants(model, degree);
        note = variantNoteFor(model, changes);
        if (dataMap.has(canonical)) recomputeDegreesFor(dataMap.get(canonical));
      }
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
      renderChips();
      renderResults(); // 重渲染图表/表格，反映新挡位分数
      if (note) setCompareModelStatus(note); // renderResults 会清空状态行，说明置后避免被吞
      return;
    }
    const close = event.target.closest('[data-cmp-variant-close]');
    if (close) {
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
      renderChips();
      return;
    }
    const dim = event.target.closest('[data-cmp-dim]');
    if (dim) {
      const key = dim.dataset.cmpDim;
      activeDims = activeDims.includes(key) ? activeDims.filter(item => item !== key) : [...activeDims, key];
      renderDimPicker();
      renderResults();
      return;
    }
    const viewBtn = event.target.closest('[data-cmp-view]');
    if (viewBtn) {
      viewMode = viewBtn.dataset.cmpView;
      syncChartClass();
      syncModeButtons();
      renderResults();
      return;
    }
    const chartBtn = event.target.closest('[data-cmp-chart]');
    if (chartBtn) {
      chartMode = chartBtn.dataset.cmpChart;
      syncChartClass();
      syncModeButtons();
      renderResults();
      return;
    }
    const cat = event.target.closest('[data-cmp-cat]');
    if (cat) {
      filterTheme = cat.dataset.cmpCat;
      expandedSeries.clear();
      renderFilterCats();
      renderModelList();
      renderResults();
      return;
    }
  });
  panel.addEventListener('change', event => {
    const revision = event.target.closest('[data-cmp-revision]');
    if (revision) selectSeriesVariant(revision.dataset.cmpRevision, revision.value);
  });
  // 变体圆圈键盘可达（Enter/空格 触发选择）
  panel.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    const slot = event.target.closest('[data-cmp-variant-slot]');
    if (slot) {
      event.preventDefault();
      slot.click();
    }
  });
  // 点圆圈外关闭
  document.addEventListener('click', event => {
    const pop = document.getElementById('cmpVariantPopover');
    if (!pop) return;
    if (event.target.closest('#cmpVariantPopover') || event.target.closest('[data-cmp-variant]')) return;
    variantOpenFor = null;
    pop.remove();
    renderChips();
  });
}

export { loadingPromise };
