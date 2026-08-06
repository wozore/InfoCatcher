/**
 * feed-parser.js —— 通用解析与内容标准化层
 *
 * 在热点管线中的位置：被各平台采集器（news-youtube / news-bilibili / news-x）
 * 与编排入口（build-news.js）共享。负责把三个平台的原始格式
 * （YouTube Atom、B站 RSSHub、X TwitterAPI.io JSON）转换为统一内容模型，
 * 并提供跨平台的 HTTP 请求（requestText）与标识规范化工具。
 *
 * 模块边界：
 *   - 只做「解析/规范化」，不含平台网络采集逻辑（采集在 collectors/ 下）；
 *   - normalizeTweet 是 X 专属规范化，随 collectX 放在 collectors/news-x.js；
 *   - normalizeRssItem 为 RSS 类（YouTube/Bilibili）通用规范化。
 */

'use strict';

const crypto = require('crypto');

/**
 * 解码 XML 文本：剥离 CDATA、解码 5 个基础实体（&amp;/&lt;/&gt;/&quot;/&#39;）、
 * 去残留标签并把连续空白折叠为单空格。RSS 描述里常混有 HTML 标签，统一在此净化。
 */
function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 按标签名提取首个匹配标签的文本内容（非贪婪 + 忽略属性）。只转义冒号，
 * 因此适用于带命名空间前缀的标签（如 yt:videoId / media:description / dc:creator）。
 * 未匹配返回空串。
 */
function matchTag(xml, tag) {
  const escaped = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

/**
 * 同时解析 Atom 与 RSS：各自按 <entry> / <item> 正则切块后统一映射。
 * 保留原始块 raw_block（供下游 normalizeRssItem 抽取显式链接）；
 * 缺失标题/URL/发布时间之一的条目被过滤（非完整内容不进入管线）。
 */
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

/**
 * 规范化 URL：仅保留 http/https；去掉 hash 片段与常见追踪参数
 * （utm_* / feature / si / spm_id_from）。解析失败返回空串。
 * 目的：同一链接的不同追踪变体在去重/溯源时视为同一 URL。
 */
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

/**
 * 启发式推断 B 站动态的细分类（RSS 只给到 bilibili_dynamic，需在此细分）：
 * 命中顺序 = 专栏 URL → 转发文案 → 视频投稿 → 兜底纯文本。规则基于标题/描述关键词，
 * 不是强契约；不匹配任何规则时归为 dynamic_text。
 */
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

/**
 * 兼容 TwitterAPI.io 的多种返回结构：裸数组 / {tweets} / {data:{tweets}} / {data}。
 * 均返回条目数组；都不匹配返回空数组。
 */
function extractTweetArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.tweets)) return payload.tweets;
  if (Array.isArray(payload.data?.tweets)) return payload.data.tweets;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 带重试与额度回调的文本请求（fetch 封装）。
 * beforeAttempt 回调用于在每次重试前检查额度：
 * 如果额度不足（返回 false），立即抛出 quota_paused 并跳过后续重试——
 * 额度不足不是网络问题，重试不会让额度恢复。
 */
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

/** 历史回溯游标：优先 resume_page_token（额度中断恢复），其次是常规 page_token。 */
function historicalPageToken(progress) {
  return progress.page_token ?? progress.resume_page_token ?? null;
}

module.exports = {
  decodeXml,
  matchTag,
  parseFeed,
  normalizeUrl,
  hash,
  numberOrNull,
  requestText,
  historicalPageToken,
  inferBilibiliType,
  extractTweetArray,
  normalizeRssItem,
};
