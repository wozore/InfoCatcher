'use strict';

/**
 * catalog-series-policy.js —— LLM 二级系列分类政策深模块（阶段 1）。
 *
 * 职责边界：纯确定性、零网络、零 AI。负责
 *   - 读取并严格校验厂商政策；
 *   - 规范化 vendor 标识（别名）；
 *   - 按政策把候选模型归类为用途（general_llm / 专用 / 未覆盖）；
 *   - 匹配模型家族、返回该厂商允许的目标二级系列；
 *   - 校验人工 placement 引用（kind / 存在性 / 厂商归属）。
 *
 * 设计红线：
 *   - 未知厂商 / 规则不完整 / 用途无法确认时，绝不允许回退到“以具体模型名建组”。
 *   - 被识别为 general_llm 但厂商没有对应家族规则 → fail_closed。
 *   - 被识别为专用用途（video/image/coding/…）→ 返回 non_general，调用方走专用路径，不建通用组。
 *   - 无法确定用途（uncovered）→ 调用方不得自动建组，标记待人工。
 *
 * 阶段 4 的 AI 分类 Adapter 只输出语义建议，本模块作最终规则门禁；
 * 阶段 2 的迁移 planner 读取本模块的 allowedTargetSeries / 系列规则。均不把 AI 或网络引入本文件。
 */

const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson } = require('../shared/json-store');
const { REF_TARGETS, emptySnapshot } = require('./catalog-contract');

const USAGE_KINDS = Object.freeze([
  'general_llm', 'coding', 'image', 'video', 'audio_realtime',
  'translation', 'omni', 'media', 'subscription', 'tool', 'unknown',
]);

const EVIDENCE_STATUS = Object.freeze(['verified', 'repository_only', 'inferred']);
const COHORTS = Object.freeze(['newest', 'previous']);
const SPLIT_RULES = Object.freeze(['family', 'auto', 'auto_after_4', 'none']);

const DETAIL_REF_KIND = 'tool-level3';

/** 1. 读取政策原始 JSON。 */
function readSeriesPolicy(filePath) {
  const payload = readJson(filePath || CATALOG_GENERATOR_FILES.seriesPolicy, null);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('SERIES_POLICY_INVALID_ROOT');
  }
  return payload;
}

/** 校验成员 id 是否为合法 detail ref 短 id（允许带或不带 tool-level3: 前缀）。 */
function detailKeyOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.startsWith(`${DETAIL_REF_KIND}:`) ? text.slice(DETAIL_REF_KIND.length + 1) : text;
}

/** 把短/完整成员 id 规范为完整 detail ref id。 */
function detailRefIdOf(value) {
  const key = detailKeyOf(value);
  if (!key) return null;
  return `${DETAIL_REF_KIND}:${key}`;
}

const REQUIRED_TOPS = ['schema_version', 'capacity', 'defaults', 'vendor_aliases', 'vendors'];

