'use strict';

/**
 * validate-comparison.js — 模型对比（data/comparison）数据校验
 *
 * 校验 integrated/index.json + data.json 一致性 / canonical 唯一 / composite 与 raw
 * 自洽 / 各维度 0-100 / view-config 与 models-alias 契约形状；raw 快照存在则校验
 * schema（缺失优雅跳过，前端 mock 阶段无 raw 不阻塞）。网络抽检延后（本期不做）。
 * 失败经本模块 fail()/failed 记录，由 validate.js 聚合为最终退出码。
 */

const fs = require('fs');
const { COMPARISON_FILES } = require('../shared/paths');
const {
  SOURCES,
  DIMENSION_KEYS,
  validateRawRows,
  validateLmarenaSnapshot,
  OPENROUTER_FIELDS,
  LLM_STATS_FIELDS,
  LIVEBENCH_GROUP_FIELDS,
} = require('../comparison/compare-schema');

let failed = false;

function fail(message) {
  console.error('❌', message);
  failed = true;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function has(file) {
  return fs.existsSync(file);
}

const RAW_KEY_MAP = { openrouter: 'rawOpenRouter', lmarena: 'rawLmarena', livebench: 'rawLivebench', llm_stats: 'rawLlmStats' };
function rawKeyOf(source) {
  return RAW_KEY_MAP[source];
}

// ═══════════════════════════════════════════════════════════════
// view-config / models-alias
// ═══════════════════════════════════════════════════════════════
function validateViewConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { fail('view-config.json 顶层应为对象'); return; }
  if (data.schema_version !== 1) fail('view-config.json.schema_version 应为 1');
  if (!Array.isArray(data.default_dimensions) || !data.default_dimensions.every(dim => DIMENSION_KEYS.includes(dim))) {
    fail('view-config.json.default_dimensions 应为维度键数组（未知键: ' + JSON.stringify(data.default_dimensions || []) + '）');
  }
  for (const key of ['radar_dimension_cap', 'model_cap']) {
    if (!Number.isInteger(data[key]) || data[key] < 1) fail(`view-config.json.${key} 应为正整数`);
  }
  console.log(`  view-config.json: 默认维度 ${(data.default_dimensions || []).length} 个，通过`);
}

function validateModelsAlias(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { fail('models-alias.json 顶层应为对象'); return; }
  if (!Array.isArray(data.entries)) { fail('models-alias.json.entries 应为数组'); return; }
  for (let i = 0; i < data.entries.length; i++) {
    const entry = data.entries[i];
    if (!entry || typeof entry !== 'object') { fail(`models-alias.json.entries[${i}] 应为对象`); continue; }
    if (!entry.canonical || typeof entry.canonical !== 'string') fail(`models-alias.json.entries[${i}].canonical 应为非空字符串`);
    const aliases = entry.aliases;
    if (!aliases || typeof aliases !== 'object') { fail(`models-alias.json.entries[${i}].aliases 应为对象`); continue; }
    for (const source of Object.keys(aliases)) {
      if (!SOURCES.includes(source)) fail(`models-alias.json.entries[${i}].aliases.${source} 未知源`);
      else if (!Array.isArray(aliases[source]) || !aliases[source].every(alias => typeof alias === 'string')) fail(`models-alias.json.entries[${i}].aliases.${source} 应为字符串数组`);
    }
  }
  console.log(`  models-alias.json: ${data.entries.length} 条登记，通过`);
}

// ═══════════════════════════════════════════════════════════════
// integrated/index.json
// ═══════════════════════════════════════════════════════════════
function validateIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) { fail('integrated/index.json 顶层应为对象'); return; }
  if (index.schema_version !== 1) fail('integrated/index.json.schema_version 应为 1');
  if (!Array.isArray(index.models)) { fail('integrated/index.json.models 应为数组'); return; }
  if (typeof index.model_count === 'number' && index.model_count !== index.models.length) fail(`integrated/index.json.model_count (${index.model_count}) 与 models 长度 (${index.models.length}) 不一致`);

  const seen = new Set();
  for (let i = 0; i < index.models.length; i++) {
    const model = index.models[i];
    if (!model || typeof model !== 'object') { fail(`integrated/index.json.models[${i}] 应为对象`); continue; }
    if (!model.canonical || typeof model.canonical !== 'string') fail(`integrated/index.json.models[${i}].canonical 缺失`);
    if (seen.has(model.canonical)) fail(`integrated/index.json.models[${i}].canonical 重复: ${model.canonical}`);
    seen.add(model.canonical);
    if (typeof model.display !== 'string' || !model.display) fail(`integrated/index.json.models[${i}].display 缺失`);
    if (typeof model.has_composite !== 'boolean') fail(`integrated/index.json.models[${i}].has_composite 应为布尔`);
    if (model.has_composite && !(typeof model.composite_score === 'number' && model.composite_score >= 0 && model.composite_score <= 100)) fail(`integrated/index.json.models[${i}].composite_score 应为 0-100 数值`);
    if (!model.has_composite && model.composite_score != null) fail(`integrated/index.json.models[${i}].composite_score 在无综合分时应为 null`);
    if (!Array.isArray(model.sources) || !model.sources.every(source => SOURCES.includes(source))) fail(`integrated/index.json.models[${i}].sources 应为已知源数组`);
    if (model.file !== 'data.json') fail(`integrated/index.json.models[${i}].file 应为 data.json`);
    if (model.degrees && typeof model.degrees !== 'object') fail(`integrated/index.json.models[${i}].degrees 应为对象`);
  }

  if (index.sources) {
    for (const source of SOURCES) {
      const meta = index.sources[source];
      if (!meta || typeof meta !== 'object') { fail(`integrated/index.json.sources.${source} 缺失`); continue; }
      if (typeof meta.count !== 'number' || meta.count < 0) fail(`integrated/index.json.sources.${source}.count 应为非负整数`);
    }
  }
  console.log(`  integrated/index.json: ${index.models.length} 个模型，通过`);
}

