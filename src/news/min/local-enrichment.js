/**
 * local-enrichment.js —— 热点候选本地 Bonsai 初审、摘要与翻译编排（方案 A）
 *
 * 在热点管线中的位置：
 *   供 CLI（min-review enrich）与自动化任务在后台按批次运行本地 Bonsai 模型，
 *   对候选层（min-candidates.json）中尚未处理或处理失败的内容补全初审（L1/L2）、
 *   中文摘要（summary）与标题/描述本地化（localizations.zh）。
 *
 * 核心特性：
 *   1. 纯函数判定：needsL1Review, needsSummary, needsLocalize, countEnrichmentWork
 *   2. 分批处理（默认每批 30 条），每批原子落盘，支持断点续传（中断后重新执行仅处理未完成项）
 *   3. 算力克制：只有非 discarded 的项才消费摘要与翻译算力
 *   4. 依赖注入：writeStore, reviewCandidate, fetchImpl, onBatchDone 便于测试与 CLI 解耦
 */

'use strict';

const {
  l1AiReview,
  l2AiAdvice,
  DEFAULT_AUTO_APPROVE_CONFIDENCE,
  DEFAULT_AUTO_DISCARD_CONFIDENCE,
} = require('./review-v2');
const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates, hasUsableLocalizedContent } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { readMinStore, writeMinStore, revisionOfMinStore } = require('./min-store');
const { getProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/ai-provider-registry');

const DEFAULT_REPAIR_LIMIT = 100;

function nonNegativeInteger(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') throw new Error(`${label} 必须是有限的非负整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} 必须是有限的非负整数`);
  }
  return number;
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// 判定纯函数
// ═══════════════════════════════════════════════════════════════

/**
 * 判定条目是否需要 L1 审核。
 * - 已被丢弃（discarded）或已通过（approved）不需要。
 * - 只有处于 pending（或未审）且尚未产出有效 L1 verdict 时需要。
 *
 * @param {object} candidate - 候选条目
 * @returns {boolean}
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
 *
 * @param {object} candidate - 候选条目
 * @param {boolean} [l2Enabled=true]
 * @returns {boolean}
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
 *
 * @param {object} candidate - 候选条目
 * @returns {boolean}
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
 *
 * @param {object} candidate - 候选条目
 * @param {string} [locale='zh'] - 目标语言代码
 * @returns {boolean}
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
 * @param {object} candidate - 候选条目
 * @param {string|object} [optionsOrLocale='zh'] - 目标语言代码或配置选项
 * @returns {boolean}
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
 * @param {Array<object>} candidates - 候选条目列表
 * @param {object} [options]
 * @param {string} [options.locale='zh']
 * @param {boolean} [options.skipReview]
 * @param {boolean} [options.skipSummary]
 * @param {boolean} [options.skipLocalize]
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

/**
 * 统计候选集在当前选项下的待处理工作量。
 *
 * @param {Array<object>} candidates - 候选条目列表
 * @param {object} [options]
 * @param {boolean} [options.skipReview]
 * @param {boolean} [options.skipSummary]
 * @param {boolean} [options.skipLocalize]
 * @param {boolean} [options.force]
 * @param {boolean} [options.l2Enabled=true] - L2 建议是否计入审核工作量
 * @param {string} [options.locale='zh']
 * @returns {{ total: number, review: number, summary: number, localize: number, hasWork: boolean }}
 */
function countEnrichmentWork(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const locale = options.locale || 'zh';
  const force = options.force === true;
  const l2Enabled = options.l2Enabled !== false;

  let review = 0;
  let summary = 0;
  let localize = 0;

  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const isDiscarded = c.review_status === 'discarded';
    if (isDiscarded) continue;

    if (!options.skipReview) {
      if (force ? (c.review_status === 'pending' && !c.reviewed_at) : needsReviewWork(c, { l2Enabled })) {
        review += 1;
      }
    }
    if (!options.skipSummary) {
      const isProtectedSummary = Boolean(c.transcript_summarized_at || c.transcript_summary_llm === 'deepseek');
      if (force) {
        if (!isProtectedSummary) {
          const hasSource = Boolean(
            String(c.title || '').trim() ||
            String(c.description || '').trim() ||
            (typeof c.transcript === 'string' && c.transcript.trim()) ||
            c.transcript?.text
          );
          if (hasSource) summary += 1;
        }
      } else if (needsSummary(c)) {
        summary += 1;
      }
    }
    if (!options.skipLocalize) {
      if (force) {
        const hasSource = Boolean(
          String(c.title || '').trim() ||
          String(c.description || '').trim()
        );
        if (hasSource) localize += 1;
      } else if (needsLocalize(c, locale)) {
        localize += 1;
      }
    }
  }

  return {
    total: list.length,
    review,
    summary,
    localize,
    hasWork: review > 0 || summary > 0 || localize > 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// 单条 L1/L2 审核处理
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
// 并发安全落盘：repair/enrich 与维护者工作台可能并发写候选层
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
  const l2Enabled = options.l2Enabled !== false;
  const oursById = new Map();
  for (const target of targets || []) {
    if (target && typeof target === 'object' && target.id != null) oursById.set(String(target.id), target);
  }
  let changed = false;
  for (const candidate of fresh.candidates || []) {
    const ours = oursById.get(String(candidate && candidate.id));
    if (!ours || candidate.review_status === 'discarded') continue;

    const stillNeedsReview = !candidate.reviewed_at && needsReviewWork(candidate, { l2Enabled });
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

// ═══════════════════════════════════════════════════════════════
// 核心主流程
// ═══════════════════════════════════════════════════════════════

/**
 * 对候选层执行分批 Enrichment（初审、摘要与翻译）。
 *
 * @param {object} store - min store 对象 ({ candidates: [] })
 * @param {object} [config] - news-config-v2.json 配置对象
 * @param {object} [options]
 * @param {number} [options.batchSize=30] - 每批数量
 * @param {number} [options.concurrency] - 批内并发数，默认读 config.collection.concurrency 兜底 5
 * @param {number} [options.limit] - 处理条数上限
 * @param {boolean} [options.skipReview=false] - 跳过审核
 * @param {boolean} [options.skipSummary=false] - 跳过摘要
 * @param {boolean} [options.skipLocalize=false] - 跳过本地化翻译
 * @param {boolean} [options.force=false] - 强制重新处理
 * @param {boolean} [options.dryRun=false] - 模拟运行不写盘
 * @param {string} [options.locale='zh'] - 目标语言
 * @param {Function} [options.onBatchDone] - 每批完成回调 (batchInfo) => void
 * @param {Function} [options.writeStore] - 写 store 函数注入
 * @param {Function} [options.reviewCandidate] - 审核 mock 注入
 * @param {Function} [options.fetchImpl] - 网络 fetch 注入
 * @returns {Promise<object>} 处理统计结果
 */
async function enrichMinCandidates(store, config = {}, options = {}) {
  const candidates = Array.isArray(store?.candidates) ? store.candidates : [];
  const batchSize = Math.max(1, Number(options.batchSize) || 30);
  const concurrency = Math.max(1, Number(options.concurrency) || Number(config?.collection?.concurrency) || 5);
  const locale = options.locale || 'zh';
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const limit = options.limit != null ? nonNegativeInteger(options.limit, null, 'options.limit') : null;
  const l2Enabled = config?.review?.l2_enabled !== false && options.l2Enabled !== false;
  const apiKey = options.apiKeyLocal || options.apiKey || 'local-bonsai';
  // 本轮开始时的候选层 revision，用于逐批并发安全落盘（每批写回后滚动更新）
  let baseRevision = revisionOfMinStore(store);

  const enrichOptions = {
    ...options,
    apiKey,
    config,
    concurrency,
    locale,
    l2Enabled,
  };

  // 1. 收集所有需要执行任何一项工作的条目
  const targets = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const isDiscarded = c.review_status === 'discarded';
    if (isDiscarded) continue;

    let hasWork = false;
    if (!options.skipReview) {
      if (force ? (c.review_status === 'pending' && !c.reviewed_at) : needsReviewWork(c, { l2Enabled })) hasWork = true;
    }
    if (!options.skipSummary && !hasWork) {
      const isProtectedSummary = Boolean(c.transcript_summarized_at || c.transcript_summary_llm === 'deepseek');
      if (force) {
        if (!isProtectedSummary) {
          const hasSource = Boolean(
            String(c.title || '').trim() ||
            String(c.description || '').trim() ||
            (typeof c.transcript === 'string' && c.transcript.trim()) ||
            c.transcript?.text
          );
          if (hasSource) hasWork = true;
        }
      } else if (needsSummary(c)) {
        hasWork = true;
      }
    }
    if (!options.skipLocalize && !hasWork) {
      if (force) {
        const hasSource = Boolean(
          String(c.title || '').trim() ||
          String(c.description || '').trim()
        );
        if (hasSource) hasWork = true;
      } else if (needsLocalize(c, locale)) {
        hasWork = true;
      }
    }

    if (hasWork) {
      if (limit != null && targets.length >= limit) {
        break;
      }
      targets.push(c);
    }
  }

  const resultStats = {
    totalCandidates: candidates.length,
    targetsCount: targets.length,
    processed: 0,
    reviewed: 0,
    autoApproved: 0,
    autoDiscarded: 0,
    pending: 0,
    summarized: 0,
    localized: 0,
    batches: 0,
    dryRun,
  };

  if (targets.length === 0) {
    return resultStats;
  }

  // 2. 切分成批次
  const batches = [];
  for (let index = 0; index < targets.length; index += batchSize) {
    batches.push(targets.slice(index, index + batchSize));
  }
  resultStats.batches = batches.length;

  // 3. 逐批处理
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const batchStats = {
      reviewed: 0,
      autoApproved: 0,
      autoDiscarded: 0,
      pending: 0,
      summarized: 0,
      localized: 0,
    };

    // ── 步骤 3.1: L1 审核（缺 L1 的走完整 L1→L2 流程）──
    if (!options.skipReview) {
      const l1Targets = batch.filter(c => (force ? (c.review_status === 'pending' && !c.reviewed_at) : needsL1Review(c)));
      await runPool(l1Targets, concurrency, async item => {
        const verdict = await executeCandidateReview(item, config, enrichOptions);
        batchStats.reviewed += 1;
        if (verdict === 'approved') batchStats.autoApproved += 1;
        else if (verdict === 'discarded') batchStats.autoDiscarded += 1;
        else batchStats.pending += 1;
      });

      // 仅缺 L2 建议的条目：只补建议，不重跑 L1、不改状态
      const l2Targets = force ? [] : batch.filter(c => needsL2Advice(c, l2Enabled));
      await runPool(l2Targets, concurrency, async item => {
        await executeL2OnlyAdvice(item, config, enrichOptions);
        batchStats.reviewed += 1;
        batchStats.pending += 1;
      });
    }

    // ── 步骤 3.2: 摘要（仅非 discarded 项；force 失败时回滚旧值） ──
    if (!options.skipSummary) {
      const summaryTargets = batch.filter(c => {
        if (c.review_status === 'discarded') return false;
        const isProtected = Boolean(c.transcript_summarized_at || c.transcript_summary_llm === 'deepseek');
        if (force) return !isProtected;
        return needsSummary(c);
      });

      if (summaryTargets.length > 0) {
        // force 模式：先暂存旧值再删除以触发重跑；模型失败/无结果时恢复，绝不丢既有摘要
        const forceSnapshot = force
          ? summaryTargets.map(c => ({ item: c, summary: c.summary, keyPoints: c.summary_key_points }))
          : [];
        if (force) {
          for (const c of summaryTargets) {
            delete c.summary;
            delete c.summary_key_points;
          }
        }
        const summaryRes = await summarizeCandidates(summaryTargets, enrichOptions);
        batchStats.summarized += summaryRes?.summarized || 0;
        if (force) {
          for (const snap of forceSnapshot) {
            if (!snap.item.summary || !String(snap.item.summary).trim()) {
              if (snap.summary !== undefined) snap.item.summary = snap.summary;
              if (snap.keyPoints !== undefined) snap.item.summary_key_points = snap.keyPoints;
            }
          }
        }
      }
    }

    // ── 步骤 3.3: 本地化翻译（仅非 discarded 项；force 失败时回滚旧值） ──
    if (!options.skipLocalize) {
      const localizeTargets = batch.filter(c => {
        if (c.review_status === 'discarded') return false;
        if (force) return true;
        return needsLocalize(c, locale);
      });

      if (localizeTargets.length > 0) {
        const forceSnapshot = force
          ? localizeTargets.map(c => ({ item: c, loc: c.localizations?.[locale], meta: c.localizations_meta?.[locale] }))
          : [];
        if (force) {
          for (const c of localizeTargets) {
            if (c.localizations) delete c.localizations[locale];
          }
        }
        const localizeRes = await localizeCandidates(localizeTargets, enrichOptions);
        batchStats.localized += localizeRes?.localized || 0;
        if (force) {
          for (const snap of forceSnapshot) {
            if (!hasUsableLocalizedContent(snap.item, locale)) {
              if (snap.loc !== undefined) {
                snap.item.localizations ||= {};
                snap.item.localizations[locale] = snap.loc;
              }
              if (snap.meta !== undefined) {
                snap.item.localizations_meta ||= {};
                snap.item.localizations_meta[locale] = snap.meta;
              }
            }
          }
        }
      }
    }

    // 累加批次统计
    resultStats.processed += batch.length;
    resultStats.reviewed += batchStats.reviewed;
    resultStats.autoApproved += batchStats.autoApproved;
    resultStats.autoDiscarded += batchStats.autoDiscarded;
    resultStats.pending += batchStats.pending;
    resultStats.summarized += batchStats.summarized;
    resultStats.localized += batchStats.localized;

    // ── 步骤 3.4: 并发安全原子落盘 ──
    if (!dryRun) {
      if (store) {
        store.updated_at = new Date().toISOString();
      }
      const writeResult = guardedWriteStore(store, baseRevision, batch, `min-enrich-batch-${batchIndex + 1}`, {
        ...options,
        locale,
        l2Enabled,
      });
      baseRevision = writeResult.baseRevision;
    }

    // 回调通知
    if (typeof options.onBatchDone === 'function') {
      options.onBatchDone({
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        batchSize: batch.length,
        stats: { ...batchStats },
        totalStats: { ...resultStats },
      });
    }
  }

  return resultStats;
}

/**
 * 运行单个通道的初审、摘要与翻译处理。
 * 摘要/翻译首轮后如仍有残缺，延迟 retryDelayMs（默认 5s）后以减半并发自动补做一轮，
 * 吸收限流、网络抖动等瞬时失败（持久失败交由上层合并语义保持诚实不写）。
 * @param {Array<object>} items - 目标条目副本
 * @param {object} config
 * @param {object} channelOpts
 * @returns {Promise<{ reviewed: number, summarized: number, localized: number }>}
 */
async function runRepairChannel(items, config, channelOpts) {
  const stats = { reviewed: 0, summarized: 0, localized: 0 };
  const conc = channelOpts.concurrency || 3;
  const locale = channelOpts.locale || 'zh';
  const retryDelayMs = channelOpts.retryDelayMs ?? 5000;

  // 1. 审核：缺 L1 的走完整流程；仅缺 L2 建议的只补建议（不重跑 L1、不改状态）
  if (!channelOpts.skipReview) {
    const l1Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status === 'discarded' || c.review_status === 'approved') return false;
      return needsL1Review(c);
    });
    const l2Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status !== 'pending') return false;
      return needsL2Advice(c, channelOpts.l2Enabled !== false);
    });
    if (l1Targets.length > 0) {
      await runPool(l1Targets, conc, async item => {
        try {
          await executeCandidateReview(item, config, channelOpts);
          if (item.l1_review?.verdict) stats.reviewed += 1;
        } catch {
          /* 隔离异常 */
        }
      });
    }
    if (l2Targets.length > 0) {
      await runPool(l2Targets, conc, async item => {
        try {
          await executeL2OnlyAdvice(item, config, channelOpts);
          if (item.ai_advice?.verdict) stats.reviewed += 1;
        } catch {
          /* 隔离异常 */
        }
      });
    }
  }

  // 2. 摘要（仅非 discarded 项；保护只对有效摘要生效，空摘要允许重试）
  //    仅外部通道（external）在首轮后仍有残缺时延迟重试一轮（减半并发，吸收限流/网络抖动）；
  //    本地通道失败多为确定性（模型复述/离线），重试无收益只拖时长。
  if (!channelOpts.skipSummary) {
    const summaryTargets = items.filter(c => c.review_status !== 'discarded' && needsSummary(c));
    if (summaryTargets.length > 0) {
      try {
        const res = await summarizeCandidates(summaryTargets, channelOpts);
        stats.summarized = res?.summarized || 0;
      } catch {
        /* 隔离异常 */
      }
      if (channelOpts.external === true && retryDelayMs > 0) {
        const summaryRetryTargets = summaryTargets.filter(c => needsSummary(c));
        if (summaryRetryTargets.length > 0) {
          await sleepMs(retryDelayMs);
          try {
            const retryRes = await summarizeCandidates(summaryRetryTargets, {
              ...channelOpts,
              concurrency: Math.max(1, Math.floor(conc / 2)),
            });
            stats.summarized += retryRes?.summarized || 0;
          } catch {
            /* 隔离异常 */
          }
        }
      }
    }
  }

  // 3. 翻译（仅非 discarded 项）；重试策略同摘要（仅外部通道）
  if (!channelOpts.skipLocalize) {
    const localizeTargets = items.filter(c => {
      if (c.review_status === 'discarded') return false;
      return needsLocalize(c, locale);
    });
    if (localizeTargets.length > 0) {
      try {
        const res = await localizeCandidates(localizeTargets, channelOpts);
        stats.localized = res?.localized || 0;
      } catch {
        /* 隔离异常 */
      }
      if (channelOpts.external === true && retryDelayMs > 0) {
        const localizeRetryTargets = localizeTargets.filter(c => needsLocalize(c, locale));
        if (localizeRetryTargets.length > 0) {
          await sleepMs(retryDelayMs);
          try {
            const retryRes = await localizeCandidates(localizeRetryTargets, {
              ...channelOpts,
              concurrency: Math.max(1, Math.floor(conc / 2)),
            });
            stats.localized += retryRes?.localized || 0;
          } catch {
            /* 隔离异常 */
          }
        }
      }
    }
  }

  return stats;
}

