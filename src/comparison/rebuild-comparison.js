'use strict';

/**
 * rebuild-comparison.js — 模型对比 integrated 重建（数据管线核心，纯逻辑可测）
 *
 * 主键对齐（统一格式 slug + models-alias 兜底）→ 合并 4 源 → 各维度归一化
 * （契约 §2 口径）→ 预计算加权综合分（缺源按比例重分配权重）→ 性价比 min-max →
 * 写 integrated/index.json + data.json。只消费 raw/ 快照与 models-alias.json；
 * 任一源 raw 缺失 → 拒绝重建（由调度层保证全绿才重建）。
 */

const fs = require('fs');
const path = require('path');
const { COMPARISON_FILES } = require('../shared/paths');
const {
  LMARENA_CONFIGS,
  LMARENA_AGENT_CONFIGS,
  normalizeLmarena,
  normalizeIndex,
  normalizeBenchmark,
} = require('./compare-schema');
const {
  normalizeVendor,
  parseModelNameMetadata,
  stripRevision,
  createModelIdentityResolver,
  normalizedDisplayKey,
} = require('./model-identity');
const { readSeriesConfig, attachSeriesMetadata, validateSeriesProjection } = require('./model-series');
const { readExclusionConfig, filterExcludedRecords } = require('./model-exclusions');
const { filterEmptyModels } = require('./empty-model-filter');
const { normalizeRevision } = require('./revision-date');

const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];
const CONFIG_DIMS = new Set(LMARENA_CONFIGS.filter(config => config !== 'agent'));
const VENDOR_THEMES = {
  midjourney: 'vision', stability: 'vision', blackforestlabs: 'vision', flux: 'vision',
  runway: 'media', sora: 'media', openai: 'general', veo: 'media', pika: 'media', luma: 'media',
};

// llm-stats 的 license 值多为下划线小写 → 统一为契约展示形态
const LICENSE_NORMALIZE = {
  proprietary: 'Proprietary',
  apache_2_0: 'Apache-2.0',
  apache: 'Apache-2.0',
  mit: 'MIT',
  cc_by_nc_4_0: 'CC BY-NC 4.0',
  cc_by_4_0: 'CC BY 4.0',
  llama: 'Llama',
  deepseek: 'DeepSeek License',
};

function normalizeLicense(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim();
  return LICENSE_NORMALIZE[key] || String(raw);
}

// ── 读取 ───────────────────────────────────────────────────────
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

// ── 主键规范化 ─────────────────────────────────────────────────
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-') // 保留点号（gpt-5.6-sol），其余特殊字符统一为连字符
    .replace(/^-+|-+$/g, '');
}

// 日期 token 剥离（尾部或中缀，如 -2025-02-27 / 20250326 / 2025-02 / 202506 / 08-2024 / 26-01-10 / 02-15；
// 分隔符兼容连字符/下划线/空格——lmarena 空格分隔日期如 'Amazon Nova ... 10-09' 也命中）。
// 多版本取最新：同 base 日期变体合并到同一 canonical，先到先得。
function stripCanonicalDates(model) {
  return String(model || '')
    .replace(/[-_\s]\d{4}-\d{2}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{8}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{4}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{6}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{4}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{2}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{2}(?=[-_\s:]|$)/, '');
}

function openrouterCanonical(id) {
  const model = String(id).split('/').pop() || '';
  return slugify(stripCanonicalDates(model));
}

// llm-stats model_id 常带日期（如 amazon-nova-experimental-chat-10-09），统一剥离对齐。
function llmStatsCanonical(modelId) {
  return slugify(stripCanonicalDates(modelId));
}

function openrouterVendor(id) {
  return slugify(String(id).split('/')[0]);
}

