/**
 * pipeline-min.js —— 热点管线 v2 总指挥（runMin 编排）
 *
 * 把 v2 各模块串成完整流水线的唯一入口：
 *   collect（pipeline-collect → collector-youtube-v2 / collector-x-v2）
 *   → 去重（projection.dedupeItems）→ L0 硬过滤（review-v2.l0HardFilter）
 *   → 分类（content-classifier）→ 评分（scoring-v2 + history-store）
 *   → L1/L2 审核（review-v2.applyL1Verdicts）→ 候选落地（min-store）
 *   → 总结（content-summarizer）+ 本地化（content-localizer）
 *   → 每日公开投影（daily-projection + projection.enrichHotspotProjection
 *     + news-public-gate.filterProjectionByWindow）→ 写 data/news/output/hotspots.json
 *
 * 本模块只编排，不重写任何子模块。**每步失败不抛错**：降级继续并把原因记进
 * coverage（子模块自身的失败语义已保证：LLM 失败 → 降级对象/verdict null，绝不 reject）。
 *
 * 注入点（测试 mock 用，缺省回落真实实现；采集/调度注入点见 pipeline-collect 与
 * pipeline-schedule）：
 *   options.classify / options.review / options.summarize / options.localize / options.score
 *   options.config / options.now / options.xWindow / options.runId
 *   options.minStoreIn / options.minStoreOut / options.historyIn / options.historyOut
 *   options.lastRunOut(record, runId) / options.scheduleStateIn / options.scheduleStateOut
 *   options.catalogApi  目录查询注入 { listToolCards, listVendorCards, readGlossary, readScenes }
 *                       （组合根构造）；未注入时公开投影按空词典处理（不关联 related_resources）
 *   options.autoReviewList=false 关闭自动生成人工审核清单；options.autoRepair=true 开启双通道自愈兜底
 *
 * 数据文件：
 *   - 候选层  data/news/runtime/min-candidates.json（writeMinStore）
 *   - 历史库  data/news/runtime/source-history.json（writeHistoryStore）
 *   - 采集记录 data/news/runtime/last-run.json（每次采集结束写；ai-top 据此判定
 *     "最后一次采集是否有 YouTube"来决定 top N，见 cmd-min.js hasYouTubeInLastRun）
 *   - 主输出  data/news/output/hotspots.json（writeJsonAtomic）
 */

'use strict';

const { readHistoryStore, writeHistoryStore, appendSamples, sourceKeyOf } = require('./history-store');
const { assessItemV2 } = require('../pipeline/scoring-v2');
const { l0HardFilter, applyL1Verdicts } = require('./review-v2');
const { readMinStore, writeMinStore, mergeCandidatesMin } = require('./min-store');
const { buildDailyProjection } = require('./daily-projection');
const { classifyCandidate } = require('../classify/content-classifier');
const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { dedupeItems, enrichHotspotProjection, buildProjectionInputs } = require('../pipeline/projection');
const { filterProjectionByWindow } = require('../core/news-public-gate');
const { countRepairWork } = require('./enrichment-core');
const { repairIncompleteCandidates } = require('./min-repair');
const { buildReviewList } = require('./review-list');
const { collectPlatforms } = require('./pipeline-collect');
const { writeJsonAtomic } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');
const {
  buildLastRunRecord,
  isCollectionEnabled,
  isYoutubeDue,
  loadV2Config,
  normalizeNow,
  resolveXWindow,
} = require('./pipeline-schedule');

/** 错误标签：防御 undefined 边界。 */
function errorLabel(error) {
  return (error && (error.message || error.code)) || String(error);
}

/**
 * 热点管线 v2 全链编排。
 *
 * @param {object} [options] 见文件头注入点说明
 * @returns {Promise<{ coverage: object, minCandidates: number, publicItems: number }>}
 *   - coverage：全链统计（采集/去重/L0/分类/评分/审核/总结/本地化/投影 + 各步降级错误）
 *   - minCandidates：候选层合并后候选总数
 *   - publicItems：公开投影（hotspots.json）过滤后条目数
 */
