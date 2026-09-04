'use strict';

/**
 * catalog-series-placement-ai.js —— 二级系列 AI 语义分类 Adapter（阶段 4）。
 *
 * 职责边界：AI 只输出“语义建议”，不拥有最终归属。
 *   - 输入：候选模型、厂商政策、当前该厂商二级系列与成员摘要、已有登记表元数据；
 *     不要求 Research 阶段才获得的正文摘录，避免 placement→plan→research 循环依赖。
 *   - 输出严格结构：usage_kind / modality / canonical_vendor_key / canonical_family /
 *     major_line / release_cohort / confidence / rationale。
 *   - AI 不直接决定 target ID/标题、不输出 LayerPatch、不负责 split 成员搬迁。
 *
 * 确定性门禁在 catalog-series-policy 的 planSeriesPlacement：
 *   - 已知规则直接由 policy 判定，AI 只处理 usage/family 未知或歧义；
 *   - AI 建议只作为 hint 重跑确定性 planner；低置信、未知家族、跨用途、与政策冲突一律 fail-closed。
 *
 * 编排 resolveSeriesPlacement：
 *   人工 placement（existing_level1/2_ref）最高优先，且必须通过引用校验；
 *   否则确定性判定；needs_ai 时才允许调用 AI，再以 hint 重跑确定性 planner。
 */

const { getProvider, resolveProvider, apiKeyForProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { requestStructuredJson } = require('../../shared/llm-gateway');
const {
  normalizeVendorKey,
  policyForVendor,
  allowedTargetSeries,
  validatePlacementRef,
  planSeriesPlacement,
} = require('./catalog-series-policy');

const VALID_USAGE = Object.freeze([
  'general_llm', 'coding', 'image', 'video', 'audio_realtime',
  'translation', 'omni', 'media', 'tool', 'subscription', 'unknown',
]);

/** 构建 AI 分类输入（纯函数）。 */
function buildSeriesPlacementInput({ candidate, policy, currentSeries }) {
  const vendorKey = normalizeVendorKey(policy, candidate.vendor_key || candidate.vendor_name);
  const vendorPolicy = vendorKey ? policyForVendor(policy, vendorKey) : null;
  return {
    candidate: {
      name: candidate.name,
      detail_kind: candidate.detail_kind || null,
      modality: candidate.modality || null,
      vendor_name: candidate.vendor_name || null,
      vendor_key: candidate.vendor_key || null,
      official_url: candidate.official_url || null,
    },
    policy_scope: vendorPolicy
      ? {
          vendor_key: vendorPolicy.vendor_key,
          families: vendorPolicy.families.map(f => ({
            family: f.family,
            usage_kind: f.usage_kind,
            version_axis: f.version_axis || null,
            name_patterns: f.name_patterns || [],
          })),
        }
      : null,
    current_series: (currentSeries || []).map(s => ({
      id: s.id,
      title: s.title,
      usage: s.usage || null,
      members: (s.members || []).slice(0, 20),
    })),
  };
}

/** 构建 AI 分类指令（纯函数）。 */
function buildSeriesPlacementInstructions() {
  return '你只负责从候选模型名和厂商政策里给出语义分类建议，不决定最终归属。' +
    '规则：' +
    '1) usage_kind 只能取 ' + VALID_USAGE.join('/') + '；通用大语言模型为 general_llm，' +
    '编程/图像/视频/实时语音/翻译/全模态/媒体/工具/套餐等专用用途如实标注，禁止把专用模型当 general_llm。' +
    '2) canonical_vendor_key 只能取政策中已列出的 vendor_key（用别名对应）；政策未覆盖时填 unknown。' +
    '3) canonical_family 只能取当前厂商政策 families 中的 family 名；不确定时填 unknown。' +
    '4) major_line 是厂商自己的主版本标识（如 glm5、qwen3），不要用全局数字猜测。' +
    '5) release_cohort 只能取 newest（当前代）或 previous（紧邻上一代）；无法判断填 unknown。' +
    '6) confidence 为 0~1 的小数，低置信（<0.5）表示建议不可靠。' +
    '7) rationale 用一句话说明依据，必须引用候选名/政策家族名，不许编造 URL。' +
    '输出 JSON：{"usage_kind":string,"modality":string,"canonical_vendor_key":string,' +
    '"canonical_family":string,"major_line":string,"release_cohort":string,' +
    '"confidence":number,"rationale":string}。字段必须是字符串/数字，禁止额外字段。';
}

/** 校验 AI 输出结构。 */
function validateSeriesPlacementValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['usage_kind', 'modality', 'canonical_vendor_key', 'canonical_family', 'major_line', 'release_cohort', 'rationale']
    .every(key => typeof value[key] === 'string')
    && typeof value.confidence === 'number'
    && value.confidence >= 0 && value.confidence <= 1;
}