/** 2. 结构校验：失败返回错误数组，成功返回空数组。 */
function validateSeriesPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['SERIES_POLICY_ROOT_INVALID'];
  }
  for (const top of REQUIRED_TOPS) {
    if (!(top in policy)) errors.push(`SERIES_POLICY_MISSING_TOP:${top}`);
  }
  if (errors.length) return errors;

  if (!Number.isInteger(policy.schema_version) || policy.schema_version < 1) errors.push('SERIES_POLICY_SCHEMA_VERSION_INVALID');
  if (typeof policy.verified_at !== 'string' || !policy.verified_at) errors.push('SERIES_POLICY_VERIFIED_AT_INVALID');

  const cap = policy.capacity;
  if (!cap || !Number.isInteger(cap.merge_up_to) || !Number.isInteger(cap.split_when_member_count_exceeds)) {
    errors.push('SERIES_POLICY_CAPACITY_INVALID');
  } else if (cap.merge_up_to < 1 || cap.split_when_member_count_exceeds < 1 || cap.split_when_member_count_exceeds < cap.merge_up_to) {
    errors.push('SERIES_POLICY_CAPACITY_RANGE_INVALID');
  }

  if (!policy.defaults || typeof policy.defaults !== 'object') errors.push('SERIES_POLICY_DEFAULTS_INVALID');
  if (!policy.vendor_aliases || typeof policy.vendor_aliases !== 'object' || Array.isArray(policy.vendor_aliases)) {
    errors.push('SERIES_POLICY_VENDOR_ALIASES_INVALID');
  }

  if (!Array.isArray(policy.vendors) || !policy.vendors.length) {
    errors.push('SERIES_POLICY_VENDORS_EMPTY');
    return errors;
  }

  const seenVendor = new Set();
  const seenSeriesId = new Set();
  const vendorAliases = policy.vendor_aliases || {};
  for (const alias of Object.values(vendorAliases)) {
    if (!Array.isArray(alias)) errors.push('SERIES_POLICY_ALIAS_NOT_ARRAY');
  }

  for (const vendor of policy.vendors) {
    const vk = vendor && vendor.vendor_key;
    if (!vk || typeof vk !== 'string') { errors.push('SERIES_POLICY_VENDOR_KEY_INVALID'); continue; }
    if (seenVendor.has(vk)) errors.push(`SERIES_POLICY_VENDOR_DUPLICATE:${vk}`);
    seenVendor.add(vk);

    if (!Array.isArray(vendor.families) || !vendor.families.length) {
      errors.push(`SERIES_POLICY_VENDOR_NO_FAMILY:${vk}`);
      continue;
    }
    const seenFamily = new Set();
    for (const family of vendor.families) {
      if (!family || typeof family.family !== 'string' || !family.family) {
        errors.push(`SERIES_POLICY_FAMILY_INVALID:${vk}`);
        continue;
      }
      if (seenFamily.has(family.family)) errors.push(`SERIES_POLICY_FAMILY_DUPLICATE:${vk}:${family.family}`);
      seenFamily.add(family.family);
      if (!USAGE_KINDS.includes(family.usage_kind)) {
        errors.push(`SERIES_POLICY_USAGE_INVALID:${vk}:${family.family}:${family.usage_kind}`);
      }
      if (family.version_axis && typeof family.version_axis !== 'string') errors.push(`SERIES_POLICY_VERSION_AXIS_INVALID:${vk}:${family.family}`);
      if (family.split_rule && !SPLIT_RULES.includes(family.split_rule)) errors.push(`SERIES_POLICY_SPLIT_RULE_INVALID:${vk}:${family.family}:${family.split_rule}`);
      if (family.name_patterns && !Array.isArray(family.name_patterns)) errors.push(`SERIES_POLICY_NAME_PATTERNS_INVALID:${vk}:${family.family}`);

      if (!Array.isArray(family.series) || !family.series.length) {
        errors.push(`SERIES_POLICY_FAMILY_NO_SERIES:${vk}:${family.family}`);
      } else {
        for (const series of family.series) {
          if (!series || typeof series.id !== 'string' || !series.id) errors.push(`SERIES_POLICY_SERIES_ID_INVALID:${vk}:${family.family}`);
          if (series.id && seenSeriesId.has(series.id)) errors.push(`SERIES_POLICY_SERIES_DUPLICATE:${series.id}`);
          if (series.id) seenSeriesId.add(series.id);
          if (typeof series.title !== 'string' || !series.title) errors.push(`SERIES_POLICY_SERIES_TITLE_INVALID:${series.id || vk}`);
          if (!COHORTS.includes(series.cohort)) errors.push(`SERIES_POLICY_SERIES_COHORT_INVALID:${series.id || vk}:${series.cohort}`);
          if (!Array.isArray(series.expected_members)) errors.push(`SERIES_POLICY_SERIES_MEMBERS_INVALID:${series.id || vk}`);
          for (const member of series.expected_members || []) {
            if (detailKeyOf(member) === null) errors.push(`SERIES_POLICY_SERIES_MEMBER_KEY_INVALID:${series.id || vk}:${member}`);
          }
        }
      }

      const ev = family.evidence;
      if (!ev || typeof ev !== 'object' || !EVIDENCE_STATUS.includes(ev.status)) {
        errors.push(`SERIES_POLICY_EVIDENCE_INVALID:${vk}:${family.family}`);
      }
      if (ev && typeof ev.url !== 'string' && typeof ev.title !== 'string') {
        errors.push(`SERIES_POLICY_EVIDENCE_URL_INVALID:${vk}:${family.family}`);
      }
      if (ev && ev.member_status) {
        for (const [key, status] of Object.entries(ev.member_status)) {
          if (!EVIDENCE_STATUS.includes(status)) errors.push(`SERIES_POLICY_EVIDENCE_MEMBER_STATUS_INVALID:${vk}:${key}:${status}`);
        }
      }
    }
  }
  return errors;
}

