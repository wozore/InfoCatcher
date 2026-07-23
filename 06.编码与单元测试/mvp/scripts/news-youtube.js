'use strict';

const { withQuota } = require('./news-quota');
const { bulkDiscover, needsExpensiveProcessing, updateLifecycle } = require('./news-registry');
const { classifyTimeLayer } = require('./news-scheduler');

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

function apiUrl(resource, params, apiKey) {
  const url = new URL(`${YOUTUBE_API}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

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

function batch(values, size = 50) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

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

async function collectYouTubeLayerStep(options) {
  const context = {
    ...options,
    fetch: options.fetch || globalThis.fetch,
    videoBatchSize: options.videoBatchSize || 50,
  };
  if (!context.apiKey) throw new Error('缺少 YOUTUBE_API_KEY');
  const uploadsPlaylistId = await resolveUploadsPlaylist(context, options.uploadsPlaylistId);
  if (!uploadsPlaylistId) return { status: 'quota_paused', page_token: options.pageToken || null };

  const page = await quotaFetchJson(context, 'playlistItems.list', 'playlistItems', {
    part: 'snippet,contentDetails', playlistId: uploadsPlaylistId,
    maxResults: options.pageSize || 50, pageToken: options.pageToken,
  });
  if (!page) return { status: 'quota_paused', uploads_playlist_id: uploadsPlaylistId, page_token: options.pageToken || null };

  const observed = playlistCandidates(page.items, context.source, context.layer, context.timeLayers, context.nowUtcMs);
  const inLayer = observed.filter(candidate => candidate.layer_id === context.layer.id);
  const discoveries = bulkDiscover(context.registry, observed, { now: context.nowIso });
  const newInLayerKeys = new Set(inLayer.map(candidate => `${candidate.platform}:${candidate.native_id}`));
  const processable = discoveries
    .filter(result => newInLayerKeys.has(result.key) && (result.isNew || needsExpensiveProcessing(result.record, context.analysisVersion)))
    .map(result => result.record);
  const detailResult = await fetchVideoDetails(context, processable);
  const detailIds = new Set(detailResult.details.map(detail => detail.id));
  for (const record of processable) {
    if (detailIds.has(record.native_id)) updateLifecycle(record, { processing_status: 'details_fetched', details_fetched: true }, context.nowIso);
  }

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
