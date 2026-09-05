/**
 * collector-x-normalize.js —— X(TwitterAPI.io) 采集器的数据规范化层（纯函数）：
 * 推文统一内容模型、长文（Twitter Article）信号判定与正文提取、handle 解析。
 * 网络请求与 credits 结算在 collector-x-v2.js。
 */

'use strict';

const { normalizeUrl, hash, numberOrNull } = require('../pipeline/feed-parser');

/** 从推文 URL 提取 handle（x.com/{handle}/status/...）；无法提取返回 null。 */
function extractHandleFromUrl(url) {
  const match = String(url).match(/x\.com\/([^/]+)/) || String(url).match(/twitter\.com\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * 将单条 TwitterAPI.io 推文标准化为统一内容模型（兼容多套字段命名）。
 * 博主路径的 author 为配置名单推导（{ id, handle, name, language, content_tags }），
 * 关键词路径无预知来源，author 为 null，身份信息从推文自身解析。
 * 缺正文或时间则返回 null（不进入管线）。
 */
function normalizeXV2Tweet(tweet, author, fetchedAt) {
  const nativeId = String(tweet.id || tweet.id_str || tweet.tweetId || tweet.rest_id || hash(JSON.stringify(tweet)));
  const text = tweet.text || tweet.full_text || tweet.fullText || tweet.content || '';
  const created = tweet.createdAt || tweet.created_at || tweet.created || tweet.timestamp;
  if (!text || !created) return null;

  const handle =
    author?.handle ||
    tweet.author?.handle ||
    tweet.author?.username ||
    tweet.user?.screen_name ||
    tweet.user?.username ||
    extractHandleFromUrl(tweet.url) ||
    null;
  const authorId = author?.id || `x-${hash(handle || nativeId)}`;
  const authorName =
    tweet.author?.name ||
    tweet.authorName ||
    tweet.user?.name ||
    author?.name ||
    handle ||
    '';
  const url = normalizeUrl(
    tweet.url ||
      (handle ? `https://x.com/${handle}/status/${nativeId}` : `https://x.com/i/status/${nativeId}`)
  );

  return {
    id: `x-${hash(nativeId)}`,
    platform: 'x',
    native_id: nativeId,
    source_type: 'x_post',
    url,
    title: text.slice(0, 180),
    description: text.slice(0, 600),
    published_at: new Date(created).toISOString(),
    fetched_at: fetchedAt,
    author_id: authorId,
    author_name: authorName,
    source_id: authorId,
    language: tweet.lang || tweet.language || author?.language || 'en',
    source_tags: Array.isArray(author?.content_tags) ? author.content_tags : [],
    thumbnail: tweet.media?.[0]?.url || tweet.extendedEntities?.media?.[0]?.media_url_https || null,
    metrics: {
      views: numberOrNull(tweet.viewCount ?? tweet.views ?? tweet.view_count),
      likes: numberOrNull(tweet.likeCount ?? tweet.favorite_count ?? tweet.likes),
      comments: null,
      reposts: numberOrNull(tweet.retweetCount ?? tweet.retweet_count ?? tweet.reposts),
      replies: numberOrNull(tweet.replyCount ?? tweet.reply_count ?? tweet.replies),
    },
    explicit_links: [
      ...new Set(
        [
          ...(text.match(/https?:\/\/\S+/g) || []),
          ...(Array.isArray(tweet.urls)
            ? tweet.urls.map(link => link.expanded_url || link.url).filter(Boolean)
            : []),
        ]
          .map(normalizeUrl)
          .filter(Boolean)
      ),
    ].slice(0, 10),
    content_type: null,
    comments: [],
  };
}

/**
 * 判断推文是否承载长文（Twitter Article）。
 * 信号：tweet.article_id / articleId / article 对象 / note_tweet / 正文含 /i/articles/ 链接。
 */
function hasArticleSignal(tweet, description) {
  if (tweet.articleId || tweet.article_id) return true;
  if (tweet.article && (tweet.article.id || typeof tweet.article === 'object')) return true;
  if (tweet.note_tweet) return true;
  return /\/i\/articles\//.test(description || '');
}

/**
 * 从 /twitter/article 响应中提取长文正文。
 * 兼容 { data: { article } } / { article } / 裸 { data } 三层结构；
 * content 兼容字符串与 block 数组（每块取 content / text）。
 * 无可读正文返回 null。
 */
function extractArticleText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data;
  const article =
    (data && data.article) ||
    payload.article ||
    (data && typeof data === 'object' && !Array.isArray(data) ? data : null) ||
    null;
  if (!article || typeof article !== 'object') return null;

  const title = typeof article.title === 'string' ? article.title.trim() : '';
  const subtitle = typeof article.subtitle === 'string' ? article.subtitle.trim() : '';
  let body = '';
  if (typeof article.content === 'string') {
    body = article.content;
  } else if (Array.isArray(article.content)) {
    body = article.content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block.content === 'string') return block.content;
        if (block && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return [title, subtitle, body].map(part => part.trim()).filter(Boolean).join('\n\n') || null;
}

module.exports = {
  extractHandleFromUrl,
  normalizeXV2Tweet,
  hasArticleSignal,
  extractArticleText,
};
