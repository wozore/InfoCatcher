/**
 * build-news.js —— AI 热点构建总编排入口
 *
 * 在热点管线中的位置：GitHub Actions（collect-news.yml）调用此脚本，
 * 它是整个热点系统的唯一入口，负责编排所有模块完成一次完整的构建运行。
 *
 * ═══════════════════════════════════════════════════════════════
 * 模块依赖关系（数据流向）：
 * ═══════════════════════════════════════════════════════════════
 *
 *   外部平台 API ──┐
 *   news-sources   ├──→ 采集层（collectYouTube / collectX / collectBilibili）
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
 *   - 新增采集平台：实现 collectXxx() 函数，在 collectSource() 增加分支，
 *     在 runHistoricalLayerPass() 增加对应适配器调用。
 *   - 新增评分维度：在 assessItem() 增加新函数，修改 scoring.weights 配置。
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

// ═══════════════════════════════════════════════════════════════
// 第 1 部分：XML/RSS 解析与内容标准化
// 将三个平台的原始格式转换为统一的内容模型
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  readJson, writeJsonAtomic, acquireLock, releaseLock,
} = require('../core/news-storage');
const { createRegistry, bulkDiscover, updateLifecycle, finalizeRegistry } = require('../core/news-registry');
const {
  createQuotaLedger, reserveQuota, consumeQuota, finishQuotaLedger,
} = require('../core/news-quota');
const {
  createSchedulerState, initializeLayer, updateSourceProgress, advanceLayer,
} = require('../core/news-scheduler');
const { collectYouTubeLayerStep } = require('../collectors/news-youtube');
const { collectBilibiliLayerStep } = require('../collectors/news-bilibili');
const { enrichYouTubeTranscripts } = require('../collectors/news-transcripts');
const { normalizeManualItem } = require('../../content/news-manual');
const { createAuthorizationStore, createAuthorizationTask } = require('../core/news-authorization');
const {
  readCandidateStore, writeCandidateStore, mergeCandidates, stampCandidateStatuses, buildPublicProjection,
  attachProjectionSnapshot, DEFAULT_REVIEW_STATUS,
} = require('../core/news-candidates');
const { isWithinPublicWindow, markAnomalousTimeCandidates, filterProjectionByWindow } = require('../core/news-public-gate');
const { recordReviewTransition } = require('../core/news-review-events');
const { NEWS_FILES, CATALOG_FILES, DIRS } = require('../../shared/paths');
const { generateRss } = require('../../content/generate-rss');

// ── 数据文件路径（按读写频率排列） ──────────────────────────
// 前两个是每次构建的配置输入，后六个是构建状态/输出
const SOURCES_PATH = NEWS_FILES.sources;                            // 96 个来源（人工维护 + CLI）
const CONFIG_PATH = NEWS_FILES.config;                              // 评分/时间层/额度配置
const OUTPUT_PATH = NEWS_FILES.hotspots;                            // 前端热点投影（最后写入！）
const STATE_PATH = NEWS_FILES.state;                                // 构建批次和来源游标
const REGISTRY_PATH = NEWS_FILES.registry;                          // 持久视频记录
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

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchTag(xml, tag) {
  const escaped = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function parseFeed(xml) {
  const atomEntries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const rssItems = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return [...atomEntries, ...rssItems].map(block => {
    const linkAttr = block.match(/<link[^>]+href=["']([^"']+)["']/i);
    const guid = matchTag(block, 'guid') || matchTag(block, 'yt:videoId') || matchTag(block, 'id');
    const url = linkAttr?.[1] || matchTag(block, 'link');
    const media = block.match(/<(?:media:thumbnail|media:content)[^>]+url=["']([^"']+)["']/i);
    return {
      native_id: matchTag(block, 'yt:videoId') || guid || url,
      title: matchTag(block, 'title'),
      description: matchTag(block, 'description') || matchTag(block, 'media:description') || matchTag(block, 'summary') || matchTag(block, 'content'),
      url,
      published_at: matchTag(block, 'published') || matchTag(block, 'pubDate') || matchTag(block, 'updated'),
      author_name: matchTag(block, 'name') || matchTag(block, 'author') || matchTag(block, 'dc:creator'),
      thumbnail: media?.[1] || null,
      raw_block: block,
    };
  }).filter(item => item.title && item.url && item.published_at);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizeUrl(value = '') {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['feature', 'si', 'spm_id_from'].includes(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return ''; }
}

function inferBilibiliType(item) {
  const text = `${item.title} ${item.description}`;
  if (/专栏|article|read\/cv/i.test(item.url)) return 'bilibili_article';
  if (/转发|转自|repost/i.test(text)) return 'bilibili_dynamic_repost';
  if (/video\/BV|视频|投稿/i.test(item.url + text)) return 'bilibili_dynamic_video';
  return 'bilibili_dynamic_text';
}

function normalizeRssItem(item, source, contentType, fetchedAt) {
  const nativeId = String(item.native_id || hash(item.url));
  return {
    id: `${source.platform}-${hash(nativeId)}`,
    platform: source.platform,
    native_id: nativeId,
    source_type: contentType === 'bilibili_dynamic' ? inferBilibiliType(item) : contentType,
    url: normalizeUrl(item.url),
    title: item.title,
    description: item.description?.slice(0, 600) || '',
    published_at: new Date(item.published_at).toISOString(),
    fetched_at: fetchedAt,
    author_id: source.id,
    author_name: item.author_name || source.name,
    source_id: source.id,
    language: source.language,
    source_tags: source.content_tags,
    thumbnail: item.thumbnail,
    metrics: { views: null, likes: null, comments: null, reposts: null, replies: null },
    explicit_links: [...new Set((item.raw_block.match(/https?:\/\/[^\s"'<>]+/g) || []).map(normalizeUrl))].slice(0, 10),
  };
}

function extractTweetArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.tweets)) return payload.tweets;
  if (Array.isArray(payload.data?.tweets)) return payload.data.tweets;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function normalizeTweet(tweet, source, fetchedAt) {
  const nativeId = String(tweet.id || tweet.id_str || tweet.tweetId || tweet.rest_id || hash(JSON.stringify(tweet)));
  const text = tweet.text || tweet.full_text || tweet.fullText || tweet.content || '';
  const created = tweet.createdAt || tweet.created_at || tweet.created || tweet.timestamp;
  if (!text || !created) return null;
  return {
    id: `x-${hash(nativeId)}`,
    platform: 'x',
    native_id: nativeId,
    source_type: 'x_post',
    url: normalizeUrl(tweet.url || `https://x.com/${source.handle}/status/${nativeId}`),
    title: text.slice(0, 180),
    description: text.slice(0, 600),
    published_at: new Date(created).toISOString(),
    fetched_at: fetchedAt,
    author_id: source.id,
    author_name: tweet.author?.name || tweet.authorName || source.name,
    source_id: source.id,
    language: source.language,
    source_tags: source.content_tags,
    thumbnail: tweet.media?.[0]?.url || tweet.extendedEntities?.media?.[0]?.media_url_https || null,
    metrics: {
      views: numberOrNull(tweet.viewCount ?? tweet.views),
      likes: numberOrNull(tweet.likeCount ?? tweet.favorite_count ?? tweet.likes),
      comments: null,
      reposts: numberOrNull(tweet.retweetCount ?? tweet.retweet_count ?? tweet.reposts),
      replies: numberOrNull(tweet.replyCount ?? tweet.reply_count ?? tweet.replies),
    },
    explicit_links: [...new Set([...(text.match(/https?:\/\/\S+/g) || []), ...(tweet.urls || []).map(v => v.expanded_url || v.url).filter(Boolean)].map(normalizeUrl))],
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ═══════════════════════════════════════════════════════════════
// 第 2 部分：平台采集器
// 每个平台一个采集函数，负责网络请求、原始数据解析和 AI 关键词初筛
// X 采用来源轮转（每次只采集部分来源以控制日调用量）
// Bilibili 发送三条 RSSHub 路由（视频/动态/专栏），取最差状态
// ═══════════════════════════════════════════════════════════════

  // beforeAttempt 回调用于在每次重试前检查额度。
  // 如果额度不足（返回 false），立即抛出 quota_paused 并跳过后续重试——
  // 额度不足不是网络问题，重试不会让额度恢复。
async function requestText(url, options, config, beforeAttempt = null) {
  const timeout = config.collection.request_timeout_ms;
  const fetchImpl = options.fetchImpl || fetch;
  const requestOptions = { ...options };
  delete requestOptions.fetchImpl;
  let lastError;
  for (let attempt = 0; attempt <= config.collection.max_retries; attempt++) {
    try {
      if (beforeAttempt && beforeAttempt(attempt) === false) throw Object.assign(new Error('请求额度不足'), { code: 'quota_paused' });
      const response = await fetchImpl(url, { ...requestOptions, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) {
        const body = await response.text();
        const cloudflare = response.status === 403 && (/cloudflare/i.test(response.headers?.get?.('server') || '') || /just a moment/i.test(body));
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: cloudflare ? 'cloudflare_challenge' : `http_${response.status}` });
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      // 额度不足不是网络问题，立即终止重试并向上传递 quota_paused
      if (error.code === 'quota_paused' || error.code === 'cloudflare_challenge') throw error;
      if (attempt < config.collection.max_retries) {
        await new Promise(resolve => setTimeout(resolve, config.collection.retry_base_ms * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * 通过 Data API 补充 YouTube RSS 缺少的互动数据（浏览量/点赞/评论）。
 * 需要 YOUTUBE_API_KEY，每次调用消耗 1 quota unit（含重试）。
 * 无 API Key 时降级为 rss_only，不影响 RSS 内容的采集。
 */