// ═══════════════════════════════════════════════════════════════
// integrated/data.json（与 index 交叉一致性）
// ═══════════════════════════════════════════════════════════════
function validateData(data, index) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { fail('integrated/data.json 顶层应为对象'); return; }
  if (!Array.isArray(data.models)) { fail('integrated/data.json.models 应为数组'); return; }

  const indexCanonicals = new Set((index.models || []).map(model => model.canonical));
  const dataCanonicals = new Set();
  const seen = new Set();

  for (let i = 0; i < data.models.length; i++) {
    const model = data.models[i];
    if (!model || typeof model !== 'object') { fail(`integrated/data.json.models[${i}] 应为对象`); continue; }
    if (!model.canonical || typeof model.canonical !== 'string') fail(`integrated/data.json.models[${i}].canonical 缺失`);
    dataCanonicals.add(model.canonical);
    if (seen.has(model.canonical)) fail(`integrated/data.json.models[${i}].canonical 重复: ${model.canonical}`);
    seen.add(model.canonical);

    // composite 一致性
    if (model.composite) {
      const c = model.composite;
      if (typeof c.score !== 'number' || c.score < 0 || c.score > 100) fail(`integrated/data.json ${model.canonical}.composite.score 应为 0-100 数值`);
      if (c.method === 'proportional_redistribute') {
        if (!c.weights || typeof c.weights !== 'object') fail(`integrated/data.json ${model.canonical}.composite.weights 缺失`);
        else {
          const sum = Object.values(c.weights).reduce((a, b) => a + (Number(b) || 0), 0);
          if (Math.abs(sum - 1) > 0.01) fail(`integrated/data.json ${model.canonical}.composite.weights 之和 (${sum}) 应 ≈ 1`);
          for (const source of Object.keys(c.weights)) if (!SOURCES.includes(source)) fail(`integrated/data.json ${model.canonical}.composite.weights 未知源: ${source}`);
        }
      }
      const indexModel = (index.models || []).find(item => item.canonical === model.canonical);
      if (indexModel) {
        if (indexModel.has_composite !== true) fail(`integrated/data.json ${model.canonical} 有 composite 但 index.has_composite 为 false`);
        if (Math.abs(Number(indexModel.composite_score) - Number(c.score)) > 0.01) fail(`integrated/data.json ${model.canonical} composite.score (${c.score}) 与 index.composite_score (${indexModel.composite_score}) 不一致`);
      }
    } else {
      const indexModel = (index.models || []).find(item => item.canonical === model.canonical);
      if (indexModel && indexModel.has_composite !== false) fail(`integrated/data.json ${model.canonical} 无 composite 但 index.has_composite 为 true`);
    }

    // dimensions 0-100 + 源 + 已知键
    if (model.dimensions && typeof model.dimensions === 'object') {
      for (const [dim, entry] of Object.entries(model.dimensions)) {
        if (!DIMENSION_KEYS.includes(dim)) fail(`integrated/data.json ${model.canonical}.dimensions.${dim} 未知维度键`);
        if (!entry || typeof entry !== 'object') fail(`integrated/data.json ${model.canonical}.dimensions.${dim} 应为对象`);
        else {
          if (!(typeof entry.value === 'number' && entry.value >= 0 && entry.value <= 100)) fail(`integrated/data.json ${model.canonical}.dimensions.${dim}.value 应为 0-100 数值`);
          if (entry.source && !SOURCES.includes(entry.source) && entry.source !== 'composite') fail(`integrated/data.json ${model.canonical}.dimensions.${dim}.source 未知源: ${entry.source}`);
          if (entry.raw === undefined) fail(`integrated/data.json ${model.canonical}.dimensions.${dim}.raw 缺失`);
        }
      }
    }

    if (model.value && (typeof model.value.score !== 'number' || model.value.score < 0 || model.value.score > 100)) fail(`integrated/data.json ${model.canonical}.value.score 应为 0-100 数值`);
    if (model.single_source !== undefined && typeof model.single_source !== 'boolean') fail(`integrated/data.json ${model.canonical}.single_source 应为布尔`);
    if (model.pricing && typeof model.pricing !== 'object') fail(`integrated/data.json ${model.canonical}.pricing 应为对象`);
    if (model.lmarena_scores && typeof model.lmarena_scores !== 'object') fail(`integrated/data.json ${model.canonical}.lmarena_scores 应为对象`);
    if (model.livebench_scores && typeof model.livebench_scores !== 'object') fail(`integrated/data.json ${model.canonical}.livebench_scores 应为对象`);
  }

  for (const canonical of indexCanonicals) {
    if (!dataCanonicals.has(canonical)) fail(`integrated/data.json 缺少 index 中的模型: ${canonical}`);
  }
  for (const canonical of dataCanonicals) {
    if (!indexCanonicals.has(canonical)) fail(`integrated/index.json 缺少 data 中的模型: ${canonical}`);
  }
  console.log(`  integrated/data.json: ${data.models.length} 个模型，通过`);
}

