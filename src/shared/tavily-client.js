'use strict';

/**
 * tavily-client.js —— Tavily Search/Extract 原生 fetch transport（keyless + keyed 混用）
 *
 * 认证按 operation 路由（同一 base URL、同一请求体，只换认证头）：
 *   - /search、/extract → keyless（`X-Tavily-Access-Mode: keyless`，免费，不耗账号积分）
 *   - /map、/crawl、/research → keyed（`Authorization: Bearer`，耗账号月度积分）
 *
 * 铁律（官方规则，见 TAVILY_HYBRID_IMPLEMENTATION.md）：
 *   1. 同一请求绝不同时带两个认证头 —— key 优先，会白烧 keyless 额度。
 *   2. keyless 与 keyed 是两套独立配额桶（keyless = 每 IP 小时 / keyed = 每账号月度积分）。
 *   3. 两者成功响应 schema 完全一致，归一化代码无需区分来源。
 *   4. keyless 触发 429（error.code === 'hourly_cap_reached'）后，配置了 key 时自动带
 *      Bearer 重试同一请求（fallback_to_key）；只匹配 code，不匹配动态 message。
 *
 * 政策红线：官方支持的「单账号内混用」，不涉及多开账号绕额度（ToS 反滥用）。
 */

const SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_EXCERPT = 1200;
const TRAILING_URL_PUNCTUATION = /[`'"“”‘’.,;:!?\)\]}>，。；：！？、）】》」』…]+$/u;

// ═══════════════════════════════════════════════════════════════
// keyless / keyed 混用认证
// ═══════════════════════════════════════════════════════════════

const KEYLESS_OPERATIONS = new Set(['search', 'extract']);
const KEYED_OPERATIONS = new Set(['map', 'crawl', 'research']);
const KEYLESS_CAP_CODE = 'hourly_cap_reached';

const DEFAULT_KEYLESS_MIN_INTERVAL_MS = 1000;
const DEFAULT_KEYLESS_COOLDOWN_MS = 90000;

// keyless 配额按 IP 记账，本进程所有调用方共享同一配额桶 → 模块级共享状态。
// 测试经 options.keylessState / keylessNow / keylessSleep 注入全新状态隔离。
const keylessState = {
  lastAtMs: 0, // 上次 keyless 发送时刻（本地最小间隔用）
  cooldownUntilMs: 0, // keyless 429 cap 后的冷却截止
  stats: {
    keylessCalls: 0,
    keyedCalls: 0,
    keylessCapHits: 0,
    keylessFallbacks: 0,
    cooldownTriggers: 0,
  },
};
// keyless 请求互斥串行（简单 promise 链锁）；锁只包 keyless 发送，keyed 回退在锁外。
let keylessChain = Promise.resolve();

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

function opPrefix(operation) {
  return `TAVILY_${String(operation || '').toUpperCase()}`;
}

function classifyHttpError(status, operation) {
  const prefix = opPrefix(operation);
  if (status === 401 || status === 403) return `${prefix}_AUTH_REQUIRED`;
  if (status === 408 || status === 504) return `${prefix}_TIMEOUT`;
  if (status === 429) return `${prefix}_RATE_LIMITED`;
  return `${prefix}_FAILED`;
}

/** 认证模式解析：options.accessMode → 环境变量 TAVILY_ACCESS_MODE → 按 operation 默认归属。 */
function resolveAccessMode(operation, options = {}) {
  if (options.accessMode === 'keyless' || options.accessMode === 'keyed') return options.accessMode;
  const envMode = String(process.env.TAVILY_ACCESS_MODE || '').toLowerCase();
  if (envMode === 'keyless' || envMode === 'keyed') return envMode;
  return KEYLESS_OPERATIONS.has(operation) ? 'keyless' : 'keyed';
}

/** 认证头构建（铁律 1：同一请求绝不同时带两个认证头）。 */
function buildHeaders(mode, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (mode === 'keyless') headers['X-Tavily-Access-Mode'] = 'keyless';
  else headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 是否为 keyless 每小时额度耗尽（429 + error.code === hourly_cap_reached）。 */
function isKeylessCapResult(result) {
  return Boolean(result && result.status === 429 && result.capCode === KEYLESS_CAP_CODE);
}

async function requestKeyed(endpoint, operation, payload, options) {
  const attempt = await sendWithMode(endpoint, operation, payload, 'keyed', options);
  if (attempt.ok) (options.keylessState || keylessState).stats.keyedCalls += 1;
  return attempt;
}

async function requestKeyless(endpoint, operation, payload, options) {
  const apiKey = apiKeyOf(options.apiKey);
  const state = options.keylessState || keylessState;
  const nowFn = options.keylessNow || (() => Date.now());
  const sleep = options.keylessSleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const fallback = options.fallbackToKey ?? true;
  const minIntervalMs = options.keylessMinIntervalMs ?? DEFAULT_KEYLESS_MIN_INTERVAL_MS;
  const cooldownMs = options.keylessCooldownMs ?? DEFAULT_KEYLESS_COOLDOWN_MS;

  // 冷却窗口内：直接短路 —— 立即 keyed 回退或立即返回 RATE_LIMITED，绝不 sleep 阻塞调用方。
  const now = nowFn();
  if (now < state.cooldownUntilMs) {
    state.stats.cooldownTriggers += 1;
    return maybeFallbackKeyed(endpoint, operation, payload, options, apiKey, fallback, now, state);
  }

  // 本地最小间隔节流：避免过早耗尽每 IP 小时 keyless 额度。
  const waitMs = state.lastAtMs + minIntervalMs - now;
  if (waitMs > 0) await sleep(waitMs);

  let release;
  try {
    await keylessChain;
    keylessChain = new Promise(resolve => { release = resolve; });
    const attempt = await sendWithMode(endpoint, operation, payload, 'keyless', options);
    state.lastAtMs = nowFn();
    state.stats.keylessCalls += 1;
    if (isKeylessCapResult(attempt)) {
      state.cooldownUntilMs = nowFn() + cooldownMs;
      state.stats.keylessCapHits += 1;
      return maybeFallbackKeyed(endpoint, operation, payload, options, apiKey, fallback, nowFn(), state);
    }
    return attempt;
  } finally {
    if (release) release();
  }
}

/** 冷却 / cap 命中后的 keyed 回退决策（同步返回，被调用处 await）。 */
function maybeFallbackKeyed(endpoint, operation, payload, options, apiKey, fallback, now, state) {
  if (fallback && apiKey) {
    state.stats.keylessFallbacks += 1;
    return requestKeyed(endpoint, operation, payload, options);
  }
  return errorResult(
    `${opPrefix(operation)}_RATE_LIMITED`,
    'Tavily keyless hourly cap 已耗尽（未配置 TAVILY_API_KEY 可回退）',
    { status: 429, keyless_cap: true, keyless: true, retry_after_ms: Math.max(0, state.cooldownUntilMs - now) },
  );
}

/** 共享原始发送：fetch + 超时 + HTTP/JSON 错误归一化。keyed 缺 key fail-closed；keyless 缺 key 不报错。 */
async function sendWithMode(endpoint, operation, payload, mode, options = {}) {
  const apiKey = apiKeyOf(options.apiKey);
  if (mode === 'keyed' && !apiKey) {
    return errorResult(`${opPrefix(operation)}_AUTH_REQUIRED`, `缺少 TAVILY_API_KEY（${operation} 为 keyed 端点）`);
  }
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return errorResult('TAVILY_NETWORK_ERROR', '当前运行环境无 fetch');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: buildHeaders(mode, apiKey),
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT';
    return errorResult(timeout ? `${opPrefix(operation)}_TIMEOUT` : 'TAVILY_NETWORK_ERROR', String(error?.message || error));
  }
  if (!response?.ok) {
    const status = response?.status;
    // keyless cap 检测：仅 keyless 分支、429、error.code === hourly_cap_reached（只匹配 code，不匹配动态 message）。
    // 注意：fetch Response 的 body 只能消费一次 —— 429 分支必须优先读 json()，绝不能用 text() 先行消费，
    // 否则 json() 抛错、capCode 落空，429 被误判为普通限流而不回退。
    if (mode === 'keyless' && status === 429) {
      let capCode = '';
      try { capCode = String((await response.json())?.error?.code || ''); } catch {}
      if (capCode === KEYLESS_CAP_CODE) {
        return { ok: false, code: `${opPrefix(operation)}_RATE_LIMITED`, status: 429, capCode, keyless_cap: true, error: `Tavily ${operation} keyless hourly cap 已耗尽` };
      }
    }
    let detail = '';
    try { detail = String(await response.text()).slice(0, 500); } catch {}
    return errorResult(classifyHttpError(status, operation), `Tavily ${operation} HTTP ${status}${detail ? `: ${detail}` : ''}`, { status });
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object') return errorResult(`${opPrefix(operation)}_FAILED`, 'Tavily 响应不是对象');
    return { ok: true, data };
  } catch (error) {
    return errorResult(`${opPrefix(operation)}_FAILED`, `Tavily 响应不是 JSON: ${error.message}`);
  }
}

async function requestTavily(endpoint, operation, payload, options = {}) {
  const mode = resolveAccessMode(operation, options);
  return mode === 'keyed'
    ? requestKeyed(endpoint, operation, payload, options)
    : requestKeyless(endpoint, operation, payload, options);
}

// ═══════════════════════════════════════════════════════════════
// 对外 API（签名不变；新增可选键 accessMode/fallbackToKey/keyless*）
// ═══════════════════════════════════════════════════════════════

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
  resolveAccessMode,
  isKeylessCapResult,
  searchTavily,
  extractTavily,
  probeTavily,
};
