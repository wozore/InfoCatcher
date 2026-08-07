/**
 * build-news.js —— AI 热点构建总编排入口
 *
 * 在热点管线中的位置：GitHub Actions（collect-news.yml）调用此脚本，
 * 它是整个热点系统的唯一入口，负责编排所有模块完成一次完整的构建运行。
 *
 * 本文件为「编排入口」，不内联实现：
 *   - 平台采集（collectYouTube / collectX / collectBilibili）在
 *     src/news/collectors/{news-youtube,news-x,news-bilibili}.js（单一实现）；
 *   - 通用解析/规范化在 src/news/pipeline/feed-parser.js；
 *   - 评分/异常检测在 src/news/pipeline/scoring.js；
 *   - 公开投影/关联/去重在 src/news/pipeline/projection.js。
 * 本文件保留 resolvePlatformScope / classifyTimeLayer / runCollection /
 * runFixtureBuild / main 等编排逻辑，并对上列子模块做汇总 re-export。
 *
 * ═══════════════════════════════════════════════════════════════
 * 模块依赖关系（数据流向）：
 * ═══════════════════════════════════════════════════════════════
 *
 *   外部平台 API ──┐
 *   news-sources   ├──→ 采集层（collectors/news-youtube | news-x | news-bilibili）
 *   news-config ───┘        │
 *                            ▼
 *                    标准化 + AI 过滤 + 去重
 *                            │
 *                ┌───────────┼───────────┐
 *                ▼           ▼           ▼
 *           Registry    Scheduler      Quota
 *          (防重/状态)  (时间层推进)   (额度控制)
 *                │           │           │
 *                └───────────┼───────────┘
 *                            ▼
 *                  评分 / 溯源 / 主题聚合
 *                            │
 *                            ▼
 *             字幕/文字稿 enrichment（YouTube，决策 51/52，配置开关）
 *                            │
 *                            ▼
 *              内部候选层（hotspot-candidates.json，含双状态轴，不发布）
 *                            │ 公开资格门禁（决策 49/69）
 *                            ▼
 *                     hotspots.json（前端投影，最后写入）
 *
 * ═══════════════════════════════════════════════════════════════
 * 一次构建的完整流程（runCollection）：
 * ═══════════════════════════════════════════════════════════════
 *
 *   Phase 1: 准备
 *     - 读取 config / sources / 旧 hotspots / state
 *     - 创建本轮 quota ledger 和 registry 内存索引
 *     - 确定 X 平台本轮轮转的来源子集
 *
 *   Phase 2: 最新 Feed 采集（所有启用来源）
 *     - YouTube RSS + Data API 统计补充
 *     - X TwitterAPI.io（来源轮转，带 cursor 分页）
 *     - Bilibili RSSHub（视频 / 动态 / 专栏三路由）
 *     - 每条采集结果都写入 Registry（含非 AI 内容标记为 filtered_non_ai）
 *
 *   Phase 3: 历史层回溯（YouTube + Bilibili，受控单步）
 *     - 读取 scheduler 状态，确定当前激活的时间层
 *     - 对每个来源执行一个受控 step（一页或一批）
 *     - 合格的历史内容合并到 freshItems
 *
 *   Phase 4: 内容处理
 *     - 旧内容保留（按 output_retention_days 截断）
 *     - 去重、排序、按 max_output_items 截断
 *     - 评分、异常检测、溯源和主题聚合
 *
 *   Phase 5: 持久化（严格顺序）
 *     - Registry → State → Quota → Authorizations → 候选层 → hotspots.json
 *     - 候选层（内部，不发布）先写；前端投影最后写入，失败不破坏内部状态
 *
 * ═══════════════════════════════════════════════════════════════
 * 扩展点：
 * ═══════════════════════════════════════════════════════════════
 *
 *   - 新增采集平台：在 collectors/ 实现 collectXxx()，在 collectSource() 增加分支，
 *     在 runHistoricalLayerPass() 增加对应适配器调用。
 *   - 新增评分维度：在 scoring.js 的 assessItem() 增加新函数，修改 scoring.weights 配置。
 *   - 新增内容类型：在 CONTENT_TYPES 列表和 normalizeRssItem/normalizeTweet
 *     中增加支持，更新 AI 关键词和信号配置。
 *   - 调整时间层：修改 news-config.json 的 time_layers 数组，
 *     validate.js 会自动检查连续性。
 *
 * 运行方式：
 *   node scripts/build-news.js              # 真实采集（需要 Secrets）
 *   node scripts/build-news.js --fixture    # 本地确定性测试（无网络）
 *   node scripts/build-news.js --allow-empty # 允许空输出（调试用）
 */

'use strict';

// ── 核心依赖 ──────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const {
  readJson, writeJsonAtomic, acquireLock, releaseLock,
} = require('../core/news-storage');
const { createRegistry, bulkDiscover, updateLifecycle, finalizeRegistry, pruneRegistry } = require('../core/news-registry');
const {
  createQuotaLedger, finishQuotaLedger,
} = require('../core/news-quota');
const {
  createSchedulerState, initializeLayer, updateSourceProgress, advanceLayer,
  classifyTimeLayer: schedulerClassifyTimeLayer,
} = require('../core/news-scheduler');
const { collectYouTube, collectYouTubeLayerStep } = require('../collectors/news-youtube');
const { collectBilibili, probeBilibiliProvider, collectBilibiliLayerStep } = require('../collectors/news-bilibili');
const { collectX, normalizeTweet } = require('../collectors/news-x');
const { enrichYouTubeTranscripts } = require('../collectors/news-transcripts');
const { normalizeManualItem } = require('../../content/news-manual');
const { createAuthorizationStore, createAuthorizationTask } = require('../core/news-authorization');
const {
  readCandidateStore, writeCandidateStore, mergeCandidates, stampCandidateStatuses, buildPublicProjection,
  attachProjectionSnapshot, DEFAULT_REVIEW_STATUS,
} = require('../core/news-candidates');
const { classifyCandidates } = require('../classify/content-classifier');
const { enrichCandidateSummaries } = require('../classify/content-summarizer');
const { enrichCandidateReviews } = require('../classify/content-reviewer');
const { enrichCandidateLocalizations } = require('../classify/content-localizer');
const { isWithinPublicWindow, markAnomalousTimeCandidates, filterProjectionByWindow } = require('../core/news-public-gate');
const { recordReviewTransition } = require('../core/news-review-events');
const { NEWS_FILES, DIRS } = require('../../shared/paths');
const { generateRss } = require('../../content/generate-rss');

