'use strict';

/**
 * compare-http.js — 模型对比抓取共享 HTTP 层（Node 内置 fetch，零依赖）
 *
 * 限速 + 合理 UA + 有限重试；失败抛出带上下文错误（调用方 WARN 隔离）。
 * 代理：本地开发经 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 环境变量（Node 24
 * 自动应用），CI 不设代理走直连；脚本不内嵌任何代理凭据。
 */

const DEFAULT_UA = 'KnowView-comparison/0.1 (+https://github.com/wozore/KnowView)';

/**
 * 抓取文本（GET），带有限重试与退避。
 * @param {string} url
 * @param {object} [options] { retries, timeoutMs, ua }
 * @returns {Promise<string>} 响应文本
 */
async function fetchText(url, options = {}) {
  const retries = options.retries == null ? 2 : options.retries;
  const timeoutMs = options.timeoutMs == null ? 45000 : options.timeoutMs;
  const ua = options.ua || DEFAULT_UA;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    let controller;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'application/json, text/csv, */*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (response.status === 429) {
        // 限速：按 attempt 指数退避，最后一次仍 429 才放弃
        lastError = new Error('HTTP 429');
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 6000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.length) throw new Error('空响应');
      return text;
    } catch (error) {
      lastError = error;
      if (error && error.name === 'AbortError') lastError = new Error(`超时（${timeoutMs}ms）`);
    }
  }
  throw new Error(`${url} 请求失败：${lastError ? lastError.message : '未知错误'}`);
}

/** 抓取并解析 JSON。 */
async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} JSON 解析失败：${error.message}`);
  }
}

module.exports = { fetchText, fetchJson, DEFAULT_UA };