// 展示名仅移除发布日期、供应方式与已解析的评测挡位；参数规模、MoE、模式和模态均属于模型身份，必须保留。
function cleanModelDisplay(raw) {
  if (raw == null) return null;
  let name = String(raw).trim();
  if (!name) return null;
  name = name.replace(/\s*\((?:high|low|medium|xhigh|auto|max)(?:-effort)?\)\s*$/i, '');
  name = name.replace(/\s*\((?:\d{4}-\d{2}-\d{2}|\d{2}-\d{4})\)\s*$/i, '');
  name = stripRevision(name);
  name = name.replace(/(?:[-_\s]+)(?:batch|free|fast|latest)\s*$/i, '');
  name = name.replace(/[-_\s]{2,}/g, ' ').replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  return name || null;
}

function lmarenaParse(name) {
  const parsed = parseModelNameMetadata('lmarena', name);
  return {
    base: parsed.model_name,
    degree: parsed.degree,
    evaluation_profile: parsed.evaluation_profile,
  };
}

function livebenchParse(name) {
  const parsed = parseModelNameMetadata('livebench', name);
  return {
    base: slugify(stripRevision(parsed.model_name)),
    degree: parsed.degree,
    evaluation_profile: parsed.evaluation_profile,
  };
}

function buildAliasMap(entries) {
  const map = { openrouter: {}, lmarena: {}, livebench: {}, llm_stats: {} };
  for (const entry of entries || []) {
    for (const source of SOURCE_ORDER) {
      for (const alias of entry.aliases?.[source] || []) {
        map[source][String(alias).toLowerCase()] = entry.canonical;
      }
    }
  }
  return map;
}

function resolveCanonical(aliasMap, source, rawName, autoCanonical) {
  return aliasMap[source][String(rawName).toLowerCase()] || autoCanonical;
}

// ── 源记录收集 ─────────────────────────────────────────────────
function addIdentityMetadata(record, resolved, source, rawName, now = new Date()) {
  if (resolved.revision) record.revisions.add(normalizeRevision(resolved.revision, now));
  if (resolved.evaluation_profile) record.evaluation_profiles.add(resolved.evaluation_profile);
  if (!record.source_names[source]) record.source_names[source] = [];
  if (!record.source_names[source].includes(rawName)) record.source_names[source].push(rawName);
  for (const offering of resolved.offerings) {
    if (!record.offerings[source]) record.offerings[source] = [];
    if (!record.offerings[source].some(entry => entry.kind === offering && entry.raw_name === rawName)) {
      record.offerings[source].push({ kind: offering, raw_name: rawName });
    }
  }
}

