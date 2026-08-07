/**
 * pipeline-min.js —— 热点管线 v2 总指挥（runMin 编排）
 *
 * 在热点管线 v2 中的位置：把 v2 各模块串成完整流水线的唯一入口。
 *   collect（collector-youtube-v2 / collector-x-v2）
 *   → 去重（projection.dedupeItems）
 *   → L0 硬过滤（review-v2.l0HardFilter）
 *   → 分类（content-classifier.classifyCandidate / classifyRuleBased）
 *   → 评分（scoring-v2.assessItemV2 + history-store 历史库）
 *   → L1/L2 审核（review-v2.applyL1Verdicts）
 *   → 候选落地（min-store.mergeCandidatesMin / writeMinStore）
 *   → 总结（content-summarizer）+ 本地化（content-localizer）
 *   → 每日公开投影（daily-projection.buildDailyProjection + projection.enrichHotspotProjection
 *     + news-public-gate.filterProjectionByWindow）→ 写 data/news/output/hotspots.json
 *
 * 本模块只编排，不重写任何子模块。**每步失败不抛错**：降级继续并把原因记进
 * coverage（子模块自身的失败语义已保证：LLM 失败 → 降级对象/verdict null，绝不 reject）。
 *
 * 注入点（测试 mock 用，缺省回落真实实现）：
 *   options.collectors = { youtube, x }          覆盖 collectYouTubeV2 / collectXV2
 *   options.classify                             覆盖 classifyCandidate（接受单条，同步/异步均可）
 *   options.review                               覆盖 applyL1Verdicts（返回 { kept, discarded }）
 *   options.summarize                            覆盖 summarizeCandidates（批量签名 (items, options)）
 *   options.localize                             覆盖 localizeCandidates（批量签名 (items, options)）
 *   options.score                                覆盖 assessItemV2（可选）
 *   options.config                               覆盖 news-config-v2.json
 *   options.now                                  采集/评分/投影参考时间（Date 或 ISO 字符串）
 *   options.xWindow = { since, until }           覆盖 X 时间窗；缺省用「今天 0 点 → now」
 *   options.runId                                写入临时文件名标识（可选）
 *   options.minStoreIn / options.minStoreOut     覆盖候选层读写（fixture 注入内存存根，避免污染运行时文件）
 *   options.historyIn / options.historyOut       覆盖历史库读写（同上；缺省回落真实文件）
 *                                                签名：minStoreIn()→store，minStoreOut(store,runId)；
 *                                                historyIn()→store，historyOut(store,runId)
 *
 * 并发语义：分类与审核（applyL1Verdicts）都按 config.collection.concurrency
 * 并发执行（DeepSeek 逐条串行会卡十几分钟，实测见 2026-08-08 基准）；
 * 总结/本地化走 summarizeCandidates / localizeCandidates 自带批量并发。
 *
 * 数据文件：
 *   - 候选层  data/news/runtime/min-candidates.json（writeMinStore）
 *   - 历史库  data/news/runtime/source-history.json（writeHistoryStore）
 *   - 主输出  data/news/output/hotspots.json（writeJsonAtomic）
 */

'use strict';

const { collectYouTubeV2 } = require('../collectors/collector-youtube-v2');
const { collectXV2 } = require('../collectors/collector-x-v2');
const { readHistoryStore, writeHistoryStore, appendSamples, sourceKeyOf } = require('./history-store');
const { assessItemV2 } = require('../pipeline/scoring-v2');
const { l0HardFilter, applyL1Verdicts } = require('./review-v2');
const { readMinStore, writeMinStore, mergeCandidatesMin } = require('./min-store');
const { buildDailyProjection } = require('./daily-projection');
const { classifyCandidate } = require('../classify/content-classifier');
const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { dedupeItems, enrichHotspotProjection } = require('../pipeline/projection');
const { filterProjectionByWindow } = require('../core/news-public-gate');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

const V2_CONFIG_PATH = '../../../data/news/config/news-config-v2.json';

let cachedV2Config = null;

/** 懒加载 news-config-v2.json；不可读时退回最小兜底配置。 */
function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  try {
    cachedV2Config = require(V2_CONFIG_PATH);
  } catch {
    cachedV2Config = { schema_version: 1, collection: {}, keywords: { ai_keywords: [] }, review: {}, scoring: {} };
  }
  return cachedV2Config;
}

