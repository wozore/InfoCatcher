/**
 * news-bilibili.js — Bilibili RSSHub 可见内容采集与能力边界标记
 *
 * 在热点管线中的位置：被 build-news.js 的 runHistoricalLayerPass() 调用，
 * 负责 B站视频、动态和专栏的历史可见内容归层。
 *
 * 能力边界（重要）：
 *   - 只使用 RSSHub 公开路由，不调用 B站内部 API、不逆向 SDK、不绕过风控。
 *   - RSSHub 返回的是每个路由的最新可见内容，没有按日期的分页参数，
 *     因此无法像 YouTube 一样按 publishedAfter/publishedBefore 精确回溯。
 *   - 第 3/4 时间层（30-270天）内容只能依赖 RSSHub 自然覆盖的可见条目。
 *   - 当 RSSHub 路由成功返回但其中没有第 3/4 层内容时，状态为 history_unsupported，
 *     原因 rsshub_feed_has_no_historical_pagination——"接口能力不足"，
 *     而不是 observed_empty="这段时间内容为空"。
 *   - 多路由结果按最差状态汇总，防止后续成功掩盖之前失败。
 *
 * B站动态的特殊地位（产品约束）：
 *   - 动态（文字观点、转发评论、视频投稿）是独立的一等内容来源。
 *   - 可进入热点 Feed、可形成主题事件、可作为独立观点、可参与内容评分。
 *   - 动态同时辅助反映近期活跃度，但不能反过来因为动态路由故障推断"博主不活跃"。
 *   - 纯转发（无附加有价值评论）的内容贡献较低，但仍作为传播信号保留。
 *
 * 扩展点：
 *   - 新增 RSSHub 实例或镜像时，修改 routes 数组中的 URL 前缀即可。
 *   - 新增内容类型时，在 routes 中增加对应条目，并在 parseFeed 支持该类型。
 */

'use strict';

const { withQuota } = require('./news-quota');
const { bulkDiscover } = require('./news-registry');
const { classifyTimeLayer } = require('./news-scheduler');

/**
 * 将 RSSHub 返回的条目标准化为 candidate 列表。
 * 每条 candidate 携带 layer_id（时间层归属）、content_type 和 discovery_status。
 */
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

/**
 * 请求单个 RSSHub 路由，计入 B站额度（HTTP attempt）。
 * 成功返回 { status: 'success', entries }，
 * 额度不足返回 { status: 'quota_paused', entries: [] }。
 */
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

/**
 * 执行单次 B站历史层采集步骤。
 *
 * 流程：
 *   1. 依次请求三个 RSSHub 路由（video、dynamic、article）
 *   2. 将所有条目标准化并归入五层时间窗口
 *   3. 通过 Registry 批量防重
 *   4. 判断状态：
 *      - 额度不足 → quota_paused
 *      - 路由失败 → partial（有内容）或 temporarily_failed（无内容）
 *      - 历史层（>=30天）且无内容 → history_unsupported
 *      - 有内容 → complete 或 observed_empty
 *
 * @returns {object} 包含 status、stop_reason、coverage_limitation 和各路由状态
 */
async function collectBilibiliLayerStep(options) {
  // 1. 请求所有路由
  const routeResults = [];
  for (const route of options.routes) {
    try {
      routeResults.push({ route, ...(await requestRssHubRoute(options, route)) });
    } catch (error) {
      routeResults.push({ route, status: 'failed', entries: [], error: error.message });
    }
  }

  // 2. 标准化所有可见条目
  const visible = routeResults.flatMap(result => classifyVisibleEntries(
    result.entries, options.source, result.route.type, options.timeLayers,
    options.nowUtcMs, options.layer.id,
  ));
  const inLayer = visible.filter(item => item.layer_id === options.layer.id);

  // 3. Registry 防重
  const discoveries = bulkDiscover(options.registry, visible, { now: options.nowIso });

  // 4. 状态判定
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
    // 关键：历史层无内容时标记为接口能力不足，而非"历史内容为空"
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
