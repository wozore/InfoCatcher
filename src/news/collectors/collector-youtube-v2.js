/**
 * collector-youtube-v2.js — 热点管线 v2 的 YouTube 采集器（关键词发现）
 *
 * 在热点管线 v2 中的位置：v2 管线（热点发现层）的 YouTube 采集入口，
 * 通过 YouTube Data API v3 search.list 按关键词发现近 N 日内容，
 * 再用 videos.list / videoCategories.list / commentThreads.list 补详情、
 * 分类名与评论，统一输出为 v1 管线相同的内容模型。
 *
 * 与旧采集器 news-youtube.js 的区别：
 *   - 旧版：按来源名单（registry）分频道 RSS/playlist 回溯，依赖
 *     quota ledger / registry / scheduler 模块；
 *   - v2：按 config.keywords.ai_keywords 关键词搜索，不依赖旧架构的
 *     quota / registry / scheduler，使用独立配额计数，全程无来源名单。
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
 *     apiKey: process.env.YOUTUBE_API_KEY,
 *     now: '2026-08-07T00:00:00Z',  // 可选，测试注入
 *     fetchImpl: customFetch,       // 可选，测试注入
 *   });
 *   // => { items, quota, coverage }
 */

'use strict';

const { requestText, numberOrNull, normalizeUrl, hash } = require('../pipeline/feed-parser');

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
  try {
    cachedV2Config = require('../../../data/news/config/news-config-v2.json');
  } catch {
    cachedV2Config = DEFAULT_CONFIG;
  }
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

/**
 * 解析 ISO 8601 时长（PT#H#M#S / P#D 等）为秒数；不可解析返回 null。
 * contentDetails.duration 形如 'PT1H2M3S'。
 */
function parseDuration(iso) {
  if (!iso) return null;
  const match = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const [, days, hours, mins, secs] = match;
  const total =
    (numberOrNull(days) || 0) * 86400 +
    (numberOrNull(hours) || 0) * 3600 +
    (numberOrNull(mins) || 0) * 60 +
    (numberOrNull(secs) || 0);
  return total > 0 ? total : null;
}

/** 错误标签：防御 requestText 可能抛 undefined 的边界情况。 */
function errorLabel(error) {
  return (error && (error.code || error.message)) || 'api_error';
}

/**
 * 将一条 videos.list 详情标准化为统一内容模型。
 * author_id/source_id 沿用 v1 的频道 id 约定（`youtube-${hash(channelId)}`），
 * 关键词发现没有来源名单，频道即来源。
 */
function buildItem(detail, comments, categoryMap, fetchedAt) {
  const snippet = detail.snippet || {};
  const statistics = detail.statistics || {};
  const contentDetails = detail.contentDetails || {};
  const categoryId = snippet.categoryId || null;
  const channelId = snippet.channelId || null;
  const authorId = `youtube-${hash(channelId || detail.id)}`;
  const linkText = `${snippet.title || ''} ${snippet.description || ''}`;
  return {
    id: `youtube-${hash(detail.id)}`,
    platform: 'youtube',
    native_id: detail.id,
    source_type: 'youtube_video',
    url: `https://www.youtube.com/watch?v=${detail.id}`,
    title: snippet.title || '',
    description: (snippet.description || '').slice(0, 600),
    published_at: snippet.publishedAt ? new Date(snippet.publishedAt).toISOString() : null,
    fetched_at: fetchedAt,
    author_id: authorId,
    author_name: snippet.channelTitle || '',
    source_id: authorId,
    language: 'en',
    source_tags: [],
    thumbnail:
      snippet.thumbnails?.maxres?.url ||
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.default?.url ||
      null,
    metrics: {
      views: numberOrNull(statistics.viewCount),
      likes: numberOrNull(statistics.likeCount),
      comments: numberOrNull(statistics.commentCount),
      reposts: null,
      replies: null,
    },
    explicit_links: [
      ...new Set((linkText.match(/https?:\/\/[^\s"'<>]+/g) || []).map(normalizeUrl).filter(Boolean)),
    ].slice(0, 10),
    content_type: null, // 评分/分类阶段再填
    category: (categoryId && categoryMap && categoryMap[categoryId]) || null,
    comments: comments || [],
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    duration_seconds: parseDuration(contentDetails.duration),
  };
}

/**
 * YouTube Data API v3 采集入口。
 * 任何 API 失败不抛错，降级返回部分结果与 coverage 状态。
 *
 * @param {object} options
 * @param {object} [options.config] v2 配置（缺省自动加载 news-config-v2.json）
 * @param {string} [options.apiKey] YOUTUBE_API_KEY（缺省读 process.env）
 * @param {string|Date} [options.now] 采集参考时间（测试注入，缺省当前时间）
 * @param {string} [options.fetchedAt] fetched_at（缺省 now ISO）
 * @param {function} [options.fetchImpl] fetch 实现（测试注入）
 * @returns {Promise<{items: object[], quota: object, coverage: object}>}
 */
async function collectYouTubeV2(options = {}) {
  const config = resolveConfig(options.config);
  const apiKey = options.apiKey || process.env.YOUTUBE_API_KEY;
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

  /** 执行一次计入配额的 API 调用；失败向上抛，由调用方记录并降级。 */
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

  // ── 4. commentThreads.list 取评论（每条视频 1 次，top N） ──
  const commentsByVideo = new Map();
  for (const videoId of detailsById.keys()) {
    if (!canSpend()) { failures.push('daily_quota_reached'); break; }
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
  }

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