/**
 * 调用结构化 AI 输出系列分类建议。
 * ledger 必传（requestStructuredJson fail-closed）；缺 → COST_LEDGER_REQUIRED。
 */
async function suggestSeriesPlacement(input, options = {}) {
  const providerName = options.provider || DEFAULT_PROVIDER_NAME;
  const currentProvider = getProvider(providerName) || getProvider(DEFAULT_PROVIDER_NAME);
  const result = await requestStructuredJson({
    kind: 'series_placement',
    instructions: buildSeriesPlacementInstructions(),
    input: JSON.stringify(input),
    maxOutputTokens: options.maxOutputTokens ?? 600,
    ledger: options.ledger,
    validate: validateSeriesPlacementValue,
  }, {
    provider: options.provider,
    model: options.model || currentProvider?.defaultModel,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint,
    fetchImpl: options.fetchImpl,
  });
  if (!result.ok) return result;
  const value = result.value;
  const hint = {
    usage_kind: VALID_USAGE.includes(value.usage_kind) ? value.usage_kind : 'unknown',
    canonical_family: value.canonical_family || null,
    release_cohort: ['newest', 'previous'].includes(value.release_cohort) ? value.release_cohort : null,
    confidence: value.confidence,
  };
  return { ok: true, hint, usage: result.usage, raw: value };
}

/**
 * 编排二级系列归属（阶段 4）。
 * 优先级：人工 placement → 确定性 planner →（needs_ai 且允许时）AI → 以 hint 重跑 planner。
 * @param {object} policy
 * @param {object} snapshot normalized 五模块快照
 * @param {object} candidate seed 片段
 * @param {object} [options]
 *   - allowAi           是否允许调用 AI（默认 false；批量链路由成本确认后放行）
 *   - suggestPlacement  AI 调用注入（测试 mock；缺省回落真实 suggestSeriesPlacement）
 *   - ledger            AI 结构化成本账本（调用 AI 时必传）
 * @returns {Promise<{kind:'manual'|'decision'|'not_applicable'|'migration_required'|'fail_closed'|'needs_ai', ...}>}
 */
async function resolveSeriesPlacement(policy, snapshot, candidate, options = {}) {
  // 0. 已持久化的 placement decision 短路（from-preview/resume 复用，不重复调 AI/重算）
  const cached = candidate?.placement_decision;
  if (cached && cached.target_level2_id) {
    const reflectsExisting = candidate.placement?.existing_level2_ref?.id === cached.target_level2_id;
    const reflectsCreate = cached.target_mode === 'create'
      && candidate.placement?.new_group_title === cached.target_level2_title;
    if (reflectsExisting || reflectsCreate) {
      return {
        kind: 'decision',
        source: 'cached',
        vendor: cached.vendor,
        family: cached.family,
        target_mode: cached.target_mode,
        target_level2_id: cached.target_level2_id,
        target_level2_title: cached.target_level2_title,
        group_key: cached.group_key,
        confidence: 1,
      };
    }
  }
  // 1. 人工 placement：最高优先级，但必须通过引用校验
  if (candidate.placement?.existing_level2_ref || candidate.placement?.existing_level1_ref) {
    const vendorKey = normalizeVendorKey(policy, candidate.vendor_key || candidate.vendor_name);
    const check = validatePlacementRef(policy, snapshot, candidate.placement, vendorKey);
    if (!check.ok) return { kind: 'fail_closed', code: 'PLACEMENT_REF_INVALID', violations: check.violations };
    return {
      kind: 'manual',
      source: 'manual',
      target_level2_id: candidate.placement.existing_level2_ref?.id || null,
      target_level1_id: candidate.placement.existing_level1_ref?.id || null,
    };
  }

  // 2. 确定性判定（零网络零 AI）
  const planned = planSeriesPlacement(policy, snapshot, candidate, null);
  if (planned.kind === 'not_applicable' || planned.kind === 'migration_required' || planned.kind === 'fail_closed') {
    return planned;
  }
  if (planned.kind === 'decision') return planned;

  // 3. needs_ai：仅当显式允许才调用 AI；否则 fail-closed（绝不由模型名兜底建组）
  if (planned.kind !== 'needs_ai') return planned;
  if (!options.allowAi) return { kind: 'fail_closed', code: 'PLACEMENT_MANUAL_REQUIRED', reason: planned.reason };

  const ledger = options.ledger;
  if (!ledger) return { kind: 'fail_closed', code: 'PLACEMENT_LEDGER_REQUIRED' };
  const suggestFn = options.suggestPlacement || suggestSeriesPlacement;
  const input = buildSeriesPlacementInput({
    candidate,
    policy,
    currentSeries: seriesSummaryOf(policy, snapshot, candidate),
  });
  const suggestion = await suggestFn(input, { ...options, ledger });
  if (!suggestion.ok) return { kind: 'fail_closed', code: 'PLACEMENT_AI_FAILED', error: suggestion.error || suggestion.code };

  // 4. 用 AI hint 重跑确定性 planner（AI 只作 hint，最终归属仍由政策重算）
  const hint = {
    usage_kind: suggestion.hint.usage_kind,
    canonical_family: suggestion.hint.canonical_family,
    release_cohort: suggestion.hint.release_cohort,
    confidence: suggestion.hint.confidence,
  };
  const replanned = planSeriesPlacement(policy, snapshot, candidate, hint);
  if (replanned.kind === 'decision' || replanned.kind === 'not_applicable' || replanned.kind === 'migration_required') {
    return { ...replanned, source: 'ai', ai_confidence: suggestion.hint.confidence };
  }
  return { kind: 'fail_closed', code: 'PLACEMENT_AI_NOT_CONFIRMED', reason: replanned.reason };
}

