/**
 * collector-youtube-normalize.js —— YouTube 采集器的数据规范化层（纯函数）：
 * ISO 8601 时长解析与 videos.list 详情的统一内容模型装配。
 * 网络请求与配额计数在 collector-youtube-v2.js。
 */

'use strict';

const { normalizeUrl, hash, numberOrNull } = require('../pipeline/feed-parser');

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

/**
 * 将一条 videos.list 详情标准化为统一内容模型。
 * author_id/source_id 沿用频道 id 约定（`youtube-${hash(channelId)}`），
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

module.exports = {
  parseDuration,
  buildItem,
};
