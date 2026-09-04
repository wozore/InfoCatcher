/**
 * compare-dimensions.js — 模型对比评测维度计算、图表（柱状图/雷达图）与指标渲染
 */

import { t } from './i18n.js';
import { escapeHtml, safeExternalUrl } from './ui-helpers.js';
import { brandIconHtml } from './brand-icons.js';

export const SOURCE_META = {
  openrouter: { label: 'OpenRouter', license: null, url: 'https://openrouter.ai/models', listed: true },
  lmarena: { label: 'LMArena', license: 'CC BY 4.0', url: 'https://arena.ai/leaderboard/agent' },
  livebench: { label: 'LiveBench', license: 'Apache-2.0 / MIT', url: 'https://livebench.ai/' },
  llm_stats: { label: 'LLM Stats', license: null, url: 'https://llm-stats.com/leaderboards/open-llm-leaderboard' },
};
export const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

export const DIM_GROUPS = [
  { key: 'composite', dims: ['composite', 'value'] },
  { key: 'merged', dims: ['reasoning', 'coding', 'communication', 'instruction_following', 'agentic_coding', 'tool_calling', 'long_context'] },
  { key: 'benchmark', dims: ['expert_knowledge', 'math_reasoning', 'multimodal', 'swe_capability'] },
  { key: 'pro', dims: ['finance', 'legal', 'healthcare'] },
  { key: 'lmarena', dims: ['text', 'vision', 'webdev', 'search', 'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit'] },
  { key: 'agent', dims: ['agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit'] },
];

export const ALL_DIMS = DIM_GROUPS.flatMap(group => group.dims);

const DIM_PALETTE = [
  '#4a6fa5', '#c05621', '#2f7d6b', '#9c3d54', '#7a6bb5', '#b8860b',
  '#3d7a4f', '#a85a32', '#456d91', '#8a5a9e', '#5d7a3a', '#b04a5a',
];

export function dimColor(dim) {
  const index = ALL_DIMS.indexOf(dim);
  return DIM_PALETTE[(index >= 0 ? index : 0) % DIM_PALETTE.length];
}

const BROWSE_TOP_N = 10;

export function dimensionValue(model, key) {
  if (!model) return null;
  if (key === 'value') return Number.isFinite(model.value?.score) ? model.value.score : null;
  const dim = model.dimensions?.[key];
  return Number.isFinite(dim?.value) ? dim.value : null;
}

