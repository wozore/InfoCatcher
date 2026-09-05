/**
 * collector-youtube-v2.js — 热点管线 v2 的 YouTube 采集器（关键词发现）
 *
 * 在热点管线 v2 中的位置：v2 管线（热点发现层）的 YouTube 采集入口，
 * 通过 YouTube Data API v3 search.list 按关键词发现近 N 日内容，
 * 再用 videos.list / videoCategories.list / commentThreads.list 补详情、
 * 分类名与评论，统一输出为 v1 管线相同的内容模型。
 *
 * 采集模型：按 config.keywords.ai_keywords 关键词搜索，使用独立配额计数，
 * 全程无来源名单；不依赖 quota ledger / registry / scheduler。
 *
 * 配额模型（成本要点）：
 *   - search.list：独立桶，1 单位/次（config.collection.youtube_search_cost_units），
 *     每次运行上限 config.collection.youtube_search_max_per_run（100 次）；
 *   - videos.list（≤50 ID/批）、commentThreads.list（每条视频 1 次）、
 *     videoCategories.list（1 次）都从 youtube_daily_quota_units（10000）总配额扣；
 *   - usedQuota 计数器累计所有端点消耗，searchCalls 单独累计 search.list 调用次数；
 *     任一超出即停止，不抛错，降级返回部分结果。
 *
 * 使用示例：
 *   const result = await collectYouTubeV2({
 *     config,                       // data/news/config/news-config-v2.json（缺省自动加载）
 *     apiKey,                       // 缺省读 YOUTUBE_API_KEY（经 loadCollectorConfig）
 *     now: '2026-08-07T00:00:00Z',  // 可选，测试注入
 *     fetchImpl: customFetch,       // 可选，测试注入
 *   });
 *   // => { items, quota, coverage }
 */

'use strict';

const { requestText, numberOrNull } = require('../pipeline/feed-parser');
const { parseDuration, buildItem } = require('./collector-youtube-normalize');
const { youtubeApiKeyOf } = require('./loadCollectorConfig');
const { readJson } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

/** 兜底配置：仅在未传入 config 且 v2 配置文件不可读时使用。 */
const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  schedule: { youtube_window_days: 3 },
  collection: {
    youtube_search_max_per_run: 100,
    youtube_search_cost_units: 1,
    youtube_daily_quota_units: 10000,
    youtube_videos_batch_size: 50,
    youtube_comments_top_n: 10,
    youtube_fallback_enabled: true, // search 桶耗尽时自动改用 videos.list mostPopular（合并桶计费）
    request_timeout_ms: 15000,
    max_retries: 2,
    retry_base_ms: 750,
  },
  keywords: { ai_keywords: ['ai'] },
});

let cachedV2Config = null;

/** 懒加载 news-config-v2.json；不可读时退回 DEFAULT_CONFIG。 */
function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  cachedV2Config = readJson(NEWS_FILES.configV2, null) || DEFAULT_CONFIG;
  return cachedV2Config;
}

/**
 * 以 v2 配置文件为基准，用调用方传入的 config 覆盖对应段。
 * 保证缺省字段（request_timeout_ms / max_retries 等）在调用方只传
 * 部分配置时也有兜底值（requestText 依赖这些字段）。
 */
function resolveConfig(config) {
  const base = loadV2Config();
  if (!config) return base;
  return {
    ...base,
    ...config,
    schedule: { ...(base.schedule || {}), ...(config.schedule || {}) },
    collection: { ...(base.collection || {}), ...(config.collection || {}) },
    keywords: { ...(base.keywords || {}), ...(config.keywords || {}) },
  };
}

/** 错误标签：防御 requestText 可能抛 undefined 的边界情况。 */
function errorLabel(error) {
  return (error && (error.code || error.message)) || 'api_error';
}

/**
 * 判断错误是否为「配额耗尽」（区别于普通限流）。
 * requestText 附了响应体 error.body（含 API 的 error.code），
 * 精确匹配 Google 配额耗尽类错误码（quotaExceeded / dailyLimitExceeded 等）。
 * @returns {boolean}
 */
function isQuotaExceeded(error) {
  if (!error) return false;
  const body = error.body;
  if (!body) return false;
  try {
    const code = JSON.parse(body).error?.code;
    return typeof code === 'string' && /quota.*exceed|dailylimit|rateLimitExceeded/i.test(code);
  } catch {
    return false;
  }
}

