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
 *   options.platforms = ['youtube','x']          采集平台范围（缺省双跑；分时采集传单平台，如 ['youtube']）
 *   options.classify                             覆盖 classifyCandidate（接受单条，同步/异步均可）
 *   options.review                               覆盖 applyL1Verdicts（返回 { kept, discarded }）
 *   options.summarize                            覆盖 summarizeCandidates（批量签名 (items, options)）
 *   options.localize                             覆盖 localizeCandidates（批量签名 (items, options)）
 *   options.score                                覆盖 assessItemV2（可选）
 *   options.config                               覆盖 news-config-v2.json
 *   options.now                                  采集/评分/投影参考时间（Date 或 ISO 字符串）
 *   options.xWindow = { since, until }           覆盖 X 时间窗；缺省用「北京时间今天 0 点 → now」
 *   options.runId                                写入临时文件名标识（可选）
 *   options.minStoreIn / options.minStoreOut     覆盖候选层读写（fixture 注入内存存根，避免污染运行时文件）
 *   options.historyIn / options.historyOut       覆盖来源质量历史库读写（同上；缺省回落真实文件）
 *                                                签名：minStoreIn()→store，minStoreOut(store,runId)；
 *                                                historyIn()→store，historyOut(store,runId)
 *   options.lastRunOut                           覆盖采集运行记录写盘（签名 lastRunOut(record, runId)，
 *                                                缺省原子写 data/news/runtime/last-run.json；fixture 注入存根）
 *
 * 加平台 = platforms 数组枚举 + options.collectors 注入点：
 *   新增采集平台时，在 platforms 缺省数组枚举该平台，并在 options.collectors 提供对应采集器；
 *   未启用平台的 coverage.collectors[platform] 保持 { status:'not_run', items:0, error:null }。
 *
 * 并发语义：分类与审核（applyL1Verdicts）都按 config.collection.concurrency
 * 并发执行（DeepSeek 逐条串行会卡十几分钟，实测见 2026-08-08 基准）；
 * 总结/本地化走 summarizeCandidates / localizeCandidates 自带批量并发。
 *
 * 数据文件：
 *   - 候选层  data/news/runtime/min-candidates.json（writeMinStore）
 *   - 历史库  data/news/runtime/source-history.json（writeHistoryStore）
 *   - 采集记录 data/news/runtime/last-run.json（每次采集结束写；ai-top 据此判定
 *     "最后一次采集是否有 YouTube"来决定 top N，见 cmd-min.js hasYouTubeInLastRun）
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
const { beijingMidnightIso } = require('../../shared/beijing-time');
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

/** 懒加载 news-config-v2.json；不可读时退回默认关闭的最小兜底配置。 */
function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  try {
    cachedV2Config = require(V2_CONFIG_PATH);
  } catch {
    cachedV2Config = { schema_version: 1, collection: { enabled: false }, keywords: { ai_keywords: [] }, review: {}, scoring: {} };
  }
  return cachedV2Config;
}

