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
 *   - 维度勾选（默认 read view-config.default_dimensions；数据不足不画 0 柱）
 *   - 柱状图 ↔ 雷达图 toggle（雷达仅 2 模型、维度 ≤ radar_dimension_cap、开启放开限宽）
 *   - 表格视图（独立，license/open_source/vendor/modalities/is_moe/context/pricing）
 *   - 每图块右对齐来源 footer（平台名 + 许可证 + 链接；OpenRouter 标挂牌参考价）
 *   - 路由桥接：catalog api_model +对比 → 标题→canonical（tool_key → slug → display → alias）
 *
 * 安全：所有外部字段渲染走 escapeHtml；前端只显示归一化 value，不显示 raw。
 */

import { escapeHtml, safeExternalUrl, renderState } from './data.js';
import { t } from './i18n.js';
import { getToolCardItems, getToolLevel3Item } from './data.js';

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
    indexMap = new Map(indexModels.map(model => [model.canonical, model]));
    activeDims = Array.isArray(viewConfig.default_dimensions)
      ? [...viewConfig.default_dimensions]
      : ['composite', 'reasoning', 'coding', 'math_reasoning'];
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

/** 懒加载 data.json（首次需要完整记录时触发；选择器只需要 index）。 */
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

function aliasCanonicalFor(toolKey, title) {
  const needles = [toolKey, slugifyModelName(title)].filter(Boolean);
  for (const entry of aliasEntries) {
    for (const source of SOURCE_ORDER) {
      const aliases = entry.aliases?.[source] || [];
      if (aliases.some(alias => needles.includes(String(alias).toLowerCase().replace(/^[^/]+\//, '')))) return entry.canonical;
    }
  }
  return null;
}

export function bridgeToCanonical(title, toolKey) {
  if (!indexMap.size) return null;
  if (toolKey && indexMap.has(toolKey)) return toolKey;
  const slug = slugifyModelName(title);
  if (slug && indexMap.has(slug)) return slug;
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

function modelIcon(model) {
  const catalogCard = getToolCardItems().find(card => card.tool_key === model.canonical);
  if (catalogCard?.icon) return catalogCard.icon;
  return VENDOR_ICONS[model.vendor] || THEME_ICONS[model.theme] || '🧠';
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

function unionDegrees(model) {
  const seen = new Map();
  for (const source of SOURCE_ORDER) {
    const degrees = model.degrees?.[source] || [];
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
    const previous = activeVariants[model.canonical]?.[source];
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
// 渲染入口（模型 tab 激活时调用）
// ═══════════════════════════════════════════════════════════════
export function renderModelCompare() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;
  syncRadarClass();
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

function syncRadarClass() {
  document.getElementById('view-compare')?.classList.toggle('cmp-radar-active', viewMode === 'chart' && chartMode === 'radar');
}

// ── 选择器 ─────────────────────────────────────────────────────
function renderFilterCats() {
  const box = document.getElementById('cmpFilterCats');
  if (!box) return;
  const themes = [...new Set(indexModels.map(model => model.theme).filter(Boolean))];
  box.innerHTML = '<button class="filter-chip' + (filterTheme === 'all' ? ' active' : '') + '" type="button" data-cmp-cat="all" aria-pressed="' + (filterTheme === 'all') + '">全部</button>' +
    themes.map(theme => '<button class="filter-chip' + (filterTheme === theme ? ' active' : '') + '" type="button" data-cmp-cat="' + escapeHtml(theme) + '" aria-pressed="' + (filterTheme === theme) + '">' + escapeHtml(theme) + '</button>').join('');
}

function filteredModels() {
  const query = searchQuery.trim().toLowerCase();
  const list = indexModels.filter(model => {
    if (filterTheme !== 'all' && model.theme !== filterTheme) return false;
    if (!query) return true;
    return [model.display, model.vendor].join(' ').toLowerCase().includes(query);
  });
  list.sort((a, b) => {
    const scoreA = Number.isFinite(a.composite_score) ? a.composite_score : -1;
    const scoreB = Number.isFinite(b.composite_score) ? b.composite_score : -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return String(a.display).localeCompare(String(b.display), 'zh-CN');
  });
  return list;
}

function renderModelList() {
  const list = document.getElementById('cmpModelList');
  if (!list) return;
  const models = filteredModels();
  if (!models.length) {
    list.innerHTML = renderState({ icon: '⌕', title: t('compare.empty.noMatch'), message: '', type: 'no-match' });
    return;
  }
  list.innerHTML = models.map(model => {
    const isSelected = selected.includes(model.canonical);
    const singleSource = Array.isArray(model.sources) && model.sources.length === 1;
    const coverage = singleSource
      ? '<span class="cmp-coverage">' + escapeHtml(t('compare.onlySource', { source: SOURCE_META[model.sources[0]]?.label || model.sources[0] })) + '</span>'
      : '<span class="cmp-coverage">' + (model.sources || []).length + ' 源</span>';
    const score = Number.isFinite(model.composite_score)
      ? '<span class="cmp-score">' + Number(model.composite_score).toFixed(1) + '</span>'
      : '<span class="cmp-score cmp-score-na">' + t('compare.noComposite') + '</span>';
    return '<button class="cmp-model-item' + (isSelected ? ' selected' : '') + '" type="button" data-cmp-pick="' + escapeHtml(model.canonical) + '" aria-pressed="' + isSelected + '">' +
      '<span class="cmp-model-icon" aria-hidden="true">' + escapeHtml(modelIcon(model)) + '</span>' +
      '<span class="cmp-model-text"><span class="cmp-model-name">' + escapeHtml(model.display) + '</span>' +
      '<span class="cmp-model-vendor">' + escapeHtml(model.vendor) + '</span></span>' +
      coverage + score +
    '</button>';
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
      '<button class="cmp-chip-icon" type="button" data-cmp-variant="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.variantOf') + index.display) + '" aria-expanded="' + (variantOpenFor === canonical) + '">' + escapeHtml(modelIcon(index)) + '</button>' +
      '<span class="cmp-chip-body"><span class="cmp-chip-name">' + escapeHtml(index.display) + '</span>' +
      '<span class="cmp-chip-degrees">' + escapeHtml(degreeLabelFor(index)) + '</span></span>' +
      '<button class="cmp-chip-remove" type="button" data-cmp-remove="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.removeModel')) + '">×</button>' +
    '</span>';
  }).join('');
}

// ── 维度勾选 ───────────────────────────────────────────────────
function renderDimPicker() {
  const box = document.getElementById('cmpDims');
  if (!box) return;
  box.innerHTML = DIM_GROUPS.map(group => {
    const chips = group.dims.map(dim => {
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
function renderResults() {
  const out = document.getElementById('cmpResults');
  const status = document.getElementById('cmpStatus');
  if (status) status.textContent = '';
  if (!selected.length) {
    out.innerHTML = renderState({ icon: '↔', title: t('compare.empty.noSelection'), message: t('compare.viewLead'), type: 'empty' });
    return;
  }
  ensureData().then(() => {
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
    out.innerHTML = renderBars(models, activeDims);
  });
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

// ── 柱状图（每勾选维度一个图块；数据不足不画 0 柱） ────────────
function renderBars(models, dims) {
  return dims.map(dimension => {
    const dimLabel = t('compare.dimension.' + dimension);
    const rows = models.map(model => {
      const value = dimensionValue(model, dimension);
      if (value === null) {
        return '<div class="cmp-bar-item">' +
          '<span class="cmp-bar-name">' + escapeHtml(modelIcon(model)) + ' ' + escapeHtml(model.display) + '</span>' +
          '<span class="cmp-bar-track cmp-bar-track-empty">' + escapeHtml(t('compare.dataInsufficient')) + '</span>' +
          '<span class="cmp-bar-value cmp-bar-value-na">—</span></div>';
      }
      const pct = Math.max(0, Math.min(100, value));
      return '<div class="cmp-bar-item">' +
        '<span class="cmp-bar-name">' + escapeHtml(modelIcon(model)) + ' ' + escapeHtml(model.display) + '</span>' +
        '<span class="cmp-bar-track" role="img" aria-label="' + escapeHtml(model.display + ' ' + dimLabel + ' ' + value.toFixed(1)) + '"><span class="cmp-bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="cmp-bar-value">' + value.toFixed(1) + '</span></div>';
    }).join('');
    return '<section class="cmp-block" aria-labelledby="cmp-block-' + escapeHtml(dimension) + '">' +
      '<div class="cmp-block-head"><h3 id="cmp-block-' + escapeHtml(dimension) + '">' + escapeHtml(dimLabel) + '</h3>' +
      '<span class="cmp-block-note">' + escapeHtml(t('compare.barSort')) + '</span></div>' +
      '<div class="cmp-bars">' + rows + '</div>' +
      sourceFooterHtml(sourcesForDimension(dimension, models)) +
    '</section>';
  }).join('');
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
  pop.className = 'cmp-variant-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('compare.variantOf') + model.display);

  const N = circle.length;
  const size = 200;
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
  positionPopover(pop, trigger, size);
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

function renderAll() {
  renderChips();
  renderModelList();
  renderResults();
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
    timer = setTimeout(() => { searchQuery = cmpSearch.value; renderModelList(); }, 150);
    cmpSearchClear.style.display = cmpSearch.value ? 'block' : 'none';
  });
  cmpSearchClear?.addEventListener('click', () => {
    cmpSearch.value = '';
    searchQuery = '';
    cmpSearchClear.style.display = 'none';
    renderModelList();
    cmpSearch.focus();
  });

  panel.addEventListener('click', event => {
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
        renderChips();
        renderVariantPopover(variantTrigger, canonical);
      }
      return;
    }
    const slot = event.target.closest('[data-cmp-variant-slot]');
    if (slot) {
      const canonical = slot.dataset.cmpVariantModel;
      const degree = slot.dataset.cmpVariantSlot;
      const model = indexMap.get(canonical);
      if (model) {
        const changes = setActiveVariants(model, degree);
        const note = variantNoteFor(model, changes);
        if (note) setCompareModelStatus(note);
      }
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
      renderChips();
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
      syncRadarClass();
      syncModeButtons();
      renderResults();
      return;
    }
    const chartBtn = event.target.closest('[data-cmp-chart]');
    if (chartBtn) {
      chartMode = chartBtn.dataset.cmpChart;
      syncRadarClass();
      syncModeButtons();
      renderResults();
      return;
    }
    const cat = event.target.closest('[data-cmp-cat]');
    if (cat) {
      filterTheme = cat.dataset.cmpCat;
      renderFilterCats();
      renderModelList();
      return;
    }
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
