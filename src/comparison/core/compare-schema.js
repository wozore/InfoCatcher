'use strict';

/**
 * compare-schema.js — 模型对比数据管线共享契约（CommonJS）
 *
 * 唯一事实源：docs/manual/comparison-data-contract.md + comparison-data-sources.md。
 * 本模块只放纯函数/常量（无 fs/网络）：源 key、维度键枚举、raw 快照 schema
 * 白名单校验（fail-closed）、各口径归一化函数。
 *
 * 安全：schema 白名单校验 fail-closed —— 必需列缺失/类型不符/越界 → 整文件拒绝
 * （调用方保留旧 raw 快照并 WARN，不阻塞其余源）。只存白名单字段，不存多余列。
 */

const SOURCES = Object.freeze(['openrouter', 'lmarena', 'livebench', 'llm_stats']);

// 契约 §2 维度键枚举（前端 i18n compare.dimension.<key> 与此一致）
const DIMENSION_KEYS = Object.freeze([
  'composite', 'value',
  'expert_knowledge', 'math_reasoning', 'multimodal', 'swe_capability',
  'reasoning', 'coding', 'communication', 'instruction_following',
  'agentic_coding', 'tool_calling', 'long_context',
  'finance', 'legal', 'healthcare',
  'text', 'vision', 'webdev', 'search',
  'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit',
  'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps',
  'agent_tool_hallucination', 'agent_task_outcome_explicit',
]);

// LMArena 拉取 15 个 config（设计定稿；document 不拉，无对应卡片）。
// agent 榜（agent + 5 子维度）用比例分 `score`；其余 9 榜（text/vision/webdev/search/
// 图像/视频）用 Elo `rating`，两套 schema 在 validateLmarenaSnapshot 按 config 分流。
const LMARENA_CONFIGS = Object.freeze([
  'agent', 'text', 'vision', 'webdev', 'search',
  'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit',
  'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps',
  'agent_tool_hallucination', 'agent_task_outcome_explicit',
]);

const LMARENA_AGENT_CONFIGS = Object.freeze([
  'agent', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps',
  'agent_tool_hallucination', 'agent_task_outcome_explicit',
]);
const LMARENA_ELO_CONFIGS = Object.freeze(LMARENA_CONFIGS.filter(config => !LMARENA_AGENT_CONFIGS.includes(config)));

// agent 榜行字段白名单（比例分 schema；CI 上下界与观测数为可空——agent 子榜常为 null）
const LMARENA_AGENT_FIELDS = Object.freeze({
  model_name: 'string',
  organization: 'string',
  license: 'string',
  score: 'number',
  score_ci_lower: 'numberOrNull',
  score_ci_upper: 'numberOrNull',
  observation_count: 'numberOrNull',
  session_count: 'numberOrNull',
  rank: 'number',
  category: 'string',
  leaderboard_publish_date: 'string',
});

// Elo 榜行字段白名单（rating schema；CI 区间/方差/票数可空）
const LMARENA_ELO_FIELDS = Object.freeze({
  model_name: 'string',
  organization: 'string',
  license: 'string',
  rating: 'number',
  rating_lower: 'numberOrNull',
  rating_upper: 'numberOrNull',
  variance: 'numberOrNull',
  vote_count: 'numberOrNull',
  rank: 'number',
  category: 'string',
  leaderboard_publish_date: 'string',
});

// OpenRouter 官方 models API 白名单（raw/openrouter.json 只存这些）
const OPENROUTER_FIELDS = Object.freeze({
  id: 'string',
  name: 'string',
  created: 'numberOrNull',
  hugging_face_id: 'stringOrNull',
  context_length: 'numberOrNull',
  modality: 'stringOrNull',
  input_modalities: 'array',
  output_modalities: 'array',
  prompt: 'number',          // pricing.prompt 转 number
  completion: 'number',
  input_cache_read: 'numberOrNull',
});

// llm-stats（RSC payload）白名单：身份 5 + 规格 4 + 性能 4 + 6 benchmark + 12 index
const LLM_STATS_FIELDS = Object.freeze({
  model_id: 'string',
  name: 'string',
  organization: 'string',
  organization_id: 'stringOrNull',
  license: 'stringOrNull',
  release_date: 'stringOrNull',
  params: 'numberOrNull',
  context: 'numberOrNull',
  multimodal: 'booleanOrNull',
  is_moe: 'booleanOrNull',
  input_price: 'numberOrNull',
  output_price: 'numberOrNull',
  throughput: 'numberOrNull',
  latency: 'numberOrNull',
  aime_2025_score: 'numberOrNull',
  hle_score: 'numberOrNull',
  gpqa_score: 'numberOrNull',
  swe_bench_verified_score: 'numberOrNull',
  swe_bench_pro_score: 'numberOrNull',
  mmmu_pro_score: 'numberOrNull',
  index_general: 'numberOrNull',
  index_reasoning: 'numberOrNull',
  index_math: 'numberOrNull',
  index_code: 'numberOrNull',
  index_search: 'numberOrNull',
  index_communication: 'numberOrNull',
  index_vision: 'numberOrNull',
  index_tool_calling: 'numberOrNull',
  index_long_context: 'numberOrNull',
  index_finance: 'numberOrNull',
  index_legal: 'numberOrNull',
  index_healthcare: 'numberOrNull',
});