async function enrichYouTubeStatistics(items, context, sourceId) {
  if (!context.youtubeApiKey || !items.length) return { items, status: 'rss_only' };
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'statistics');
    url.searchParams.set('id', items.map(item => item.native_id).slice(0, 50).join(','));
    url.searchParams.set('key', context.youtubeApiKey);
    const text = await requestText(url, {}, context.config, attempt => {
      const reservation = reserveQuota(context.quota, 'youtube', {
        source_id: sourceId,
        layer_id: 'recent-feed',
        operation: 'videos.list:latest-feed',
        cost: 1,
        attempt: attempt + 1,
      });
      if (!reservation.accepted) return false;
      consumeQuota(context.quota, 'youtube', reservation.reservation_id, 'sent');
      return true;
    });
    const payload = JSON.parse(text);
    const statistics = new Map((payload.items || []).map(item => [item.id, item.statistics || {}]));
    for (const item of items) {
      const stats = statistics.get(item.native_id);
      if (!stats) continue;
      item.metrics.views = numberOrNull(stats.viewCount);
      item.metrics.likes = numberOrNull(stats.likeCount);
      item.metrics.comments = numberOrNull(stats.commentCount);
    }
    return { items, status: 'enriched' };
  } catch (error) {
    return { items, status: 'rss_only', reason: error.code || error.name || 'youtube_api_failed' };
  }
}

