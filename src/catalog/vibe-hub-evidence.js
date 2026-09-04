'use strict';

/**
 * vibe-hub-evidence.js —— vibe-hub.org 概念页提取与本地缓存（概念批量生成补充证据）
 *
 * vibe-hub.org（VibeHub·Vibe Coding 术语图鉴）是用户提供的概念仓库：Next.js SSR，
 * 概念页位于 `https://vibe-hub.org/<slug>`，正文（定义/别名/相关概念/权威出处）全部
 * 服务端渲染在 HTML 中。robots.txt 允许爬取（仅禁 `/api/`）；概念页 URL 由 term→slug 直接构造。
 *
 * 本模块只做纯 HTTP（零 API 成本，不计 ledger）：
 *   - term → 英文 kebab slug（含中文/非 ASCII 返回 null → 跳过）
 *   - 先查本地缓存，命中且未过 TTL 直接返回（零请求）；未命中/过期才 GET
 *   - 请求串行 + ≥500ms 节流（尊重站点负载），User-Agent + AbortSignal.timeout
 *   - 404/网络/超时 → 返回 null（静默跳过，不阻塞概念合成；approved 摘要才是主证据）
 *   - 缓存 `data/manual/archive/vibe-hub-cache.json`，TTL 默认 3 天；缓存只省重复抓取、
 *     永不挡新抓取，也永不成为证据缺失的原因
 *
 * 提取以页面 JSON-LD `<script id="vibehub-page-jsonld">` 的 DefinedTerm 为主
 * （name/alternateName/description），正文 `.prerequisite-links`（先知道=相关概念）、
 * `.alias-row`（也常被叫作=别名）、`.reference-title/.reference-source`（来源）为补充。
 *
 * 注入点（测试用，仿 tavily-client.js）：
 *   options.readCache / options.writeCache    缓存读写注入（缺省文件实现）
 *   options.fetchImpl                          网络注入（替换真实 fetch）
 *   options.now / options.sleep               时钟与休眠注入
 *   options.throttleState                     串行节流状态注入（隔离跨测试污染）
 *   options.cacheFile / options.timeoutMs / options.minIntervalMs / options.ttlMs / options.userAgent
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { CONCEPT_FILES } = require('../shared/paths');

const VIBE_HUB_ORIGIN = 'https://vibe-hub.org';
const DEFAULT_MIN_INTERVAL_MS = 500; // 请求最小间隔（用户拍板：串行 + ≥500ms 节流）
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_VIBE_HUB_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 天
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; catalog-concepts/1.0; concept-glossary-enrichment)';
const MAX_VIBE_HUB_TEXT = 12000;

// 串行节流链 + 模块级节流状态（本进程所有调用方共享；测试经 options.throttleState 注入隔离）。
let vibeHubChain = Promise.resolve();
const throttleState = { lastAtMs: 0 };

function emptyCache() {
  return { schema_version: 1, kind: 'vibe_hub_cache', updated_at: null, entries: {} };
}

// ═══════════════════════════════════════════════════════════════
// 纯函数：提取
// ═══════════════════════════════════════════════════════════════

/** 去掉一段 HTML 片段的标签并合并空白。 */
function stripTags(fragment) {
  return String(fragment || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 基础实体解码（页面可见文本够用，不必引入完整解码表）。 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .trim();
}

/** 页面主体可见文本（剥脚本/样式/注释/标签，用于补充证据与回退）。 */
function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<template[\s\S]*?<\/template>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * 从 vibe-hub 概念页 HTML 提取结构化字段（纯函数，零副作用）。
 * @param {string} html 概念页原始 HTML
 * @returns {{ title:string, aliases:string[], definition:string, related_terms:string[], sources:Array<{name,url?}>, text:string }|null}
 *   提取不出任何有用内容时返回 null。
 */
function extractVibeHubText(html) {
  if (typeof html !== 'string' || !html.length) return null;
  const result = { title: '', aliases: [], definition: '', related_terms: [], sources: [], text: htmlToText(html).slice(0, MAX_VIBE_HUB_TEXT) };

  // 1. JSON-LD DefinedTerm —— 最可靠（name/alternateName/description）
  const jsonLd = html.match(/<script[^>]*id=["']vibehub-page-jsonld["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLd) {
    try {
      const data = JSON.parse(jsonLd[1]);
      const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];
      const term = graph.find(entry => entry && entry['@type'] === 'DefinedTerm');
      if (term) {
        if (term.name) result.title = String(term.name).trim();
        if (Array.isArray(term.alternateName)) result.aliases = term.alternateName.map(String).map(decodeEntities).map(s => s.trim()).filter(Boolean);
        if (term.description) result.definition = decodeEntities(String(term.description).trim().replace(/…+$/, '')).trim();
      }
    } catch { /* JSON-LD 解析失败走正文回退 */ }
  }

  // 2. title 回退：<title>（剥站点后缀）
  if (!result.title) {
    const title = html.match(/<title>([^<]*)<\/title>/i);
    if (title) result.title = String(title[1]).split(/｜|\|/)[0].trim();
  }

  // 3. 别名回退/补充：正文 `.alias-row`（也常被叫作 …）
  for (const block of html.matchAll(/<div class="alias-row"[^>]*>[\s\S]*?<\/div>/gi)) {
    for (const em of block[0].matchAll(/<em>([\s\S]*?)<\/em>/g)) {
      const value = decodeEntities(stripTags(em[1]));
      if (value) result.aliases.push(value);
    }
  }
  result.aliases = [...new Set(result.aliases)];

  // 4. 相关概念：正文 `.prerequisite-links`（先知道 …），取锚点可见文本（如「输入框 Input」）
  const prereq = html.match(/<div class="prerequisite-links"[^>]*>([\s\S]*?)<\/div>/i);
  if (prereq) {
    result.related_terms = [...prereq[1].matchAll(/<a[^>]*>[\s\S]*?<\/a>/gi)]
      .map(match => decodeEntities(stripTags(match[0])))
      .filter(Boolean);
  }

  // 5. 来源：正文 reference 块（标题 + 出处 + 外链；class 在内层 span 上）
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const inner = match[1];
    const title = inner.match(/<span class="reference-title">([\s\S]*?)<\/span>/i);
    const source = inner.match(/<span class="reference-source">([\s\S]*?)<\/span>/i);
    if (!title && !source) continue;
    const href = match[0].match(/href=["']([^"']*)["']/i);
    const name = decodeEntities(stripTags(
      title ? title[1] : (source ? source[1] : ''),
    )).replace(/\s*↗\s*$/, '');
    if (!name) continue;
    result.sources.push({
      name,
      ...(href && href[1] ? { url: href[1] } : {}),
    });
  }

  if (!result.title && !result.definition && !result.text) return null;
  return result;
}