/** 3. 读取 + 校验，失败抛错（fail-closed）。 */
function loadSeriesPolicy(filePath) {
  const policy = readSeriesPolicy(filePath);
  const errors = validateSeriesPolicy(policy);
  if (errors.length) throw new Error(`SERIES_POLICY_INVALID:${errors.join(',')}`);
  return policy;
}

/** 4. 把任意 vendor 名/别名规范为政策里的 canonical vendor_key。未命中返回 null。 */
function normalizeVendorKey(policy, value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (policy.vendors.some(v => v.vendor_key === text)) return text;
  for (const [canonical, aliases] of Object.entries(policy.vendor_aliases || {})) {
    if (canonical === text) return canonical;
    if (Array.isArray(aliases) && aliases.some(alias => String(alias).toLowerCase() === text)) return canonical;
  }
  return null;
}

/** 5. 获取某厂商政策条目。未命中返回 null。 */
function policyForVendor(policy, vendorKey) {
  const key = String(vendorKey || '').trim().toLowerCase();
  return policy.vendors.find(v => v.vendor_key === key) || null;
}

/** 6. 用候选名匹配厂商下的模型家族。返回 { family, source: 'pattern' } 或在第 2 个参数下的默认 general family 上回退。 */
function matchFamily(policy, vendorPolicy, modelName) {
  if (!vendorPolicy) return null;
  const name = String(modelName || '').toLowerCase();
  for (const family of vendorPolicy.families) {
    const patterns = family.name_patterns;
    if (!Array.isArray(patterns) || !patterns.length) continue;
    if (patterns.some(p => name.includes(String(p).toLowerCase()))) {
      return { family: family.family, source: 'pattern', usage_kind: family.usage_kind };
    }
  }
  return null;
}

/** 按 modality 直接映射用途。 */
function usageFromModality(modality) {
  if (modality === 'video') return 'video';
  if (modality === 'image') return 'image';
  if (modality === 'audio') return 'audio_realtime';
  if (modality === 'text') return 'general_llm';
  return null;
}

/**
 * 7. 判定候选模型的用途分类。
 * @returns {string} 'general_llm' | 具体专用用途 | 'uncovered' | 'subscription' | 'tool' | 'unknown'
 */
function usageKindOf(policy, vendorPolicy, seed) {
  if (!seed?.detail_kind || !seed?.name) return 'unknown';
  if (seed.detail_kind === 'subscription_plan') return 'subscription';
  if (seed.detail_kind === 'tool') {
    const matched = matchFamily(policy, vendorPolicy, seed.name);
    return matched ? matched.usage_kind : 'tool';
  }

  // api_model：先用厂商家族 pattern 匹配（覆盖无 modality 的 pending，如 Realtime/Image/H3/Kling）
  const matched = matchFamily(policy, vendorPolicy, seed.name);
  if (matched) return matched.usage_kind;

  // 其次显式 modality
  if (seed.modality) {
    const usage = usageFromModality(seed.modality);
    if (usage) return usage;
  }

  // 厂商在政策内但无任何家族命中：缺省按该厂商默认，否则 uncovered
  if (vendorPolicy) {
    const defaultFamily = vendorPolicy.families.find(f => f.usage_kind === 'general_llm');
    if (defaultFamily) return 'general_llm';
    return 'uncovered';
  }
  // 厂商不在政策（例如视频专用厂商可灵）→ 未覆盖，调用方不得自动建通用组
  return 'uncovered';
}

/** 8. 返回某厂商某家族允许的目标二级系列（policy_series）。 */
function allowedTargetSeries(policy, vendorPolicy, familyKey) {
  if (!vendorPolicy) return [];
  const family = vendorPolicy.families.find(f => f.family === familyKey);
  return family ? family.series : [];
}

