'use strict';

const { withQuota } = require('./news-quota');
const { bulkDiscover } = require('./news-registry');
const { classifyTimeLayer } = require('./news-scheduler');

function classifyVisibleEntries(entries, source, contentType, layers, nowUtcMs, layerId) {
  return entries.map(entry => ({
    platform: 'bilibili',
    native_id: entry.native_id || entry.id || null,
    source_id: source.id,
    canonical_url: entry.url || entry.link || '',
    title: entry.title || '',
    description: entry.description || '',
    published_at: entry.published_at || entry.published || null,
    layer_id: classifyTimeLayer(entry.published_at || entry.published, layers, nowUtcMs),
    content_type: contentType,
    discovery_status: layers.find(layer => layer.id === layerId)?.min_age_days >= 30 ? 'backfill_candidate' : 'discovered',
  })).filter(candidate => candidate.native_id || candidate.canonical_url);
}

async function requestRssHubRoute(options, route) {
  const result = await withQuota(options.quota, 'bilibili', {
    source_id: options.source.id,
    layer_id: options.layer.id,
    operation: `rsshub:${route.type}`,
    cost: 1,
  }, async () => {
    const response = await (options.fetch || globalThis.fetch)(route.url);
    if (!response.ok) throw new Error(`RSSHub ${route.type} HTTP ${response.status}`);
    return (options.parseFeed)(await response.text());
  });
  return result.sent ? { status: 'success', entries: result.value } : { status: 'quota_paused', entries: [] };
}

async function collectBilibiliLayerStep(options) {
  const routeResults = [];
  for (const route of options.routes) {
    try {
      routeResults.push({ route, ...(await requestRssHubRoute(options, route)) });
    } catch (error) {
      routeResults.push({ route, status: 'failed', entries: [], error: error.message });
    }
  }

  const visible = routeResults.flatMap(result => classifyVisibleEntries(
    result.entries, options.source, result.route.type, options.timeLayers,
    options.nowUtcMs, options.layer.id,
  ));
  const inLayer = visible.filter(item => item.layer_id === options.layer.id);
  const discoveries = bulkDiscover(options.registry, visible, { now: options.nowIso });
  const quotaPaused = routeResults.some(result => result.status === 'quota_paused');
  const failed = routeResults.some(result => result.status === 'failed');
  const historical = options.layer.min_age_days >= 30;
  let status;
  let stopReason;
  if (quotaPaused) {
    status = 'quota_paused';
    stopReason = 'rsshub_quota_exhausted';
  } else if (failed) {
    status = inLayer.length ? 'partial' : 'temporarily_failed';
    stopReason = 'one_or_more_routes_failed';
  } else if (historical && inLayer.length === 0) {
    status = 'history_unsupported';
    stopReason = 'rsshub_feed_has_no_historical_pagination';
  } else {
    status = inLayer.length ? 'complete' : 'observed_empty';
    stopReason = inLayer.length ? 'visible_feed_processed' : 'visible_feed_empty_for_layer';
  }

  return {
    status,
    page_token: null,
    pages_fetched: routeResults.filter(result => result.status !== 'quota_paused').length,
    items_observed: visible.length,
    oldest_observed_at: visible.length
      ? visible.map(item => item.published_at).filter(Boolean).sort()[0] || null
      : null,
    new_video_count: discoveries.filter(result => result.isNew && inLayer.some(item => `${item.platform}:${item.native_id}` === result.key)).length,
    duplicate_count: discoveries.filter(result => !result.isNew).length,
    stop_reason: stopReason,
    coverage_limitation: historical ? 'rsshub_visible_feed_only_no_date_pagination' : null,
    routes: routeResults.map(result => ({ type: result.route.type, status: result.status, error: result.error || null })),
    items: inLayer,
  };
}

module.exports = { classifyVisibleEntries, requestRssHubRoute, collectBilibiliLayerStep };
