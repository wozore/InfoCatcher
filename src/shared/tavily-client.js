'use strict';

const SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_EXCERPT = 1200;
const TRAILING_URL_PUNCTUATION = /[`'"“”‘’.,;:!?\)\]}>，。；：！？、）】》」』…]+$/u;

function apiKeyOf(explicitApiKey) {
  return explicitApiKey ?? process.env.TAVILY_API_KEY;
}

function canonicalizeUrl(value) {
  if (typeof value !== 'string') return '';
  let candidate = value.trim();
  candidate = candidate.replace(/^<+|>+$/g, '');
  while (TRAILING_URL_PUNCTUATION.test(candidate)) candidate = candidate.replace(TRAILING_URL_PUNCTUATION, '');
  if (!/^https?:\/\//i.test(candidate)) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function errorResult(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function classifyHttpError(status, operation) {
  const prefix = operation === 'search' ? 'TAVILY_SEARCH' : 'TAVILY_EXTRACT';
  if (status === 401 || status === 403) return `${prefix}_AUTH_REQUIRED`;
  if (status === 408 || status === 504) return `${prefix}_TIMEOUT`;
  if (status === 429) return `${prefix}_RATE_LIMITED`;
  return `${prefix}_FAILED`;
}

async function requestTavily(endpoint, operation, payload, options = {}) {
  const apiKey = apiKeyOf(options.apiKey);
  if (!apiKey) return errorResult(`TAVILY_${operation.toUpperCase()}_AUTH_REQUIRED`, '缺少 TAVILY_API_KEY');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return errorResult('TAVILY_NETWORK_ERROR', '当前运行环境无 fetch');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT';
    return errorResult(timeout ? `TAVILY_${operation.toUpperCase()}_TIMEOUT` : 'TAVILY_NETWORK_ERROR', String(error?.message || error));
  }
  if (!response?.ok) {
    let detail = '';
    try { detail = String(await response.text()).slice(0, 500); } catch {}
    return errorResult(classifyHttpError(response?.status, operation), `Tavily ${operation} HTTP ${response?.status}${detail ? `: ${detail}` : ''}`, { status: response?.status });
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object') return errorResult(`TAVILY_${operation.toUpperCase()}_FAILED`, 'Tavily 响应不是对象');
    return { ok: true, data };
  } catch (error) {
    return errorResult(`TAVILY_${operation.toUpperCase()}_FAILED`, `Tavily 响应不是 JSON: ${error.message}`);
  }
}

function searchPayload(options = {}) {
  return {
    query: options.query,
    search_depth: options.searchDepth || 'advanced',
    max_results: options.maxResults ?? 5,
    include_answer: false,
    include_raw_content: options.includeRawContent ?? false,
    include_images: false,
    ...(Array.isArray(options.includeDomains) && options.includeDomains.length ? { include_domains: options.includeDomains } : {}),
    ...(Array.isArray(options.excludeDomains) && options.excludeDomains.length ? { exclude_domains: options.excludeDomains } : {}),
    ...(options.topic ? { topic: options.topic } : {}),
  };
}

async function searchTavily(options = {}) {
  if (!options.query || typeof options.query !== 'string') return errorResult('TAVILY_SEARCH_QUERY_REQUIRED', '缺少 Tavily 搜索 query');
  const result = await requestTavily(options.endpoint || SEARCH_ENDPOINT, 'search', searchPayload(options), options);
  if (!result.ok) return result;
  const sources = [];
  for (const item of Array.isArray(result.data.results) ? result.data.results : []) {
    const url = canonicalizeUrl(item?.url);
    if (!url || sources.some(source => source.url === url)) continue;
    sources.push({
      url,
      title: String(item.title || url).trim().slice(0, 240),
      excerpt: String(item.content || item.raw_content || '').trim().slice(0, MAX_EXCERPT),
      ...(Number.isFinite(item.score) ? { score: item.score } : {}),
    });
  }
  return { ok: true, sources, usage: result.data.usage || null };
}

function extractPayload(options = {}) {
  return {
    urls: (options.urls || []).map(canonicalizeUrl).filter(Boolean),
    ...(options.query ? { query: options.query } : {}),
    extract_depth: options.extractDepth || 'advanced',
    format: options.format || 'markdown',
    ...(Number.isInteger(options.chunksPerSource) ? { chunks_per_source: options.chunksPerSource } : {}),
    include_images: false,
  };
}

async function extractTavily(options = {}) {
  const urls = [...new Set((options.urls || []).map(canonicalizeUrl).filter(Boolean))];
  if (!urls.length) return errorResult('TAVILY_EXTRACT_URLS_REQUIRED', '缺少 Tavily Extract URLs');
  const result = await requestTavily(options.endpoint || EXTRACT_ENDPOINT, 'extract', extractPayload({ ...options, urls }), options);
  if (!result.ok) return result;
  const contents = [];
  for (const item of Array.isArray(result.data.results) ? result.data.results : []) {
    const url = canonicalizeUrl(item?.url);
    const content = String(item?.raw_content || item?.content || '').trim();
    if (!url || !content || contents.some(source => source.url === url)) continue;
    contents.push({ url, content });
  }
  const failed = (Array.isArray(result.data.failed_results) ? result.data.failed_results : []).map(item => ({
    url: canonicalizeUrl(item?.url),
    error: String(item?.error || 'Tavily Extract failed'),
  })).filter(item => item.url);
  return { ok: true, contents, failed, usage: result.data.usage || null };
}

async function probeTavily(options = {}) {
  const result = await searchTavily({
    ...options,
    query: options.query || 'Tavily official API documentation',
    includeDomains: options.includeDomains || ['docs.tavily.com'],
    maxResults: 1,
    searchDepth: 'basic',
  });
  if (!result.ok) return result;
  return { ok: true, source_count: result.sources.length, usage: result.usage };
}

module.exports = {
  SEARCH_ENDPOINT,
  EXTRACT_ENDPOINT,
  canonicalizeUrl,
  searchTavily,
  extractTavily,
  probeTavily,
};