// ── 管线子模块（本文件只编排，不内联实现） ───────────────────
const {
  parseFeed, normalizeRssItem, inferBilibiliType, extractTweetArray, historicalPageToken, numberOrNull,
} = require('./feed-parser');
const {
  matchesAi, scoreTimeliness, detectLightExperience, detectCommercial, assessItem,
  applyAnomalyDetection, HEAT_DEFINITION,
} = require('./scoring');
const {
  buildEvidenceExcerpt, buildToolUrlIndex, resolveRelatedResources, buildRelatedTitleLexicon,
  titleContainsKeyword, matchRelatedByTitle, searchConceptKey, computeHotScores,
  enrichHotspotProjection, upgradeHotspotsProjection, migrateContentTypeProjection,
  dedupeItems, buildProvenance, buildEvents, getToolUrlIndex,
} = require('./projection');

// ── 数据文件路径（按读写频率排列） ──────────────────────────
// 前两个是每次构建的配置输入，后六个是构建状态/输出
const SOURCES_PATH = NEWS_FILES.sources;                            // 96 个来源（人工维护 + CLI）
const CONFIG_PATH = NEWS_FILES.config;                              // 评分/时间层/额度配置
const OUTPUT_PATH = NEWS_FILES.hotspots;                            // 前端热点投影（最后写入！）
const STATE_PATH = NEWS_FILES.state;                                // 构建批次和来源游标
const REGISTRY_PATH = NEWS_FILES.registry;                          // 持久视频记录
const REGISTRY_PRUNED_PATH = NEWS_FILES.registryPruned;             // N-P2：裁剪记录归档（可审计回滚）
const QUOTA_PATH = NEWS_FILES.quota;                                // 平台额度账本
const AUTHORIZATIONS_PATH = NEWS_FILES.authorizations;              // 待授权任务
const MANUAL_ITEMS_PATH = NEWS_FILES.manualItems;                    // B站人工精选暂存
const LOCK_PATH = NEWS_FILES.lock;                                  // 构建并发锁（不入库）

const PLATFORM_SCOPES = new Set(['all', 'bilibili-only']);
const EMPTY_OUTPUT = { items: [], events: [], provenance: [], assessments: [], coverage: {} };

function resolvePlatformScope(value = 'all') {
  const scope = String(value || 'all').trim();
  if (!PLATFORM_SCOPES.has(scope)) {
    throw new Error(`无效 NEWS_PLATFORM_SCOPE: ${scope}；仅支持 all 或 bilibili-only`);
  }
  return scope;
}

// ═══════════════════════════════════════════════════════════════
// 时间层统计（N-P1 决策）
//
// classifyTimeLayer 为真正转发到 news-scheduler 的统一实现（单一事实来源）。
// 历史：此处曾是独立实现且行为与 scheduler 不同（未来归 recent-1d、超窗/无效归 older），
// 注释谎称「转发」；现改为真正转发，并用 TIME_LAYER_STATS_OPTS 参数保持统计行为不变。
// 采集器侧（news-youtube / news-bilibili）用 scheduler 默认策略（边界内容归 null，不进入调度层）。
// ═══════════════════════════════════════════════════════════════

/** 管线统计策略（N-P1 决策）：未来归第一层、超窗归 older、无效归 older——保证 coverage/registry 恒有层标识。 */
const TIME_LAYER_STATS_OPTS = Object.freeze({ future: 'recent', overflow: 'older', invalid: 'older' });

/**
 * 将内容归入五层时间窗口（统计口径转发自 news-scheduler 的统一实现）。
 */
function classifyTimeLayer(item, config, now) {
  return schedulerClassifyTimeLayer(item.published_at, config.time_layers, now, TIME_LAYER_STATS_OPTS);
}

// ═══════════════════════════════════════════════════════════════
// 第 4 部分补充：状态合并与平台分发
// ═══════════════════════════════════════════════════════════════

function mergeStatus(current, next) {
  const rank = { not_run: 0, success: 1, rotating: 2, partial: 3, degraded: 4, failed: 5 };
  return (rank[next] ?? 0) > (rank[current] ?? 0) ? next : current;
}

function mergeRouteCoverage(current, next) {
  if (!current || current.status === 'not_run') return { ...next };
  return {
    status: mergeStatus(current.status, next.status),
    items: (current.items || 0) + (next.items || 0),
    reasons: [...new Set([...(current.reasons || (current.reason ? [current.reason] : [])), ...(next.reasons || (next.reason ? [next.reason] : []))])],
  };
}

function updateLayerState(state, source, items, status, config, now, error = null) {
  state.layer_coverage ||= {};
  for (const layer of config.time_layers) {
    state.layer_coverage[layer.id] ||= {};
    const count = items.filter(item => classifyTimeLayer(item, config, now) === layer.id).length;
    state.layer_coverage[layer.id][source.id] = {
      status: status === 'degraded' ? 'degraded' : count ? status : 'observed_empty',
      items: count,
      checked_at: new Date(now).toISOString(),
      error_code: error?.code || null,
    };
  }
}

function resolveActiveLayer(state, enabledSources, config) {
  const terminal = new Set(['success', 'partial', 'degraded', 'observed_empty']);
  for (const layer of config.time_layers) {
    const entries = state.layer_coverage?.[layer.id] || {};
    if (!enabledSources.every(source => terminal.has(entries[source.id]?.status))) return layer.id;
  }
  return null;
}

function initialState() {
  return {
    schema_version: 1,
    last_run: null,
    active_layer: null,
    x_rotation_offset: 0,
    layer_coverage: {},
    sources: {},
  };
}

/** 根据平台分发到对应采集函数（collectors/ 下的单一实现）。新增平台时在此增加分支。 */
async function collectSource(source, context) {
  if (source.platform === 'youtube') {
    const result = await collectYouTube(source, context);
    return {
      items: result.items,
      routeCoverage: result.enrichment.status === 'enriched' ? null : {
        metadata: { status: 'partial', items: result.items.length, reason: result.enrichment.reason || 'youtube_api_key_unavailable' },
      },
    };
  }
  if (source.platform === 'x') return { items: await collectX(source, context), routeCoverage: null };
  if (source.platform === 'bilibili') return collectBilibili(source, context);
  throw Object.assign(new Error(`不支持的平台：${source.platform}`), { code: 'unsupported_platform' });
}

