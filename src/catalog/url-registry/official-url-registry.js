/**
 * official-url-registry.js —— 批量生成前置：人工官方 URL 登记表
 *
 * 在批量生成链路（②→③）中的位置：厂商/官方源解析的第一道命中源。
 * 维护者把已知工具的官方域名人工登记到 data/manual/archive/official-url-registry.json，
 * 批量生成时优先查表，命中就不必花 Tavily/DeepSeek 去搜索解析。
 *
 * 数据形状：
 *   厂商表 data/manual/archive/official-url-registry.json：
 *   { schema_version: 1, entries: { "<vendor_key>": { vendor_name, official_urls: [], aliases?: [], model_prefixes?: [] } } }
 *   产品表 data/manual/archive/official-product-url-registry.json：
 *   { schema_version: 1, products: { "<product_key>": { name, vendor_key, official_urls: [], update_sources?: [], aliases?: [], product_prefixes?: [], lifecycle, last_verified_at? } } }
 *   update_sources 是更新链路专用来源；GitHub URL 始终是 github.com 人类网页，REST endpoint 由后续 collector 根据 repository 构造。
 *   product_prefixes 采用词边界匹配，model_prefixes 保留旧 startsWith 兼容。
 *
 * 纯本地读写，不发网络请求、不消费额度。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const productRegistry = require('./product-registry');
const { loadProductUrlRegistry } = productRegistry;
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { canonicalizeUrl } = require('../../shared/tavily-client');

/** 归一化 key：trim + NFKC + 小写（用于登记表匹配与写入键）。 */
function normalizeKey(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function ensureRegistryDir() {
  fs.mkdirSync(path.dirname(CATALOG_GENERATOR_FILES.urlRegistry), { recursive: true });
}

/** 读取登记表；文件缺失返回空表（不抛错）。 */
function loadUrlRegistry() {
  return readJson(CATALOG_GENERATOR_FILES.urlRegistry, { schema_version: 1, entries: {} });
}

function listUrlRegistry() {
  return loadUrlRegistry();
}

function productPrefixMatches(needle, prefix) {
  if (!prefix || !needle.startsWith(prefix)) return false;
  const next = needle.slice(prefix.length);
  return !next || /^[\s\d._/+\-]/.test(next);
}

function normalizedPrefixesOf(entry, field) {
  return Array.isArray(entry?.[field])
    ? entry[field].map(normalizeKey).filter(Boolean)
    : [];
}

function prefixHitOf(needle, entry, field, boundary = false) {
  const prefixes = normalizedPrefixesOf(entry, field);
  return prefixes
    .filter(prefix => boundary ? productPrefixMatches(needle, prefix) : needle.startsWith(prefix))
    .sort((left, right) => right.length - left.length)[0] || null;
}

function officialUrlsOf(entry) {
  return [
    ...(Array.isArray(entry?.official_urls) ? entry.official_urls : []),
    ...(Array.isArray(entry?.official_url) ? entry.official_url : entry?.official_url ? [entry.official_url] : []),
  ].map(canonicalizeUrl).filter(Boolean);
}

function addRegistryCandidate(candidates, { key, entry, officialUrls, kind, match, priority, vendorEntry }) {
  if (!match || !officialUrls.length) return;
  candidates.push({
    key,
    entry: vendorEntry || entry,
    officialUrls,
    kind,
    matchedKey: key,
    priority,
    prefixLength: match === true ? 0 : match.length,
  });
}

/**
 * 查找模型名/工具名的登记条目。
 * 默认同时读取厂商表与产品表；传入 registry 且未传 productRegistry 时保留旧单表测试注入模式。
 * detailKind 为 tool 时优先产品，api_model 时优先厂商模型；缺省时产品优先。
 * @param {string} name 模型名/工具名
 * @param {object} [options] { registry?, productRegistry?, detailKind? }
 * @returns {{ok:true, vendor_name, official_url, official_urls, matched_entry_kind, matched_key} | {ok:false, code, error}}
 */
function lookupOfficialUrl(name, options = {}) {
  const vendorStore = options.registry !== undefined ? options.registry : loadUrlRegistry();
  const productStore = options.productRegistry !== undefined
    ? options.productRegistry
    : options.registry === undefined
      ? loadProductUrlRegistry()
      : null;
  const vendorEntries = vendorStore && vendorStore.entries && typeof vendorStore.entries === 'object' ? vendorStore.entries : {};
  const productEntries = productStore && productStore.products && typeof productStore.products === 'object' ? productStore.products : {};
  const needle = normalizeKey(name);
  if (!needle) return { ok: false, code: 'URL_REGISTRY_MISS', error: `登记表未命中: ${name}` };
  const detailKind = options.detailKind;
  const candidates = [];

  for (const [key, product] of Object.entries(productEntries)) {
    if (!product || typeof product !== 'object') continue;
    const vendorKey = normalizeKey(product.vendor_key);
    const vendorEntry = vendorEntries[vendorKey];
    if (!vendorEntry || typeof vendorEntry !== 'object') continue;
    const officialUrls = officialUrlsOf(product);
    const exactNames = [key, product.name, ...(Array.isArray(product.aliases) ? product.aliases : [])].map(normalizeKey);
    const exactHit = exactNames.includes(needle);
    const productHit = prefixHitOf(needle, product, 'product_prefixes', true);
    if (detailKind !== 'api_model') {
      addRegistryCandidate(candidates, {
        key,
        entry: product,
        vendorEntry,
        officialUrls,
        kind: 'product',
        match: exactHit || productHit,
        priority: exactHit ? 4 : 3,
      });
    } else {
      addRegistryCandidate(candidates, {
        key,
        entry: product,
        vendorEntry,
        officialUrls,
        kind: 'product',
        match: exactHit,
        priority: 2,
      });
    }
  }

  for (const [key, entry] of Object.entries(vendorEntries)) {
    if (!entry || typeof entry !== 'object') continue;
    const officialUrls = officialUrlsOf(entry);
    const exactNames = [key, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeKey);
    const exactHit = exactNames.includes(needle);
    const modelHit = prefixHitOf(needle, entry, 'model_prefixes');
    if (exactHit) {
      addRegistryCandidate(candidates, { key, entry, officialUrls, kind: 'vendor', match: true, priority: detailKind === 'api_model' ? 4 : 2 });
    } else if (modelHit && detailKind !== 'tool') {
      addRegistryCandidate(candidates, { key, entry, officialUrls, kind: 'vendor', match: modelHit, priority: detailKind === 'api_model' ? 3 : 1 });
    }
  }

  if (!candidates.length) return { ok: false, code: 'URL_REGISTRY_MISS', error: `登记表未命中: ${name}` };
  candidates.sort((left, right) => right.priority - left.priority || right.prefixLength - left.prefixLength || left.key.localeCompare(right.key));
  const best = candidates[0];
  const tied = candidates.filter(candidate => candidate.priority === best.priority && candidate.prefixLength === best.prefixLength);
  if (tied.length > 1) {
    return { ok: false, code: 'URL_REGISTRY_AMBIGUOUS', error: `登记表命中多个条目: ${name}`, matches: tied.map(candidate => candidate.key) };
  }
  return {
    ok: true,
    vendor_name: String(best.entry.vendor_name || name).trim() || name,
    official_url: best.officialUrls[0],
    official_urls: best.officialUrls,
    matched_entry_kind: best.kind,
    matched_key: best.matchedKey,
  };
}

const FORBIDDEN_PRODUCT_PREFIXES = new Set(['ai', 'agent', 'coding agent', 'code', 'developer', 'assistant', 'pro', 'studio']);

function productPrefixesOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeKey).filter(prefix => prefix && !FORBIDDEN_PRODUCT_PREFIXES.has(prefix)))];
}