async function collectYouTube(source, context) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.external_id)}`;
  const xml = await requestText(url, {}, context.config);
  const items = parseFeed(xml)
    .slice(0, context.config.collection.youtube_max_per_source)
    .map(item => normalizeRssItem(item, source, 'youtube_video', context.fetchedAt));
  const enriched = await enrichYouTubeStatistics(items, context, source.id);
  return { items: enriched.items, enrichment: enriched };
}

async function collectX(source, context) {
  if (!context.xApiKey) throw Object.assign(new Error('X_API_KEY 未配置'), { code: 'missing_api_key' });
  const items = [];
  let cursor = '';
  const maxPages = Math.max(1, context.config.collection.x_max_pages_per_source || 1);
  for (let page = 0; page < maxPages; page++) {
    const url = new URL('/twitter/user/last_tweets', context.config.collection.twitter_api_base_url);
    url.searchParams.set('userName', source.handle);
    if (cursor) url.searchParams.set('cursor', cursor);
    const text = await requestText(url, { headers: { 'X-API-Key': context.xApiKey } }, context.config);
    const payload = JSON.parse(text);
    items.push(...extractTweetArray(payload).map(tweet => normalizeTweet(tweet, source, context.fetchedAt)).filter(Boolean));
    const nextCursor = payload.next_cursor || payload.nextCursor || payload.data?.next_cursor || payload.data?.nextCursor;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return items;
}

async function probeBilibiliProvider(source, context) {
  const probeConfig = { ...context.config, collection: { ...context.config.collection, max_retries: 0 } };
  const base = context.config.collection.rsshub_base_url.replace(/\/$/, '');
  try {
    const xml = await requestText(`${base}/bilibili/user/video/${source.external_id}`, { fetchImpl: context.fetchImpl }, probeConfig, attempt => {
      const reservation = reserveQuota(context.quota, 'bilibili', {
        source_id: source.id, layer_id: 'provider-probe', operation: 'rsshub:provider-probe', cost: 1, attempt: attempt + 1,
      });
      if (!reservation.accepted) return false;
      consumeQuota(context.quota, 'bilibili', reservation.reservation_id, 'sent');
      return true;
    });
    return { blocked: false, xml };
  } catch (error) {
    if (error.code === 'cloudflare_challenge') return { blocked: true, reason: 'cloudflare_challenge' };
    return { blocked: true, reason: error.code || error.name || 'provider_probe_failed' };
  }
}

async function collectBilibili(source, context) {
  const base = context.config.collection.rsshub_base_url.replace(/\/$/, '');
  const routes = [
    { key: 'video', path: `/bilibili/user/video/${source.external_id}`, type: 'bilibili_video' },
    { key: 'dynamic', path: `/bilibili/user/dynamic/${source.external_id}`, type: 'bilibili_dynamic' },
    { key: 'article', path: `/bilibili/user/article/${source.external_id}`, type: 'bilibili_article' },
  ];
  const items = [];
  const routeCoverage = {};
  for (const route of routes) {
    try {
      const xml = await requestText(`${base}${route.path}`, { fetchImpl: context.fetchImpl }, context.config, attempt => {
        const reservation = reserveQuota(context.quota, 'bilibili', {
          source_id: source.id,
          layer_id: 'recent-feed',
          operation: `rsshub:${route.key}:latest-feed`,
          cost: 1,
          attempt: attempt + 1,
        });
        if (!reservation.accepted) return false;
        consumeQuota(context.quota, 'bilibili', reservation.reservation_id, 'sent');
        return true;
      });
      const routeItems = parseFeed(xml)
        .slice(0, context.config.collection.bilibili_max_per_route)
        .map(item => normalizeRssItem(item, source, route.type, context.fetchedAt));
      items.push(...routeItems);
      routeCoverage[route.key] = { status: 'success', items: routeItems.length };
    } catch (error) {
      routeCoverage[route.key] = { status: 'degraded', items: 0, reason: error.code || error.name || 'request_failed' };
    }
  }
  return { items, routeCoverage };
}

// ═══════════════════════════════════════════════════════════════
// 第 3 部分：评分、溯源与主题聚合
//
// 评分公式（见 news-config.json scoring.weights）：
//   基础分 = 0.30×长期专业质量 + 0.25×近期时效性 + 0.10×轻度用户体验
//          + 0.20×来源可靠性 + 0.15×互动质量
//   最终分 = clamp(基础分 - 商业推广扣分 - 异常调整, 0, 100)
//
// 时效分使用指数衰减：100 × exp(-ln(2) × 内容年龄天数 / 半衰期天数)
// 轻度用户体验、商单和异常必须在有证据时才能扣分/加分，
// 证据不足时保持中性（50 分、0 扣分、insufficient_sample）。
// ═══════════════════════════════════════════════════════════════

/** AI 关键词过滤：标题或描述包含任一配置关键词（大小写不敏感） */
function matchesAi(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  return config.ai_keywords.some(keyword => text.includes(keyword.toLowerCase()));
}

function primaryTag(item) {
  return item.source_tags?.[0] || 'default';
}

function scoreTimeliness(item, config, now = Date.now()) {
  const ageDays = Math.max(0, (now - new Date(item.published_at).getTime()) / 86400000);
  const halfLife = config.scoring.half_life_days[primaryTag(item)] || config.scoring.half_life_days.default;
  return Math.max(0, Math.min(100, 100 * Math.exp(-Math.LN2 * ageDays / halfLife)));
}

function detectLightExperience(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const categories = Object.entries(config.light_user_signals)
    .filter(([, words]) => words.some(word => text.includes(word.toLowerCase())))
    .map(([category]) => category);
  if (categories.length < 2) return { score: config.scoring.neutral_score, confidence: 0.25, evidence: [] };
  return {
    score: Math.min(100, 50 + categories.length * 12.5),
    confidence: Math.min(1, categories.length / 4),
    evidence: categories.map(category => ({ type: `light_experience_${category}`, source_url: item.url })),
  };
}

function detectCommercial(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  for (const [label, words] of Object.entries(config.commercial_signals)) {
    const matched = words.find(word => text.includes(word.toLowerCase()));
    if (matched) {
      return {
        label,
        confidence: 0.9,
        penalty: config.scoring.commercial_penalties[label] || 0,
        evidence: [{ type: 'explicit_text_match', text: matched, source_url: item.url }],
      };
    }
  }
  const affiliateUrl = (item.explicit_links || []).find(link => /(?:affiliate|aff_id|ref=|referral|partner)/i.test(link));
  if (affiliateUrl) {
    return {
      label: 'affiliate_link', confidence: 0.8,
      penalty: config.scoring.commercial_penalties.affiliate_link || 0,
      evidence: [{ type: 'affiliate_url_pattern', source_url: affiliateUrl }],
    };
  }
  return { label: 'none_confirmed', confidence: 0.5, penalty: 0, evidence: [] };
}

function interactionScore(item, neutral) {
  const values = Object.values(item.metrics || {}).filter(value => Number.isFinite(value));
  if (!values.length) return { score: neutral, confidence: 0, reason: 'metrics_unavailable' };
  return { score: neutral, confidence: 0.1, reason: 'awaiting_source_baseline' };
}

function assessItem(item, source, config, now) {
  const light = detectLightExperience(item, config);
  const commercial = detectCommercial(item, config);
  const interaction = interactionScore(item, config.scoring.neutral_score);
  const contentTypeFactor = item.source_type === 'bilibili_dynamic_repost' ? 0.6 : 1;
  const scores = {
    long_term_quality: (source.quality_prior ?? config.scoring.neutral_score) * contentTypeFactor,
    recent_timeliness: scoreTimeliness(item, config, now),
    light_user_experience: item.source_type === 'bilibili_dynamic_repost'
      ? config.scoring.neutral_score
      : light.score,
    source_reliability: source.reliability_prior ?? config.scoring.neutral_score,
    interaction_quality: interaction.score,
  };
  const weighted = Object.entries(config.scoring.weights)
    .reduce((sum, [key, weight]) => sum + scores[key] * weight, 0);
  return {
    content_id: item.id,
    event_id: null,
    score_breakdown: scores,
    final_score: Math.round(Math.max(0, Math.min(100, weighted - commercial.penalty)) * 10) / 10,
    confidence: Math.round(((light.confidence + interaction.confidence + 1) / 3) * 100) / 100,
    commercial_assessment: commercial,
    anomaly_assessment: {
      status: 'insufficient_sample',
      method: config.anomaly.method,
      sample_count: 0,
      min_samples: config.anomaly.min_samples,
      adjustment: 0,
      evidence: [],
    },
    official_cross_check: { status: source.content_tags.includes('官方来源') ? 'official_source' : 'not_checked', evidence: [] },
    evidence: [...light.evidence],
    assessed_at: new Date(now).toISOString(),
  };
}

function interactionValue(item) {
  const metrics = item.metrics || {};
  const weights = { views: 0.02, likes: 1, comments: 2, reposts: 2, replies: 2 };
  let total = 0;
  let available = false;
  for (const [key, weight] of Object.entries(weights)) {
    if (Number.isFinite(metrics[key])) {
      available = true;
      total += metrics[key] * weight;
    }
  }
  return available ? Math.log10(total + 1) : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function applyAnomalyDetection(items, assessments, config) {
  const groups = new Map();
  for (const item of items) {
    const value = interactionValue(item);
    if (value == null) continue;
    if (!groups.has(item.source_id)) groups.set(item.source_id, []);
    groups.get(item.source_id).push({ item, value });
  }

  const assessmentMap = new Map(assessments.map(assessment => [assessment.content_id, assessment]));
  for (const samples of groups.values()) {
    const values = samples.map(sample => sample.value);
    if (values.length < config.anomaly.min_samples) {
      for (const sample of samples) {
        const target = assessmentMap.get(sample.item.id).anomaly_assessment;
        target.sample_count = values.length;
      }
      continue;
    }
    const center = median(values);
    const deviations = values.map(value => Math.abs(value - center));
    const mad = median(deviations);
    for (const sample of samples) {
      const robustZ = mad === 0 ? 0 : 0.6745 * (sample.value - center) / mad;
      const target = assessmentMap.get(sample.item.id).anomaly_assessment;
      target.sample_count = values.length;
      target.baseline = { median: center, mad };
      target.threshold = config.anomaly.mad_threshold;
      target.trigger_value = sample.value;
      if (Math.abs(robustZ) > config.anomaly.mad_threshold) {
        target.status = 'review';
        target.robust_z = robustZ;
        target.adjustment = config.anomaly.confirmed_adjustment;
        target.evidence = [{
          type: 'mad_outlier', sample_count: values.length, median: center, mad,
          robust_z: robustZ, threshold: config.anomaly.mad_threshold,
        }];
      } else {
        target.status = 'within_baseline';
        target.robust_z = robustZ;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 3.5 部分：公开热点数据契约补充（B16 决策 74/77/78/85/88/89）
//
// 在写出 hotspots.json 前，对每条内容补充公开投影字段：
//   - hot_score          热度语义（0–100 平台内相对互动量级；无互动数据为 null）
//   - evidence_excerpt   依据片段（来源原文的受控节选；纯链接或缺失为 null）
//   - related_resources  稳定关联 ID（仅精确规范 URL 身份匹配工具目录；不模糊匹配）
//
// 语义边界（决策 85）：hot_score 只在来源平台内计算相对量级，不构成跨平台
// 权威综合热度；缺失互动数据的条目为 null，前端按“最近”时间回退，不伪装为 0 或高热度。
// 关联关系只来自精确 URL 身份（已有数据关系），不根据标题普通词做模糊匹配（决策 89）。
// ═══════════════════════════════════════════════════════════════

const HEAT_DEFINITION = 'hot_score 表示条目在其来源平台内的相对互动量级（0–100），由公开互动数据（浏览/点赞/评论/转发）的加权对数指数按平台归一化得到；仅在平台内可比，跨平台不构成权威综合热度。无互动数据时为 null，前端按“最近”时间回退排序。';

/** 依据片段：取来源原文（描述优先，标题兜底）的受控节选；纯链接或空文本返回 null，不伪造原文。 */
function buildEvidenceExcerpt(item) {
  const raw = String(item.description || item.title || '').trim();
  if (!raw) return null;
  if (/^(?:https?:\/\/\S+\s*)+$/.test(raw)) return null; // 纯链接不能当作可定位依据片段
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const max = 160;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('.'), cut.lastIndexOf(' '), cut.lastIndexOf('?'), cut.lastIndexOf('!'));
  return (boundary > 60 ? cut.slice(0, boundary + 1) : cut).trim() + '…';
}

/** 工具目录规范 URL → 工具 的索引（用于精确身份匹配）。 */
function buildToolUrlIndex(toolData) {
  const index = new Map();
  for (const tool of toolData || []) {
    if (!tool || !tool.url) continue;
    const normalized = normalizeUrl(tool.url);
    if (normalized) index.set(normalized, tool);
  }
  return index;
}

/** 稳定关联 ID：仅当条目 URL 或显式链接与工具目录的规范 URL 完全一致时匹配，避免模糊匹配误关联。 */
function resolveRelatedResources(item, toolUrlIndex) {
  const resources = [];
  const seen = new Set();
  for (const raw of [item.url, ...(item.explicit_links || [])]) {
    const normalized = normalizeUrl(raw);
    if (!normalized) continue;
    const tool = toolUrlIndex.get(normalized);
    if (tool && !seen.has(tool.id)) {
      seen.add(tool.id);
      resources.push({ type: 'tool', id: tool.id, label: tool.name });
    }
  }
  return resources;
}

/** 热度：对同一平台内的条目按互动量级归一化到 0–100；无互动数据为 null。 */
function computeHotScores(items) {
  const byPlatform = new Map();
  for (const item of items) {
    if (!byPlatform.has(item.platform)) byPlatform.set(item.platform, []);
    byPlatform.get(item.platform).push(item);
  }
  for (const platformItems of byPlatform.values()) {
    const indexed = platformItems.map(item => ({ item, value: interactionValue(item) }));
    const present = indexed.filter(entry => entry.value !== null).map(entry => entry.value);
    if (!present.length) {
      indexed.forEach(entry => { entry.item.hot_score = null; });
      continue;
    }
    const min = Math.min(...present);
    const max = Math.max(...present);
    const range = max - min;
    indexed.forEach(entry => {
      entry.item.hot_score = entry.value === null
        ? null
        : range > 0 ? Math.round(((entry.value - min) / range) * 100) : 50;
    });
  }
}

let cachedToolUrlIndex = null;
/** 惰性加载工具目录 URL 索引（一次构建只读一次；读取失败时降级为空索引）。 */
function getToolUrlIndex() {
  if (cachedToolUrlIndex === null) {
    let tools = [];
    try { tools = JSON.parse(fs.readFileSync(CATALOG_FILES.tools, 'utf8')); } catch { tools = []; }
    cachedToolUrlIndex = buildToolUrlIndex(tools);
  }
  return cachedToolUrlIndex;
}

/**
 * 对一条热点投影的整体 items 应用公开契约补充（热度/依据片段/稳定关联）。
 * toolUrlIndex 可注入（测试用）；缺省时使用工具目录的规范 URL 索引。
 * 对同一批 items 重复调用保持幂等（各字段由现有公开字段确定性推导）。
 */
function enrichHotspotProjection(items, toolUrlIndex = null) {
  computeHotScores(items);
  const index = toolUrlIndex || getToolUrlIndex();
  for (const item of items) {
    item.evidence_excerpt = buildEvidenceExcerpt(item);
    item.related_resources = resolveRelatedResources(item, index);
  }
  return items;
}

/** 就地升级现有 hotspots.json 的公开投影（无需 API secrets，供开发/数据契约补齐使用）。 */
function upgradeHotspotsProjection() {
  const data = readJson(OUTPUT_PATH, null);
  if (!data || !Array.isArray(data.items)) throw new Error('--upgrade-hotspots：无法读取现有 hotspots.json');
  enrichHotspotProjection(data.items, getToolUrlIndex());
  data.schema_version = 2;
  data.heat_definition = HEAT_DEFINITION;
  writeJsonAtomic(OUTPUT_PATH, data, `upgrade-${Date.now()}`);
  console.log(`✅ hotspots.json 公开投影已升级：${data.items.length} 条内容（schema_version=${data.schema_version}，新增 hot_score/evidence_excerpt/related_resources）`);
}

// B16 决策 65：内容类型枚举（决策 65 六类 + unclassified 占位）。
const CONTENT_TYPE_VALUES = new Set([
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified'
]);

/**
 * 就地迁移现有 hotspots.json（B16 决策 65/66，路径 B）：
 *   - 旧 content_type（来源媒体类型，如 x_post/youtube_video）→ 移到 source_type；
 *   - content_type 统一置 unclassified + content_type_status=unclassified（AI 分类+审核确认未上线前的诚实占位）；
 *   - schema_version 2 → 3（content_type 语义变化）。
 * 幂等：source_type 已存在或 content_type 已是内容类型时不做重复迁移。
 */
function migrateContentTypeProjection() {
  const data = readJson(OUTPUT_PATH, null);
  if (!data || !Array.isArray(data.items)) throw new Error('--migrate-content-type：无法读取现有 hotspots.json');
  let changed = 0;
  for (const item of data.items) {
    if (!item.source_type && item.content_type && !CONTENT_TYPE_VALUES.has(item.content_type)) {
      item.source_type = item.content_type;
      item.content_type = 'unclassified';
      item.content_type_status = 'unclassified';
      changed += 1;
    } else if (!item.source_type) {
      // content_type 缺失或已是内容类型但无来源媒体类型 → source_type 置 unknown
      item.source_type = 'unknown';
      changed += 1;
    }
  }
  data.schema_version = 3;
  writeJsonAtomic(OUTPUT_PATH, data, `migrate-content-type-${Date.now()}`);
  console.log(`✅ hotspots.json 内容类型字段已迁移：${changed} 条调整，content_type 统一置 unclassified（schema_version=${data.schema_version}）`);
}

// ═══════════════════════════════════════════════════════════════
// 第 4 部分：溯源关系、事件聚合与去重
//
// 溯源（provenance）：识别重复观察、转载、评论、翻译和引用关系，
//   每条记录通过 content_id 关联到内容条目。
// 事件聚合（events）：按确定性关键词、显式 URL 关联或人工 topic_key
//   将多条内容归入同一事件/主题，保留各自观点而不合并为单一结论。
// 去重（dedupeItems）：按 url + title 组合去重，保留先出现的条目。
// ═══════════════════════════════════════════════════════════════

/** 将内容归入五层时间窗口（转发到 news-scheduler 的实现） */
function classifyTimeLayer(item, config, now) {
  const ageDays = Math.max(0, (now - new Date(item.published_at).getTime()) / 86400000);
  return config.time_layers.find(layer => ageDays >= layer.min_age_days && ageDays < layer.max_age_days)?.id || 'older';
}

function topicKey(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const entities = config.topic_entities.filter(entity => text.includes(entity.toLowerCase())).sort();
  if (entities.length) return entities.slice(0, 3).join('+');
  const words = text.match(/[a-z][a-z0-9-]{3,}|[一-鿿]{2,6}/g) || [];
  return words.slice(0, 3).join('+') || hash(item.title);
}

function buildProvenance(items) {
  const byNative = new Map();
  const byUrl = new Map(items.map(item => [normalizeUrl(item.url), item]));
  const observedUrls = new Map();
  const provenance = [];
  for (const item of items) {
    const nativeKey = `${item.platform}:${item.native_id}`;
    const urlKey = normalizeUrl(item.url);
    const duplicate = byNative.get(nativeKey) || observedUrls.get(urlKey);
    if (duplicate) {
      provenance.push({
        content_id: item.id,
        canonical_content_id: duplicate.id,
        origin_status: 'confirmed',
        relation: 'duplicate_observation',
        detected_by: 'platform_id_or_url',
        confidence: 1,
        evidence: [{ type: 'matching_platform_id_or_url', source_url: item.url }],
        checked_at: item.fetched_at,
      });
      continue;
    }
    byNative.set(nativeKey, item);
    observedUrls.set(urlKey, item);
    const external = item.explicit_links.find(link => link && normalizeUrl(link) !== urlKey);
    const linkedOriginal = external ? byUrl.get(normalizeUrl(external)) : null;
    provenance.push({
      content_id: item.id,
      canonical_content_id: linkedOriginal?.id || (external ? null : item.id),
      origin_status: linkedOriginal ? 'candidate' : external ? 'candidate' : 'unknown',
      relation: item.source_type === 'bilibili_dynamic_repost' ? 'repost' : external ? 'citation' : 'original',
      detected_by: linkedOriginal ? 'explicit_link_to_collected_content' : external ? 'explicit_link' : 'self_observation',
      confidence: linkedOriginal ? 0.85 : external ? 0.65 : 0.35,
      evidence: external ? [{ type: 'explicit_link', source_url: external }] : [],
      checked_at: item.fetched_at,
    });
  }
  return provenance;
}

function buildEvents(items, assessments, config) {
  const groups = new Map();
  const assessmentsByContentId = new Map();
  for (const assessment of assessments) {
    if (!assessmentsByContentId.has(assessment.content_id)) assessmentsByContentId.set(assessment.content_id, []);
    assessmentsByContentId.get(assessment.content_id).push(assessment);
  }
  for (const item of items) {
    const key = topicKey(item, config);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, group]) => {
    const id = `event-${hash(key)}`;
    let firstSeenAt = group[0].published_at;
    let updatedAt = group[0].published_at;
    for (const item of group) {
      for (const assessment of assessmentsByContentId.get(item.id) || []) assessment.event_id = id;
      if (item.published_at < firstSeenAt) firstSeenAt = item.published_at;
      if (item.published_at > updatedAt) updatedAt = item.published_at;
    }
    return {
      id,
      topic_key: key,
      title: group[0].title,
      first_seen_at: firstSeenAt,
      updated_at: updatedAt,
      content_ids: group.map(item => item.id),
      viewpoints: group.map(item => ({
        content_id: item.id,
        position: 'unclassified',
        summary: item.description || item.title,
        evidence_level: 'source_content',
      })),
      official_verification: { status: group.some(item => item.source_tags.includes('官方来源')) ? 'official_source_present' : 'not_checked', evidence: [] },
    };
  });
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.platform}:${item.native_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

/** 根据平台分发到对应采集函数。新增平台时在此增加分支。 */
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

function historicalPageToken(progress) {
  return progress.page_token ?? progress.resume_page_token ?? null;
}

async function runHistoricalLayerPass(options) {
  const { config, sourcePayload, state, registryIndex, quota, now, fetchedAt, youtubeApiKey } = options;
  const sourceScope = options.sources || sourcePayload.sources;
  const sources = sourceScope.filter(source => source.enabled && ['youtube', 'bilibili'].includes(source.platform));
  if (!sources.length) return { status: 'not_applicable', active_layer: null, items: [] };
  const historicalItems = [];
  const scheduler = createSchedulerState(state.history_scheduler || null);
  const layer = config.time_layers.find(item => item.id === scheduler.active_layer) || config.time_layers[0];
  scheduler.active_layer = layer.id;
  initializeLayer(scheduler, layer, sources, fetchedAt);

  for (const source of sources) {
    const key = `${layer.id}:${source.id}`;
    const progress = scheduler.sources[key];
    if (['complete', 'observed_empty', 'partial', 'history_unsupported', 'skipped_by_user'].includes(progress.status)) continue;
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
        });
      }
      if (source.platform === 'youtube' && result.details) {
        historicalItems.push(...result.details.map(detail => normalizeHistoricalYouTube(detail, source, fetchedAt)).filter(item => item.title && item.published_at));
      }
      if (source.platform === 'bilibili' && result.items) {
        historicalItems.push(...result.items.map(item => normalizeHistoricalBilibili(item, source, fetchedAt)).filter(item => item.title && item.url && item.published_at));
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
    });
  freshItems.push(...(history.items || []).filter(item => matchesAi(item, config)));

  // B16 决策 63/72：旧内容保留与公开资格统一使用同一近期窗口过滤（单一来源规则，
  // 规则集中在 news-public-gate.js，RSS 与热点视图共用，避免口径漂移）。
  const retainedOld = (oldOutput.items || []).filter(item => isWithinPublicWindow(item, { now, config }));
  const items = dedupeItems([...freshItems, ...retainedOld])
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
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
  const candidateStore = mergeCandidates(
    readCandidateStore(),
    items.map(item => stampCandidateStatuses({
      ...item,
      // B16 决策 65/66：content_type 为内容类型（AI 工具/产品/概念/技术动态/行业事件/其他）。
      // 路径 B：AI 分类+审核确认未上线前统一置 unclassified，content_type_status 记录诚实状态；
      // 路径 A 上线后由分类器写 ai_suggested，审核确认后改 reviewed。
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
  const finalizedQuota = finishQuotaLedger(quota, fetchedAt);
  output.coverage.registry = {
    total: registry.stats.count,
    observations_in_run: observedRegistryResults.length,
    new_in_projection: registryResults.filter(result => result.isNew).length,
    analysis_version: config.collection.analysis_version,
  };

  // 写入顺序有严格依赖：Registry/State/Quota/Authorizations 是内部状态，
  // 候选层也是内部状态（不发布），hotspots.json 是面向浏览器的公开投影。
  // 候选层先写、公开投影最后写：如果中间任何一步失败，旧 hotspots.json 保持
  // 不变，前端不会看到半成品。
  // 候选层写入前附带投影快照（events/provenance/assessments/coverage/热度定义），
  // 使 PR 合并后可由 Actions 独立重建最终公开投影（决策 49/59）。
  if (!options.noWrite) {
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
  computeHotScores,
  enrichHotspotProjection,
  upgradeHotspotsProjection,
  migrateContentTypeProjection,
  runCollection,
  runFixtureBuild,
  historicalPageToken,
  main,
};