/** 9. 校验人工 placement 引用：kind / 存在性 / 厂商归属。返回 { ok, violations }。 */
function validatePlacementRef(policy, snapshotInput, placement, vendorKey) {
  const violations = [];
  const snapshot = snapshotInput || emptySnapshot();
  const plac = placement || {};

  const level1 = plac.existing_level1_ref;
  if (level1 !== undefined && level1 !== null) {
    const targetKind = REF_TARGETS['vendor-card.level1_ref'];
    if (!level1 || level1.kind !== targetKind) violations.push(`PLACEMENT_L1_KIND_INVALID:${level1 && level1.id}`);
    else {
      const found = (snapshot['vendor-level1'] || []).find(x => x.id === level1.id);
      if (!found) violations.push(`PLACEMENT_L1_NOT_FOUND:${level1.id}`);
      else if (vendorKey && found.vendor_key && found.vendor_key !== vendorKey) violations.push(`PLACEMENT_L1_VENDOR_MISMATCH:${level1.id}`);
    }
  }

  const level2 = plac.existing_level2_ref;
  if (level2 !== undefined && level2 !== null) {
    const targetKind = REF_TARGETS['vendor-level1.level2_refs'];
    if (!level2 || level2.kind !== targetKind) violations.push(`PLACEMENT_L2_KIND_INVALID:${level2 && level2.id}`);
    else {
      const found = (snapshot['vendor-level2'] || []).find(x => x.id === level2.id);
      if (!found) violations.push(`PLACEMENT_L2_NOT_FOUND:${level2.id}`);
      else if (vendorKey && found.vendor_key && found.vendor_key !== vendorKey) violations.push(`PLACEMENT_L2_VENDOR_MISMATCH:${level2.id}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

// ═══════════════════════════════════════════════════════════════
// 确定性 Placement 规划（阶段 4）
// 输出 kind：
//   - 'not_applicable'   非通用 LLM / 无政策厂商 → 调用方走现有路径，不改 seed
//   - 'decision'         目标已定：existing（加入已有组）或 create（用 policy 稳定 id/title 新建）
//   - 'migration_required' 第 4 个成员触发容量拆分 → 阻断普通 Draft，走迁移
//   - 'needs_ai'         政策无法确定 usage/family → 调用方可用 AI 建议作 hint 后重跑
//   - 'fail_closed'      非法/冲突 → 绝不由模型名兜底建组
// ═══════════════════════════════════════════════════════════════

/** 统计某目标系列在快照中的成员数。 */
function memberCountOfSeries(snapshot, seriesId) {
  const l2 = (snapshot['vendor-level2'] || []).find(x => x.id === seriesId);
  return l2 ? (l2.detail_refs || []).length : 0;
}

/** 从目标系列 id 提取 group key（最后一个 `:` 段）。 */
function groupKeyOfSeriesId(seriesId) {
  const parts = String(seriesId || '').split(':');
  return parts[parts.length - 1] || null;
}

/** 由通用家族派生品牌提示词（家族名 + 系列标题词 + 成员名），用于识别已知 LLM 品牌名。 */
function brandHintsOfFamily(familyDef) {
  const hints = [String(familyDef.family || '')];
  for (const series of familyDef.series || []) {
    for (const word of String(series.title || '').split(/\s+/)) if (word && word.length >= 2) hints.push(word);
    for (const member of series.expected_members || []) {
      const key = detailKeyOf(member);
      if (key && key.length >= 2) hints.push(key);
    }
  }
  return [...new Set(hints.map(h => h.toLowerCase()).filter(h => h.length >= 2))];
}

/**
 * 确定性判定候选模型的二级系列归属。
 * @param {object} policy
 * @param {object} snapshot normalized 五模块快照
 * @param {object} candidate seed 片段（name/detail_kind/vendor_key/vendor_name/modality）
 * @param {object} [hint] 可选 AI 建议 { usage_kind, canonical_family, release_cohort, modality }
 * @returns {object}
 */
function planSeriesPlacement(policy, snapshot, candidate, hint) {
  const cap = policy.capacity || {};
  const splitThreshold = cap.split_when_member_count_exceeds;

  // 1. 厂商归一化：无政策厂商 → 现有路径
  const vendorKey = normalizeVendorKey(policy, candidate.vendor_key || candidate.vendor_name);
  if (!vendorKey) return { kind: 'not_applicable', reason: 'VENDOR_NOT_IN_POLICY' };
  const vendorPolicy = policyForVendor(policy, vendorKey);
  if (!vendorPolicy) return { kind: 'not_applicable', reason: 'VENDOR_NOT_IN_POLICY' };
  const generalFamilies = vendorPolicy.families.filter(f => f.usage_kind === 'general_llm');

  // 2. 用途判定：pattern 命中 / 显式 modality / AI hint 均视为高置信；
  //    无任何品牌命中的“默认通用”属歧义，交由 AI 或人工确认。
  const lowerName = String(candidate.name || '').toLowerCase();
  const matched = matchFamily(policy, vendorPolicy, candidate.name);
  const modalityUsage = candidate.modality ? usageFromModality(candidate.modality) : null;
  const brandFamily = generalFamilies.find(gf => brandHintsOfFamily(gf).some(h => lowerName.includes(h)))?.family || null;
  const hintUsage = hint && VALID_USAGE_KIND_FOR_PLACEMENT.includes(hint.usage_kind) ? hint.usage_kind : null;

  let usage = matched?.usage_kind || modalityUsage || hintUsage || (brandFamily ? 'general_llm' : null);
  const confident = Boolean(matched || modalityUsage || hintUsage || brandFamily);

  if (!usage) {
    if (generalFamilies.length) { usage = 'general_llm'; } // 默认通用（歧义，见下）
    else return { kind: 'needs_ai', reason: 'USAGE_UNCOVERED' };
  }
  if (usage === 'uncovered' || usage === 'unknown') return { kind: 'needs_ai', reason: `USAGE_UNKNOWN:${usage}` };
  if (usage !== 'general_llm') return { kind: 'not_applicable', reason: `NOT_GENERAL_LLM:${usage}` };
  if (!confident) return { kind: 'needs_ai', reason: 'USAGE_AMBIGUOUS_DEFAULT' };

  // 3. 家族判定
  let family = matched?.family || brandFamily || (hint && hint.canonical_family) || null;
  if (!family) {
    const generalFamily = generalFamilies[0];
    if (!generalFamily) return { kind: 'fail_closed', code: 'PLACEMENT_NO_GENERAL_FAMILY', vendor: vendorKey };
    family = generalFamily.family;
  }
  const familyDef = vendorPolicy.families.find(f => f.family === family);
  if (!familyDef || familyDef.usage_kind !== 'general_llm') {
    return { kind: 'fail_closed', code: 'PLACEMENT_FAMILY_NOT_GENERAL', vendor: vendorKey, family };
  }

  // 4. 目标系列
  const seriesList = allowedTargetSeries(policy, vendorPolicy, family);
  if (!seriesList.length) return { kind: 'fail_closed', code: 'PLACEMENT_NO_SERIES', vendor: vendorKey, family };

  let target;
  if (seriesList.length === 1) {
    target = seriesList[0];
    // 单系列容量：达到/超过拆分阈值且家族允许拆分 → 第 4 个触发迁移
    const count = memberCountOfSeries(snapshot, target.id);
    const canSplit = familyDef.split_rule === 'auto' || familyDef.split_rule === 'auto_after_4';
    if (canSplit && Number.isInteger(splitThreshold) && count >= splitThreshold) {
      return {
        kind: 'migration_required',
        vendor: vendorKey,
        family,
        series: target,
        reason: `成员数 ${count} ≥ 拆分阈值 ${splitThreshold}`,
      };
    }
  } else {
    // 多系列（newest/last）：按 cohort 选目标
    const cohort = (hint && hint.release_cohort === 'previous') ? 'previous' : 'newest';
    target = seriesList.find(s => s.cohort === cohort) || seriesList[0];
  }

  const exists = (snapshot['vendor-level2'] || []).some(l2 => l2.id === target.id);
  return {
    kind: 'decision',
    vendor: vendorKey,
    family,
    usage_kind: 'general_llm',
    release_cohort: target.cohort,
    target_mode: exists ? 'existing' : 'create',
    target_level2_id: target.id,
    target_level2_title: target.title,
    group_key: groupKeyOfSeriesId(target.id),
    source: hint ? 'ai' : 'policy',
    confidence: hint ? (hint.confidence ?? 1) : 1,
    evidence: [target.id],
  };
}

const VALID_USAGE_KIND_FOR_PLACEMENT = Object.freeze([
  'general_llm', 'coding', 'image', 'video', 'audio_realtime',
  'translation', 'omni', 'media', 'tool', 'subscription',
]);

module.exports = {
  USAGE_KINDS,
  EVIDENCE_STATUS,
  COHORTS,
  SPLIT_RULES,
  readSeriesPolicy,
  validateSeriesPolicy,
  loadSeriesPolicy,
  normalizeVendorKey,
  policyForVendor,
  matchFamily,
  usageKindOf,
  allowedTargetSeries,
  validatePlacementRef,
  planSeriesPlacement,
  memberCountOfSeries,
  groupKeyOfSeriesId,
  brandHintsOfFamily,
  detailKeyOf,
  detailRefIdOf,
};

