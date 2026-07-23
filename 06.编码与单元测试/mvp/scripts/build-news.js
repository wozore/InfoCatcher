'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  readJson, writeJsonAtomic, acquireLock, releaseLock,
} = require('./news-storage');
const { createRegistry, bulkDiscover, updateLifecycle, finalizeRegistry } = require('./news-registry');
const {
  createQuotaLedger, reserveQuota, consumeQuota, finishQuotaLedger,
} = require('./news-quota');
const {
  createSchedulerState, initializeLayer, updateSourceProgress, advanceLayer,
} = require('./news-scheduler');
const { collectYouTubeLayerStep } = require('./news-youtube');
const { collectBilibiliLayerStep } = require('./news-bilibili');
const { createAuthorizationStore, createAuthorizationTask } = require('./news-authorization');

const MVP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(MVP_DIR, 'data');
const SOURCES_PATH = path.join(DATA_DIR, 'news-sources.json');
const CONFIG_PATH = path.join(DATA_DIR, 'news-config.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'hotspots.json');
const STATE_PATH = path.join(DATA_DIR, 'news-state.json');
const REGISTRY_PATH = path.join(DATA_DIR, 'news-registry.json');
const QUOTA_PATH = path.join(DATA_DIR, 'news-quota.json');
const AUTHORIZATIONS_PATH = path.join(DATA_DIR, 'pending-authorizations.json');
const LOCK_PATH = path.join(DATA_DIR, '.news-build.lock');

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
    content_type: contentType === 'bilibili_dynamic' ? inferBilibiliType(item) : contentType,
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
    content_type: 'x_post',
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

async function requestText(url, options, config, beforeAttempt = null) {
  const timeout = config.collection.request_timeout_ms;
  let lastError;
  for (let attempt = 0; attempt <= config.collection.max_retries; attempt++) {
    try {
      if (beforeAttempt && beforeAttempt(attempt) === false) throw Object.assign(new Error('请求额度不足'), { code: 'quota_paused' });
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: `http_${response.status}` });
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error.code === 'quota_paused') throw error;
      if (attempt < config.collection.max_retries) {
        await new Promise(resolve => setTimeout(resolve, config.collection.retry_base_ms * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function enrichYouTubeStatistics(items, context) {
  if (!context.youtubeApiKey || !items.length) return { items, status: 'rss_only' };
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'statistics');
    url.searchParams.set('id', items.map(item => item.native_id).slice(0, 50).join(','));
    url.searchParams.set('key', context.youtubeApiKey);
    const text = await requestText(url, {}, context.config, attempt => {
      const reservation = reserveQuota(context.quota, 'youtube', {
        source_id: context.currentSourceId,
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
  context.currentSourceId = source.id;
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.external_id)}`;
  const xml = await requestText(url, {}, context.config);
  const items = parseFeed(xml)
    .slice(0, context.config.collection.youtube_max_per_source)
    .map(item => normalizeRssItem(item, source, 'youtube_video', context.fetchedAt));
  const enriched = await enrichYouTubeStatistics(items, context);
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
      const xml = await requestText(`${base}${route.path}`, {}, context.config, attempt => {
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
  const contentTypeFactor = item.content_type === 'bilibili_dynamic_repost' ? 0.6 : 1;
  const scores = {
    long_term_quality: (source.quality_prior ?? config.scoring.neutral_score) * contentTypeFactor,
    recent_timeliness: scoreTimeliness(item, config, now),
    light_user_experience: item.content_type === 'bilibili_dynamic_repost'
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
      relation: item.content_type === 'bilibili_dynamic_repost' ? 'repost' : external ? 'citation' : 'original',
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
  for (const item of items) {
    const key = topicKey(item, config);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, group]) => {
    const id = `event-${hash(key)}`;
    for (const assessment of assessments) {
      if (group.some(item => item.id === assessment.content_id)) assessment.event_id = id;
    }
    return {
      id,
      topic_key: key,
      title: group[0].title,
      first_seen_at: group.map(item => item.published_at).sort()[0],
      updated_at: group.map(item => item.published_at).sort().at(-1),
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

function normalizeHistoricalYouTube(detail, source, fetchedAt) {
  const snippet = detail.snippet || {};
  return {
    id: `youtube:${detail.id}`,
    platform: 'youtube',
    native_id: detail.id,
    content_type: 'youtube_video',
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
    content_type: candidate.content_type || 'unknown',
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
  const sources = sourcePayload.sources.filter(source => source.enabled && ['youtube', 'bilibili'].includes(source.platform));
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

async function runCollection(options = {}) {
  const config = options.config || readJson(CONFIG_PATH);
  const sourcePayload = options.sourcePayload || readJson(SOURCES_PATH);
  const oldOutput = readJson(OUTPUT_PATH, { items: [], events: [], provenance: [], assessments: [], coverage: {} });
  const state = options.state || readJson(STATE_PATH, initialState());
  const now = options.now || Date.now();
  const fetchedAt = new Date(now).toISOString();
  const runId = `run-${fetchedAt.replace(/[-:.TZ]/g, '')}`;
  const quota = options.quota || createQuotaLedger(config.collection, runId, fetchedAt);
  const registryIndex = options.registryIndex || createRegistry(readJson(REGISTRY_PATH, null));
  const enabled = sourcePayload.sources.filter(source => source.enabled);

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
  };
  const freshItems = [];
  const observedRegistryResults = [];
  const coverage = {
    status: 'running',
    sources_total: enabled.length,
    sources_attempted: selected.length,
    sources_terminal: 0,
    platforms: {
      youtube: { status: 'not_run', items: 0 },
      x: { status: 'rotating', items: 0, attempted: selectedX.length, total: xSources.length },
      bilibili: {
        status: 'not_run', items: 0,
        video: { status: 'not_run' }, dynamic: { status: 'not_run' }, article: { status: 'not_run' },
      },
    },
  };

  for (const source of selected) {
    try {
      const result = options.collector
        ? await options.collector(source, context)
        : await collectSource(source, context);
      const filtered = result.items.filter(item => matchesAi(item, config));
      const filteredIds = new Set(filtered.map(item => `${item.platform}:${item.native_id}`));
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
    } catch (error) {
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
  const history = skipHistory
    ? { status: 'skipped', active_layer: state.history_scheduler?.active_layer || null, items: [] }
    : await runHistoricalLayerPass({
      config, sourcePayload, state, registryIndex, quota, now, fetchedAt,
      youtubeApiKey: context.youtubeApiKey,
    });
  freshItems.push(...(history.items || []).filter(item => matchesAi(item, config)));

  const retentionDays = config.collection.output_retention_days ?? config.collection.retention_days ?? 30;
  const cutoff = now - retentionDays * 86400000;
  const retainedOld = (oldOutput.items || []).filter(item => new Date(item.published_at).getTime() >= cutoff);
  const items = dedupeItems([...freshItems, ...retainedOld])
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, config.collection.max_output_items);

  if (!items.length && !options.allowEmpty) throw new Error('本轮未获得任何有效内容，保留上一版输出');

  const sourceMap = new Map(sourcePayload.sources.map(source => [source.id, source]));
  const assessments = items.map(item => assessItem(item, sourceMap.get(item.source_id) || { content_tags: [], quality_prior: 50, reliability_prior: 50 }, config, now));
  applyAnomalyDetection(items, assessments, config);
  const events = buildEvents(items, assessments, config);
  const provenance = buildProvenance(items);
  coverage.time_layers = Object.fromEntries(config.time_layers.map(layer => [layer.id, { items: 0 }]));
  coverage.time_layers.older = { items: 0 };
  for (const item of items) coverage.time_layers[classifyTimeLayer(item, config, now)].items++;
  coverage.status = coverage.sources_terminal === selected.length ? 'complete' : 'partial';
  if (selectedX.length < xSources.length) {
    coverage.platforms.x.status = coverage.platforms.x.status === 'degraded' ? 'degraded' : 'rotating';
    if (coverage.status === 'complete') coverage.status = 'rotating';
  }

  state.schema_version = 1;
  state.last_run = { run_id: runId, started_at: fetchedAt, completed_at: new Date().toISOString(), status: coverage.status };
  state.active_layer = resolveActiveLayer(state, enabled, config);
  state.x_rotation_offset = xSources.length ? (offset + xLimit) % xSources.length : 0;
  coverage.active_layer = state.active_layer;
  coverage.time_layer_scope = 'latest-feed-observation';

  const output = {
    schema_version: 1,
    generated_at: fetchedAt,
    items,
    events,
    provenance,
    assessments,
    coverage,
  };

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

  if (!options.noWrite) {
    writeJsonAtomic(REGISTRY_PATH, registry, runId);
    writeJsonAtomic(STATE_PATH, state, runId);
    writeJsonAtomic(QUOTA_PATH, finalizedQuota, runId);
    writeJsonAtomic(AUTHORIZATIONS_PATH, authorizations, runId);
    writeJsonAtomic(OUTPUT_PATH, output, runId);
  }
  return { output, state, registry, quota: finalizedQuota, authorizations };
}

async function runFixtureBuild() {
  const fixtureDir = path.join(__dirname, 'news-fixtures');
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
    state: initialState(), now: fixedNow, noWrite: true, allowEmpty: false, skipHistory: true,
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
    const result = await runCollection({ allowEmpty });
    console.log(`✅ 热点构建完成：${result.output.items.length} 条内容，${result.output.events.length} 个主题`);
    console.log(`   覆盖：${result.output.coverage.sources_terminal}/${result.output.coverage.sources_attempted} 个本轮来源`);
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
  runCollection,
  runFixtureBuild,
  historicalPageToken,
};