async function mapWithConcurrency(values, limit, iteratee) {
  const configuredLimit = Number(limit);
  const workerCount = Math.min(values.length, Number.isFinite(configuredLimit) ? Math.max(1, Math.floor(configuredLimit)) : 1);
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await iteratee(values[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function collectLatestSource(source, context, collector, config) {
  try {
    const result = collector
      ? await collector(source, context)
      : await collectSource(source, context);
    const filtered = result.items.filter(item => matchesAi(item, config));
    return { source, result, filtered, filteredIds: new Set(filtered.map(item => `${item.platform}:${item.native_id}`)) };
  } catch (error) {
    return { source, error };
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 5 部分：历史层受控回溯
//
// 在最新 Feed 采集完成后，对 YouTube 和 Bilibili 来源执行
// 当前时间层的受控回溯（一次一页/一批，由 news-scheduler 管理进度）。
// 采集到的历史内容经 AI 过滤后合并到 freshItems，
// 再与最新 Feed 内容一起进入评分和输出。
//
// normalizeHistoricalYouTube/Bilibili 将平台原始详情/条目
// 转换为与最新 Feed 相同的内容模型，以便统一评分。
// ═══════════════════════════════════════════════════════════════

/** 将 YouTube videos.list 详情转换为统一内容模型 */
function normalizeHistoricalYouTube(detail, source, fetchedAt) {
  const snippet = detail.snippet || {};
  return {
    id: `youtube:${detail.id}`,
    platform: 'youtube',
    native_id: detail.id,
    source_type: 'youtube_video',
    url: `https://www.youtube.com/watch?v=${detail.id}`,
    title: snippet.title || '',
    description: snippet.description || '',
    published_at: snippet.publishedAt || null,
    fetched_at: fetchedAt,
    author_id: source.id,
    author_name: snippet.channelTitle || source.name,
    source_id: source.id,
    language: source.language,
    source_tags: source.content_tags,
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
    metrics: {
      views: numberOrNull(detail.statistics?.viewCount),
      likes: numberOrNull(detail.statistics?.likeCount),
      comments: numberOrNull(detail.statistics?.commentCount),
      reposts: null,
      replies: null,
    },
    explicit_links: [],
  };
}

function normalizeHistoricalBilibili(candidate, source, fetchedAt) {
  return {
    id: `bilibili:${candidate.native_id}`,
    platform: 'bilibili',
    native_id: candidate.native_id,
    source_type: candidate.source_type || candidate.content_type || 'unknown',
    url: candidate.canonical_url,
    title: candidate.title,
    description: candidate.description || '',
    published_at: candidate.published_at,
    fetched_at: fetchedAt,
    author_id: source.id,
    author_name: source.name,
    source_id: source.id,
    language: source.language,
    source_tags: source.content_tags,
    thumbnail: null,
    metrics: { views: null, likes: null, comments: null, reposts: null, replies: null },
    explicit_links: [],
  };
}

async function runHistoricalLayerPass(options) {
  const { config, sourcePayload, state, registryIndex, quota, now, fetchedAt, youtubeApiKey, fetchImpl } = options;
  const sourceScope = options.sources || sourcePayload.sources;
  const sources = sourceScope.filter(source => source.enabled && ['youtube', 'bilibili'].includes(source.platform));
  if (!sources.length) return { status: 'not_applicable', active_layer: null, items: [] };
  const historicalItems = [];
  const scheduler = createSchedulerState(state.history_scheduler || null);
  const layer = config.time_layers.find(item => item.id === scheduler.active_layer) || config.time_layers[0];
  scheduler.active_layer = layer.id;
  initializeLayer(scheduler, layer, sources, fetchedAt);
  // N-P3（2026-08-05）：历史回溯预算——单来源单层翻页/贡献条数硬上限，达限强制终态。
  // 页上限防病理频道无限翻页阻塞层推进；条数上限防单一来源淹没候选层。
  const maxPages = config.collection.max_pages_per_source_layer;
  const maxItems = config.collection.max_items_per_source_layer;

  for (const source of sources) {
    const key = `${layer.id}:${source.id}`;
    const progress = scheduler.sources[key];
    if (['complete', 'observed_empty', 'partial', 'history_unsupported', 'skipped_by_user'].includes(progress.status)) continue;
    // N-P3 max_pages：已达翻页上限 → 强制终态，不再调用采集器（页数跨 run 累计在 result.pages_fetched）
    if (source.platform === 'youtube' && maxPages && (progress.pages_fetched || 0) >= maxPages) {
      updateSourceProgress(scheduler, layer.id, source.id, { status: 'partial', stop_reason: 'max_pages_reached' }, fetchedAt);
      continue;
    }
    let result;
    try {
      if (source.platform === 'youtube') {
        if (!youtubeApiKey) {
          result = { status: 'temporarily_failed', stop_reason: 'missing_youtube_api_key' };
        } else {
          result = await collectYouTubeLayerStep({
            source, layer, timeLayers: config.time_layers, nowUtcMs: now, nowIso: fetchedAt,
            registry: registryIndex, quota, apiKey: youtubeApiKey,
            uploadsPlaylistId: progress.uploads_playlist_id,
            pageToken: historicalPageToken(progress),
            pageSize: config.collection.youtube_playlist_page_size,
            videoBatchSize: config.collection.youtube_video_batch_size,
            stopAfterNew: config.collection.stop_after_new_videos_per_source_layer,
            analysisVersion: config.collection.analysis_version,
            fetch: fetchImpl,
          });
        }
      } else {
        const base = config.collection.rsshub_base_url.replace(/\/$/, '');
        result = await collectBilibiliLayerStep({
          source, layer, timeLayers: config.time_layers, nowUtcMs: now, nowIso: fetchedAt,
          registry: registryIndex, quota, parseFeed,
          routes: [
            { type: 'bilibili_video', url: `${base}/bilibili/user/video/${source.external_id}` },
            { type: 'bilibili_dynamic', url: `${base}/bilibili/user/dynamic/${source.external_id}` },
            { type: 'bilibili_article', url: `${base}/bilibili/user/article/${source.external_id}` },
          ],
          fetch: fetchImpl,
        });
      }
      // N-P3：逐来源累计「本层已贡献条数」（跨 run，存 scheduler progress），
      // 超过 max_items_per_source_layer 时截断并强制终态。
      if (source.platform === 'youtube' && result.details) {
        const added = result.details.map(detail => normalizeHistoricalYouTube(detail, source, fetchedAt)).filter(item => item.title && item.published_at);
        const remaining = maxItems ? Math.max(0, maxItems - (progress.items_contributed || 0)) : added.length;
        historicalItems.push(...added.slice(0, remaining));
        result.items_contributed = (progress.items_contributed || 0) + Math.min(added.length, remaining);
      }
      if (source.platform === 'bilibili' && result.items) {
        const added = result.items.map(item => normalizeHistoricalBilibili(item, source, fetchedAt)).filter(item => item.title && item.url && item.published_at);
        const remaining = maxItems ? Math.max(0, maxItems - (progress.items_contributed || 0)) : added.length;
        historicalItems.push(...added.slice(0, remaining));
        result.items_contributed = (progress.items_contributed || 0) + Math.min(added.length, remaining);
      }
      // N-P3 max_pages：翻页数跨 run 累计（collector 单步返回 pages_fetched=1）
      if (source.platform === 'youtube' && result.pages_fetched) {
        result.pages_fetched = (progress.pages_fetched || 0) + result.pages_fetched;
      }
      // N-P3 max_items：贡献条数达到上限后强制终态，后续不再为该来源翻页/聚合。
      // 不覆盖 quota_paused / 失败状态（额度或错误优先，保留恢复游标与审计）。
      if (maxItems && (result.items_contributed || 0) >= maxItems
        && !['quota_paused', 'temporarily_failed', 'permanently_failed'].includes(result.status)) {
        result.status = 'partial';
        result.stop_reason = 'max_items_reached';
      }
    } catch (error) {
      result = { status: 'temporarily_failed', stop_reason: error.code || error.name || 'history_step_failed', error_message: error.message };
    }
    if (result.status !== 'quota_paused') result.resume_page_token = null;
    updateSourceProgress(scheduler, layer.id, source.id, result, fetchedAt);
  }

  const advancement = advanceLayer(scheduler, config.time_layers, sources.map(source => source.id), fetchedAt);
  if (advancement.advanced && advancement.next_layer) initializeLayer(scheduler, config.time_layers.find(item => item.id === advancement.next_layer), sources, fetchedAt);
  state.history_scheduler = scheduler;
  return {
    status: advancement.complete ? 'complete' : advancement.reason || 'advanced',
    active_layer: scheduler.active_layer,
    items: historicalItems,
  };
}

// ═══════════════════════════════════════════════════════════════
// 第 6 部分：主构建编排（runCollection）
//
// 这是整个热点系统的核心编排函数，按 5 个 Phase 执行：
//   Phase 1: 准备配置、来源、状态、额度、Registry
//   Phase 2: 最新 Feed 采集（本轮作用域内的启用来源）
//   Phase 3: 历史层受控回溯（YouTube + Bilibili 单步）
//   Phase 4: 评分、溯源、主题聚合
//   Phase 5: 原子写入（状态文件在前，hotspots.json 最后）
//
// 参数说明：
//   options.collector —— 注入自定义采集函数（fixture 测试用）
//   options.skipHistory —— 跳过历史回溯（fixture 测试默认开启）
//   options.noWrite —— 跳过文件写入（fixture 测试默认开启）
//   options.oldOutput —— 注入旧热点投影（fixture 测试应传空投影，避免读取生产数据）
//   options.platformScope —— all 或 bilibili-only；后者只发出 B站网络请求
//   options.allowEmpty —— 允许空输出而不抛出错误
// ═══════════════════════════════════════════════════════════════
async function runCollection(options = {}) {
  const config = options.config || readJson(CONFIG_PATH);
  const sourcePayload = options.sourcePayload || readJson(SOURCES_PATH);
  const oldOutput = options.oldOutput ?? readJson(OUTPUT_PATH, EMPTY_OUTPUT);
  const state = options.state || readJson(STATE_PATH, initialState());
  if (state.history_scheduler) createSchedulerState(state.history_scheduler);
  const platformScope = resolvePlatformScope(options.platformScope ?? 'all');
  const now = options.now || Date.now();
  const fetchedAt = new Date(now).toISOString();
  const runId = `run-${fetchedAt.replace(/[-:.TZ]/g, '')}`;
  const quota = options.quota || createQuotaLedger(config.collection, runId, fetchedAt);
  const registryIndex = options.registryIndex || createRegistry(readJson(REGISTRY_PATH, null));
  const allEnabled = sourcePayload.sources.filter(source => source.enabled);
  const bilibiliManual = config.collection.bilibili_collection_mode === 'manual';
  const bilibiliAutomatedPaused = bilibiliManual && platformScope === 'all' && !options.collector;
  const enabled = platformScope === 'bilibili-only'
    ? allEnabled.filter(source => source.platform === 'bilibili')
    : allEnabled.filter(source => !(bilibiliAutomatedPaused && source.platform === 'bilibili'));
  // B16 决策 51/69：新候选默认 review_status 为 pending，等待人工审核。
  // options.defaultReviewStatus 仅供测试/覆盖用（管线单元测试保持断言公开投影），
  // 生产路径不传，沿用 DEFAULT_REVIEW_STATUS（pending）。
  const defaultReviewStatus = options.defaultReviewStatus || DEFAULT_REVIEW_STATUS;
  const manualPayload = options.manualItems ?? readJson(MANUAL_ITEMS_PATH, { schema_version: 1, items: [] });
  const manualItems = (manualPayload.items || [])
    .map(item => normalizeManualItem(item, sourcePayload.sources, fetchedAt))
    .filter(item => registryIndex.byKey.get(`bilibili:${item.native_id}`)?.processing_status !== 'published');

  // X 来源轮转：每次构建只选取 x_max_sources_per_run 个来源，
  // 从上次的 rotation_offset 开始循环取，控制日调用成本。
  // bilibili-only 不选择 X 来源，并保留原有轮转游标。
  const allXSources = allEnabled.filter(source => source.platform === 'x');
  const xSources = enabled.filter(source => source.platform === 'x');
  const xLimit = Math.min(config.collection.x_max_sources_per_run, xSources.length);
  const offset = (state.x_rotation_offset || 0) % Math.max(1, xSources.length);
  const selectedX = Array.from({ length: xLimit }, (_, index) => xSources[(offset + index) % xSources.length]);
  const selectedXIds = new Set(selectedX.map(source => source.id));
  const selected = enabled.filter(source => source.platform !== 'x' || selectedXIds.has(source.id));

  const context = {
    config,
    fetchedAt,
    quota,
    xApiKey: options.xApiKey ?? process.env.X_API_KEY,
    youtubeApiKey: options.youtubeApiKey ?? process.env.YOUTUBE_API_KEY,
    fetchImpl: options.fetchImpl,
  };
  const freshItems = [...manualItems.filter(item => matchesAi(item, config))];
  const observedRegistryResults = [];
  const coverage = {
    status: 'running',
    platform_scope: platformScope,
    sources_total: enabled.length,
    sources_attempted: selected.length,
    sources_terminal: 0,
    platforms: {
      youtube: platformScope === 'bilibili-only'
        ? { status: 'not_run', items: 0, reason: 'excluded_by_platform_scope' }
        : { status: 'not_run', items: 0 },
      x: platformScope === 'bilibili-only'
        ? { status: 'not_run', items: 0, attempted: 0, total: allXSources.length, reason: 'excluded_by_platform_scope' }
        : { status: 'rotating', items: 0, attempted: selectedX.length, total: xSources.length },
      bilibili: bilibiliAutomatedPaused ? {
        status: 'manual_curated', items: freshItems.filter(item => item.platform === 'bilibili').length,
        reason: 'automated_collection_paused',
        video: { status: 'not_run' }, dynamic: { status: 'not_run' }, article: { status: 'not_run' },
      } : {
        status: 'not_run', items: 0,
        video: { status: 'not_run' }, dynamic: { status: 'not_run' }, article: { status: 'not_run' },
      },
    },
  };

  let providerBlocked = null;
  if (platformScope === 'bilibili-only' && !options.collector && selected[0]) {
    const probe = await probeBilibiliProvider(selected[0], context);
    if (probe.blocked) {
      providerBlocked = probe.reason;
      coverage.sources_terminal = selected.length;
      coverage.platforms.bilibili = {
        status: 'degraded', items: 0, reason: 'rsshub_provider_blocked', provider_reason: probe.reason,
        video: { status: 'degraded', items: 0, reason: probe.reason },
        dynamic: { status: 'not_run', items: 0, reason: 'provider_circuit_open' },
        article: { status: 'not_run', items: 0, reason: 'provider_circuit_open' },
      };
    }
  }

  const latestResults = providerBlocked
    ? []
    : await mapWithConcurrency(selected, config.collection.concurrency, source => collectLatestSource(source, context, options.collector, config));
  for (const outcome of latestResults) {
    const { source } = outcome;
    if (!outcome.error) {
      const { result, filtered, filteredIds } = outcome;
      observedRegistryResults.push(...bulkDiscover(registryIndex, result.items.map(item => ({
        platform: item.platform,
        native_id: item.native_id,
        source_id: item.source_id,
        canonical_url: item.url,
        title: item.title,
        published_at: item.published_at,
        layer_id: classifyTimeLayer(item, config, now),
        discovery_status: filteredIds.has(`${item.platform}:${item.native_id}`) ? 'discovered' : 'filtered_non_ai',
      })), { now: fetchedAt }));
      freshItems.push(...filtered);
      const status = result.routeCoverage && Object.values(result.routeCoverage).some(route => route.status === 'degraded') ? 'partial' : 'success';
      state.sources[source.id] = {
        status,
        attempts: 1,
        last_native_id: filtered[0]?.native_id || null,
        last_published_at: filtered[0]?.published_at || null,
        fetched_at: fetchedAt,
        error_code: null,
        error_message: null,
        route_coverage: result.routeCoverage,
      };
      updateLayerState(state, source, filtered, status, config, now);
      coverage.sources_terminal++;
      coverage.platforms[source.platform].items += filtered.length;
      coverage.platforms[source.platform].status = mergeStatus(coverage.platforms[source.platform].status, status);
      if (source.platform === 'bilibili' && result.routeCoverage) {
        for (const [key, value] of Object.entries(result.routeCoverage)) {
          coverage.platforms.bilibili[key] = mergeRouteCoverage(coverage.platforms.bilibili[key], value);
        }
      }
    } else {
      const { error } = outcome;
      state.sources[source.id] = {
        status: 'degraded', attempts: config.collection.max_retries + 1,
        last_native_id: state.sources[source.id]?.last_native_id || null,
        last_published_at: state.sources[source.id]?.last_published_at || null,
        fetched_at: fetchedAt,
        error_code: error.code || error.name || 'collection_failed',
        error_message: error.message,
      };
      updateLayerState(state, source, [], 'degraded', config, now, error);
      coverage.sources_terminal++;
      coverage.platforms[source.platform].status = mergeStatus(coverage.platforms[source.platform].status, 'degraded');
    }
  }

  const skipHistory = options.skipHistory ?? Boolean(options.collector);
  const history = skipHistory || providerBlocked
    ? { status: providerBlocked ? 'provider_circuit_open' : 'skipped', active_layer: state.history_scheduler?.active_layer || null, items: [] }
    : await runHistoricalLayerPass({
      config, sourcePayload, sources: enabled, state, registryIndex, quota, now, fetchedAt,
      youtubeApiKey: context.youtubeApiKey,
      fetchImpl: context.fetchImpl, // 测试注入点：历史采集复用统一 fetch（N-P3 集成测试需要）
    });
  freshItems.push(...(history.items || []).filter(item => matchesAi(item, config)));

  // B16 决策 63/72：旧内容保留与公开资格统一使用同一近期窗口过滤（单一来源规则，
  // 规则集中在 news-public-gate.js，RSS 与热点视图共用，避免口径漂移）。
  const retainedOld = (oldOutput.items || []).filter(item => isWithinPublicWindow(item, { now, config }));
  const items = dedupeItems([...freshItems, ...retainedOld])
    // N-P1：排序前预解析 published_at 为时间戳，避免比较器内重复 new Date（N-P4 印证的排序热点）
    .map(item => [item, new Date(item.published_at).getTime()])
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item)
    .slice(0, config.collection.max_output_items);

  // B16 决策 74/77/78/85/88/89：写出前补充公开热点数据契约字段（热度/依据片段/稳定关联）
  enrichHotspotProjection(items, getToolUrlIndex());

  if (!items.length && !options.allowEmpty) throw new Error('本轮未获得任何有效内容，保留上一版输出');

  const sourceMap = new Map(sourcePayload.sources.map(source => [source.id, source]));
  const assessments = items.map(item => assessItem(item, sourceMap.get(item.source_id) || { content_tags: [], quality_prior: 50, reliability_prior: 50 }, config, now));
  applyAnomalyDetection(items, assessments, config);
  const events = buildEvents(items, assessments, config);
  const provenance = buildProvenance(items);
  coverage.time_layers = Object.fromEntries(config.time_layers.map(layer => [layer.id, { items: 0 }]));
  coverage.time_layers.older = { items: 0 };
  for (const item of items) coverage.time_layers[classifyTimeLayer(item, config, now)].items++;
  coverage.status = providerBlocked
    ? 'partial'
    : coverage.sources_terminal === selected.length ? 'complete' : 'partial';
  if (platformScope === 'all' && selectedX.length < xSources.length) {
    coverage.platforms.x.status = coverage.platforms.x.status === 'degraded' ? 'degraded' : 'rotating';
    if (coverage.status === 'complete') coverage.status = 'rotating';
  }

  state.schema_version = 1;
  state.last_run = { run_id: runId, started_at: fetchedAt, completed_at: new Date().toISOString(), status: coverage.status };
  state.active_layer = resolveActiveLayer(state, enabled, config);
  state.x_rotation_offset = platformScope === 'all' && xSources.length
    ? (offset + xLimit) % xSources.length
    : state.x_rotation_offset || 0;
  coverage.active_layer = state.active_layer;
  coverage.time_layer_scope = 'latest-feed-observation';

  // B16 决策 49/69：先构建内部候选层（每条候选带双状态轴），公开 hotspots.json
  // 由候选层经公开资格门禁派生，不再直接写原始 items。
  // 决策 70：采集时给候选打上所属抓取批次 batch_id 与初版 candidate_version。
  const batchId = `batch_${fetchedAt.slice(0, 10).replace(/-/g, '')}`;
  // B16 路径 A：候选创建前跑内容分类建议（决策 65/66/79）。
  //   - L0 规则式恒兜底：新候选默认得 ai_suggested 建议（classifier=rule_based），
  //     不再是无条件 unclassified；
  //   - L1 DeepSeek 显式启用：INFOCATCHER_CLASSIFY_PROVIDER=deepseek 或存在
  //     DEEPSEEK_API_KEY 时启用；缺 key/网络失败时 classifyWithDeepSeek 返回降级对象，
  //     分类器自动回退 L0，build 不因 LLM 故障阻塞（b16 成本/可靠性约定）；
  //   - 已人工确认（content_type_status=reviewed）的候选被 classifyCandidates 跳过，
  //     且 mergeCandidates 保留其结论，双保险防止 AI 建议覆盖人工确认。
  const classifyProvider = process.env.INFOCATCHER_CLASSIFY_PROVIDER
    || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : null);
  const classifiedItems = await classifyCandidates(items, {
    provider: classifyProvider,
    model: process.env.INFOCATCHER_CLASSIFY_MODEL || undefined,
    fetchImpl: context.fetchImpl,
    concurrency: config.collection.concurrency, // N-P3：统一用配置值（此前硬编码 5，与采集并发不一致）
  });
  const candidateStore = mergeCandidates(
    readCandidateStore(),
    classifiedItems.items.map(item => stampCandidateStatuses({
      ...item,
      // B16 决策 65/66：content_type 为内容类型（AI 工具/产品/概念/技术动态/行业事件/其他）。
      // 分类建议由上方 classifyCandidates 写入（L0 或 L1，classifier 字段标注来源）；
      // 未分类（缺 title 等异常）时兜底 unclassified，content_type_status 诚实记录状态。
      source_type: item.source_type || item.content_type || 'unknown',
      content_type: item.content_type || 'unclassified',
      content_type_status: item.content_type_status || 'unclassified',
      batch_id: batchId,
      candidate_version: item.candidate_version || 1,
    }, { review_status: defaultReviewStatus })),
    fetchedAt
  );
  const statusById = new Map(candidateStore.candidates.map(candidate => [candidate.id, candidate]));

  // B16 决策 63：发布时间缺失或未来超容错的候选标记为 held（异常待复审），
  // 不会通过审核门禁进入公开数据；变更记录到只追加审核事件日志（决策 70）。
  // 注意：news-public-gate 的 classifyPublicTime 用 now - time 做算术，必须传数字时间戳 now，
  // 不能传 ISO 字符串 fetchedAt（字符串参与减法会得到 NaN，导致未来/超窗判定静默失效）。
  const timeAnomalies = markAnomalousTimeCandidates(candidateStore, { now, config });
  if (!options.noWrite && timeAnomalies.length) {
    for (const { id } of timeAnomalies) {
      const candidate = statusById.get(id);
      if (candidate) {
        recordReviewTransition(candidate, { action: 'time_anomaly_hold', reason: candidate.hold_reason, reviewer: 'system', now: fetchedAt });
      }
    }
  }

  // B16 决策 51/52：对本轮 YouTube 候选做字幕/文字稿 enrichment（配置开关控制，
  // 默认关闭）。成功获取且此前因字幕原因 held 的候选重置为 pending；字幕缺失/过短
  // 置为 held，技术失败置为 error。状态对象被就地修改，statusById 与后续投影同步。
  const reviewStatusBefore = new Map(items.map(item => [item.id, statusById.get(item.id)?.review_status]));
  await enrichYouTubeTranscripts(candidateStore, items.map(item => item.id), {
    enabled: config.collection.transcript_enabled === true && options.transcriptEnabled !== false,
    fetchImpl: context.fetchImpl,
    baseUrl: config.collection.transcript_base_url,
    languages: config.collection.transcript_languages,
    minChars: config.collection.transcript_min_chars,
    timeoutMs: config.collection.transcript_timeout_ms,
    maxItems: config.collection.transcript_max_items_per_run,
    now: fetchedAt,
    runId,
  });
  // B16 决策 70：字幕 enrichment 导致的审核状态变化（自动 held / 恢复 pending）也
  // 追加到只追加审核事件日志，保证历史状态可追溯。
  if (!options.noWrite) {
    for (const item of items) {
      const candidate = statusById.get(item.id);
      const before = reviewStatusBefore.get(item.id);
      if (candidate && candidate.review_status !== before) {
        const action = candidate.review_status === 'held' ? 'transcript_auto_hold' : 'transcript_recovery';
        recordReviewTransition(candidate, { action, reason: candidate.hold_reason || null, reviewer: 'system', now: fetchedAt });
      }
    }
  }
  // 内容总结 enrichment（content-summarizer，默认关闭）：对本轮候选做 AI 总结。
  // 必须在字幕 enrichment（上方）之后调用——候选有 transcript 时总结用字幕，无字幕
  // 时自动只用 title+desc。总结是候选上的 AI 建议字段（summary / summary_key_points），
  // 不引入独立审核态，随 review_status 门禁进公开（approved 才公开）；任何 LLM 失败
  // 降级为 summary=null，前端回退 description，不阻塞采集管线。
  // 成本控制：summary_enabled 默认关 + maxItems 上限 + 只总结无 summary 的候选。
  await enrichCandidateSummaries(candidateStore, items.map(item => item.id), {
    enabled: config.collection.summary_enabled === true,
    fetchImpl: context.fetchImpl,
    maxItems: config.collection.summary_max_items_per_run,
    maxTranscriptChars: config.collection.summary_max_transcript_chars,
    timeoutMs: config.collection.summary_timeout_ms,
    concurrency: config.collection.concurrency,
    now: fetchedAt,
  });
  // AI 审核建议 enrichment（content-reviewer，默认关闭）：对本轮候选做 AI 初步审核，
  // 输出 ai_review 建议（verdict: discard/hold/approve + reasons + confidence）。
  // 必须在总结 enrichment（上方）之后调用——审核输入含候选 summary，无总结时自动只用
  // title+desc+字幕。ai_review 是内部建议字段，不进公开投影（前端零改动）。
  // 自动化：review_auto_apply=true 且 confidence≥review_auto_min_confidence 时，
  // discard/hold 由 AI 自动落 review_status（reviewer='ai_review'，可恢复、进审核日志）；
  // approve 永不自动落——通过必须由人 review set/batch。
  // 成本控制：review_enabled 默认关 + maxItems 上限 + 只审核无 ai_review 且 pending 的候选。
  const reviewResult = await enrichCandidateReviews(candidateStore, items.map(item => item.id), {
    enabled: config.collection.review_enabled === true,
    fetchImpl: context.fetchImpl,
    maxItems: config.collection.review_max_items_per_run,
    timeoutMs: config.collection.review_timeout_ms,
    concurrency: config.collection.concurrency,
    autoApply: config.collection.review_auto_apply === true,
    autoMinConfidence: config.collection.review_auto_min_confidence,
    now: fetchedAt,
  });
  // B16 决策 70：AI 审核自动应用导致的状态变化（reviewer='ai_review'）也追加到
  // 只追加审核事件日志，保证历史状态可追溯；与上方字幕 auto-hold 的记录方式一致。
  if (!options.noWrite && reviewResult.autoApplied.length) {
    for (const applied of reviewResult.autoApplied) {
      const candidate = statusById.get(applied.id);
      if (candidate) {
        recordReviewTransition(candidate, {
          action: applied.to === 'discarded' ? 'ai_review_auto_discard' : 'ai_review_auto_hold',
          reason: applied.reasons && applied.reasons.length ? applied.reasons.join('；') : null,
          reviewer: 'ai_review',
          now: fetchedAt,
        });
      }
    }
  }
  // 内容本地化 enrichment（content-localizer，默认关闭）：对本轮候选做多语言翻译，
  // 输出 localizations[locale]（当前 zh）—— 前端按语言读取，原文 title/description 保留
  // 顶层作溯源核验基线。只消费原文 title/desc，与总结/审核无依赖，放 review 之后、投影之前。
  // 成本控制：localize_enabled 默认关 + maxItems 上限 + 只翻译无 localizations[locale] 的候选。
  await enrichCandidateLocalizations(candidateStore, items.map(item => item.id), {
    enabled: config.collection.localize_enabled === true,
    fetchImpl: context.fetchImpl,
    maxItems: config.collection.localize_max_items_per_run,
    locale: config.collection.localize_target_locale || 'zh',
    timeoutMs: config.collection.localize_timeout_ms,
    concurrency: config.collection.concurrency,
    now: fetchedAt,
  });
  // 仅取本轮 items 对应的候选：公开窗口/排序/上限仍由上方 items 逻辑决定，
  // 门禁只剔除未通过人工审核的候选，历史积累不会回流公开。
  let output = buildPublicProjection({
    candidates: items.map(item => statusById.get(item.id)).filter(Boolean),
    events,
    provenance,
    assessments,
    coverage,
    generatedAt: fetchedAt,
    heatDefinition: HEAT_DEFINITION,
  });
  // B16 决策 63/72：公开投影生成时再次按统一近期窗口一致过滤（第二道防线），
  // 覆盖历史回溯混入的超窗条目，与 publish-news.js / RSS 共用同一规则。
  // now 必须为数字时间戳（同上方 markAnomalousTimeCandidates 的类型要求）。
  output = filterProjectionByWindow(output, { config, now });

  const registryResults = bulkDiscover(registryIndex, items.map(item => ({
    platform: item.platform,
    native_id: item.native_id,
    source_id: item.source_id,
    canonical_url: item.url,
    title: item.title,
    published_at: item.published_at,
    layer_id: classifyTimeLayer(item, config, now),
    discovery_status: 'discovered',
  })), { now: fetchedAt });
  for (const result of registryResults) {
    updateLifecycle(result.record, {
      processing_status: 'published',
      details_fetched: true,
      analysis_completed: true,
      analysis_version: config.collection.analysis_version,
    }, fetchedAt);
  }
  output.coverage.history = { status: history.status, active_layer: history.active_layer };
  const authorizations = createAuthorizationStore(readJson(AUTHORIZATIONS_PATH, null));
  if (history.status === 'complete' && state.history_scheduler) {
    for (const source of enabled.filter(item => ['youtube', 'bilibili'].includes(item.platform))) {
      const progress = config.time_layers.map(layer => state.history_scheduler.sources[`${layer.id}:${source.id}`]).filter(Boolean);
      if (progress.length === config.time_layers.length && progress.every(entry => Number(entry.new_video_count || 0) === 0)) {
        createAuthorizationTask(authorizations, {
          platform: source.platform,
          source_id: source.id,
          source_name: source.name,
          searched_range_days: 270,
          duplicate_count: progress.reduce((sum, entry) => sum + Number(entry.duplicate_count || 0), 0),
          filtered_count: progress.reduce((sum, entry) => sum + Number(entry.filtered_count || 0), 0),
          quota: quota.platforms[source.platform],
          capability_limit: source.platform === 'bilibili' ? 'rsshub_visible_feed_only_no_date_pagination' : null,
        }, fetchedAt);
      }
    }
  }
  const registry = finalizeRegistry(registryIndex, fetchedAt);
  // N-P2（2026-08-05）：每轮 build 自动裁剪超期 Registry 记录（用户拍板：以 last_seen_at
  // 起算、保留 registry_retention_days 天）。裁剪在内存中先完成，归档批次先于 registry
  // 写盘：若归档写失败则异常先抛，registry 文件保持旧版（未裁剪），下一轮重新裁剪，安全。
  const registryPrune = pruneRegistry(registryIndex, {
    now: fetchedAt, retentionDays: config.collection.registry_retention_days, runId,
  });
  const finalizedQuota = finishQuotaLedger(quota, fetchedAt);
  output.coverage.registry = {
    total: registry.stats.count,
    observations_in_run: observedRegistryResults.length,
    new_in_projection: registryResults.filter(result => result.isNew).length,
    pruned_in_run: registryPrune.pruned_count,
    analysis_version: config.collection.analysis_version,
  };

  // 写入顺序有严格依赖：Registry/State/Quota/Authorizations 是内部状态，
  // 候选层也是内部状态（不发布），hotspots.json 是面向浏览器的公开投影。
  // 候选层先写、公开投影最后写：如果中间任何一步失败，旧 hotspots.json 保持
  // 不变，前端不会看到半成品。
  // 候选层写入前附带投影快照（events/provenance/assessments/coverage/热度定义），
  // 使 PR 合并后可由 Actions 独立重建最终公开投影（决策 49/59）。
  if (!options.noWrite) {
    if (registryPrune.pruned_count > 0) {
      // N-P2 归档：追加批次到 news-registry-pruned.json（run_id/规则/时间 + 记录全文），
      // 提供「可审计清理与回滚」——从归档可恢复被裁剪记录（CLI/手动重新导入）。
      const archive = readJson(REGISTRY_PRUNED_PATH, { schema_version: 1, prunes: [] });
      archive.prunes ||= [];
      archive.prunes.push({
        run_id: runId,
        pruned_at: fetchedAt,
        retention_days: config.collection.registry_retention_days,
        count: registryPrune.pruned_count,
        records: registryPrune.pruned,
      });
      writeJsonAtomic(REGISTRY_PRUNED_PATH, archive, runId);
    }
    writeJsonAtomic(REGISTRY_PATH, registry, runId);
    writeJsonAtomic(STATE_PATH, state, runId);
    writeJsonAtomic(QUOTA_PATH, finalizedQuota, runId);
    writeJsonAtomic(AUTHORIZATIONS_PATH, authorizations, runId);
    attachProjectionSnapshot(candidateStore, {
      events,
      provenance,
      assessments,
      coverage,
      heatDefinition: HEAT_DEFINITION,
    });
    writeCandidateStore(candidateStore, runId);
    // B16 决策 51/69：新候选默认 pending 待人工审核。公开投影经门禁过滤后可能为空，
    // 此时不覆盖 hotspots.json（保留上一版公开数据），避免本地采集误伤公开页；
    // 公开区由审核通过后 publish-news.js 从候选层重建（决策 59）。
    if (output.items.length > 0) {
      writeJsonAtomic(OUTPUT_PATH, output, runId);
    } else {
      console.log('ℹ️ 本轮公开投影为空（候选层无 approved），hotspots.json 保持不变；公开区由审核通过后 publish-news.js 重建');
    }
  }
  return { output, state, registry, quota: finalizedQuota, authorizations };
}

// ═══════════════════════════════════════════════════════════════
// 第 7 部分：测试入口与主入口
//
// --fixture：使用本地 XML/JSON 样本运行完整采集+评分管线，
//   不请求真实 API、不消费额度、不写持久文件（noWrite=true）。
//   用于验证标准化→过滤→评分→溯源的确定性行为。
//
// --allow-empty：允许本轮采集无有效内容时不抛出错误，
//   保留上一版 hotspots.json 不变（生产保护机制）。
// ═══════════════════════════════════════════════════════════════

/** 使用本地 fixture 样本运行完整内容管线（仅用于测试） */
async function runFixtureBuild() {
  const fixtureDir = DIRS.fixtures;
  const youtubeSource = {
    id: 'fixture-youtube', platform: 'youtube', external_id: 'fixture', name: 'Fixture YouTube',
    language: 'zh', content_tags: ['深度解读'], enabled: true, quality_prior: 70, reliability_prior: 70,
  };
  const xSource = {
    id: 'fixture-x', platform: 'x', external_id: 'fixture', handle: 'fixture', name: 'Fixture X',
    language: 'en', content_tags: ['即时资讯'], enabled: true, quality_prior: 60, reliability_prior: 60,
  };
  const bilibiliSource = {
    id: 'fixture-bilibili', platform: 'bilibili', external_id: 'fixture', name: 'Fixture B站',
    language: 'zh', content_tags: ['轻度用户体验'], enabled: true, quality_prior: 60, reliability_prior: 50,
  };
  const fixedNow = new Date('2026-07-23T12:00:00Z').getTime();
  const fetchedAt = new Date(fixedNow).toISOString();
  const youtubeItems = parseFeed(fs.readFileSync(path.join(fixtureDir, 'youtube.xml'), 'utf8'))
    .map(item => normalizeRssItem(item, youtubeSource, 'youtube_video', fetchedAt));
  const xPayload = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'x.json'), 'utf8'));
  const xItems = extractTweetArray(xPayload).map(tweet => normalizeTweet(tweet, xSource, fetchedAt)).filter(Boolean);
  const dynamicItems = parseFeed(fs.readFileSync(path.join(fixtureDir, 'bilibili-dynamic.xml'), 'utf8'))
    .map(item => normalizeRssItem(item, bilibiliSource, 'bilibili_dynamic', fetchedAt));
  return runCollection({
    sourcePayload: { schema_version: 1, sources: [youtubeSource, xSource, bilibiliSource] },
    state: initialState(), oldOutput: EMPTY_OUTPUT,
    now: fixedNow, noWrite: true, allowEmpty: false, skipHistory: true,
    // fixture 用于确定性测试采集+评分管线，用 approved 保持断言公开投影的能力；
    // 生产路径不传该选项，新候选默认 pending 待人工审核（决策 51/69）。
    defaultReviewStatus: 'approved',
    collector: async current => {
      if (current.platform === 'youtube') return { items: youtubeItems, routeCoverage: null };
      if (current.platform === 'x') return { items: xItems, routeCoverage: null };
      return {
        items: dynamicItems,
        routeCoverage: {
          video: { status: 'success', items: 0 },
          dynamic: { status: 'success', items: dynamicItems.length },
          article: { status: 'success', items: 0 },
        },
      };
    },
  });
}

