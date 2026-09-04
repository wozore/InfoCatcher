/**
 * enrichment-core.js —— 候选加工共用机制层：残缺判定纯函数、单条 L1/L2 审核执行、
 * 并发安全落盘防护。enrich（local-enrichment.js）与 repair（min-repair.js）两条流程
 * 共用本层，保证"什么算残缺、怎么执行单条审核、怎么不覆盖人工结论"的语义只有一份。
 */

'use strict';

const {
  l1AiReview,
  l2AiAdvice,
  DEFAULT_AUTO_APPROVE_CONFIDENCE,
  DEFAULT_AUTO_DISCARD_CONFIDENCE,
} = require('./review-v2');
const { hasUsableLocalizedContent } = require('../classify/content-localizer');
const { readMinStore, writeMinStore, revisionOfMinStore } = require('./min-store');

/** 校验并归一为有限的非负整数，非法输入抛错。 */
function nonNegativeInteger(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') throw new Error(`${label} 必须是有限的非负整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} 必须是有限的非负整数`);
  }
  return number;
}

// ═══════════════════════════════════════════════════════════════
// 判定纯函数
// ═══════════════════════════════════════════════════════════════

/**
 * 判定条目是否需要 L1 审核。
 * - 已被丢弃（discarded）或已通过（approved）不需要。
 * - 只有处于 pending（或未审）且尚未产出有效 L1 verdict 时需要。
 */
function needsL1Review(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.reviewed_at) return false;
  if (candidate.review_status === 'discarded' || candidate.review_status === 'approved') {
    return false;
  }
  return !candidate.l1_review || candidate.l1_review.verdict == null;
}

/**
 * 判定条目是否仅缺 L2 人工参考建议（L1 已有有效结论）。
 * - L2 关闭（l2Enabled=false）时恒为 false。
 * - 已有人工审核标记（reviewed_at）或非 pending 状态不需要。
 * - L1 缺失的条目不算——它们走完整 L1→L2 流程。
 */
function needsL2Advice(candidate, l2Enabled = true) {
  if (!l2Enabled) return false;
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.reviewed_at) return false;
  if (candidate.review_status !== 'pending') return false;
  if (needsL1Review(candidate)) return false;
  return !candidate.ai_advice?.verdict;
}

/**
 * 统一的审核工作量判定：缺 L1，或在 L2 开启时缺 L2 建议。
 * countEnrichmentWork / enrich 目标筛选 / repair 判定共用，防止语义漂移。
 */
function needsReviewWork(candidate, options = {}) {
  if (needsL1Review(candidate)) return true;
  return needsL2Advice(candidate, options.l2Enabled !== false);
}

/**
 * 判定条目是否需要生成中文摘要。
 * - 已被丢弃（discarded）不消费算力。
 * - 已有非空白 summary 不需要（含受保护字幕总结——保护只对有效摘要生效）。
 * - 保护标记存在但 summary 为空（字幕总结曾失败）时允许重试补齐。
 * - 必须具备基本输入素材（标题/描述/字幕）。
 */
function needsSummary(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.review_status === 'discarded') return false;
  if (candidate.summary && String(candidate.summary).trim().length > 0) return false;

  const hasSource = Boolean(
    String(candidate.title || '').trim() ||
    String(candidate.description || '').trim() ||
    (typeof candidate.transcript === 'string' && candidate.transcript.trim()) ||
    candidate.transcript?.text
  );
  return hasSource;
}

/**
 * 判定条目是否需要指定语言本地化翻译。
 * - 已被丢弃（discarded）不消费算力。
 * - 已有 localizations[locale] 且非空不需要。
 * - 必须具备基本输入素材（标题或描述）。
 */
function needsLocalize(candidate, locale = 'zh') {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.review_status === 'discarded') return false;

  // 可用判定：字段齐全且非"原样复述"假翻译，假翻译必须重新修复
  if (hasUsableLocalizedContent(candidate, locale)) return false;

  const hasSource = Boolean(
    String(candidate.title || '').trim() ||
    String(candidate.description || '').trim()
  );
  return hasSource;
}

/**
 * 判定条目是否属于残缺条目（初审残缺、L2建议残缺、摘要残缺或翻译残缺）。
 * - 已被丢弃（discarded）不属于修复范围。
 * - 只有非 discarded 且（需要 L1 审核，或作为待审条目缺少有效 L2 建议，或缺少摘要，或缺少本地化翻译）时才需要修复。
 * - 支持通过 options.skipReview / skipSummary / skipLocalize 排除跳过项的残缺判定。
 *
 * @param {string|object} [optionsOrLocale='zh'] - 目标语言代码或配置选项
 */