function collectSourceRecords(snapshots, identityRegistry = {}, now = new Date()) {
  const registry = Array.isArray(identityRegistry) ? { schema_version: 1, entries: identityRegistry } : identityRegistry;
  const resolveIdentity = createModelIdentityResolver(registry);
  const records = {}; // model_key[@revision] → { identity, vendor, sources }
  const get = resolved => {
    const revision = resolved.revision ? normalizeRevision(resolved.revision, now) : null;
    const recordKey = revision ? `${resolved.model_key}@${revision}` : resolved.model_key;
    if (!records[recordKey]) {
      records[recordKey] = {
        canonical: recordKey,
        identity: resolved.identity,
        family: resolved.family,
        vendor: resolved.vendor,
        revisions: new Set(),
        evaluation_profiles: new Set(),
        offerings: {},
        source_names: {},
        sources: {},
      };
    }
    return records[recordKey];
  };

  // openrouter（无 degree；Batch/Free/Fast/Latest 收拢到主模型）
  for (const item of snapshots.openrouter?.data || []) {
    const resolved = resolveIdentity({ source: 'openrouter', rawName: item.id });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'openrouter', item.id, now);
    const current = rec.sources.openrouter;
    const currentOfferingCount = Number(current?._identityOfferingCount || 0);
    if (!current || resolved.offerings.length < currentOfferingCount ||
      (resolved.offerings.length === currentOfferingCount && Number(item.created || 0) > Number(current.created || 0))) {
      rec.sources.openrouter = { ...item, vendor: resolved.vendor, _identityOfferingCount: resolved.offerings.length };
    }
  }

  // lmarena（per config × degree；agent 榜用 score 比例分，其余 9 榜用 rating Elo）
  for (const config of LMARENA_CONFIGS) {
    const scoreField = LMARENA_AGENT_CONFIGS.includes(config) ? 'score' : 'rating';
    for (const row of snapshots.lmarena?.configs?.[config] || []) {
      const resolved = resolveIdentity({ source: 'lmarena', rawName: row.model_name, vendorHint: row.organization });
      if (resolved.kind !== 'model') continue;
      const rawScore = row[scoreField];
      if (!hasNum(rawScore)) continue;
      const rec = get(resolved);
      addIdentityMetadata(rec, resolved, 'lmarena', row.model_name, now);
      const lmarena = rec.sources.lmarena || (rec.sources.lmarena = {
        configs: {}, profiles: {}, organization: resolved.vendor, license: row.license, degreeOrder: {}, baseName: null,
      });
      if (!lmarena.baseName) lmarena.baseName = resolved.display;
      const degree = resolved.degree || 'base';
      const score = { score: Number(rawScore), rank: row.rank };
      if (resolved.evaluation_profile) {
        const profiles = lmarena.profiles[config] || (lmarena.profiles[config] = {});
        const profileScores = profiles[resolved.evaluation_profile] || (profiles[resolved.evaluation_profile] = {});
        if (!profileScores[degree]) profileScores[degree] = score;
        continue;
      }
      lmarena.configs[config] = lmarena.configs[config] || {};
      if (!lmarena.configs[config][degree]) lmarena.configs[config][degree] = score;
      if (!lmarena.degreeOrder[config]) lmarena.degreeOrder[config] = [];
      if (!lmarena.degreeOrder[config].includes(degree)) lmarena.degreeOrder[config].push(degree);
    }
  }

  // livebench（per degree 组分数）
  for (const row of snapshots.livebench?.groups || []) {
    const resolved = resolveIdentity({ source: 'livebench', rawName: row.model });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'livebench', row.model, now);
    const livebench = rec.sources.livebench || (rec.sources.livebench = { scores: {}, degreeOrder: [] });
    const degree = resolved.degree || 'base';
    if (!livebench.scores[degree]) livebench.scores[degree] = {};
    for (const key of ['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding']) {
      if (hasNum(row[key])) livebench.scores[degree][key] = Number(row[key]);
    }
    if (!livebench.degreeOrder.includes(degree)) livebench.degreeOrder.push(degree);
  }

  // llm_stats（无 degree；model_id 常带日期，统一剥离对齐）
  for (const model of snapshots.llm_stats?.models || []) {
    const resolved = resolveIdentity({ source: 'llm_stats', rawName: model.model_id, vendorHint: model.organization_id || model.organization });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'llm_stats', model.model_id, now);
    if (!rec.sources.llm_stats || !resolved.revision) rec.sources.llm_stats = model;
  }

  return records;
}

// ── 维度归一化与优先级 ──────────────────────────────────────────
function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}

/** 严格数值判有：null/undefined/空串/纯空白 视为无值（规避 Number(null)===0 把缺失字段当真值 0）。 */
function hasNum(x) {
  return x != null && String(x).trim() !== '' && Number.isFinite(Number(x));
}

