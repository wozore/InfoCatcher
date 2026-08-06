/**
 * news-x.js — X（TwitterAPI.io）最新 Feed 采集适配器
 *
 * 在热点管线中的位置：被 build-news.js 的 collectSource() 分发调用，
 * 负责 X 来源的最近推文采集（来源轮转，带 cursor 分页），
 * 并把 TwitterAPI.io 响应标准化为统一内容模型。
 *
 * 设计决策：
 *   - 来源轮转由编排层（build-news.js 的 x_rotation_offset）决定，
 *     本模块只负责单个来源的翻页采集；
 *   - 每次请求消耗 1 quota unit（含重试，经 requestText 的 beforeAttempt 回调）；
 *   - normalizeTweet 为 X 专属规范化（与 RSS 类通用 normalizeRssItem 分离，
 *     后者在 pipeline/feed-parser.js）。
 */

'use strict';

const { requestText, extractTweetArray, hash, normalizeUrl, numberOrNull } = require('../pipeline/feed-parser');

/**
 * 将单条 TwitterAPI.io 推文标准化为统一内容模型。
 * 兼容多套字段命名（id/id_str/tweetId/rest_id、text/full_text 等），全部缺失时
 * 以推文 JSON 的 hash 兜底 native_id；缺正文或时间则返回 null（不进入管线）。
 */
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

/**
 * 采集单个 X 来源：按 cursor 翻页取最近推文，直至无下一页或达到 x_max_pages_per_source。
 * 每页一次请求（经 requestText 的 beforeAttempt 计入 quota）；X_API_KEY 未配置时直接抛 missing_api_key。
 */
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

module.exports = { normalizeTweet, collectX };
