'use strict';

/**
 * rebuild-comparison.js — 模型对比 integrated 重建（编排层）
 *
 * 编排多源快照对齐、清洗、过滤、加权综合分与性价比计算，
 * 输出 integrated/index.json 与 data.json。
 */

const fs = require('fs');
const path = require('path');
const { COMPARISON_FILES } = require('../../shared/paths');
const { readCatalogReleaseDates } = require('../../shared/catalog-release-dates');
const { writeReleaseIndex } = require('../../shared/release-index');
const {
  slugify,
  openrouterCanonical,
  llmStatsCanonical,
  lmarenaParse,
  livebenchParse,
  buildAliasMap,
  cleanModelDisplay,
} = require('./rebuild-canonical');
const { collectSourceRecords, SOURCE_ORDER } = require('./rebuild-collector');
const {
  themeOfDimensions,
  computeLmarenaEloBounds,
  buildModelRecord,
} = require('./rebuild-dimensions');
const { normalizedDisplayKey } = require('../identity/model-identity');
const { readExclusionConfig, filterExcludedRecords } = require('../identity/model-exclusions');
const { filterEmptyModels } = require('../identity/empty-model-filter');
const { readSeriesConfig, attachSeriesMetadata, validateSeriesProjection } = require('../series/model-series');
const { buildReleaseLookup, filterByReleaseCutoff, buildSharedReleaseIndex } = require('../series/release-date');

function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadInputs(options = {}) {
  if (options.snapshots) return options.snapshots;
  if (options.dataDir) {
    const read = name => {
      const file = path.join(options.dataDir, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    return {
      openrouter: read('openrouter.json'),
      lmarena: read('lmarena.json'),
      livebench: read('livebench.json'),
      llm_stats: read('llm-stats.json'),
    };
  }
  return {
    openrouter: readJson(COMPARISON_FILES.rawOpenRouter),
    lmarena: readJson(COMPARISON_FILES.rawLmarena),
    livebench: readJson(COMPARISON_FILES.rawLivebench),
    llm_stats: readJson(COMPARISON_FILES.rawLlmStats),
  };
}

function priceAvgPerM(record) {
  const or = record.pricing.openrouter;
  if (or && (or.prompt || or.completion)) {
    const inPerM = Number(or.prompt) * 1e6;
    const outPerM = Number(or.completion) * 1e6;
    return (inPerM + outPerM) / 2;
  }
  const ls = record.pricing.llm_stats;
  if (ls && (ls.input_per_m != null || ls.output_per_m != null)) {
    const nums = [ls.input_per_m, ls.output_per_m].filter(Number.isFinite);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  return null;
}

function computeValues(records) {
  const rawValues = [];
  for (const record of records) {
    if (!record.composite) continue;
    const avg = priceAvgPerM(record);
    if (avg == null || avg <= 0) continue;
    // 价格/性能比跨数量级，先 ln 压缩再 min-max
    record._valueRaw = Math.log(record.composite.score / avg);
    rawValues.push(record._valueRaw);
  }
  if (!rawValues.length) return;
  const min = Math.min(...rawValues);
  const max = Math.max(...rawValues);
  for (const record of records) {
    if (record._valueRaw == null) continue;
    const score = max > min ? ((record._valueRaw - min) / (max - min)) * 100 : 100;
    record.value = { score: round1(score), raw: record._valueRaw, note: 'ln(综合分/平均每M价)' };
    delete record._valueRaw;
  }
}

function enforceUniqueDisplays(models) {
  const groups = new Map();
  for (const model of models) {
    const key = `${model.vendor}::${normalizedDisplayKey(model.display)}`;
    const group = groups.get(key) || [];
    group.push(model);
    groups.set(key, group);
  }
  const collisions = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const model of group) {
      model.display = `${model.display} (${model.identity})`;
    }
    collisions.push({
      vendor: group[0].vendor,
      before: group[0].display.replace(/ \([^)]*\)$/, ''),
      canonicals: group.map(model => model.canonical),
      resolved: true,
    });
  }
  return collisions;
}

function modelSourcePresent(model, source) {
  if (source === 'openrouter') return model.pricing.openrouter != null;
  if (source === 'llm_stats') return model.pricing.llm_stats != null || (model.dimensions && Object.values(model.dimensions).some(dim => dim.source === 'llm_stats'));
  if (source === 'lmarena') return model.lmarena_scores && Object.keys(model.lmarena_scores).length > 0;
  if (source === 'livebench') return model.livebench_scores && Object.keys(model.livebench_scores).length > 0;
  return false;
}