function meanOf(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** 通用维度取值辅助：candidates 按优先级排列，取第一个有值。 */
function pick(candidates) {
  for (const candidate of candidates) {
    if (candidate && Number.isFinite(candidate.value)) return candidate;
  }
  return null;
}

/** 各 Elo 榜 config 的 score 值域（min/max），供 min-max 归一化到 0-100。 */
function computeLmarenaEloBounds(records) {
  const bounds = {};
  for (const record of Object.values(records)) {
    const lmarena = record.sources.lmarena;
    if (!lmarena) continue;
    for (const config of Object.keys(lmarena.configs)) {
      if (LMARENA_AGENT_CONFIGS.includes(config)) continue;
      let min = bounds[config]?.min ?? Infinity;
      let max = bounds[config]?.max ?? -Infinity;
      for (const entry of Object.values(lmarena.configs[config])) {
        if (entry.score < min) min = entry.score;
        if (entry.score > max) max = entry.score;
      }
      bounds[config] = { min, max };
    }
  }
  return bounds;
}

/** 把 Elo 分归一化到 0-100（min-max；单值退化为 100）。 */
function normalizeEloRange(x, bounds) {
  if (!bounds || bounds.max <= bounds.min) return 100;
  return Math.max(0, Math.min(100, ((x - bounds.min) / (bounds.max - bounds.min)) * 100));
}

function buildModelRecord(entry, lmarenaEloBounds = {}) {
  const { canonical, identity, family, vendor: recordVendor, revisions, evaluation_profiles: evaluationProfiles, offerings, source_names: sourceNames, sources } = entry;
  const lmarena = sources.lmarena;
  const livebench = sources.livebench;
  const llm = sources.llm_stats;
  const or = sources.openrouter;

  // ── 元数据 ──
  const lmDegree = lmarena ? (lmarena.degreeOrder.agent ? lmarena.degreeOrder.agent[0] : Object.values(lmarena.configs)[0] ? Object.keys(lmarena.configs[Object.keys(lmarena.configs)[0]])[0] : 'base') : null;
  const lbDegree = livebench ? livebench.degreeOrder[0] : null;

  const lmarenas = source => (lmarena && lmarena.configs[source] ? lmarena.configs[source] : {});
  const lmarenaScore = (config, degree) => {
    const map = lmarenas(config);
    return map[degree] || map[degree && String(degree).toLowerCase()] || null;
  };
  const livebenchScores = livebench && livebench.scores[lbDegree] ? livebench.scores[lbDegree] : {};
  const lbAvg = meanOf(['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding']
    .map(key => livebenchScores[key]).filter(hasNum).map(Number));

  const baseDisplay = cleanModelDisplay(
    (llm && llm.name) ||
    (or && or.name ? String(or.name).replace(/^[^:]+:\s*/, '') : null) ||
    (lmarena && lmarena.baseName) ||
    identity || canonical
  );
  const display = revisions?.size ? `${baseDisplay} (${[...revisions].sort().join(', ')})` : baseDisplay;
  const vendor = normalizeVendor(recordVendor || (llm && llm.organization_id) || (or && or.vendor) || (lmarena && lmarena.organization) || 'unknown');
  const licenseRaw = (llm && llm.license) || (lmarena && lmarena.license) || null;
  const license = normalizeLicense(licenseRaw);

  const openSource = Boolean(
    (llm && llm.license && String(llm.license).toLowerCase() !== 'proprietary') ||
    (lmarena && lmarena.license && String(lmarena.license).toLowerCase() !== 'proprietary') ||
    (or && or.hugging_face_id)
  );

  const modalities = new Set();
  for (const mode of [...(or?.input_modalities || []), ...(or?.output_modalities || [])]) {
    if (['text', 'image', 'video', 'audio'].includes(mode)) modalities.add(mode);
  }
  if (!modalities.size && llm) {
    modalities.add('text');
    if (llm.multimodal === true) modalities.add('image');
  }

  const degrees = {};
  if (lmarena) {
    const list = [];
    for (const config of LMARENA_CONFIGS) {
      for (const degree of lmarena.degreeOrder[config] || []) {
        if (degree !== 'base' && !list.includes(degree)) list.push(degree);
      }
    }
    if (list.length) degrees.lmarena = list;
  }
  if (livebench) {
    const list = livebench.degreeOrder.filter(degree => degree !== 'base');
    if (list.length) degrees.livebench = list;
  }
  const defaultDegree = {};
  if (lmarena && lmDegree && lmDegree !== 'base') defaultDegree.lmarena = lmDegree;
  if (livebench && lbDegree && lbDegree !== 'base') defaultDegree.livebench = lbDegree;

  // ── 维度 ──
  const dims = {};

  // LMArena 各榜（agent 5 子维度用比例分公式；text/vision/... 用 Elo min-max）
  for (const config of CONFIG_DIMS) {
    const score = lmarenaScore(config, lmDegree);
    if (score && hasNum(score.score)) {
      const value = LMARENA_AGENT_CONFIGS.includes(config)
        ? normalizeLmarena(score.score)
        : normalizeEloRange(score.score, lmarenaEloBounds[config]);
      dims[config] = { value: round1(value), source: 'lmarena', raw: score.score };
    }
  }

  // LiveBench 组 → merged 维度
  if (livebench && lbDegree) {
    const addLb = (key, dim, note) => {
      if (!hasNum(livebenchScores[key])) return;
      const value = Number(livebenchScores[key]);
      dims[dim] = { value: round1(value), source: 'livebench', raw: value, ...(note ? { note } : {}) };
    };
    addLb('reasoning', 'reasoning');
    addLb('coding', 'coding');
    addLb('instruction_following', 'instruction_following');
    addLb('agentic_coding', 'agentic_coding');
  }

  // llm-stats index → merged 维度（优先级低于 LB 的 reasoning/coding 走 pick 覆盖）
  if (llm) {
    const idx = key => (hasNum(llm[key]) ? normalizeIndex(llm[key]) : null);
    const idxRaw = key => (hasNum(llm[key]) ? llm[key] : null);
    const bench = key => (hasNum(llm[key]) ? normalizeBenchmark(llm[key]) : null);
    const benchRaw = key => (hasNum(llm[key]) ? llm[key] : null);

    // 推理/编码：LB 优先、idx 兜底
    for (const [lbKey, dim, idxKey] of [['reasoning', 'reasoning', 'index_reasoning'], ['coding', 'coding', 'index_code']]) {
      if (!dims[dim] && idx(idxKey) != null) dims[dim] = { value: round1(idx(idxKey)), source: 'llm_stats', raw: idxRaw(idxKey), note: idxKey };
    }
    // 沟通/语言：idx 优先、LB language 兜底
    if (!dims.communication) {
      if (idx('index_communication') != null) dims.communication = { value: round1(idx('index_communication')), source: 'llm_stats', raw: idxRaw('index_communication'), note: 'index_communication' };
      else if (hasNum(livebenchScores.language)) dims.communication = { value: round1(Number(livebenchScores.language)), source: 'livebench', raw: Number(livebenchScores.language) };
    }
    // 工具调用 / 长上下文（idx 独有）
    for (const [idxKey, dim] of [['index_tool_calling', 'tool_calling'], ['index_long_context', 'long_context']]) {
      if (idx(idxKey) != null) dims[dim] = { value: round1(idx(idxKey)), source: 'llm_stats', raw: idxRaw(idxKey), note: idxKey };
    }
    // 专业补充
    for (const [idxKey, dim] of [['index_finance', 'finance'], ['index_legal', 'legal'], ['index_healthcare', 'healthcare']]) {
      if (idx(idxKey) != null) dims[dim] = { value: round1(idx(idxKey)), source: 'llm_stats', raw: idxRaw(idxKey), note: idxKey };
    }
    // benchmark 四维
    const mathCandidates = [
      bench('aime_2025_score') != null ? { value: bench('aime_2025_score'), source: 'llm_stats', raw: benchRaw('aime_2025_score'), note: 'aime_2025' } : null,
      hasNum(livebenchScores.math) ? { value: round1(Number(livebenchScores.math)), source: 'livebench', raw: Number(livebenchScores.math), note: 'livebench math' } : null,
      idx('index_math') != null ? { value: idx('index_math'), source: 'llm_stats', raw: idxRaw('index_math'), note: 'index_math' } : null,
    ];
    const math = pick(mathCandidates);
    if (math) dims.math_reasoning = { value: round1(math.value), source: math.source, raw: math.raw, note: math.note };

    const knowCandidates = [
      bench('gpqa_score') != null ? { value: bench('gpqa_score'), source: 'llm_stats', raw: benchRaw('gpqa_score'), note: 'GPQA' } : null,
      bench('hle_score') != null ? { value: bench('hle_score'), source: 'llm_stats', raw: benchRaw('hle_score'), note: 'HLE' } : null,
    ];
    const know = pick(knowCandidates);
    if (know) dims.expert_knowledge = { value: round1(know.value), source: know.source, raw: know.raw, note: know.note };

    const multiCandidates = [
      bench('mmmu_pro_score') != null ? { value: bench('mmmu_pro_score'), source: 'llm_stats', raw: benchRaw('mmmu_pro_score'), note: 'mmmu_pro' } : null,
      idx('index_vision') != null ? { value: idx('index_vision'), source: 'llm_stats', raw: idxRaw('index_vision'), note: 'index_vision' } : null,
    ];
    const multi = pick(multiCandidates);
    if (multi) dims.multimodal = { value: round1(multi.value), source: multi.source, raw: multi.raw, note: multi.note };

    const sweCandidates = [
      bench('swe_bench_pro_score') != null ? { value: bench('swe_bench_pro_score'), source: 'llm_stats', raw: benchRaw('swe_bench_pro_score'), note: 'swe-bench-pro' } : null,
      bench('swe_bench_verified_score') != null ? { value: bench('swe_bench_verified_score'), source: 'llm_stats', raw: benchRaw('swe_bench_verified_score'), note: 'swe-bench-verified' } : null,
    ];
    const swe = pick(sweCandidates);
    if (swe) dims.swe_capability = { value: round1(swe.value), source: swe.source, raw: swe.raw, note: swe.note };
  }

  // ── 综合分（缺源按比例重分配） ──
  const lmAgentScore = lmarenaScore('agent', lmDegree);
  const available = {};
  if (lmAgentScore && hasNum(lmAgentScore.score)) available.lmarena = normalizeLmarena(lmAgentScore.score);
  if (lbAvg != null) available.livebench = lbAvg;
  if (llm && hasNum(llm.index_general)) available.llm_stats = normalizeIndex(llm.index_general);

  let composite = null;
  const baseWeights = (openSource && available.llm_stats != null)
    ? { lmarena: 0.45, livebench: 0.30, llm_stats: 0.25 }
    : { lmarena: 0.65, livebench: 0.35 };
  const usable = SOURCE_ORDER.filter(source => available[source] != null && baseWeights[source] != null);
  if (usable.length) {
    const total = usable.reduce((sum, source) => sum + baseWeights[source], 0);
    const weights = {};
    usable.forEach(source => { weights[source] = Math.round((baseWeights[source] / total) * 10000) / 10000; });
    const score = usable.reduce((sum, source) => sum + weights[source] * available[source], 0);
    composite = {
      score: round1(score),
      weights,
      method: 'proportional_redistribute',
      available, // 源级可用归一化分（前端切挡位重算综合分用；lmarena/livebench 随挡位变，llm_stats 恒定）
      note: usable.length !== Object.keys(baseWeights).length ? '缺源，权重按比例重分配' : null,
    };
  }
  if (composite) dims.composite = { value: composite.score, source: 'composite', raw: composite.score };

  // ── pricing ──
  const pricing = {};
  if (or) {
    pricing.openrouter = {
      prompt: Number(or.prompt) || 0,
      completion: Number(or.completion) || 0,
      input_cache_read: or.input_cache_read != null ? Number(or.input_cache_read) : null,
      currency: 'USD',
      is_listed_price: true,
    };
  }
  if (llm && (llm.input_price != null || llm.output_price != null)) {
    pricing.llm_stats = {
      input_per_m: llm.input_price != null ? Number(llm.input_price) : null,
      output_per_m: llm.output_price != null ? Number(llm.output_price) : null,
    };
  }

  // ── lmarena_scores / livebench_scores（按程度变体的源级原始数据） ──
  const lmarenaScores = {};
  if (lmarena) {
    for (const config of LMARENA_CONFIGS) {
      const map = lmarena.configs[config];
      if (!map) continue;
      const perDegree = {};
      for (const [degree, value] of Object.entries(map)) perDegree[degree] = { score: value.score, rank: value.rank };
      lmarenaScores[config] = perDegree;
    }
  }
  const lmarenaProfiles = {};
  if (lmarena) {
    for (const [config, profiles] of Object.entries(lmarena.profiles || {})) {
      lmarenaProfiles[config] = {};
      for (const [profile, degrees] of Object.entries(profiles)) {
        lmarenaProfiles[config][profile] = {};
        for (const [degree, value] of Object.entries(degrees)) {
          lmarenaProfiles[config][profile][degree] = { score: value.score, rank: value.rank };
        }
      }
    }
  }
  const livebenchScoresOut = {};
  if (livebench) {
    for (const [degree, groups] of Object.entries(livebench.scores)) livebenchScoresOut[degree] = groups;
  }

  const result = {
    canonical,
    identity: identity || canonical,
    family: family || identity || canonical,
    revisions: [...(revisions || [])].sort(),
    evaluation_profiles: [...(evaluationProfiles || [])].sort(),
    offerings: offerings || {},
    source_names: sourceNames || {},
    display,
    vendor,
    theme: VENDOR_THEMES[vendor] || 'general',
    license,
    open_source: openSource,
    is_moe: llm && llm.is_moe != null ? llm.is_moe : null,
    context_length: or?.context_length || llm?.context || null,
    modalities: [...modalities],
    single_source: SOURCE_ORDER.filter(source => sources[source]).length === 1,
    degrees,
    default_degree: defaultDegree,
    composite,
    dimensions: dims,
    lmarena_scores: lmarenaScores,
    lmarena_profiles: lmarenaProfiles,
    livebench_scores: livebenchScoresOut,
    pricing,
    value: null,
  };
  return result;
}

// ── 性价比（综合分 ÷ 平均每 M 价，全表 min-max 归一化） ────────
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
    // 价格/性能比跨数量级（单价差数百倍），线性 min-max 会被超低价模型主导，
    // 旗舰模型全贴 0；先 ln 压缩再 min-max，中段拉开、单调保序。
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

// ── 入口 ───────────────────────────────────────────────────────
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
  const activeRecords = filteredRecords.records;
  const lmarenaEloBounds = computeLmarenaEloBounds(activeRecords);
  const builtModels = Object.values(activeRecords).map(record => buildModelRecord(record, lmarenaEloBounds));
  const displayCollisions = enforceUniqueDisplays(builtModels);
  computeValues(builtModels);
  // 无数据模型自动过滤（代码规则）：identity 全部 revision 无评测数据则移除，有数据自动回归
  const { kept: models, filtered: emptyFiltered } = filterEmptyModels(builtModels);
  const seriesConfig = options.seriesConfig || readSeriesConfig(options.seriesConfigFile);
  const seriesProjection = attachSeriesMetadata(models, seriesConfig);
  const seriesErrors = validateSeriesProjection(seriesProjection.series, models);
  if (seriesErrors.length) errors.push(...seriesErrors);

  // 确定性排序：canonical 字典序（前端再按系列/综合分排序）
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
  }
  return {
    ok: errors.length === 0,
    models,
    errors,
    diagnostics: { display_collisions_resolved: displayCollisions, series_count: seriesProjection.series.length, excluded_models: filteredRecords.excluded, empty_filtered_models: emptyFiltered.map(model => model.canonical) },
    index,
    data,
  };
}

/** 数据记录是否含某源数据。 */
function modelSourcePresent(model, source) {
  if (source === 'openrouter') return model.pricing.openrouter != null;
  if (source === 'llm_stats') return model.pricing.llm_stats != null || model.dimensions && Object.values(model.dimensions).some(dim => dim.source === 'llm_stats');
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

module.exports = {
  rebuildIntegrated,
  buildModelRecord,
  collectSourceRecords,
  computeLmarenaEloBounds,
  slugify,
  openrouterCanonical,
  llmStatsCanonical,
  lmarenaParse,
  livebenchParse,
  buildAliasMap,
  loadInputs,
  cleanModelDisplay,
};