// ═══════════════════════════════════════════════════════════════
// raw 快照（存在则校验 schema；缺失优雅跳过）
// ═══════════════════════════════════════════════════════════════
function validateRaw() {
  const present = SOURCES.filter(source => has(COMPARISON_FILES[rawKeyOf(source)]));
  if (!present.length) { console.log('  comparison raw/: 无快照（管线未首跑），跳过'); return; }
  if (present.length < SOURCES.length) {
    console.warn(`⚠️  comparison raw/: 部分源快照缺失（${SOURCES.filter(s => !present.includes(s)).join(', ')}），缺失项跳过`);
  }

  const check = (label, fn) => {
    try { fn(); } catch (error) { fail(`${label} 校验异常：${error.message}`); }
  };
  check('openrouter', () => {
    const payload = readJson(COMPARISON_FILES.rawOpenRouter);
    const result = validateRawRows(payload, { rowsPath: ['data'], spec: OPENROUTER_FIELDS, label: 'openrouter' });
    if (!result.ok) result.errors.forEach(fail);
    else console.log(`  raw/openrouter.json: ${result.rows.length} 条，通过`);
  });
  check('lmarena', () => {
    const payload = readJson(COMPARISON_FILES.rawLmarena);
    const result = validateLmarenaSnapshot(payload);
    if (!result.ok) result.errors.forEach(fail);
    else {
      const total = Object.values(result.configs).reduce((sum, rows) => sum + rows.length, 0);
      console.log(`  raw/lmarena.json: ${Object.keys(result.configs).length} 个 config / ${total} 行，通过`);
    }
  });
  check('livebench', () => {
    const payload = readJson(COMPARISON_FILES.rawLivebench);
    const result = validateRawRows(payload, { rowsPath: ['groups'], spec: LIVEBENCH_GROUP_FIELDS, skipKeys: ['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding'], label: 'livebench' });
    if (!result.ok) result.errors.forEach(fail);
    else console.log(`  raw/livebench.json: ${result.rows.length} 组，通过`);
  });
  check('llm-stats', () => {
    const payload = readJson(COMPARISON_FILES.rawLlmStats);
    const result = validateRawRows(payload, { rowsPath: ['models'], spec: LLM_STATS_FIELDS, label: 'llm-stats' });
    if (!result.ok) result.errors.forEach(fail);
    else console.log(`  raw/llm-stats.json: ${result.rows.length} 条，通过`);
  });
}

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════
function validateComparison() {
  // integrated 不存在 → 优雅跳过（前端 mock 阶段/未生成）
  if (!has(COMPARISON_FILES.integratedIndex) || !has(COMPARISON_FILES.integratedData)) {
    console.log('  comparison integrated/: 未生成（等待管线重建），跳过');
    return;
  }
  validateViewConfig(readJson(COMPARISON_FILES.viewConfig));
  validateModelsAlias(readJson(COMPARISON_FILES.modelsAlias));
  const index = readJson(COMPARISON_FILES.integratedIndex);
  validateIndex(index);
  validateData(readJson(COMPARISON_FILES.integratedData), index);
  validateRaw();
}

module.exports = {
  validateComparison,
  validateViewConfig,
  validateModelsAlias,
  validateIndex,
  validateData,
  get failed() { return failed; },
};
