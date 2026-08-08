/**
 * feed-parser.js —— 通用解析与内容标准化层
 *
 * 在热点管线中的位置：被各平台采集器（news-youtube / news-x）
 * 与编排入口（build-news.js）共享。负责把各平台的原始格式
 * （YouTube Atom、X TwitterAPI.io JSON）转换为统一内容模型，
 * 并提供跨平台的 HTTP 请求（requestText）与标识规范化工具。
 *
 * 模块边界：
 *   - 只做「解析/规范化」，不含平台网络采集逻辑（采集在 collectors/ 下）；
 *   - normalizeTweet 是 X 专属规范化，随 collectX 放在 collectors/news-x.js；
 *   - normalizeRssItem 为 RSS 类（YouTube）通用规范化。
 */

'use strict';

const crypto = require('crypto');

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
        // 附上响应体，供调用方区分「限流」与「配额耗尽」：
        // 配额耗尽类错误（如 YouTube quotaExceeded / X rate_limit_exhausted）在
        // 响应体 error.code 里给出精确原因，仅靠 HTTP 429/403 无法区分。
        const error = new Error(`HTTP ${response.status}`);
        error.code = cloudflare ? 'cloudflare_challenge' : `http_${response.status}`;
        error.body = body;
        throw error;
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

module.exports = {
  normalizeUrl,
  hash,
  numberOrNull,
  requestText,
  extractTweetArray,
};