/** 规范化 now：Date / ISO 字符串 / 非法值 → 回退当前时间。 */
function normalizeNow(now) {
  if (now == null) return new Date();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

/** 错误标签：防御 undefined 边界。 */
function errorLabel(error) {
  return (error && (error.message || error.code)) || String(error);
}

/**
 * 解析 X 采集时间窗。
 * options.xWindow = { since, until } 注入时用之（since/until 可为 Date 或 ISO 字符串）；
 * 缺省用「今天 0 点（本地时区）→ now」。
 * @returns {{ sinceIso: string|null, untilIso: string|null }}
 */
function resolveXWindow(options, now) {
  if (options && options.xWindow) {
    return {
      sinceIso: options.xWindow.since != null ? new Date(options.xWindow.since).toISOString() : null,
      untilIso: options.xWindow.until != null ? new Date(options.xWindow.until).toISOString() : null,
    };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { sinceIso: start.toISOString(), untilIso: now.toISOString() };
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
    started_at: now.toISOString(),
    collectors: {
      youtube: { status: 'not_run', items: 0, error: null },
      x: { status: 'not_run', items: 0, error: null },
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
  const errors = [];
  const noteError = (step, error) => {
    const message = errorLabel(error);
    coverage[`${step}_error`] = message;
    errors.push(`${step}:${message}`);
  };

  // ═══════════════════════════════════════════════════════════════
  // 1. 采集：并行 YouTube + X（各平台失败降级返回空，不抛错）
  // ═══════════════════════════════════════════════════════════════
  const youtubeCollector = (options.collectors && options.collectors.youtube) || collectYouTubeV2;
  const xCollector = (options.collectors && options.collectors.x) || collectXV2;
  const xWindow = resolveXWindow(options, now);

  const youtubeTask = (async () => {
    const slot = coverage.collectors.youtube;
    try {
      const result = await youtubeCollector({ config, now, apiKey: options.youtubeApiKey, fetchImpl: options.fetchImpl });
      const collected = result && Array.isArray(result.items) ? result.items : [];
      slot.items = collected.length;
      slot.status = (result && result.coverage && result.coverage.status) || 'success';
      slot.reason = (result && result.coverage && result.coverage.reason) || null;
      return collected;
    } catch (error) {
      slot.status = 'failed';
      slot.error = errorLabel(error);
      return [];
    }
  })();

  const xTask = (async () => {
    const slot = coverage.collectors.x;
    try {
      const result = await xCollector({
        config, now,
        sinceIso: xWindow.sinceIso, untilIso: xWindow.untilIso,
        xApiKey: options.xApiKey, fetchImpl: options.fetchImpl,
      });
      const collected = result && Array.isArray(result.items) ? result.items : [];
      slot.items = collected.length;
      slot.status = (result && result.coverage && result.coverage.status) || 'success';
      slot.reason = (result && result.coverage && result.coverage.reason) || null;
      return collected;
    } catch (error) {
      slot.status = 'failed';
      slot.error = errorLabel(error);
      return [];
    }
  })();

  const [youtubeItems, xItems] = await Promise.all([youtubeTask, xTask]);
  const mergedRaw = [...youtubeItems, ...xItems];
  coverage.collected_total = mergedRaw.length;

  // ═══════════════════════════════════════════════════════════════
  // 2. 去重（按 platform:native_id）
  // ═══════════════════════════════════════════════════════════════
  let items;
  try {
    items = dedupeItems(mergedRaw);
  } catch (error) {
    noteError('dedupe', error);
    items = mergedRaw;
  }
  coverage.after_dedupe = items.length;

  // ═══════════════════════════════════════════════════════════════
  // 3. L0 规则硬过滤：不过的标 discarded（记 coverage.l0_dropped），
  //    不进入分类/评分/审核链；作为保留记录随候选层落盘（可人工撤销）。
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // 4. 分类：对过 L0 的每条填 content_type（失败留 unclassified，不阻塞）。
  //    DeepSeek 分类按 config.collection.concurrency 并发执行（串行逐条会卡几分钟）。
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // 5. 评分：先持久化本轮 metrics 到历史库，再对每条 assessItemV2。
  //    sourceKey 用 history-store.sourceKeyOf（X 去 'x-' 前缀、YouTube 去 'youtube-' 前缀），
  //    保证 appendSamples 写入与 evaluateLongTermQuality 查询用同一把 key。
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // 6. L1/L2 审核：applyL1Verdicts → { kept, discarded }。
  //    审核失败降级：全部保留为 pending（AI 审核失败绝不误杀）。
  // ═══════════════════════════════════════════════════════════════
  let kept = [];
  let discarded = [];
  const reviewFn = options.review || applyL1Verdicts;
  try {
    const result = await reviewFn(l0Passed, config, { ...options, config });
    kept = Array.isArray(result.kept) ? result.kept : [];
    discarded = Array.isArray(result.discarded) ? result.discarded : [];
  } catch (error) {
    noteError('review', error);
    kept = l0Passed.map(item => ({ ...item, review_status: 'pending', l1_review: null, ai_advice: null }));
    discarded = [];
  }
  coverage.kept = kept.length;
  coverage.discarded = discarded.length;

  // ═══════════════════════════════════════════════════════════════
  // 7. 候选落地：kept + L1 discarded + L0 丢弃保留记录 → 合并 → 落盘。
  //    已存在候选保留既有 review_status（人工结论不因重采被重置）。
  // ═══════════════════════════════════════════════════════════════
  let minStore;
  try {
    minStore = options.minStoreIn ? options.minStoreIn() : readMinStore();
  } catch (error) {
    noteError('min_read', error);
    minStore = { schema_version: 1, updated_at: null, candidates: [] };
  }
  let merged;
  try {
    merged = mergeCandidatesMin(minStore, [...kept, ...discarded, ...l0Failed]);
  } catch (error) {
    noteError('merge', error);
    merged = minStore;
  }

  // ═══════════════════════════════════════════════════════════════
  // 8/9. 总结 + 本地化：只处理 kept 中仍 pending 的候选。
  //      注入的 summarize/localize 为批量签名 (items, options)；
  //      LLM 失败降级（summary/localizations 不写，前端回退原文），不阻塞。
  //      summarize/localize 原地修改的正是合并后候选层对象（同引用），
  //      故写完后再统一写盘，避免中间态落盘。
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // 10. 每日公开投影：approved 候选按天取 top N → 公开契约补充
  //     （hot_score/evidence_excerpt/related_resources）→ 近期窗口一致过滤 → 写 hotspots.json。
  //     events/provenance/assessments 沿用旧文件已有值（本管线不构建），
  //     经 filterProjectionByWindow 剔除悬空引用后一并保留，兼容前端 schema。
  // ═══════════════════════════════════════════════════════════════
  let publicItems = 0;
  try {
    const projection = buildDailyProjection(merged, config, { now });
    enrichHotspotProjection(projection.items);
    const existing = readJson(NEWS_FILES.hotspots, null) || {};
    const output = {
      schema_version: 1,
      generated_at: projection.generated_at,
      items: projection.items,
      events: Array.isArray(existing.events) ? existing.events : [],
      provenance: Array.isArray(existing.provenance) ? existing.provenance : [],
      assessments: Array.isArray(existing.assessments) ? existing.assessments : [],
      coverage,
    };
    const filtered = filterProjectionByWindow(output, { config, now: nowMs });
    // 空投影保护（决策 R1.6）：公开投影为空（无 approved 内容）时不覆盖 hotspots.json，
    // 保留上一版数据，避免前端突然空白（对齐 v1 决策 51/69）。
    if (filtered.items.length > 0) {
      writeJsonAtomic(NEWS_FILES.hotspots, filtered, runId);
      publicItems = filtered.items.length;
    } else {
      // 空投影保护：保留上一版 hotspots.json（避免前端空白）
      coverage.public_projection = 'empty_skipped_write';
    }
  } catch (error) {
    noteError('projection', error);
  }
  coverage.public_items = publicItems;

  // ═══════════════════════════════════════════════════════════════
  // 状态汇总：双采集全失败 → failed；任一步降级 → partial；否则 complete。
  // ═══════════════════════════════════════════════════════════════
  coverage.status =
    coverage.collectors.youtube.status === 'failed' && coverage.collectors.x.status === 'failed'
      ? 'failed'
      : errors.length > 0
        ? 'partial'
        : 'complete';

  return { coverage, minCandidates: coverage.min_candidates, publicItems };
}

module.exports = {
  runMin,
  loadV2Config,
  normalizeNow,
  resolveXWindow,
};