// LiveBench 分组列（all_groups.csv 聚合口径；契约 §7 groups 行）
const LIVEBENCH_GROUP_FIELDS = Object.freeze({
  model: 'string',
  reasoning: 'numberOrNull',
  coding: 'numberOrNull',
  math: 'numberOrNull',
  language: 'numberOrNull',
  instruction_following: 'numberOrNull',
  data_analysis: 'numberOrNull',
  agentic_coding: 'numberOrNull',
});

// LiveBench 官网 categories_<release>.json 的类别名 → 分组键
const LIVEBENCH_CATEGORY_MAP = Object.freeze({
  Reasoning: 'reasoning',
  Coding: 'coding',
  Mathematics: 'math',
  Language: 'language',
  'Instruction Following': 'instruction_following',
  IF: 'instruction_following',
  'Data Analysis': 'data_analysis',
  'Agentic Coding': 'agentic_coding',
});

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** LMArena 任一分归一化：`(x+0.3)/0.5×100`，clamp 0-100。 */
function normalizeLmarena(x) {
  return Math.max(0, Math.min(100, ((Number(x) + 0.3) / 0.5) * 100));
}

/** llm-stats index 归一化：`(x+20)/80×100`（-20→0、60→100），clamp 0-100。 */
function normalizeIndex(x) {
  return Math.max(0, Math.min(100, ((Number(x) + 20) / 80) * 100));
}

/** benchmark accuracy 0-1 → 0-100。 */
function normalizeBenchmark(x) {
  return clamp01(Number(x)) * 100;
}

function isType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'numberOrNull': return value == null || (typeof value === 'number' && Number.isFinite(value));
    case 'stringOrNull': return value == null || typeof value === 'string';
    case 'booleanOrNull': return value == null || typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    default: return true;
  }
}

/**
 * 校验并投影一行记录到字段白名单。
 * @param {object} row 源记录（可含多余字段，只投影白名单）
 * @param {object} spec 字段名 → 类型
 * @param {string} tag 错误前缀（文件/行号）
 * @param {string[]} errors 错误收集
 * @param {string[]} [skipKeys] 可选字段（缺失不报错）
 * @returns {object|null} 投影结果；失败返回 null 并 push 错误
 */
function validateRowProjection(row, spec, tag, errors, skipKeys = []) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    errors.push(`${tag} 应为对象`);
    return null;
  }
  const out = {};
  let ok = true;
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === undefined) {
      if (!skipKeys.includes(field)) { errors.push(`${tag}.${field} 缺失`); ok = false; }
      continue;
    }
    if (!isType(value, type)) {
      errors.push(`${tag}.${field} 类型不符（期望 ${type}，实际 ${Array.isArray(value) ? 'array' : typeof value}）`);
      ok = false;
      continue;
    }
    out[field] = value;
  }
  return ok ? out : null;
}

/**
 * raw 快照白名单校验（fail-closed）。
 * @param {object} payload raw 快照 JSON
 * @param {object} options { rowsPath, spec, skipKeys, label }
 * @returns {{ok: boolean, errors: string[], rows: object[]}}
 */
function validateRawRows(payload, { rowsPath, spec, skipKeys = [], label }) {
  const errors = [];
  const rows = rowsPath.reduce((acc, key) => (acc == null ? undefined : acc[key]), payload);
  if (!Array.isArray(rows)) {
    errors.push(`${label}: ${rowsPath.join('.')} 应为数组`);
    return { ok: false, errors, rows: [] };
  }
  const projected = [];
  rows.forEach((row, i) => {
    const result = validateRowProjection(row, spec, `${label} 行[${i}]`, errors, skipKeys);
    if (result) projected.push(result);
  });
  if (errors.length) return { ok: false, errors, rows: projected };
  return { ok: true, errors, rows: projected };
}

/** LMArena raw 校验：顶层 { fetched_at, configs: { config: [行...] } }；按 config 分流 schema。 */
function validateLmarenaSnapshot(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['lmarena raw 顶层应为对象'], configs: {} };
  }
  if (typeof payload.fetched_at !== 'string') errors.push('lmarena raw.fetched_at 缺失');
  const configs = payload.configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    errors.push('lmarena raw.configs 应为对象');
    return { ok: false, errors, configs: {} };
  }
  const projectedConfigs = {};
  for (const config of LMARENA_CONFIGS) {
    const spec = LMARENA_AGENT_CONFIGS.includes(config) ? LMARENA_AGENT_FIELDS : LMARENA_ELO_FIELDS;
    const rows = configs[config];
    if (!Array.isArray(rows)) {
      errors.push(`lmarena raw.configs.${config} 缺失或不是数组`);
      continue;
    }
    const projected = [];
    rows.forEach((row, i) => {
      const result = validateRowProjection(row, spec, `lmarena ${config} 行[${i}]`, errors);
      if (result) projected.push(result);
    });
    projectedConfigs[config] = projected;
  }
  return { ok: errors.length === 0, errors, configs: projectedConfigs };
}

module.exports = {
  SOURCES,
  DIMENSION_KEYS,
  LMARENA_CONFIGS,
  LMARENA_AGENT_CONFIGS,
  OPENROUTER_FIELDS,
  LLM_STATS_FIELDS,
  LIVEBENCH_GROUP_FIELDS,
  LIVEBENCH_CATEGORY_MAP,
  normalizeLmarena,
  normalizeIndex,
  normalizeBenchmark,
  validateRowProjection,
  validateRawRows,
  validateLmarenaSnapshot,
};