// ═══════════════════════════════════════════════════════════════
// term → slug
// ═══════════════════════════════════════════════════════════════

/**
 * term → vibe-hub 英文 kebab slug。
 * 仅接受纯 ASCII（拉丁字母/数字/空格/连字符）；含中文等非 ASCII 返回 null（跳过该概念）。
 * 注意：slug 与直觉不一定一致（/ai-agent 而非 /agent），命中由页面决定，查不到返回 null 回退摘要。
 */
function vibeHubSlugOf(term) {
  const value = String(term || '').trim();
  if (!value) return null;
  if (/[^\x00-\x7F]/.test(value)) return null; // 含非 ASCII（中文等）→ 无法映射，跳过
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

// ═══════════════════════════════════════════════════════════════
// 本地缓存读写
// ═══════════════════════════════════════════════════════════════

/** 读取 vibe-hub 缓存（文件缺失/损坏 → 空缓存，不阻塞）。 */
function loadVibeHubCache(options = {}) {
  const file = options.cacheFile || CONCEPT_FILES.vibeHubCache;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyCache();
    // 缓存损坏：视为空重新抓取，不阻塞合成
    console.error(`⚠️ vibe-hub 缓存损坏（${file}），已重置：${error.message}`);
    return emptyCache();
  }
  if (data && data.kind === 'vibe_hub_cache' && data.entries) return data;
  return emptyCache();
}

/** 原子写 vibe-hub 缓存。 */
function saveVibeHubCache(cache, options = {}) {
  const file = options.cacheFile || CONCEPT_FILES.vibeHubCache;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, cache, 'vibe-hub-cache');
  return file;
}

// ═══════════════════════════════════════════════════════════════
// 网络获取（串行 + 节流）
// ═══════════════════════════════════════════════════════════════