/**
 * 新增/覆盖登记条目（原子写）。
 * @param {object} input { name, vendor_name, official_url?, official_urls?, aliases?, product_prefixes?, model_prefixes? }
 *   name = 厂商或产品键（建议与 vendor_key/tool_key 同规范）；
 *   official_url / official_urls = 官方文档/开发者站（单值或数组，至少一个有效）；
 *   product_prefixes = 产品/工具名词边界前缀；model_prefixes = 模型名前缀。
 * @param {object} [options] { registry } 注入登记表（测试用，不落盘）
 * @returns {{ok:true, entry, count}}
 */
function addUrlRegistryEntry(input, options = {}) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('URL_REGISTRY_NAME_REQUIRED');
  const officialUrls = [
    ...(Array.isArray(input?.official_urls) ? input.official_urls.map(String) : []),
    ...(Array.isArray(input?.official_url) ? input.official_url.map(String) : input?.official_url ? [String(input.official_url)] : []),
  ].map(canonicalizeUrl).filter(Boolean);
  if (!officialUrls.length) throw new Error('URL_REGISTRY_URL_INVALID');
  const store = options.registry || loadUrlRegistry();
  const entries = { ...(store.entries || {}) };
  entries[normalizeKey(name)] = {
    vendor_name: String(input?.vendor_name || name).trim() || name,
    official_urls: officialUrls,
    ...(Array.isArray(input?.aliases) && input.aliases.length ? { aliases: [...input.aliases] } : {}),
    ...(productPrefixesOf(input?.product_prefixes).length ? { product_prefixes: productPrefixesOf(input.product_prefixes) } : {}),
    ...(Array.isArray(input?.model_prefixes) && input.model_prefixes.length ? { model_prefixes: [...input.model_prefixes] } : {}),
  };
  const next = { schema_version: 1, ...store, entries };
  if (options.registry) Object.assign(options.registry, next);
  else {
    ensureRegistryDir();
    writeJsonAtomic(CATALOG_GENERATOR_FILES.urlRegistry, next, 'url-registry-add');
  }
  return { ok: true, entry: entries[normalizeKey(name)], count: Object.keys(entries).length };
}

/**
 * 删除登记条目（原子写）。
 * @param {string} name 要删除的归一化名
 * @param {object} [options] { registry } 注入登记表（测试用，不落盘）
 * @returns {{ok:true, removed, count}}
 */
function removeUrlRegistryEntry(name, options = {}) {
  const key = normalizeKey(name);
  if (!key) throw new Error('URL_REGISTRY_NAME_REQUIRED');
  const store = options.registry || loadUrlRegistry();
  const entries = { ...(store.entries || {}) };
  delete entries[key];
  const next = { schema_version: 1, ...store, entries };
  if (options.registry) Object.assign(options.registry, next);
  else {
    ensureRegistryDir();
    writeJsonAtomic(CATALOG_GENERATOR_FILES.urlRegistry, next, 'url-registry-remove');
  }
  return { ok: true, removed: key, count: Object.keys(entries).length };
}

module.exports = {
  normalizeKey,
  loadUrlRegistry,
  listUrlRegistry,
  lookupOfficialUrl,
  addUrlRegistryEntry,
  removeUrlRegistryEntry,
  ...productRegistry,
};
