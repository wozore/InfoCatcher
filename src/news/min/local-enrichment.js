/**
 * local-enrichment.js —— 热点候选批量增量加工（enrich）编排：初审（L1/L2）、
 * 中文摘要与标题/描述本地化。
 *
 * 在热点管线中的位置：
 *   供 CLI（min-review enrich）与自动化任务在后台按批次运行本地 Bonsai 模型，
 *   对候选层（min-candidates.json）中尚未处理或处理失败的内容补全加工。
 *   残缺判定、单条审核执行与并发安全落盘共用 enrichment-core.js。
 *
 * 核心特性：
 *   1. 分批处理（默认每批 30 条），每批原子落盘，支持断点续传（中断后重新执行仅处理未完成项）
 *   2. 算力克制：只有非 discarded 的项才消费摘要与翻译算力
 *   3. 依赖注入：writeStore, reviewCandidate, fetchImpl, onBatchDone 便于测试与 CLI 解耦
 */

'use strict';

const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates, hasUsableLocalizedContent } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { revisionOfMinStore } = require('./min-store');
const {
  needsL1Review,
  needsL2Advice,
  needsReviewWork,
  needsSummary,
  needsLocalize,
  executeCandidateReview,
  executeL2OnlyAdvice,
  guardedWriteStore,
  nonNegativeInteger,
} = require('./enrichment-core');

/**
 * 统计候选集在当前选项下的待处理工作量。
 *
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

/**
 * 对候选层执行分批 Enrichment（初审、摘要与翻译）。
 *
 * @param {object} store - min store 对象 ({ candidates: [] })
 * @param {object} [config] - news-config-v2.json 配置对象
 * @param {object} [options]
 * @param {number} [options.batchSize=30] - 每批数量
 * @param {number} [options.concurrency] - 批内并发数，默认读 config.collection.concurrency 兜底 5
 * @param {number} [options.limit] - 处理条数上限
 * @param {boolean} [options.skipReview] - 跳过审核
 * @param {boolean} [options.skipSummary] - 跳过摘要
 * @param {boolean} [options.skipLocalize] - 跳过本地化翻译
 * @param {boolean} [options.force] - 强制重新处理
 * @param {boolean} [options.dryRun] - 模拟运行不写盘
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

module.exports = {
  countEnrichmentWork,
  enrichMinCandidates,
};
