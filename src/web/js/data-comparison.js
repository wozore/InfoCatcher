/**
 * data-comparison.js — 模型对比数据加载与主键对齐
 * 读 data/comparison/integrated/，提供模型索引、详情懒加载与 canonical 路由桥接。
 */

import { getToolCardItems, getToolLevel3Item } from './data-catalog.js';

const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

let viewConfig = null;
let indexData = null;
let indexModels = [];
let indexSeries = [];
let indexMap = new Map();
let dataMap = new Map();
let aliasEntries = [];
let comparisonReady = false;
let comparisonFailed = false;

function buildFallbackSeries(models) {
  const groups = new Map();
  for (const model of models || []) {
    const key = model.series_key || `${model.vendor || 'unknown'}--${model.family || model.identity || model.canonical}`;
    const group = groups.get(key) || {
      series_key: key,
      display: model.series_display || model.family || model.display,
      vendor: model.vendor,
      theme: model.theme,
      member_count: 0,
      model_count: 0,
      max_composite_score: null,
      members: []
    };
    const memberKey = model.member_key || model.canonical;
    let member = group.members.find(item => item.member_key === memberKey);
    if (!member) {
      member = {
        member_key: memberKey,
        display: model.member_display || model.display,
        order: model.member_order || 9999,
        default_canonical: model.canonical,
        variant_count: 0,
        variants: []
      };
      group.members.push(member);
    }
    member.variant_count += 1;
    member.variants.push({
      canonical: model.canonical,
      display: model.display,
      revision: (model.revisions || []).join(', ') || null,
      composite_score: model.composite_score ?? null,
      sources: model.sources || []
    });
    group.model_count += 1;
    group.max_composite_score = Math.max(group.max_composite_score ?? -Infinity, model.composite_score ?? -Infinity);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.member_count = group.members.length;
    for (const member of group.members) {
      member.variants.sort((a, b) => {
        if (a.revision == null && b.revision != null) return -1;
        if (a.revision != null && b.revision == null) return 1;
        return String(b.revision || '').localeCompare(String(a.revision || ''), 'en');
      });
    }
  }
  return [...groups.values()];
}

export const comparisonLoadingPromise = loadComparisonEntry();

export async function loadComparisonEntry() {
  try {
    const [viewResp, indexResp, aliasResp] = await Promise.all([
      fetch('data/comparison/view-config.json'),
      fetch('data/comparison/integrated/index.json'),
      fetch('data/comparison/models-alias.json'),
    ]);
    if (!viewResp.ok || !indexResp.ok || !aliasResp.ok) {
      throw new Error('comparison load failed');
    }
    viewConfig = await viewResp.json();
    indexData = await indexResp.json();
    const aliasPayload = await aliasResp.json();
    aliasEntries = Array.isArray(aliasPayload.entries) ? aliasPayload.entries : [];
    indexModels = Array.isArray(indexData.models) ? indexData.models : [];
    indexSeries = Array.isArray(indexData.series) ? indexData.series : buildFallbackSeries(indexModels);
    indexMap = new Map(indexModels.map(model => [model.canonical, model]));
    comparisonReady = true;
  } catch (error) {
    comparisonFailed = true;
  }
}

let dataLoading = null;

export function ensureComparisonData() {
  if (dataMap.size > 0) return Promise.resolve(dataMap);
  if (dataLoading) return dataLoading;
  dataLoading = fetch('data/comparison/integrated/data.json')
    .then(response => {
      if (!response.ok) throw new Error('integrated/data.json HTTP ' + response.status);
      return response.json();
    })
    .then(data => {
      dataMap = new Map(Object.entries(data.models || {}));
      return dataMap;
    })
    .catch(error => {
      comparisonFailed = true;
      return dataMap;
    });
  return dataLoading;
}

export function getModelData(canonical) {
  return dataMap.get(canonical) || null;
}

export function getModelIndex(canonical) {
  return indexMap.get(canonical) || null;
}

export function slugifyModelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function catalogAliasCanonicalFor(toolKey, title) {
  const needles = [toolKey, slugifyModelName(title), String(title || '').trim().toLowerCase()].filter(Boolean);
  for (const entry of aliasEntries) {
    const aliases = entry.catalog_aliases || [];
    if (aliases.some(alias => needles.includes(String(alias).trim().toLowerCase()))) {
      return entry.model_key || entry.canonical;
    }
  }
  return null;
}

function aliasCanonicalFor(toolKey, title) {
  const needles = [toolKey, slugifyModelName(title)].filter(Boolean);
  for (const entry of aliasEntries) {
    for (const source of SOURCE_ORDER) {
      const aliases = entry.aliases?.[source] || [];
      if (aliases.some(alias => needles.includes(String(alias).toLowerCase().replace(/^[^/]+\//, '')))) {
        return entry.model_key || entry.canonical;
      }
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

export function canonicalForTool(toolId, itemId) {
  const detail = getToolLevel3Item('', toolId) || getToolLevel3Item(toolId, itemId);
  if (!detail || detail.detail_kind !== 'api_model') return null;
  const card = getToolCardItems().find(cardItem => cardItem.detail_ref?.id === detail.id);
  if (!card) return null;
  return bridgeToCanonical(card.title, card.tool_key);
}

export function modelCap() {
  return viewConfig && Number.isInteger(viewConfig.model_cap) ? viewConfig.model_cap : 5;
}

export function getComparisonState() {
  return {
    viewConfig,
    indexData,
    indexModels,
    indexSeries,
    indexMap,
    dataMap,
    comparisonReady,
    comparisonFailed,
    aliasEntries,
  };
}
