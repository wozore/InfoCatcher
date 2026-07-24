/**
 * news-youtube.js — YouTube Data API v3 历史采集适配器
 *
 * 在热点管线中的位置：被 build-news.js 的 runHistoricalLayerPass() 调用，
 * 负责 YouTube 频道的分页历史回溯和批量详情补充。
 *
 * 与最新 Feed 的分工：
 *   - 最新 Feed：build-news.js 的 collectYouTube() 使用 RSS feed
 *     （免费、无配额限制）获取最近内容；
 *   - 历史回溯：本模块使用 Data API v3 的 playlistItems.list +
 *     videos.list 进行历史分页和详情补充。
 *
 * 设计决策：
 *   1. 先获取 uploads playlist ID（channels.list，1 unit），
 *      一次获取后可跨批次复用。
 *   2. 使用 playlistItems.list（1 unit/页）而非 search.list（100 units/页）
 *      作为默认历史路径——前者的成本低两个数量级。
 *   3. 先批量检查 Registry 防重，只对需要处理的视频调用 videos.list
 *      （1 unit/批，最多 50 个 ID）。
 *   4. 详情获取后立即更新 processing_status 为 details_fetched，
 *      下次构建或分析升级前不会重复请求。
 *   5. 额度不足时保存 pageToken → resume_page_token，
 *      下一批构建通过 historicalPageToken() 优先恢复。
 *
 * 扩展点：
 *   - 新增平台时参照本模块的"列表 → Registry 防重 → 批量详情"模式。
 *   - 需要评论/字幕等额外数据时，可新增独立的 fetch 函数并在
 *     collectYouTubeLayerStep 返回的 details 后追加处理。
 *
 * 使用示例：
 *   const result = await collectYouTubeLayerStep({
 *     source, layer, timeLayers, nowUtcMs, nowIso,
 *     registry: index, quota: ledger, apiKey: process.env.YOUTUBE_API_KEY,
 *     uploadsPlaylistId: savedPlaylistId,
 *     pageToken: savedPageToken,
 *     analysisVersion: config.collection.analysis_version,
 *   });
 */

'use strict';

const { withQuota } = require('./news-quota');
const { bulkDiscover, needsExpensiveProcessing, updateLifecycle } = require('./news-registry');
const { classifyTimeLayer } = require('./news-scheduler');

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

/** 构造带 API Key 的 YouTube Data API URL */
function apiUrl(resource, params, apiKey) {
  const url = new URL(`${YOUTUBE_API}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * 对 YouTube API 发起一次计入额度的请求。
 * 通过 withQuota 确保每次 API 调用都经过 quota ledger。
 * 返回 parsed JSON，额度不足时返回 null。
 */
async function quotaFetchJson(context, operation, resource, params) {
  const result = await withQuota(context.quota, 'youtube', {
    source_id: context.source.id,
    layer_id: context.layer.id,
    operation,
    cost: 1,
  }, async () => {
    const response = await context.fetch(apiUrl(resource, params, context.apiKey));
    if (!response.ok) throw new Error(`YouTube ${operation} HTTP ${response.status}`);
    return response.json();
  });
  return result.sent ? result.value : null;
}

/**
 * 解析频道 uploads playlist ID。
 * 如果已缓存（从 state 恢复），直接复用，省去一次 channels.list 调用。
 */
async function resolveUploadsPlaylist(context, cachedPlaylistId = null) {
  if (cachedPlaylistId) return cachedPlaylistId;
  const data = await quotaFetchJson(context, 'channels.list', 'channels', {
    part: 'contentDetails', id: context.source.external_id,
  });
  if (!data) return null;
  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error(`YouTube 频道缺少 uploads playlist: ${context.source.id}`);
  return playlistId;
}

/**
 * 将 playlistItems.list 响应转换为 candidate 列表。
 * 每条 candidate 携带 layer_id（属于哪个时间层）和 discovery_status。
 * 历史层（>=30天）标记为 backfill_candidate，与最新发现区分。
 */
function playlistCandidates(items, source, layer, timeLayers, nowUtcMs) {
  return (items || []).map(item => {
    const nativeId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
    return {
      platform: 'youtube', native_id: nativeId, source_id: source.id,
      canonical_url: nativeId ? `https://www.youtube.com/watch?v=${nativeId}` : '',
      title: item.snippet?.title || '', published_at: publishedAt || null,
      layer_id: classifyTimeLayer(publishedAt, timeLayers, nowUtcMs),
      discovery_status: layer.min_age_days >= 30 ? 'backfill_candidate' : 'discovered',
    };
  }).filter(candidate => candidate.native_id);
}

/** 将数组按 size 分批，用于 videos.list 的批量查询（每次最多 50 个 ID） */
function batch(values, size = 50) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

/**
 * 批量获取视频详情（snippet + statistics + contentDetails）。
 * 每批最多 50 个 video ID，每批消耗 1 quota unit。
 * 额度不足时提前返回已获取的详情和 quotaPaused=true。
 */
