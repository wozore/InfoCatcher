'use strict';

/**
 * rebuild-dimensions.js — 评测维度归一化与模型记录组装（纯逻辑）
 */

const {
  LMARENA_CONFIGS,
  LMARENA_AGENT_CONFIGS,
  normalizeLmarena,
  normalizeIndex,
  normalizeBenchmark,
} = require('./compare-schema');
const { normalizeVendor } = require('../identity/model-identity');
const { resolveReleaseDate } = require('../series/release-date');
const { cleanModelDisplay } = require('./rebuild-canonical');
const { SOURCE_ORDER } = require('./rebuild-collector');

const CONFIG_DIMS = new Set(LMARENA_CONFIGS.filter(config => config !== 'agent'));

// 模型类型分类（按评测维度判定，非厂商）：视频生成优先，其次图像生成，再纯视觉理解，其余归通用
function themeOfDimensions(dims) {
  if (!dims) return 'general';
  if (dims.text_to_video || dims.image_to_video || dims.video_edit) return 'video';
  if (dims.text_to_image || dims.image_edit) return 'image';
  if (dims.vision && !dims.text && !dims.reasoning && !dims.coding && !dims.multimodal) return 'vision';
  return 'general';
}

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

function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}

function hasNum(x) {
  return x != null && String(x).trim() !== '' && Number.isFinite(Number(x));
}

function meanOf(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

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
  // release_date：filter 阶段已注解到 entry；直接单测 entry 无注解时回落多源解析（仅 llm-stats/openrouter）
  const releaseInfo = entry.release_date !== undefined
    ? { date: entry.release_date, provenance: entry.release_date_provenance || null }
    : resolveReleaseDate(entry);
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
      available,
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
    theme: themeOfDimensions(dims),
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
    release_date: releaseInfo.date,
    release_date_provenance: releaseInfo.provenance,
    value: null,
  };
  return result;
}

module.exports = {
  themeOfDimensions,
  computeLmarenaEloBounds,
  buildModelRecord,
  normalizeLicense,
};