async function main() {
  if (process.argv.includes('--upgrade-hotspots')) {
    upgradeHotspotsProjection();
    return;
  }
  if (process.argv.includes('--migrate-content-type')) {
    migrateContentTypeProjection();
    return;
  }
  if (process.argv.includes('--fixture')) {
    const fixture = await runFixtureBuild();
    console.log(`✅ Fixture 构建完成：${fixture.output.items.length} 条内容，${fixture.output.events.length} 个主题`);
    return;
  }
  const runId = `build-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
  try {
    acquireLock(LOCK_PATH, { run_id: runId, pid: process.pid, started_at: new Date().toISOString() });
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('已有热点构建正在运行；请用 news-cli.js lock status 检查'), { code: 'build_locked' });
    throw error;
  }
  try {
    const allowEmpty = process.argv.includes('--allow-empty');
    const platformScope = resolvePlatformScope(process.env.NEWS_PLATFORM_SCOPE || 'all');
    console.log(`ℹ️ 采集范围：${platformScope}`);
    const result = await runCollection({ allowEmpty, platformScope });
    console.log(`✅ 热点构建完成：${result.output.items.length} 条内容，${result.output.events.length} 个主题`);
    console.log(`   覆盖：${result.output.coverage.sources_terminal}/${result.output.coverage.sources_attempted} 个本轮来源`);
    generateRss();
  } finally {
    releaseLock(LOCK_PATH, runId);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`❌ 热点构建失败：${error.message}`);
    process.exit(1);
  });
}

// ═══════════════════════════════════════════════════════════════
// 汇总 re-export（scripts/、GitHub Actions、测试依赖这些名字）
//
// 本文件只负责编排与汇总，具体实现分布在：
//   - feed-parser.js：parseFeed / normalizeRssItem / inferBilibiliType / historicalPageToken
//   - news-x.js：normalizeTweet
//   - scoring.js：matchesAi / scoreTimeliness / detectLightExperience / detectCommercial /
//     assessItem / applyAnomalyDetection / HEAT_DEFINITION
//   - projection.js：buildProvenance / buildEvents / dedupeItems / buildEvidenceExcerpt /
//     buildToolUrlIndex / resolveRelatedResources / buildRelatedTitleLexicon /
//     titleContainsKeyword / matchRelatedByTitle / searchConceptKey / computeHotScores /
//     enrichHotspotProjection / upgradeHotspotsProjection / migrateContentTypeProjection
// ═══════════════════════════════════════════════════════════════

module.exports = {
  parseFeed,
  resolvePlatformScope,
  normalizeRssItem,
  normalizeTweet,
  inferBilibiliType,
  matchesAi,
  scoreTimeliness,
  detectLightExperience,
  detectCommercial,
  assessItem,
  buildProvenance,
  buildEvents,
  applyAnomalyDetection,
  classifyTimeLayer,
  HEAT_DEFINITION,
  buildEvidenceExcerpt,
  buildToolUrlIndex,
  resolveRelatedResources,
  buildRelatedTitleLexicon,
  titleContainsKeyword,
  matchRelatedByTitle,
  searchConceptKey,
  computeHotScores,
  enrichHotspotProjection,
  upgradeHotspotsProjection,
  migrateContentTypeProjection,
  dedupeItems,
  runCollection,
  runFixtureBuild,
  historicalPageToken,
  main,
};