/** 串行节流：同一时刻至多一个 vibe-hub 请求，且间隔 ≥ minIntervalMs。 */
async function throttle(options = {}) {
  const state = options.throttleState || throttleState;
  const now = options.now || (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let release;
  await vibeHubChain;
  vibeHubChain = new Promise(resolve => { release = resolve; });
  try {
    const waitMs = state.lastAtMs + minIntervalMs - now();
    if (waitMs > 0) await sleep(waitMs);
    state.lastAtMs = now();
  } finally {
    release();
  }
}

/**
 * 低层抓取：节流 → GET `https://vibe-hub.org/<slug>` → 提取。
 * @returns {{ ok: true, extracted: object }|{ ok: false, reason: string }}
 */
async function fetchPage(slug, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: 'VIBE_HUB_NO_FETCH' };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  await throttle(options);
  let response;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    response = await fetchImpl(`${VIBE_HUB_ORIGIN}/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': userAgent },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'VIBE_HUB_TIMEOUT' : 'VIBE_HUB_NETWORK_ERROR' };
  }
  if (!response?.ok) return { ok: false, reason: `VIBE_HUB_HTTP_${response?.status || 0}` };
  let html;
  try { html = await response.text(); } catch { return { ok: false, reason: 'VIBE_HUB_READ_ERROR' }; }
  const extracted = extractVibeHubText(html);
  if (!extracted) return { ok: false, reason: 'VIBE_HUB_EXTRACT_EMPTY' };
  return { ok: true, extracted };
}

// ═══════════════════════════════════════════════════════════════
// 对外：按 slug 取概念定义（带缓存）
// ═══════════════════════════════════════════════════════════════

function extractedFieldsOf(entry) {
  return {
    slug: entry.slug,
    title: entry.title || '',
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    definition: entry.definition || '',
    related_terms: Array.isArray(entry.related_terms) ? entry.related_terms : [],
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    text: entry.text || '',
  };
}

function isFresh(entry, nowMs, ttlMs) {
  const fetchedAt = entry?.fetched_at ? Number(new Date(entry.fetched_at).getTime()) : 0;
  return Boolean(fetchedAt && nowMs - fetchedAt <= ttlMs);
}

/**
 * 取 `https://vibe-hub.org/<slug>` 概念定义（缓存优先）。
 * 命中且未过 TTL → 直接返回（零请求）；未命中/过期 → GET + 提取 + 写缓存。
 * 404/网络/超时 → 返回 null（静默跳过，不阻塞概念合成）。
 * @param {string} slug 英文 kebab slug（vibeHubSlugOf 产出）
 * @returns {Promise<{ok:true, from_cache:boolean, slug, title, aliases, definition, related_terms, sources, text}|null>}
 */
async function fetchVibeHubDefinition(slug, options = {}) {
  if (!slug) return null;
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_VIBE_HUB_TTL_MS;
  const readCache = options.readCache || defaultReadCache;
  const writeCache = options.writeCache || defaultWriteCache;

  const cached = readCache(slug);
  if (cached && isFresh(cached, now(), ttlMs)) {
    return { ok: true, from_cache: true, ...extractedFieldsOf(cached) };
  }
  const fetched = await fetchPage(slug, options);
  if (!fetched.ok) return null;
  const entry = { fetched_at: new Date(now()).toISOString(), ttl_ms: ttlMs, slug, ...fetched.extracted };
  writeCache(slug, entry);
  return { ok: true, from_cache: false, ...extractedFieldsOf(entry) };
}

// ═══════════════════════════════════════════════════════════════
// 对外：定时刷新过期条目（CI 脚本用）
// ═══════════════════════════════════════════════════════════════

/**
 * 遍历缓存，刷新 `fetched_at` 距今 > TTL（默认 3 天）的条目。
 * 就地更新传入的 cache 对象（调用方负责 saveVibeHubCache）；全新鲜则零网络。
 * @param {object} cache loadVibeHubCache 产出的缓存对象
 * @param {object} [options] { ttlMs, now, fetchImpl, ... } 透传 fetchPage
 * @returns {Promise<{ refreshed: string[], failed: Array<{slug, reason}>, up_to_date: number }>}
 */
async function refreshStaleVibeHubCache(cache, options = {}) {
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_VIBE_HUB_TTL_MS;
  const entries = cache.entries || {};
  const slugs = Object.keys(entries);
  const refreshed = [];
  const failed = [];
  let upToDate = 0;
  for (const slug of slugs) {
    const entry = entries[slug];
    if (isFresh(entry, now(), ttlMs)) { upToDate += 1; continue; }
    const fetched = await fetchPage(slug, options);
    if (fetched.ok) {
      entries[slug] = { fetched_at: new Date(now()).toISOString(), ttl_ms: ttlMs, slug, ...fetched.extracted };
      refreshed.push(slug);
    } else {
      failed.push({ slug, reason: fetched.reason });
    }
  }
  if (refreshed.length || failed.length) cache.updated_at = new Date(now()).toISOString();
  return { refreshed, failed, up_to_date: upToDate };
}

// 缺省缓存读写（文件实现；每次读/写独立加载，规模小可接受）
function defaultReadCache(slug) {
  const cache = loadVibeHubCache();
  return (cache.entries || {})[slug] || null;
}

function defaultWriteCache(slug, entry) {
  const cache = loadVibeHubCache();
  cache.entries = cache.entries || {};
  cache.entries[slug] = entry;
  cache.updated_at = new Date().toISOString();
  saveVibeHubCache(cache);
}

module.exports = {
  VIBE_HUB_ORIGIN,
  DEFAULT_VIBE_HUB_TTL_MS,
  vibeHubSlugOf,
  extractVibeHubText,
  htmlToText,
  loadVibeHubCache,
  saveVibeHubCache,
  fetchVibeHubDefinition,
  fetchPage,
  refreshStaleVibeHubCache,
};