function needsRepair(candidate, optionsOrLocale = 'zh') {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.review_status === 'discarded') return false;
  const options = typeof optionsOrLocale === 'object' && optionsOrLocale !== null
    ? optionsOrLocale
    : { locale: optionsOrLocale };
  const locale = options.locale || 'zh';
  const l2Enabled = options.l2Enabled !== false;

  if (!options.skipSummary && needsSummary(candidate)) return true;
  if (!options.skipLocalize && needsLocalize(candidate, locale)) return true;
  if (!options.skipReview) {
    if (needsL1Review(candidate)) return true;
    if (needsL2Advice(candidate, l2Enabled)) return true;
  }
  return false;
}

/**
 * 统计候选集中的残缺条目工作量。
 *
 * @returns {{ total: number, review: number, summary: number, localize: number, hasWork: boolean }}
 */
function countRepairWork(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const locale = options.locale || 'zh';
  let total = 0;
  let review = 0;
  let summary = 0;
  let localize = 0;

  for (const c of list) {
    if (needsRepair(c, options)) {
      total += 1;
      if (!options.skipReview && needsReviewWork(c, { l2Enabled: options.l2Enabled !== false })) {
        review += 1;
      }
      if (!options.skipSummary && needsSummary(c)) {
        summary += 1;
      }
      if (!options.skipLocalize && needsLocalize(c, locale)) {
        localize += 1;
      }
    }
  }

  return {
    total,
    review,
    summary,
    localize,
    hasWork: total > 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// 单条 L1/L2 审核执行
// ═══════════════════════════════════════════════════════════════

async function executeCandidateReview(item, config, options = {}) {
  if (item.reviewed_at) return item.review_status;

  const autoApproveConfidence = Number(config?.review?.l1_confidence_auto_approve) || DEFAULT_AUTO_APPROVE_CONFIDENCE;
  const autoDiscardConfidence = Number(config?.review?.l1_confidence_auto_discard) || DEFAULT_AUTO_DISCARD_CONFIDENCE;
  const l2Enabled = !(config?.review?.l2_enabled === false);

  const l1 = await l1AiReview(item, { ...options, config });
  const l1Review = {
    verdict: l1.verdict,
    reasons: l1.reasons || [],
    confidence: l1.confidence || 0,
    llm_error: l1.llm_error || null,
  };

  const highConfidenceApprove = l1.verdict === 'approve' && l1.confidence >= autoApproveConfidence;
  const highConfidenceDiscard = l1.verdict === 'discard' && l1.confidence >= autoDiscardConfidence;

  if (highConfidenceApprove) {
    item.review_status = 'approved';
    item.l1_review = { ...l1Review, reasons: [] };
    item.ai_advice = null;
    delete item.discard_reason;
    delete item.discard_stage;
    return 'approved';
  }

  if (highConfidenceDiscard) {
    item.review_status = 'discarded';
    item.discard_reason = 'ai_discard';
    item.discard_stage = 'l1';
    item.l1_review = { ...l1Review, reasons: [] };
    item.ai_advice = null;
    return 'discarded';
  }

  const advice = l2Enabled
    ? await l2AiAdvice(item, { ...options, config })
    : null;

  item.review_status = 'pending';
  item.l1_review = l1Review;
  item.ai_advice = advice;
  return 'pending';
}

/**
 * 仅补齐 L2 人工参考建议：L1 已有有效结论、只缺建议的条目走这里。
 * - 绝不重新执行 L1，绝不改动 review_status / l1_review（L2 只是建议，不自动分流）。
 * - 已有人工审核标记（reviewed_at）或 L2 关闭时为 no-op。
 */
async function executeL2OnlyAdvice(item, config, options = {}) {
  if (item.reviewed_at) return item.review_status;
  const l2Enabled = options.l2Enabled !== false && !(config?.review?.l2_enabled === false);
  if (!l2Enabled) return item.review_status;
  const advice = await l2AiAdvice(item, { ...options, config });
  item.ai_advice = advice;
  return item.review_status;
}

// ═══════════════════════════════════════════════════════════════
// 并发安全落盘：加工流程与维护者工作台可能并发写候选层
// ═══════════════════════════════════════════════════════════════

function readCurrentStore(options) {
  if (typeof options.readStore === 'function') return options.readStore();
  return readMinStore();
}

/**
 * 把本轮处理过的目标条目安全合并进最新盘上状态（仅出现在并发冲突时）。
 * 合并规则（人工结论优先、只填缺失）：
 *   - fresh 条目已有人工审核标记（reviewed_at）→ 不采纳 AI 审核结论，只补缺失的摘要/翻译；
 *   - fresh 条目仍处于未初审状态 → 采纳本轮 AI 审核结论；
 *   - 摘要只在 fresh 仍缺且不受字幕总结保护时填充；翻译只在 fresh 仍缺时填充；
 *   - fresh 中已被人工 discarded 的条目完全跳过。
 */
function mergeTargetsIntoFreshStore(fresh, targets, options = {}) {
  const locale = options.locale || 'zh';
  const oursById = new Map();
  for (const target of targets || []) {
    if (target && typeof target === 'object' && target.id != null) oursById.set(String(target.id), target);
  }
  let changed = false;
  for (const candidate of fresh.candidates || []) {
    const ours = oursById.get(String(candidate && candidate.id));
    if (!ours || candidate.review_status === 'discarded') continue;

    const stillNeedsReview = !candidate.reviewed_at && needsReviewWork(candidate, { l2Enabled: options.l2Enabled !== false });
    if (stillNeedsReview && ours.l1_review?.verdict && !ours.reviewed_at) {
      candidate.review_status = ours.review_status;
      candidate.l1_review = ours.l1_review;
      candidate.ai_advice = ours.ai_advice;
      if (ours.discard_reason) candidate.discard_reason = ours.discard_reason; else delete candidate.discard_reason;
      if (ours.discard_stage) candidate.discard_stage = ours.discard_stage; else delete candidate.discard_stage;
      changed = true;
    }

    if (!candidate.summary || !String(candidate.summary).trim()) {
      const isProtected = Boolean(candidate.transcript_summarized_at || candidate.transcript_summary_llm === 'deepseek');
      if (!isProtected && ours.summary && ours.summarizer !== 'llm_failed') {
        candidate.summary = ours.summary;
        candidate.summary_key_points = ours.summary_key_points || [];
        candidate.summarizer = ours.summarizer;
        candidate.summary_generated_at = ours.summary_generated_at;
        candidate.summary_input_chars = ours.summary_input_chars;
        candidate.summary_llm_error = null;
        changed = true;
      }
    }

    if (!hasUsableLocalizedContent(candidate, locale) && hasUsableLocalizedContent(ours, locale)) {
      candidate.localizations ||= {};
      candidate.localizations[locale] = ours.localizations[locale];
      candidate.localizations_meta ||= {};
      candidate.localizations_meta[locale] = ours.localizations_meta?.[locale] || candidate.localizations_meta?.[locale];
      changed = true;
    }
  }
  if (changed) fresh.updated_at = new Date().toISOString();
  return fresh;
}

/**
 * 带并发防护的落盘：baseRevision 是本轮开始时的候选层 revision。
 * - 盘上无变化 → CAS 原子写整个 store；
 * - 盘上已被并发修改（如工作台人工审核）→ 重新读取并把本轮目标字段安全合并后写回，绝不覆盖人工结论。
 * - 仅注入 writeStore（离线测试模式）→ 直接透传不做防护；同时注入 readStore 则走完整防护路径（可测）。
 */
function guardedWriteStore(store, baseRevision, targets, runId, options = {}) {
  if (typeof options.writeStore === 'function' && typeof options.readStore !== 'function') {
    options.writeStore(store, runId);
    return { merged: false, baseRevision: revisionOfMinStore(store) };
  }

  const fresh = readCurrentStore(options);
  const freshRevision = revisionOfMinStore(fresh);
  if (freshRevision === baseRevision) {
    try {
      if (typeof options.writeStore === 'function') {
        options.writeStore(store, runId);
      } else {
        writeMinStore(store, runId, { expectedRevision: freshRevision });
      }
      return { merged: false, baseRevision: revisionOfMinStore(store) };
    } catch (error) {
      if (error.code !== 'REVISION_CONFLICT') throw error;
      // 写入瞬间被并发修改 → 落入下方合并路径
    }
  }

  const current = readCurrentStore(options);
  mergeTargetsIntoFreshStore(current, targets, options);
  if (typeof options.writeStore === 'function') {
    options.writeStore(current, runId);
  } else {
    writeMinStore(current, runId);
  }
  return { merged: true, baseRevision: revisionOfMinStore(current) };
}

module.exports = {
  nonNegativeInteger,
  needsL1Review,
  needsL2Advice,
  needsReviewWork,
  needsSummary,
  needsLocalize,
  needsRepair,
  countRepairWork,
  executeCandidateReview,
  executeL2OnlyAdvice,
  guardedWriteStore,
};