const LB_GROUPS = ['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding'];
const AGENT_CONFIGS = new Set(['agent', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit']);

function round1(x) { return Math.round(Number(x) * 10) / 10; }
function hasNum(x) { return x != null && String(x).trim() !== '' && Number.isFinite(Number(x)); }

function normalizeEloRange(x, bounds) {
  if (!bounds || bounds.max <= bounds.min) return 100;
  return Math.max(0, Math.min(100, ((x - bounds.min) / (bounds.max - bounds.min)) * 100));
}

let eloBoundsCache = null;
function lmarenaEloBounds(dataMap) {
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

export function recomputeDegreesFor(model, activeVariants = {}, dataMap = new Map()) {
  if (!model) return;
  const selectedVariants = activeVariants[model.canonical] || {};
  model.dimensions = model.dimensions || {};
  const bounds = lmarenaEloBounds(dataMap);
  const lmScores = model.lmarena_scores || {};
  for (const config of Object.keys(lmScores)) {
    const degree = selectedVariants.lmarena ?? model.default_degree?.lmarena;
    const entry = lmScores[config]?.[degree];
    if (entry && hasNum(entry.score)) {
      const val = AGENT_CONFIGS.has(config)
        ? Math.max(0, Math.min(100, ((Number(entry.score) + 0.3) / 0.5) * 100))
        : normalizeEloRange(Number(entry.score), bounds[config]);
      model.dimensions[config] = { value: round1(val), score: entry.score, source: 'lmarena' };
    }
  }
  const lbScores = model.livebench_scores || {};
  const lbDegree = selectedVariants.livebench ?? model.default_degree?.livebench;
  const lbData = lbScores[lbDegree];
  if (lbData) {
    for (const group of LB_GROUPS) {
      if (hasNum(lbData[group])) {
        model.dimensions[group] = { value: round1(Number(lbData[group])), score: lbData[group], source: 'livebench' };
      }
    }
  }
  const sourceScores = [];
  const agentScore = model.dimensions.agent?.value;
  if (hasNum(agentScore)) sourceScores.push(Number(agentScore));
  const lbAvgScores = LB_GROUPS.map(g => model.dimensions[g]?.value).filter(hasNum).map(Number);
  if (lbAvgScores.length) sourceScores.push(lbAvgScores.reduce((a, b) => a + b, 0) / lbAvgScores.length);
  if (sourceScores.length) {
    const comp = round1(sourceScores.reduce((a, b) => a + b, 0) / sourceScores.length);
    model.composite = { score: comp, method: 'custom_variants', weights: {} };
    model.composite_score = comp;
  }
}

function priceAvgPerM(model) {
  const openrouter = model.pricing?.openrouter;
  if (!openrouter) return null;
  const prompt = Number(openrouter.prompt);
  const completion = Number(openrouter.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || (prompt === 0 && completion === 0)) return null;
  return (prompt + completion) / 2;
}

export function recomputeValues(models, activeVariants = {}, dataMap = new Map()) {
  for (const model of models) recomputeDegreesFor(model, activeVariants, dataMap);
  const priced = models.map(m => ({ model: m, comp: m.composite?.score, price: priceAvgPerM(m) })).filter(x => Number.isFinite(x.comp) && Number.isFinite(x.price) && x.price > 0);
  if (priced.length < 2) {
    for (const m of models) m.value = { score: null, method: 'insufficient_data' };
    return;
  }
  const rawValues = priced.map(x => ({ ...x, raw: x.comp / Math.log10(x.price + 1.1) }));
  const maxRaw = Math.max(...rawValues.map(x => x.raw));
  const minRaw = Math.min(...rawValues.map(x => x.raw));
  const span = maxRaw - minRaw;
  for (const m of models) {
    const found = rawValues.find(x => x.model === m);
    if (!found) { m.value = { score: null, method: 'missing_price_or_composite' }; continue; }
    const scaled = span > 0 ? ((found.raw - minRaw) / span) * 100 : 100;
    m.value = { score: Math.round(scaled * 10) / 10, method: 'cohort_minmax_log' };
  }
}

export function availableDims(selected, indexMap, dataMap) {
  if (!selected.length) return ALL_DIMS;
  const models = selected.map(canonical => dataMap.get(canonical) || indexMap.get(canonical)).filter(Boolean);
  return ALL_DIMS.filter(dim => models.every(model => dimensionValue(model, dim) !== null));
}

export function renderDimPicker(selected, activeDims, indexMap, dataMap) {
  const container = document.getElementById('cmpDimPicker');
  if (!container) return;
  const available = availableDims(selected, indexMap, dataMap);
  const blocks = DIM_GROUPS.map(group => {
    const groupDims = group.dims.filter(dim => available.includes(dim));
    if (!groupDims.length) return '';
    const chips = groupDims.map(dim => {
      const active = activeDims.includes(dim);
      return '<button class="filter-chip' + (active ? ' active' : '') + '" type="button" data-cmp-dim="' + escapeHtml(dim) + '" aria-pressed="' + active + '">' +
        '<span class="cmp-dim-swatch" style="background:' + dimColor(dim) + '"></span>' +
        escapeHtml(t('compare.dimension.' + dim)) +
      '</button>';
    }).join('');
    return '<div class="cmp-dim-group"><span class="cmp-dim-group-title">' + escapeHtml(t('compare.dimGroup.' + group.key)) + '</span><div class="cmp-dim-chips">' + chips + '</div></div>';
  }).join('');
  container.innerHTML = blocks || '<span class="cmp-no-dims">' + escapeHtml(t('compare.noSharedDims')) + '</span>';
}

function modelIconHtml(model) {
  const meta = { vendorKey: model.vendor, toolKey: model.canonical, modelKey: model.canonical, emoji: '✦' };
  return brandIconHtml(meta);
}

export function sourceFooterHtml(sources) {
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

export function sourcesForDimension(dimension, models) {
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

function sourcesForDims(dims, models) {
  const sources = new Set();
  for (const dim of dims) sourcesForDimension(dim, models).forEach(source => sources.add(source));
  return sources;
}

function renderLegend(dims) {
  const items = dims.map(dim =>
    '<span class="cmp-legend-item" role="listitem"><span class="cmp-legend-swatch" style="background:' + dimColor(dim) + '"></span>' + escapeHtml(t('compare.dimension.' + dim)) + '</span>'
  ).join('');
  return '<div class="cmp-legend" role="list">' + items + '</div>';
}

function renderVerticalPlot(groups) {
  const H = 280;
  const leftPad = 4;
  const rightPad = 8;
  const plotTop = 30;
  const plotBottom = 250;
  const labelY = 268;
  const plotH = plotBottom - plotTop;
  const barW = 22;
  const clusterPad = 10;
  const gap = 30;
  const maxDims = Math.max(1, ...groups.map(group => group.bars.length));
  const groupW = maxDims * barW + clusterPad * 2;
  const totalW = leftPad + groups.length * (groupW + gap) - gap + rightPad;

  const dimMax = {};
  for (const group of groups) {
    for (const bar of group.bars) {
      const v = Number(bar.value);
      if (Number.isFinite(v)) dimMax[bar.dim] = Math.max(dimMax[bar.dim] ?? 0, v);
    }
  }

  const baseline = '<line class="cmp-vplot-baseline" x1="0" y1="' + plotBottom + '" x2="' + totalW + '" y2="' + plotBottom + '" />';
  const groupSvg = groups.map((group, index) => {
    const gx = leftPad + index * (groupW + gap);
    const barsSvg = group.bars.map((bar, barIndex) => {
      const bx = gx + clusterPad + barIndex * barW;
      const v = Number(bar.value);
      if (!Number.isFinite(v) || v <= 0) return '';
      const max = dimMax[bar.dim] || 100;
      const h = Math.max(4, Math.min(plotH, (v / max) * plotH));
      const by = plotBottom - h;
      const color = dimColor(bar.dim);
      return '<g class="cmp-vplot-bar-group">' +
        '<rect class="cmp-vplot-bar" x="' + bx + '" y="' + by + '" width="' + (barW - 1) + '" height="' + h + '" fill="' + color + '" rx="2" />' +
        '<text class="cmp-vplot-val" x="' + (bx + (barW - 1) / 2) + '" y="' + (by - 6) + '" text-anchor="middle">' + v.toFixed(1) + '</text>' +
      '</g>';
    }).join('');
    const midX = gx + groupW / 2;
    const nameLabel = '<text class="cmp-vplot-name" x="' + midX + '" y="' + labelY + '" text-anchor="middle">' + escapeHtml(group.label) + '</text>';
    return '<g class="cmp-vplot-cluster">' + barsSvg + nameLabel + '</g>';
  }).join('');

  return '<div class="cmp-vplot-wrap">' +
    '<svg class="cmp-vplot-svg" viewBox="0 0 ' + totalW + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + escapeHtml(t('compare.barsAria')) + '">' +
      baseline + groupSvg +
    '</svg>' +
  '</div>';
}

export function renderBars(models, dims) {
  const shared = dims.filter(dim => models.every(model => dimensionValue(model, dim) !== null));
  if (!shared.length) return '';
  const groups = models.map(model => ({
    label: model.display,
    icon: modelIconHtml(model),
    bars: shared.map(dim => ({ dim, value: dimensionValue(model, dim) })),
  }));
  return '<section class="cmp-vchart">' +
    '<div class="cmp-vchart-head"><h3>' + escapeHtml(t('compare.barsTitle')) + '</h3>' + renderLegend(shared) + '</div>' +
    renderVerticalPlot(groups) +
    sourceFooterHtml(sourcesForDims(shared, models)) +
  '</section>';
}

export function renderBrowse(dims, dataMap) {
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
      icon: modelIconHtml(item.model),
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

export function renderRadar(models, dims) {
  const shared = dims.filter(dim => models.every(model => dimensionValue(model, dim) !== null));
  if (!shared.length) return '';
  const N = shared.length;
  const cx = 200, cy = 200, R = 130;
  const angles = shared.map((_, i) => (Math.PI * 2 * i) / N - Math.PI / 2);
  const rings = [0.25, 0.5, 0.75, 1.0].map(fraction => {
    const pts = angles.map(angle => (cx + Math.cos(angle) * R * fraction).toFixed(1) + ',' + (cy + Math.sin(angle) * R * fraction).toFixed(1)).join(' ');
    return '<polygon class="cmp-radar-ring" points="' + pts + '" />';
  }).join('');
  const axes = angles.map(angle => {
    const x = (cx + Math.cos(angle) * R).toFixed(1);
    const y = (cy + Math.sin(angle) * R).toFixed(1);
    return '<line class="cmp-radar-axis" x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '" />';
  }).join('');
  const labels = shared.map((dim, i) => {
    const angle = angles[i];
    const lx = cx + Math.cos(angle) * (R + 24);
    const ly = cy + Math.sin(angle) * (R + 24);
    const anchor = Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    return '<text class="cmp-radar-label" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' +
      escapeHtml(t('compare.dimension.' + dim)) +
    '</text>';
  }).join('');
  const colors = ['#2563eb', '#dc2626'];
  const polygons = models.map((model, idx) => {
    const color = colors[idx % colors.length];
    const pts = shared.map((dim, i) => {
      const v = dimensionValue(model, dim) ?? 0;
      const r = (Math.max(0, Math.min(100, v)) / 100) * R;
      return (cx + Math.cos(angles[i]) * r).toFixed(1) + ',' + (cy + Math.sin(angles[i]) * r).toFixed(1);
    }).join(' ');
    return '<polygon class="cmp-radar-area" points="' + pts + '" fill="' + color + '" stroke="' + color + '" />';
  }).join('');
  const legend = '<div class="cmp-legend" role="list">' + models.map((model, idx) =>
    '<span class="cmp-legend-item" role="listitem"><span class="cmp-legend-swatch" style="background:' + colors[idx % colors.length] + '"></span>' + escapeHtml(model.display) + '</span>'
  ).join('') + '</div>';
  return '<section class="cmp-radar-block">' +
    '<div class="cmp-radar-head"><h3>' + escapeHtml(t('compare.radarTitle')) + '</h3>' + legend + '</div>' +
    '<svg class="cmp-radar-svg" viewBox="0 0 400 400" role="img" aria-label="' + escapeHtml(t('compare.radarAria')) + '">' +
      rings + axes + polygons + labels +
    '</svg>' +
    sourceFooterHtml(sourcesForDims(shared, models)) +
  '</section>';
}
