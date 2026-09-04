'use strict';

const DEFAULT_TIMEOUT_MS = 15000;

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\d[\d,]*\s+contributions?\s+between\s+(?:[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+)?20\d{2}\s+and\s+(?:[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+)?20\d{2}/gi, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameSourceOrigin(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const normalizeHost = host => host.toLowerCase().replace(/^www\./, '');
    return leftUrl.protocol === rightUrl.protocol && normalizeHost(leftUrl.hostname) === normalizeHost(rightUrl.hostname) && leftUrl.port === rightUrl.port;
  } catch {
    return false;
  }
}

async function fetchHtmlText(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, code: 'UPDATE_COLLECTOR_FETCH_UNAVAILABLE', error: '当前运行环境无 fetch' };
  try {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': options.userAgent || 'KnowView-tool-update-collector/0.1', Accept: 'text/html, application/xhtml+xml, */*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response?.ok) return { ok: false, code: `UPDATE_HTML_HTTP_${Number(response?.status || 0)}`, error: 'HTML 抓取失败', status: Number(response?.status || 0) };
    const text = htmlToText(String(await response.text() || ''));
    if (!text.trim()) return { ok: false, code: 'UPDATE_HTML_EMPTY', error: 'HTML 正文为空' };
    return { ok: true, text, final_url: String(response.url || url) };
  } catch (error) {
    const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
    return { ok: false, code: timeout ? 'UPDATE_HTML_TIMEOUT' : 'UPDATE_HTML_NETWORK_ERROR', error: String(error?.message || error) };
  }
}

module.exports = { htmlToText, sameSourceOrigin, fetchHtmlText };