/** 热点采集总开关：仅严格布尔 true 启用；缺失或类型错误均安全关闭。 */
function isCollectionEnabled(config) {
  return config?.collection?.enabled === true;
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
 * 缺省用「北京时间今天 0 点 → now」（统一北京时间，不依赖 runner 系统时区）。
 * @returns {{ sinceIso: string|null, untilIso: string|null }}
 */
function resolveXWindow(options, now) {
  if (options && options.xWindow) {
    return {
      sinceIso: options.xWindow.since != null ? new Date(options.xWindow.since).toISOString() : null,
      untilIso: options.xWindow.until != null ? new Date(options.xWindow.until).toISOString() : null,
    };
  }
  return { sinceIso: beijingMidnightIso(now), untilIso: normalizeNow(now).toISOString() };
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

  // ═══════════════════════════════════════════════════════════════
  // 1. 采集：默认并行 YouTube + X（各平台失败降级返回空，不抛错）。
  //    options.platforms 支持分时采集（如 R1：YouTube 每 3 天 22:00、X 每日 14:00/0:00 分开跑）：
  //    只启动 platforms 列表内平台的采集 Task；未启用平台的 coverage.collectors[platform]
  //    保持初始 { status:'not_run', items:0, error:null }。后续去重/评分/审核/合并/投影
  //    仍跑全链——mergeCandidatesMin 读全量 min-candidates.json，单平台跑也产出完整每日投影。
  // ═══════════════════════════════════════════════════════════════
  const platforms = Array.isArray(options.platforms) && options.platforms.length
    ? options.platforms
    : ['youtube', 'x'];
  const youtubeCollector = (options.collectors && options.collectors.youtube) || collectYouTubeV2;
  const xCollector = (options.collectors && options.collectors.x) || collectXV2;
  const xWindow = resolveXWindow(options, now);

  const collectTasks = [];
  if (platforms.includes('youtube')) {
    collectTasks.push((async () => {
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
    })());
  }
  if (platforms.includes('x')) {
    collectTasks.push((async () => {
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
        slot.credits = result && result.credits ? result.credits : null;
        return collected;
      } catch (error) {
        slot.status = 'failed';
        slot.error = errorLabel(error);
        return [];
      }
    })());
  }

  const collectedArrays = await Promise.all(collectTasks);
  const mergedRaw = collectedArrays.flat();
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

  // L0 失败通常保留为 discarded 审计记录；明确 AI 生成披露的内容按硬排除语义
  // 不进入候选层，避免它出现在 review.json 或后续人工审核清单。
  const l0PersistedFailed = l0Failed.filter(item => item.discard_reason !== 'ai_generated_disclosure');

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
    merged = mergeCandidatesMin(minStore, [...kept, ...discarded, ...l0PersistedFailed]);
  } catch (error) {
    noteError('merge', error);
    merged = minStore;
  }

  // ═══════════════════════════════════════════════════════════════
  // 8/9. 总结 + 本地化：只处理 L1 分流后仍需人工审核的 pending 候选。
  //      自动 approved/discarded 不进入这里，避免为确定性结果消费 token。
  //      失败降级不阻塞，review.json 仍保留 pending 供人工处理。
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
  // 9.5 人工审核清单（自动生成）：候选落地后、公开投影前，把 pending 候选
  //     写 data/manual/review.json（带 id、评分倒序；文件已存在时追加新 pending、
  //     不覆盖已有人工结论）供维护者打开编辑 review_status，编辑后用 min-review apply
  //     （或 bat/apply-review.bat，应用后自动生成 top 名单）写回。
  //     失败仅降级记 coverage，不阻塞管线。
  //     测试注入 options.autoReviewList=false 可关闭（避免污染 data/manual/）。
  // ═══════════════════════════════════════════════════════════════
  if (options.autoReviewList !== false) {
    try {
      const { buildReviewList } = require('./review-list');
      const reviewList = buildReviewList(merged, config, { now });
      coverage.review_list = reviewList.skipped ? 'skipped_existing' : reviewList.total_pending;
    } catch (error) {
      coverage.review_list_error = errorLabel(error);
    }
  } else {
    coverage.review_list = 'disabled';
  }

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
  // 状态汇总：本轮启用的采集平台（platforms 内 youtube/x）全失败 → failed；
  // 任一步降级 → partial；否则 complete。缺省双平台时语义与旧版一致（双采集全失败 → failed）。
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // 10.5 采集运行记录：每次采集结束写 data/news/runtime/last-run.json。
  //     这是"最后一次采集记录"的唯一权威来源（hotspots coverage 会被 publish 覆盖），
  //     供 ai-top 判定"最后一次采集是否有 YouTube"来决定 top N（cmd-min.hasYouTubeInLastRun）。
  //     记录 platforms、各平台 status/items，以及 X credits/请求账本；写失败仅降级记 coverage，不阻塞管线。
  //     测试注入 options.lastRunOut 覆盖写盘，避免污染运行时文件。
  // ═══════════════════════════════════════════════════════════════
  try {
    const lastRun = {
      schema_version: 1,
      run_id: runId,
      collected_at: now.toISOString(),
      platforms: enabledRunPlatforms,
      collectors: {
        youtube: {
          status: coverage.collectors.youtube.status,
          items: coverage.collectors.youtube.items,
          error: coverage.collectors.youtube.error,
          reason: coverage.collectors.youtube.reason || null,
        },
        x: {
          status: coverage.collectors.x.status,
          items: coverage.collectors.x.items,
          error: coverage.collectors.x.error,
          reason: coverage.collectors.x.reason || null,
          credits: coverage.collectors.x.credits || null,
        },
      },
    };
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
  normalizeNow,
  resolveXWindow,
};