async function runMin(options = {}) {
  const config = options.config || loadV2Config();
  const now = normalizeNow(options.now);
  const nowMs = now.getTime();
  const runId = options.runId || `min-${nowMs}`;

  const coverage = {
    run_id: runId,
    status: 'running',
    collection_enabled: isCollectionEnabled(config),
    started_at: now.toISOString(),
    collectors: {
      youtube: { status: 'not_run', items: 0, error: null },
      x: { status: 'not_run', items: 0, error: null, credits: null },
    },
    collected_total: 0,
    after_dedupe: 0,
    l0_dropped: 0,
    classified: 0,
    scored: 0,
    kept: 0,
    discarded: 0,
    summarized: 0,
    localized: 0,
    min_candidates: 0,
    public_items: 0,
  };

  // 统一门禁必须先于采集、AI 处理与任何持久化；关闭时保持零网络、零写入。
  if (!coverage.collection_enabled) {
    coverage.status = 'disabled';
    return { coverage, minCandidates: 0, publicItems: 0 };
  }

  const errors = [];
  const noteError = (step, error) => {
    const message = errorLabel(error);
    coverage[`${step}_error`] = message;
    errors.push(`${step}:${message}`);
  };

  // ═══ 1. 采集：默认并行 YouTube + X（各平台失败降级返回空，不抛错）。 ═══
  const { mergedRaw, platforms } = await collectPlatforms({ options, config, now, runId, coverage, noteError });

  // ═══ 2. 去重（按 platform:native_id） ═══
  let items;
  try {
    items = dedupeItems(mergedRaw);
  } catch (error) {
    noteError('dedupe', error);
    items = mergedRaw;
  }
  coverage.after_dedupe = items.length;

  // ═══ 3. L0 规则硬过滤：不过的标 discarded（记 coverage.l0_dropped），
  //        不进入分类/评分/审核链；作为保留记录随候选层落盘（可人工撤销）。 ═══
  const l0Passed = [];
  const l0Failed = [];
  for (const item of items) {
    let verdict;
    try {
      verdict = l0HardFilter(item, config);
    } catch (error) {
      verdict = { pass: false, reason: 'filter_error' };
    }
    if (verdict && verdict.pass) {
      l0Passed.push(item);
    } else {
      item.review_status = 'discarded';
      item.discard_stage = 'l0';
      item.discard_reason = (verdict && verdict.reason) || 'unknown';
      item.l1_review = null;
      item.ai_advice = null;
      l0Failed.push(item);
    }
  }
  coverage.l0_dropped = l0Failed.length;

  // L0 失败通常保留为 discarded 审计记录；明确 AI 生成披露的内容按硬排除语义
  // 不进入候选层，避免它出现在 review.json 或后续人工审核清单。
  const l0PersistedFailed = l0Failed.filter(item => item.discard_reason !== 'ai_generated_disclosure');

  // ═══ 4. 分类：对过 L0 的每条填 content_type（失败留 unclassified，不阻塞）。
  //        外部 provider 分类按 config.collection.concurrency 并发执行。 ═══
  const classifyFn = options.classify || classifyCandidate;
  const classifyOptions = { ...options, config };
  const classifyConcurrency = Math.max(1, Number(config.collection?.concurrency) || 5);
  await runPool(l0Passed, classifyConcurrency, async item => {
    try {
      const suggestion = await classifyFn(item, classifyOptions);
      if (suggestion && suggestion.content_type) {
        item.content_type = suggestion.content_type;
        item.content_type_status = suggestion.content_type_status || 'ai_suggested';
        item.classifier = suggestion.classifier || 'rule_based';
        item.classify_reasons = Array.isArray(suggestion.reasons) ? suggestion.reasons : [];
        coverage.classified += 1;
      }
    } catch (error) {
      noteError('classify', error);
    }
  });

  // ═══ 5. 评分：先持久化本轮 metrics 到历史库，再对每条 assessItemV2。
  //        sourceKey 用 history-store.sourceKeyOf，保证 appendSamples 写入与
  //        evaluateLongTermQuality 查询用同一把 key。 ═══
  let historyStore = { sources: {} };
  try {
    historyStore = options.historyIn ? options.historyIn() : readHistoryStore();
  } catch (error) {
    noteError('history_read', error);
  }
  try {
    appendSamples(historyStore, l0Passed);
    if (options.historyOut) options.historyOut(historyStore, runId);
    else writeHistoryStore(historyStore, runId);
  } catch (error) {
    noteError('history_write', error);
  }
  const scoreFn = options.score || assessItemV2;
  for (const item of l0Passed) {
    try {
      const sourceKey = sourceKeyOf(item);
      const assessment = await scoreFn(item, { config, sourceKey, history: historyStore });
      if (assessment) {
        item.final_score = assessment.final_score;
        item.score_breakdown = assessment.score_breakdown;
        coverage.scored += 1;
      }
    } catch (error) {
      noteError('score', error);
    }
  }

  // ═══ 6. L1/L2 审核：applyL1Verdicts → { kept, discarded }。
  //        审核失败降级：全部保留为 pending（AI 审核失败绝不误杀）。 ═══
  let kept = [];
  let discarded = [];
  const reviewFn = options.review || applyL1Verdicts;
  // 本地 Bonsai 初审调优参数（与修复通道 A 对齐）：30s 请求超时 + 描述上下文 1000 字符
  const reviewOptions = {
    ...options,
    config,
    timeoutMs: options.timeoutMs ?? 30000,
    maxDescChars: options.maxDescChars ?? 1000,
  };
  try {
    const result = await reviewFn(l0Passed, config, reviewOptions);
    kept = Array.isArray(result.kept) ? result.kept : [];
    discarded = Array.isArray(result.discarded) ? result.discarded : [];
  } catch (error) {
    noteError('review', error);
    kept = l0Passed.map(item => ({ ...item, review_status: 'pending', l1_review: null, ai_advice: null }));
    discarded = [];
  }
  coverage.kept = kept.length;
  coverage.discarded = discarded.length;

  // ═══ 7. 候选落地：kept + L1 discarded + L0 丢弃保留记录 → 合并 → 落盘。
  //        已存在候选保留既有 review_status（人工结论不因重采被重置）。 ═══
  let minStore;
  try {
    minStore = options.minStoreIn ? options.minStoreIn() : readMinStore();
  } catch (error) {
    noteError('min_read', error);
    minStore = { schema_version: 1, updated_at: null, candidates: [] };
  }
  let merged;
  try {
    merged = mergeCandidatesMin(minStore, [...kept, ...discarded, ...l0PersistedFailed]);
  } catch (error) {
    noteError('merge', error);
    merged = minStore;
  }

  // ═══ 8/9. 总结 + 本地化：只处理 L1 分流后仍需人工审核的 pending 候选。
  //          自动 approved/discarded 不进入这里，避免为确定性结果消费 token。
  //          失败降级不阻塞，review.json 仍保留 pending 供人工处理。 ═══
  const pendingKept = kept.filter(item => item.review_status === 'pending');
  const summarizeFn = options.summarize || summarizeCandidates;
  const localizeFn = options.localize || localizeCandidates;
  try {
    const result = await summarizeFn(pendingKept, { ...options, config });
    coverage.summarized = (result && result.summarized) || 0;
  } catch (error) {
    noteError('summarize', error);
  }
  try {
    const result = await localizeFn(pendingKept, { ...options, locale: options.locale || 'zh', config });
    coverage.localized = (result && result.localized) || 0;
  } catch (error) {
    noteError('localize', error);
  }
  try {
    if (options.minStoreOut) options.minStoreOut(merged, runId);
    else writeMinStore(merged, runId);
  } catch (error) {
    noteError('min_write', error);
  }
  coverage.min_candidates = merged.candidates.length;

  // ═══ 9.1 双通道自愈兜底：可选开启（options.autoRepair=true）。 ═══
  if (options.autoRepair === true) {
    try {
      const repairWork = countRepairWork(merged.candidates, {
        l2Enabled: config?.review?.l2_enabled !== false,
      });
      if (repairWork.hasWork) {
        const repaired = await repairIncompleteCandidates(merged, config, {
          ...options,
          writeStore: options.minStoreOut,
          runId,
        });
        coverage.repaired = {
          reviewed: repaired.repairedReview,
          summarized: repaired.repairedSummary,
          localized: repaired.repairedLocalize,
          remaining: repaired.remainingIncomplete,
        };
      }
    } catch (error) {
      noteError('repair', error);
    }
  }

  // ═══ 9.5 人工审核清单（自动生成）：候选落地后、公开投影前，把 pending 候选
  //        写 data/manual/review.json（带 id、评分倒序；文件已存在时追加新 pending、
  //        不覆盖已有人工结论）；失败仅降级记 coverage，不阻塞管线。 ═══
  if (options.autoReviewList !== false) {
    try {
      const reviewList = buildReviewList(merged, config, { now });
      coverage.review_list = reviewList.skipped ? 'skipped_existing' : reviewList.total_pending;
    } catch (error) {
      coverage.review_list_error = errorLabel(error);
    }
  } else {
    coverage.review_list = 'disabled';
  }

  // ═══ 10. 每日公开投影：approved 候选按天取 top N → 公开契约补充
  //         （hot_score/evidence_excerpt/related_resources）→ 近期窗口一致过滤
  //         → 写 hotspots.json。空投影保护：不覆盖上一版数据（避免前端空白）。 ═══
  let publicItems = 0;
  try {
    const projection = buildDailyProjection(merged, config, { now });
    const { toolUrlIndex, relatedLexicon } = buildProjectionInputs(options.catalogApi);
    enrichHotspotProjection(projection.items, toolUrlIndex, relatedLexicon);
    const output = {
      schema_version: 1,
      generated_at: projection.generated_at,
      items: projection.items,
      coverage,
    };
    const filtered = filterProjectionByWindow(output, { config, now: nowMs });
    if (filtered.items.length > 0) {
      writeJsonAtomic(NEWS_FILES.hotspots, filtered, runId);
      publicItems = filtered.items.length;
    } else {
      coverage.public_projection = 'empty_skipped_write';
    }
  } catch (error) {
    noteError('projection', error);
  }
  coverage.public_items = publicItems;

  // ═══ 状态汇总：本轮启用的采集平台全失败 → failed；任一步降级 → partial；否则 complete。 ═══
  const enabledRunPlatforms = platforms.filter(p => p === 'youtube' || p === 'x');
  const enabledCollectFailed = enabledRunPlatforms.length > 0
    && enabledRunPlatforms.every(p => coverage.collectors[p] && coverage.collectors[p].status === 'failed');
  const enabledCollectDegraded = enabledRunPlatforms.some(p => {
    const status = coverage.collectors[p] && coverage.collectors[p].status;
    return status === 'failed' || status === 'partial';
  });
  coverage.status =
    enabledCollectFailed
      ? 'failed'
      : enabledCollectDegraded || errors.length > 0
        ? 'partial'
        : 'complete';

  // ═══ 10.5 采集运行记录：每次采集结束写 data/news/runtime/last-run.json
  //         （"最后一次采集记录"的唯一权威来源，供 ai-top 判定 hasYouTube）。 ═══
  try {
    const lastRun = buildLastRunRecord(coverage, { runId, now, platforms: enabledRunPlatforms });
    if (options.lastRunOut) options.lastRunOut(lastRun, runId);
    else writeJsonAtomic(NEWS_FILES.lastRun, lastRun, runId);
  } catch (error) {
    noteError('last_run', error);
  }

  return { coverage, minCandidates: coverage.min_candidates, publicItems };
}

module.exports = {
  runMin,
  loadV2Config,
  isCollectionEnabled,
  isYoutubeDue,
  normalizeNow,
  resolveXWindow,
};