async function fetchVideoDetails(context, records) {
  const details = [];
  for (const group of batch(records, context.videoBatchSize || 50)) {
    const data = await quotaFetchJson(context, 'videos.list', 'videos', {
      part: 'snippet,statistics,contentDetails', id: group.map(record => record.native_id).join(','),
    });
    if (!data) return { details, quotaPaused: true };
    details.push(...(data.items || []));
  }
  return { details, quotaPaused: false };
}

/**
 * 执行单次 YouTube 历史层采集步骤。
 *
 * 流程：
 *   1. 解析/复用 uploads playlist ID
 *   2. 获取一页 playlistItems（最多 pageSize 条）
 *   3. 将条目归入时间层，筛选当前层内容
 *   4. 通过 Registry 批量防重
 *   5. 只对需要处理的新记录批量获取详情
 *   6. 更新详情获取状态
 *   7. 判断停止原因并返回进度
 *
 * @returns {object} 包含 status、page_token、详情数组、计数和停止原因
 */
async function collectYouTubeLayerStep(options) {
  const context = {
    ...options,
    fetch: options.fetch || globalThis.fetch,
    videoBatchSize: options.videoBatchSize || 50,
  };
  if (!context.apiKey) throw new Error('缺少 YOUTUBE_API_KEY');

  // 1. 获取 uploads playlist ID
  const uploadsPlaylistId = await resolveUploadsPlaylist(context, options.uploadsPlaylistId);
  if (!uploadsPlaylistId) return { status: 'quota_paused', page_token: options.pageToken || null };

  // 2. 分页获取 playlist 条目
  const page = await quotaFetchJson(context, 'playlistItems.list', 'playlistItems', {
    part: 'snippet,contentDetails', playlistId: uploadsPlaylistId,
    maxResults: options.pageSize || 50, pageToken: options.pageToken,
  });
  if (!page) return { status: 'quota_paused', uploads_playlist_id: uploadsPlaylistId, page_token: options.pageToken || null };

  // 3. 标准化为 candidate 并按当前层筛选
  const observed = playlistCandidates(page.items, context.source, context.layer, context.timeLayers, context.nowUtcMs);
  const inLayer = observed.filter(candidate => candidate.layer_id === context.layer.id);

  // 4. Registry 批量防重
  const discoveries = bulkDiscover(context.registry, observed, { now: context.nowIso });
  const newInLayerKeys = new Set(inLayer.map(candidate => `${candidate.platform}:${candidate.native_id}`));
  const processable = discoveries
    .filter(result => newInLayerKeys.has(result.key) && (result.isNew || needsExpensiveProcessing(result.record, context.analysisVersion)))
    .map(result => result.record);

  // 5. 批量获取详情（只对需要处理的新记录）
  const detailResult = await fetchVideoDetails(context, processable);

  // 6. 更新已获取详情的记录状态
  const detailIds = new Set(detailResult.details.map(detail => detail.id));
  for (const record of processable) {
    if (detailIds.has(record.native_id)) updateLifecycle(record, { processing_status: 'details_fetched', details_fetched: true }, context.nowIso);
  }

  // 7. 判断停止条件
  const ages = observed.map(item => new Date(item.published_at).getTime()).filter(Number.isFinite);
  const oldestObservedAt = ages.length ? new Date(Math.min(...ages)).toISOString() : null;
  const crossedLayer = observed.some(candidate => {
    const ageDays = (context.nowUtcMs - new Date(candidate.published_at).getTime()) / 86400000;
    return ageDays >= context.layer.max_age_days;
  });
  const nextToken = page.nextPageToken || null;
  let status = 'running';
  let stopReason = null;
  if (detailResult.quotaPaused) { status = 'quota_paused'; stopReason = 'quota_before_details'; }
  else if (processable.length >= (options.stopAfterNew || 1)) { status = 'partial'; stopReason = 'new_video_target_reached'; }
  else if (!nextToken || crossedLayer) { status = inLayer.length ? 'complete' : 'observed_empty'; stopReason = crossedLayer ? 'layer_boundary_crossed' : 'playlist_ended'; }

  return {
    status,
    uploads_playlist_id: uploadsPlaylistId,
    page_token: status === 'running' ? nextToken : null,
    resume_page_token: status === 'quota_paused' ? (options.pageToken || null) : null,
    pages_fetched: 1,
    items_observed: observed.length,
    oldest_observed_at: oldestObservedAt,
    new_video_count: processable.length,
    duplicate_count: discoveries.filter(result => !result.isNew).length,
    stop_reason: stopReason,
    details: detailResult.details,
  };
}

module.exports = {
  apiUrl, resolveUploadsPlaylist, playlistCandidates, batch, fetchVideoDetails,
  collectYouTubeLayerStep,
};