/**
 * 热点初审残缺数据双通道自愈修复机制。
 * - 通道 A（本地 Bonsai 调优）：timeoutMs: 30000, maxDescChars: 1000, concurrency: 3, external: false。
 * - 通道 B（外部 provider，默认 zhipu）：timeoutMs: 15000, concurrency: 5, external: true。
 * - 两通道各自运行互不干扰，合并结果时优先采用本地成功结果（零成本），本地失败则回退外部结果。
 * - 原子落盘，遵守不变式：受保护的字幕总结与已有人工审核标记绝不被覆盖；discarded 绝不进入摘要/翻译修复。
 *
 * @param {object} store - min store 对象 ({ candidates: [] })
 * @param {object} [config] - news-config-v2.json
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function repairIncompleteCandidates(store, config = {}, options = {}) {
  const candidates = Array.isArray(store?.candidates) ? store.candidates : [];
  const locale = options.locale || 'zh';
  const dryRun = options.dryRun === true;
  const l2Enabled = config?.review?.l2_enabled !== false;
  const repairLimit = nonNegativeInteger(options.limit, DEFAULT_REPAIR_LIMIT, 'options.limit');
  // 双通道请求期间的基准 revision，用于并发安全落盘
  const baseRevision = revisionOfMinStore(store);

  // 1. 筛选出残缺条目
  const rawTargets = candidates.filter(c => needsRepair(c, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }));
  const targets = rawTargets.slice(0, repairLimit);

  const resultStats = {
    totalTargets: targets.length,
    repairedReview: 0,
    repairedSummary: 0,
    repairedLocalize: 0,
    channelASuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    channelBSuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    remainingIncomplete: 0,
  };

  if (targets.length === 0) {
    resultStats.remainingIncomplete = countRepairWork(candidates, {
      locale,
      l2Enabled,
      skipReview: options.skipReview === true,
      skipSummary: options.skipSummary === true,
      skipLocalize: options.skipLocalize === true,
    }).total;
    return resultStats;
  }

  // 2. 双通道数据深拷贝隔离
  const targetsA = structuredClone(targets);
  const targetsB = structuredClone(targets);

  // 3. 通道参数配置（通道 B 外部 provider 跟随全局开关，密钥按 provider 读取）
  const externalProvider = options.providerB || options.provider || DEFAULT_PROVIDER_NAME;
  const externalProviderInfo = getProvider(externalProvider) || getProvider(DEFAULT_PROVIDER_NAME);
  const channelAOpts = {
    ...options,
    timeoutMs: options.channelA?.timeoutMs ?? 30000,
    maxDescChars: options.channelA?.maxDescChars ?? 1000,
    concurrency: options.channelA?.concurrency ?? 3,
    l2Enabled,
    external: false,
    apiKey: options.apiKeyA || 'local-bonsai',
    fetchImpl: options.fetchImplA || options.fetchImpl,
    reviewCandidate: options.reviewCandidateA || options.reviewCandidate,
    locale,
    config,
  };

  const externalApiKey = options.apiKeyB || options.apiKey || process.env[externalProviderInfo.apiKeyEnv];
  const channelBOpts = {
    ...options,
    timeoutMs: options.channelB?.timeoutMs ?? 15000,
    concurrency: options.channelB?.concurrency ?? 5,
    l2Enabled,
    external: true,
    provider: externalProvider,
    apiKey: externalApiKey,
    // 缺密钥时外部调用必然失败（missing_api_key 非瞬时错误），关闭重试避免无谓延迟
    retryDelayMs: externalApiKey ? (options.retryDelayMs ?? 5000) : 0,
    fetchImpl: options.fetchImplB || options.fetchImpl,
    reviewCandidate: options.reviewCandidateB || options.reviewCandidate,
    locale,
    config,
  };

  // 4. 双通道并行独立执行
  const [statsA, statsB] = await Promise.all([
    runRepairChannel(targetsA, config, channelAOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 })),
    options.externalEnabled === false
      ? Promise.resolve({ reviewed: 0, summarized: 0, localized: 0 })
      : runRepairChannel(targetsB, config, channelBOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 })),
  ]);

  resultStats.channelASuccesses = statsA;
  resultStats.channelBSuccesses = statsB;

  // 5. 结果合并：优先采用本地零成本成功结果，本地失败则回退外部结果
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const a = targetsA[i];
    const b = targetsB[i];

    // ── 审核结论合并 ──
    if (!target.reviewed_at) {
      const hadReviewDefect = needsL1Review(target) || needsL2Advice(target, l2Enabled);
      if (hadReviewDefect) {
        const aSuccess = Boolean(a.l1_review?.verdict && (
          a.review_status !== 'pending' ||
          a.ai_advice?.verdict ||
          !l2Enabled
        ));
        const bSuccess = Boolean(b.l1_review?.verdict && (
          b.review_status !== 'pending' ||
          b.ai_advice?.verdict ||
          !l2Enabled
        ));

        if (aSuccess) {
          target.review_status = a.review_status;
          target.l1_review = a.l1_review;
          target.ai_advice = a.ai_advice;
          if (a.discard_reason) target.discard_reason = a.discard_reason; else delete target.discard_reason;
          if (a.discard_stage) target.discard_stage = a.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        } else if (bSuccess) {
          target.review_status = b.review_status;
          target.l1_review = b.l1_review;
          target.ai_advice = b.ai_advice;
          if (b.discard_reason) target.discard_reason = b.discard_reason; else delete target.discard_reason;
          if (b.discard_stage) target.discard_stage = b.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        }
      }
    }

    // 严禁对 discarded 条目进行摘要与翻译修复
    if (target.review_status === 'discarded') {
      continue;
    }

    // ── 摘要合并（有效摘要存在时跳过；保护标记 + 空摘要允许重试补齐） ──
    if (!target.summary || !String(target.summary).trim()) {
      const aSumSuccess = Boolean(a.summary && a.summarizer !== 'llm_failed');
      const bSumSuccess = Boolean(b.summary && b.summarizer !== 'llm_failed');

      if (aSumSuccess) {
        target.summary = a.summary;
        target.summary_key_points = a.summary_key_points || [];
        target.summarizer = a.summarizer;
        target.summary_generated_at = a.summary_generated_at;
        target.summary_input_chars = a.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      } else if (bSumSuccess) {
        target.summary = b.summary;
        target.summary_key_points = b.summary_key_points || [];
        target.summarizer = b.summarizer;
        target.summary_generated_at = b.summary_generated_at;
        target.summary_input_chars = b.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      }
    }

    // ── 本地化翻译合并（可用判定：原样复述的假翻译不抢占合并结果） ──
    const hasLocal = hasUsableLocalizedContent(target, locale);
    if (!hasLocal) {
      const aLoc = a.localizations?.[locale];
      const aLocSuccess = hasUsableLocalizedContent(a, locale);
      const bLoc = b.localizations?.[locale];
      const bLocSuccess = hasUsableLocalizedContent(b, locale);

      if (aLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = aLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = a.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      } else if (bLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = bLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = b.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      }
    }
  }

  // 6. 并发安全原子落盘：双通道请求期间若候选层被并发修改（如工作台人工审核），
  //    只把修复结果合并进最新状态，绝不覆盖人工结论
  if (!dryRun) {
    if (store) {
      store.updated_at = new Date().toISOString();
    }
    const writeResult = guardedWriteStore(store, baseRevision, targets, options.runId || 'min-repair-dual-channel', {
      ...options,
      locale,
      l2Enabled,
    });
    resultStats.writeMerged = writeResult.merged;
  }

  resultStats.remainingIncomplete = countRepairWork(candidates, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }).total;
  return resultStats;
}

module.exports = {
  DEFAULT_REPAIR_LIMIT,
  nonNegativeInteger,
  needsL1Review,
  needsL2Advice,
  needsReviewWork,
  needsSummary,
  needsLocalize,
  needsRepair,
  countEnrichmentWork,
  countRepairWork,
  enrichMinCandidates,
  repairIncompleteCandidates,
};