/**
 * 固定并发池：按 concurrency 并行执行 worker，保持输入顺序。
 * 与 content-classifier.js 的 runPool 同构（本地实现，避免跨模块耦合）。
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * YouTube Data API v3 采集入口。
 * 任何 API 失败不抛错，降级返回部分结果与 coverage 状态。
 *
 * @param {object} options
 * @param {object} [options.config] v2 配置（缺省自动加载 news-config-v2.json）
 * @param {string} [options.apiKey] YOUTUBE_API_KEY（缺省经 loadCollectorConfig 读取）
 * @param {string|Date} [options.now] 采集参考时间（测试注入，缺省当前时间）
 * @param {string} [options.fetchedAt] fetched_at（缺省 now ISO）
 * @param {function} [options.fetchImpl] fetch 实现（测试注入）
 * @returns {Promise<{items: object[], quota: object, coverage: object}>}
 */
async function collectYouTubeV2(options = {}) {
  const config = resolveConfig(options.config);
  const apiKey = youtubeApiKeyOf(options);
  const emptyQuota = { search_calls: 0, videos_calls: 0, comments_calls: 0, categories_calls: 0 };

  if (!apiKey) {
    return { items: [], quota: emptyQuota, coverage: { status: 'failed', reason: 'missing_api_key' } };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const fetchedAt = options.fetchedAt || now.toISOString();

  const collection = config.collection || {};
  const keywords = config.keywords?.ai_keywords || [];
  const windowDays = Math.max(1, config.schedule?.youtube_window_days ?? 3);
  const searchMax = collection.youtube_search_max_per_run ?? 100;
  const searchCost = collection.youtube_search_cost_units ?? 1;
  const dailyQuota = collection.youtube_daily_quota_units ?? 10000;
  const videosBatchSize = collection.youtube_videos_batch_size ?? 50;
  const commentsTopN = collection.youtube_comments_top_n ?? 10;

  const quota = { search_calls: 0, videos_calls: 0, comments_calls: 0, categories_calls: 0 };
  let usedQuota = 0;
  let searchCalls = 0;
  const failures = [];
  const canSpend = () => usedQuota < dailyQuota;

  /**
   * 执行一次计入配额的 API 调用；失败向上抛，由调用方记录并降级。
   * 保留 YouTube API 的错误码（error.code，如 quotaExceeded），供配额耗尽判定：
   * HTTP 429/403 时请求本身可能超限（限流或配额），解析响应体中的
   * error.code 优先于 HTTP 状态码，用于区分「限流（429）」与「配额耗尽（quotaExceeded）」。
   */
  const callApi = async (resource, params) => {
    const url = new URL(`${YOUTUBE_API}/${resource}`);
    url.searchParams.set('key', apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const text = await requestText(url, fetchImpl ? { fetchImpl } : {}, config);
    return JSON.parse(text);
  };

  // ── 1. search.list 关键词发现（独立桶，上限 searchMax 次） ──
  const discovered = new Map(); // videoId -> { id, publishedAt }
  const publishedAfter = new Date(now.getTime() - windowDays * 86400000).toISOString();
  const publishedBefore = now.toISOString();
  let searchQuotaExhausted = false; // search 独立桶耗尽标记（触发热门榜降级）

  for (const keyword of keywords) {
    if (searchCalls >= searchMax) { failures.push('search_max_per_run_reached'); break; }
    if (!canSpend()) { failures.push('daily_quota_reached'); break; }
    try {
      const data = await callApi('search', {
        part: 'snippet',
        type: 'video',
        q: keyword,
        publishedAfter,
        publishedBefore,
        maxResults: 50,
      });
      quota.search_calls += 1;
      usedQuota += searchCost;
      searchCalls += 1;
      for (const entry of data.items || []) {
        const videoId = entry.id?.videoId;
        if (videoId && !discovered.has(videoId)) {
          discovered.set(videoId, { id: videoId, publishedAt: entry.snippet?.publishedAt || null });
        }
      }
    } catch (error) {
      quota.search_calls += 1;
      usedQuota += searchCost;
      searchCalls += 1;
      failures.push(`search:${errorLabel(error)}`);
      // search 独立桶配额耗尽（Quota exceeded for 'Search Queries per day'）：
      // 停止继续 search（再试也 429），标记触发热门榜降级。
      if (isQuotaExceeded(error)) { searchQuotaExhausted = true; break; }
    }
  }

  // ── 1b. 降级：search 独立桶耗尽 → videos.list mostPopular（合并桶 1 单位/次） ──
  //      Google 2026-06 后 search 绑定独立桶（100 次/天），耗尽不会自动切合并桶；
  //      本降级用热门榜继续发现（合并桶计费），保证 search 桶用尽后 YouTube 仍能出数据。
  if (searchQuotaExhausted && collection.youtube_fallback_enabled !== false) {
    let popularSearch = 0;
    let popularPageToken = ''; // 热门榜翻页游标
    const popularLimit = Number(collection.youtube_fallback_popular_pages) || 2; // 2 页最多 ~100 条
    for (let page = 0; page < popularLimit; page++) {
      if (!canSpend()) { failures.push('daily_quota_reached'); break; }
      try {
        const data = await callApi('videos', {
          part: 'snippet',
          chart: 'mostPopular',
          maxResults: 50,
          pageToken: page > 0 ? popularPageToken : '',
        });
        quota.videos_calls += 1;
        usedQuota += 1;
        const pageToken = data.nextPageToken;
        popularPageToken = pageToken || '';
        for (const video of data.items || []) {
          if (video.id && !discovered.has(video.id)) {
            discovered.set(video.id, { id: video.id, publishedAt: video.snippet?.publishedAt || null });
          }
        }
        popularSearch += 1;
        if (!pageToken) break; // 没有下一页
      } catch (error) {
        quota.videos_calls += 1;
        usedQuota += 1;
        failures.push(`popular:${errorLabel(error)}`);
        break;
      }
    }
    if (popularSearch > 0) {
      // 降级成功：search 桶耗尽已被热门榜降级覆盖，不算真正失败。
      // 从 failures 中移除 search 的 quota 失败项，只保留降级标记（reason 优先显示它）。
      const kept = [];
      for (const f of failures) if (!f.startsWith('search:')) kept.push(f);
      failures.length = 0;
      for (const f of kept) failures.push(f);
      failures.push(`search_quota_exhausted_fallback_popular(${popularSearch}页)`);
    }
  }

  // ── 2. videos.list 补详情（≤50 ID/批，1 单位/批） ──
  const videoIds = [...discovered.keys()];
  const detailsById = new Map();
  for (let index = 0; index < videoIds.length; index += videosBatchSize) {
    if (!canSpend()) { failures.push('daily_quota_reached'); break; }
    const group = videoIds.slice(index, index + videosBatchSize);
    try {
      const data = await callApi('videos', {
        part: 'snippet,statistics,contentDetails',
        id: group.join(','),
      });
      quota.videos_calls += 1;
      usedQuota += 1;
      for (const video of data.items || []) detailsById.set(video.id, video);
    } catch (error) {
      quota.videos_calls += 1;
      usedQuota += 1;
      failures.push(`videos:${errorLabel(error)}`);
    }
  }

  // ── 3. videoCategories.list 分类名映射（1 次） ──
  const categoryMap = {};
  if (canSpend()) {
    try {
      const data = await callApi('videoCategories', { part: 'snippet', regionCode: 'US' });
      quota.categories_calls += 1;
      usedQuota += 1;
      for (const category of data.items || []) categoryMap[category.id] = category.snippet?.title || category.id;
    } catch (error) {
      quota.categories_calls += 1;
      usedQuota += 1;
      failures.push(`categories:${errorLabel(error)}`);
    }
  } else {
    failures.push('daily_quota_reached');
  }

  // ── 4. commentThreads.list 取评论（每条视频 1 次，top N；并发池限流） ──
  // 每个视频一次请求，几百个候选串行会占采集大头；按 config.collection.concurrency
  // 并发抓取显著提速。注意：comments 计数在 runPool 内并发更新，回调为同步短路，无竞态。
  const commentsByVideo = new Map();
  const commentConcurrency = Math.max(1, Number(collection.concurrency) || 5);
  const commentVideoIds = [...detailsById.keys()];
  await runPool(commentVideoIds, commentConcurrency, async videoId => {
    if (!canSpend()) { failures.push('daily_quota_reached'); return; }
    try {
      const data = await callApi('commentThreads', {
        part: 'snippet',
        videoId,
        order: 'relevance',
        maxResults: commentsTopN,
      });
      quota.comments_calls += 1;
      usedQuota += 1;
      commentsByVideo.set(
        videoId,
        (data.items || []).map(thread => {
          const comment = thread.snippet?.topLevelComment?.snippet || {};
          return { text: comment.textDisplay || '', likeCount: numberOrNull(comment.likeCount) };
        })
      );
    } catch (error) {
      quota.comments_calls += 1;
      usedQuota += 1;
      failures.push(`comments:${errorLabel(error)}`);
    }
  });

  // ── 5. 组装统一内容模型 ──
  const items = [...detailsById.values()].map(detail =>
    buildItem(detail, commentsByVideo.get(detail.id), categoryMap, fetchedAt)
  );

  // ── 6. coverage 状态 ──
  let status = 'success';
  if (items.length === 0 && failures.length > 0) status = 'failed';
  else if (failures.length > 0) status = 'partial';
  const coverage = { status, reason: failures.length ? failures[0] : null };

  return { items, quota, coverage };
}

module.exports = {
  collectYouTubeV2,
  buildItem,
  parseDuration,
  loadV2Config,
};