/** 生成当前该厂商通用 LLM 系列及成员摘要，供 AI 输入（不要求研究正文）。 */
function seriesSummaryOf(policy, snapshot, candidate) {
  const vendorKey = normalizeVendorKey(policy, candidate.vendor_key || candidate.vendor_name);
  if (!vendorKey) return [];
  const summary = [];
  for (const l2 of snapshot['vendor-level2'] || []) {
    if (l2.vendor_key !== vendorKey) continue;
    const members = (l2.detail_refs || []).map(ref => {
      const detail = (snapshot['tool-level3'] || []).find(d => d.id === ref.id);
      return detail ? detail.title : ref.id;
    });
    summary.push({ id: l2.id, title: l2.title, members });
  }
  return summary;
}

/** 把 placement decision 应用到 seed 并持久化 decision（供 from-preview/resume 短路）。 */
function applyPlacementToSeed(seed, decision) {
  if (decision.kind === 'not_applicable') return seed; // 现有路径
  if (decision.kind !== 'decision') throw new Error(`PLACEMENT_KIND_NOT_APPLICABLE:${decision.kind}`);
  const existing = { ...(seed.placement || {}), existing_level1_ref: seed.placement?.existing_level1_ref || null };
  if (decision.target_mode === 'existing') {
    seed.placement = {
      existing_level1_ref: existing.existing_level1_ref || { kind: 'vendor-level1', id: `vendor-level1:${decision.vendor}` },
      existing_level2_ref: { kind: 'vendor-level2', id: decision.target_level2_id },
      new_group_title: undefined,
    };
  } else {
    seed.placement = {
      existing_level1_ref: existing.existing_level1_ref || { kind: 'vendor-level1', id: `vendor-level1:${decision.vendor}` },
      existing_level2_ref: null,
      new_group_title: decision.target_level2_title,
    };
    if (decision.group_key) seed.group_key = decision.group_key;
  }
  seed.placement_decision = {
    source: decision.source || 'policy',
    vendor: decision.vendor,
    family: decision.family,
    target_mode: decision.target_mode,
    target_level2_id: decision.target_level2_id,
    target_level2_title: decision.target_level2_title,
    group_key: decision.group_key || null,
    confidence: decision.confidence ?? 1,
  };
  return seed;
}

module.exports = {
  VALID_USAGE,
  buildSeriesPlacementInput,
  buildSeriesPlacementInstructions,
  validateSeriesPlacementValue,
  suggestSeriesPlacement,
  resolveSeriesPlacement,
  seriesSummaryOf,
  applyPlacementToSeed,
};
