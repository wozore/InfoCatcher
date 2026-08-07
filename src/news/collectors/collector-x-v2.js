/**
 * collector-x-v2.js — 热点管线 v2 的 X（TwitterAPI.io）采集器
 *
 * 在热点管线 v2 中的位置：v2 管线（热点发现层）的 X 采集入口，
 * 按「博主时间窗 + 关键词搜索」两条路径采集，并对长文（Twitter Article）
 * 补读正文，统一输出为与 v1 管线相同的内容模型。
 *
 * 与旧采集器 news-x.js 的区别：
 *   - 旧版：按 registry 来源名单分频道 last_tweets 翻页回溯，依赖
 *     quota ledger / registry / scheduler 模块，每次请求消耗 1 quota unit；
 *   - v2：博主名单直接来自 config.x_accounts，关键词来自 config.keywords.ai_keywords，
 *     不依赖旧架构的 quota / registry / scheduler，使用独立 credits 计数
 *     （TwitterAPI.io 计费模型：推文 15 credits/条、长文 100 credits/篇），
 *     超 config.collection.x_credits_per_run（3750）即停止。
 *
 * 配额模型（成本要点）：
 *   - 博主 last_tweets 与关键词 advanced_search 均按「时间窗内返回的推文」
 *     每条计 x_credits_per_tweet（15）credits；
 *   - 长文读取按成功读取的篇数计 x_credits_per_article（100）credits；
 *   - usedCredits 为累计值（tweets×15 + articles×100），任一操作前先查配额，
 *     不足则停止并记 failures 降级返回；
 *   - 关键词与博主结果按 native_id 去重（重复推文只输出一次，credits 仍按各自返回计）。
 *
 * 使用示例：
 *   const result = await collectXV2({
 *     config,                     // data/news/config/news-config-v2.json（缺省自动加载）
 *     xApiKey: process.env.X_API_KEY,
 *     sinceIso: '2026-08-07T00:00:00Z',  // 时间窗起点（调用方算好）
 *     untilIso: '2026-08-07T14:00:00Z',  // 时间窗终点
 *     now: '2026-08-07T14:00:00Z',       // 可选，测试注入
 *     fetchImpl: customFetch,            // 可选，测试注入
 *   });
 *   // => { items, credits: { used, tweets, articles }, coverage }
 */

'use strict';

const { requestText, numberOrNull, normalizeUrl, hash, extractTweetArray } = require('../pipeline/feed-parser');

/** 兜底配置：仅在未传入 config 且 v2 配置文件不可读时使用。 */
const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  collection: {
    twitter_api_base_url: 'https://api.twitterapi.io',
    x_credits_per_run: 3750,
    x_credits_per_tweet: 15,
    x_credits_per_article: 100,
    request_timeout_ms: 15000,
    max_retries: 2,
    retry_base_ms: 750,
  },
  keywords: { ai_keywords: [] },
  x_accounts: [],
});

let cachedV2Config = null;

/** 懒加载 news-config-v2.json；不可读时退回 DEFAULT_CONFIG。 */
function loadV2Config() {
  if (cachedV2Config) return cachedV2Config;
  try {
    cachedV2Config = require('../../../data/news/config/news-config-v2.json');
  } catch {
    cachedV2Config = DEFAULT_CONFIG;
  }
  return cachedV2Config;
}

/**
 * 以 v2 配置文件为基准，用调用方传入的 config 覆盖对应段。
 * 保证缺省字段（request_timeout_ms / max_retries 等）在调用方只传
 * 部分配置时也有兜底值（requestText 依赖这些字段）。
 */
function resolveConfig(config) {
  const base = loadV2Config();
  if (!config) return base;
  return {
    ...base,
    ...config,
    schedule: { ...(base.schedule || {}), ...(config.schedule || {}) },
    collection: { ...(base.collection || {}), ...(config.collection || {}) },
    keywords: { ...(base.keywords || {}), ...(config.keywords || {}) },
  };
}

/** 错误标签：防御 requestText 可能抛 undefined 的边界情况。 */
function errorLabel(error) {
  return (error && (error.code || error.message)) || 'api_error';
}

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

/** 执行一次请求并解出推文数组；解析/网络错误向上抛，由调用方记录并降级。 */
async function fetchTweets(url, headers, fetchImpl, config) {
  const text = await requestText(url, { headers, fetchImpl }, config);
  return extractTweetArray(JSON.parse(text));
}

/**
 * X（TwitterAPI.io）采集入口。
 * 任何 API 失败不抛错，降级返回部分结果与 coverage 状态。
 *
 * @param {object} options
 * @param {object} [options.config] v2 配置（缺省自动加载 news-config-v2.json）
 * @param {string} [options.xApiKey] X_API_KEY（缺省读 process.env）
 * @param {string} [options.sinceIso] 时间窗起点（含）；缺省不限制
 * @param {string} [options.untilIso] 时间窗终点（含）；缺省不限制
 * @param {string|Date} [options.now] 采集参考时间（测试注入，缺省当前时间）
 * @param {string} [options.fetchedAt] fetched_at（缺省 now ISO）
 * @param {function} [options.fetchImpl] fetch 实现（测试注入）
 * @returns {Promise<{items: object[], credits: object, coverage: object}>}
 */