function writeIntegrated(index, data) {
  const dir = path.dirname(COMPARISON_FILES.integratedIndex);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COMPARISON_FILES.integratedIndex, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.writeFileSync(COMPARISON_FILES.integratedData, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeSharedReleaseIndex(models, registry) {
  try {
    const payload = buildSharedReleaseIndex(models, registry);
    writeReleaseIndex(payload.entries);
  } catch {
    // 失败降级不阻塞重建
  }
}

/**
 * 重建 integrated（默认写文件；options.write=false 只返回结果供测试）。
 * @param {object} [options] { snapshots, aliasEntries, write, dataDir }
 * @returns {{ok: boolean, models: object[], errors: string[], index?: object, data?: object}}
 */
function rebuildIntegrated(options = {}) {
  const errors = [];
  const now = options.now || new Date();
  const snapshots = options.snapshots || loadInputs(options);
  const missing = SOURCE_ORDER.filter(source => !snapshots[source]);
  if (missing.length) {
    errors.push(`raw 快照缺失：${missing.join(', ')}（全绿才重建，待修源见上）`);
    return { ok: false, models: [], errors };
  }
  const identityRegistry = options.identityRegistry || options.aliasRegistry || readJson(COMPARISON_FILES.modelsAlias) || { schema_version: 2, entries: [] };
  const aliasEntries = options.aliasEntries || identityRegistry.entries || [];
  const registry = options.aliasEntries ? { ...identityRegistry, entries: aliasEntries } : identityRegistry;
  const records = collectSourceRecords(snapshots, registry, now);
  let exclusionConfig;
  try {
    exclusionConfig = options.exclusionConfig || readExclusionConfig(options.exclusionConfigFile || COMPARISON_FILES.modelExclusions);
  } catch (error) {
    return { ok: false, models: [], errors: [error.message] };
  }
  const filteredRecords = filterExcludedRecords(records, exclusionConfig);
  const cutoffDate = options.cutoffDate || null;
  const releaseLookup = buildReleaseLookup({
    catalogDates: options.catalogDates || readCatalogReleaseDates().entries,
    modelsAlias: registry,
  });
  const retentionResult = filterByReleaseCutoff(filteredRecords.records, cutoffDate, releaseLookup);
  const activeRecords = retentionResult.records;
  const lmarenaEloBounds = computeLmarenaEloBounds(activeRecords);
  const builtModels = Object.values(activeRecords).map(record => buildModelRecord(record, lmarenaEloBounds));
  const displayCollisions = enforceUniqueDisplays(builtModels);
  computeValues(builtModels);
  const { kept: models, filtered: emptyFiltered } = filterEmptyModels(builtModels);
  const seriesConfig = options.seriesConfig || readSeriesConfig(options.seriesConfigFile);
  const seriesProjection = attachSeriesMetadata(models, seriesConfig);
  const seriesErrors = validateSeriesProjection(seriesProjection.series, models);
  if (seriesErrors.length) errors.push(...seriesErrors);

  const modelByCanonical = new Map(models.map(model => [model.canonical, model]));
  for (const [canonical, meta] of seriesProjection.memberMeta) {
    const model = modelByCanonical.get(canonical);
    if (model && meta.member.theme) model.theme = meta.member.theme;
  }

  models.sort((a, b) => String(a.canonical).localeCompare(String(b.canonical)));

  const generatedAt = now.toISOString();
  const sourcesMeta = {};
  sourcesMeta.openrouter = { fetched_at: snapshots.openrouter.fetched_at || generatedAt, count: (snapshots.openrouter.data || []).length };
  sourcesMeta.lmarena = { fetched_at: snapshots.lmarena.fetched_at || generatedAt, count: Object.values(snapshots.lmarena.configs || {}).reduce((sum, rows) => sum + rows.length, 0) };
  sourcesMeta.livebench = { fetched_at: snapshots.livebench.fetched_at || generatedAt, count: (snapshots.livebench.groups || []).length };
  sourcesMeta.llm_stats = { fetched_at: snapshots.llm_stats.fetched_at || generatedAt, count: (snapshots.llm_stats.models || []).length };

  const indexModels = models.map(model => ({
    canonical: model.canonical,
    identity: model.identity,
    family: model.family,
    revisions: model.revisions,
    evaluation_profiles: model.evaluation_profiles,
    offerings: model.offerings,
    display: model.display,
    vendor: model.vendor,
    theme: model.theme,
    series_key: model.series_key,
    series_display: model.series_display,
    member_key: model.member_key,
    member_display: model.member_display,
    member_order: model.member_order,
    member_variant_count: seriesProjection.memberMeta.get(model.canonical)?.member.variant_count || 1,
    has_composite: Boolean(model.composite),
    composite_score: model.composite ? model.composite.score : null,
    degrees: model.degrees,
    sources: SOURCE_ORDER.filter(source => modelSourcePresent(model, source)),
    file: 'data.json',
  }));

  const index = {
    schema_version: 2,
    generated_at: generatedAt,
    model_count: models.length,
    series_count: seriesProjection.series.length,
    sources: sourcesMeta,
    series: seriesProjection.series,
    models: indexModels,
  };
  const data = { schema_version: 2, generated_at: generatedAt, models };

  if (options.write !== false) {
    writeIntegrated(index, data);
    writeSharedReleaseIndex(models, registry);
  }
  return {
    ok: errors.length === 0,
    models,
    errors,
    diagnostics: {
      display_collisions_resolved: displayCollisions,
      series_count: seriesProjection.series.length,
      excluded_models: filteredRecords.excluded,
      empty_filtered_models: emptyFiltered.map(model => model.canonical),
      retention_cutoff_date: cutoffDate,
      retention_filtered_models: retentionResult.filtered,
      retention_retained_null_models: retentionResult.retained_null,
    },
    index,
    data,
  };
}

module.exports = {
  rebuildIntegrated,
  collectSourceRecords,
  slugify,
  openrouterCanonical,
  llmStatsCanonical,
  lmarenaParse,
  livebenchParse,
  buildAliasMap,
  cleanModelDisplay,
  themeOfDimensions,
};