async function collectXV2(options = {}) {
  const config = resolveConfig(options.config);
  const apiKey = options.xApiKey || process.env.X_API_KEY;
  const emptyCredits = { used: 0, tweets: 0, articles: 0 };

  if (!apiKey) {
    return { items: [], credits: emptyCredits, coverage: { status: 'failed', reason: 'missing_api_key' } };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const fetchedAt = options.fetchedAt || now.toISOString();
  const sinceMs = options.sinceIso ? new Date(options.sinceIso).getTime() : null;
  const untilMs = options.untilIso ? new Date(options.untilIso).getTime() : null;

  const collection = config.collection || {};
  const baseUrl = collection.twitter_api_base_url || 'https://api.twitterapi.io';
  const creditsPerRun = collection.x_credits_per_run ?? 3750;
  const tweetsCost = collection.x_credits_per_tweet ?? 15;
  const articlesCost = collection.x_credits_per_article ?? 100;
  const accounts = Array.isArray(config.x_accounts) ? config.x_accounts : [];
  const keywords = Array.isArray(config.keywords?.ai_keywords) ? config.keywords.ai_keywords : [];

  const headers = { 'X-API-Key': apiKey };
  const credits = { used: 0, tweets: 0, articles: 0 };
  const items = new Map(); // native_id -> item（博主 + 关键词全局去重）
  const articleCandidates = []; // { tweetId, item } 待补读长文
  const failures = [];

  const canAfford = cost => credits.used + cost <= creditsPerRun;

  /** 时间窗过滤：created 缺失/不可解析视为不在窗内。 */
  const inWindow = created => {
    if (!created) return false;
    const ms = new Date(created).getTime();
    if (!Number.isFinite(ms)) return false;
    if (sinceMs !== null && ms < sinceMs) return false;
    if (untilMs !== null && ms > untilMs) return false;
    return true;
  };

  /** 统一收口：计配额 → 规范化 → 去重入 items → 标记长文候选。 */
  const ingestTweet = (tweet, author) => {
    if (!canAfford(tweetsCost)) return false; // 配额不足，停止该来源后续推文
    const created = tweet.createdAt || tweet.created_at || tweet.created || tweet.timestamp;
    if (!inWindow(created)) return true; // 窗外的推文不消耗配额，继续看下一条
    credits.used += tweetsCost;
    credits.tweets += 1;
    const item = normalizeXV2Tweet(tweet, author, fetchedAt);
    if (!item) return true;
    if (!items.has(item.native_id)) {
      items.set(item.native_id, item);
      if (hasArticleSignal(tweet, item.description)) {
        articleCandidates.push({ tweetId: item.native_id, item });
      }
    }
    return true;
  };

  // ── 1. 博主时间窗：last_tweets（15 credits/条） ──
  for (const handle of accounts) {
    if (credits.used >= creditsPerRun) { failures.push('credits_exhausted'); break; }
    if (!handle) continue;
    const author = { id: `x-${hash(handle)}`, handle, name: handle, language: 'en', content_tags: [] };
    try {
      const url = new URL('/twitter/user/last_tweets', baseUrl);
      url.searchParams.set('userName', handle);
      for (const tweet of await fetchTweets(url, headers, fetchImpl, config)) {
        if (ingestTweet(tweet, author) === false) { failures.push('credits_exhausted'); break; }
      }
    } catch (error) {
      failures.push(`accounts:${handle}:${errorLabel(error)}`);
    }
  }

  // ── 2. 关键词搜索：advanced_search（15 credits/条），与博主结果按 native_id 去重 ──
  for (const keyword of keywords) {
    if (credits.used >= creditsPerRun) { failures.push('credits_exhausted'); break; }
    if (!keyword) continue;
    try {
      const url = new URL('/twitter/tweet/advanced_search', baseUrl);
      url.searchParams.set('query', keyword);
      url.searchParams.set('queryType', 'Latest');
      for (const tweet of await fetchTweets(url, headers, fetchImpl, config)) {
        if (ingestTweet(tweet, null) === false) { failures.push('credits_exhausted'); break; }
      }
    } catch (error) {
      failures.push(`search:${keyword}:${errorLabel(error)}`);
    }
  }

  // ── 3. 长文读取：/twitter/article（100 credits/篇），正文并入 description ──
  for (const candidate of articleCandidates) {
    if (!canAfford(articlesCost)) { failures.push('credits_exhausted'); break; }
    try {
      const url = new URL('/twitter/article', baseUrl);
      url.searchParams.set('tweetId', String(candidate.tweetId));
      const body = extractArticleText(JSON.parse(await requestText(url, { headers, fetchImpl }, config)));
      if (body) {
        credits.used += articlesCost;
        credits.articles += 1;
        const base = candidate.item.description || '';
        candidate.item.description = [body, base].filter(Boolean).join('\n\n').slice(0, 600);
      }
    } catch (error) {
      failures.push(`article:${candidate.tweetId}:${errorLabel(error)}`);
    }
  }

  // ── 4. coverage 状态 ──
  const finalItems = [...items.values()];
  let status = 'success';
  if (finalItems.length === 0 && failures.length > 0) status = 'failed';
  else if (failures.length > 0) status = 'partial';
  const coverage = { status, reason: failures.length ? failures[0] : null };

  return { items: finalItems, credits, coverage };
}

module.exports = {
  collectXV2,
  normalizeXV2Tweet,
  extractArticleText,
  hasArticleSignal,
  resolveConfig,
  loadV2Config,
};
