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
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { canonicalizeUrl } = require('../shared/tavily-client');
const { REVIEW_MODES } = require('./tool-update-review-contract');
const { DATE_PATTERN } = require('./tool-update-evidence');

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

/** 读取产品登记表；文件缺失返回空表（不抛错）。 */
function loadProductUrlRegistry() {
  return readJson(CATALOG_GENERATOR_FILES.productUrlRegistry, { schema_version: 1, kind: 'official_product_url_registry', products: {} });
}

/** 列出产品登记表全部条目。 */
function listProductUrlRegistry() {
  return loadProductUrlRegistry();
}

/** 读取指定产品的专用更新源；只读投影，不参与 lookupOfficialUrl。 */
function updateSourcesForProduct(productKey, options = {}) {
  const registry = options.registry || options.productRegistry || loadProductUrlRegistry();
  const product = registry && registry.products && typeof registry.products === 'object'
    ? registry.products[normalizeKey(productKey)]
    : null;
  return Array.isArray(product?.update_sources)
    ? product.update_sources.map(source => ({ ...source }))
    : [];
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
    const productHit = prefixHitOf(needle, entry, 'product_prefixes', true);
    const modelHit = prefixHitOf(needle, entry, 'model_prefixes');
    const allowLegacyProduct = options.registry !== undefined && options.productRegistry === undefined;
    if (exactHit) {
      addRegistryCandidate(candidates, { key, entry, officialUrls, kind: 'vendor', match: true, priority: detailKind === 'api_model' ? 4 : 2 });
    } else if (allowLegacyProduct && productHit && detailKind !== 'api_model') {
      addRegistryCandidate(candidates, { key, entry, officialUrls, kind: 'legacy_product', match: productHit, priority: 3 });
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
const PRODUCT_LIFECYCLES = new Set(['active', 'deprecated', 'discontinued', 'unknown']);

const UPDATE_SOURCE_KINDS = Object.freeze(['github_releases', 'github_file', 'changelog', 'release_notes']);
const UPDATE_SOURCE_COLLECTORS = Object.freeze(['github_web_release', 'github_web_file', 'tavily_extract']);
const UPDATE_SOURCE_SURFACES = Object.freeze(['product', 'cli', 'desktop', 'ide_extension']);
const UPDATE_SOURCE_COLLECTOR_BY_KIND = Object.freeze({
  github_releases: 'github_web_release',
  github_file: 'github_web_file',
  changelog: 'tavily_extract',
  release_notes: 'tavily_extract',
});
const UPDATE_SOURCE_FIELDS = Object.freeze(['kind', 'url', 'collector', 'product_surface', 'repository', 'tag_prefix', 'include_prerelease', 'date_mode', 'review_mode']);
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const TAG_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,99}$/;

function isGithubHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com');
}

function githubPathMatchesRepository(url, repository, kind) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (typeof repository !== 'string' || !repository.includes('/')) return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const repoParts = repository.split('/');
  if (parts.length < 3 || parts[0].toLowerCase() !== repoParts[0].toLowerCase() || parts[1].toLowerCase() !== repoParts[1].toLowerCase()) return false;
  if (kind === 'github_releases') return parts[2].toLowerCase() === 'releases';
  return parts[2].toLowerCase() === 'blob' && parts.length >= 5;
}

function isPricingPath(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return false; }
  return pathname.split('/').filter(Boolean).some(segment => /^pricing(?:[-_].*)?$/i.test(segment));
}

function updateSourceError(productKey, index, code) {
  return `${productKey}:UPDATE_SOURCE[${index}]:${code}`;
}

function validateUpdateSource(source, productKey, index) {
  const errors = [];
  const prefix = (code) => updateSourceError(productKey, index, code);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [prefix('OBJECT_INVALID')];
  for (const field of Object.keys(source)) {
    if (!UPDATE_SOURCE_FIELDS.includes(field)) errors.push(prefix('UNKNOWN_FIELD'));
  }

  const kind = source.kind;
  const collector = source.collector;
  const surface = source.product_surface;
  if (!UPDATE_SOURCE_KINDS.includes(kind)) errors.push(prefix('KIND_INVALID'));
  if (!UPDATE_SOURCE_COLLECTORS.includes(collector)) errors.push(prefix('COLLECTOR_INVALID'));
  if (!UPDATE_SOURCE_SURFACES.includes(surface)) errors.push(prefix('PRODUCT_SURFACE_INVALID'));
  if (!REVIEW_MODES.includes(source.review_mode)) errors.push(prefix('REVIEW_MODE_INVALID'));
  if (source.date_mode !== undefined && source.date_mode !== 'latest') errors.push(prefix('DATE_MODE_INVALID'));
  if (UPDATE_SOURCE_COLLECTOR_BY_KIND[kind] && collector !== UPDATE_SOURCE_COLLECTOR_BY_KIND[kind]) {
    errors.push(prefix('COLLECTOR_KIND_MISMATCH'));
  }

  const url = canonicalizeUrl(source.url);
  if (!url) errors.push(prefix('URL_INVALID'));
  else if (!/^https:\/\//i.test(url)) errors.push(prefix('HTTPS_REQUIRED'));
  if (url && isPricingPath(url)) errors.push(prefix('PRICING_URL_FORBIDDEN'));

  const isGithubKind = kind === 'github_releases' || kind === 'github_file';
  if (isGithubKind) {
    if (typeof source.repository !== 'string' || !GITHUB_REPOSITORY_PATTERN.test(source.repository.trim())) {
      errors.push(prefix('REPOSITORY_INVALID'));
    }
    if (url && (!githubPathMatchesRepository(url, source.repository?.trim() || '', kind))) {
      errors.push(prefix('GITHUB_URL_REPOSITORY_MISMATCH'));
    }
    if (kind === 'github_releases') {
      if (source.include_prerelease !== false) errors.push(prefix('INCLUDE_PRERELEASE_MUST_BE_FALSE'));
      if (source.tag_prefix !== undefined && (typeof source.tag_prefix !== 'string' || !TAG_PREFIX_PATTERN.test(source.tag_prefix.trim()))) {
        errors.push(prefix('TAG_PREFIX_INVALID'));
      }
    } else {
      if (source.tag_prefix !== undefined) errors.push(prefix('TAG_PREFIX_FORBIDDEN'));
      if (source.include_prerelease !== undefined && source.include_prerelease !== false) errors.push(prefix('INCLUDE_PRERELEASE_FORBIDDEN'));
    }
  } else {
    if (source.repository !== undefined) errors.push(prefix('REPOSITORY_FORBIDDEN'));
    if (source.tag_prefix !== undefined) errors.push(prefix('TAG_PREFIX_FORBIDDEN'));
    if (source.include_prerelease !== undefined) errors.push(prefix('INCLUDE_PRERELEASE_FORBIDDEN'));
    if (url && isGithubHost(new URL(url).hostname)) errors.push(prefix('GITHUB_KIND_REQUIRED'));
  }

  if (url && isGithubKind && new URL(url).hostname.toLowerCase() !== 'github.com') {
    errors.push(prefix('GITHUB_HUMAN_URL_REQUIRED'));
  }
  return errors;
}

function validateUpdateSources(productKey, sources) {
  if (!Array.isArray(sources)) return [`${productKey}:UPDATE_SOURCES_INVALID`];
  const errors = [];
  const seenUrls = new Set();
  sources.forEach((source, index) => {
    errors.push(...validateUpdateSource(source, productKey, index));
    const url = canonicalizeUrl(source?.url);
    if (url) {
      if (seenUrls.has(url)) errors.push(updateSourceError(productKey, index, 'DUPLICATE_URL'));
      seenUrls.add(url);
    }
  });
  return errors;
}

function normalizeUpdateSourcesForWrite(productKey, sources) {
  if (!Array.isArray(sources)) throw new Error('UPDATE_SOURCES_INVALID');
  const normalized = sources.map(source => ({
    ...source,
    ...(source && source.url !== undefined ? { url: canonicalizeUrl(source.url) } : {}),
    ...(source && source.repository !== undefined ? { repository: String(source.repository).trim() } : {}),
    ...(source && source.tag_prefix !== undefined ? { tag_prefix: String(source.tag_prefix).trim() } : {}),
  }));
  const errors = validateUpdateSources(productKey, normalized);
  if (errors.length) throw new Error(`UPDATE_SOURCES_INVALID: ${errors.join(',')}`);
  return normalized;
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(String(value))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function productPrefixesOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeKey).filter(prefix => prefix && !FORBIDDEN_PRODUCT_PREFIXES.has(prefix)))];
}

function validateProductUrlRegistry(registry, options = {}) {
  const errors = [];
  const vendors = options.vendorRegistry || loadUrlRegistry();
  if (!registry || typeof registry !== 'object' || registry.schema_version !== 1) {
    errors.push('PRODUCT_URL_REGISTRY_SCHEMA_INVALID');
  }
  const products = registry && registry.products;
  if (!products || typeof products !== 'object' || Array.isArray(products)) {
    errors.push('PRODUCT_URL_REGISTRY_PRODUCTS_INVALID');
    return { ok: false, errors, count: 0 };
  }
  const vendorEntries = vendors && vendors.entries && typeof vendors.entries === 'object' ? vendors.entries : {};
  for (const [key, product] of Object.entries(products)) {
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      errors.push(`${key}:PRODUCT_INVALID`);
      continue;
    }
    if (!String(product.name || '').trim()) errors.push(`${key}:NAME_REQUIRED`);
    const vendorKey = normalizeKey(product.vendor_key);
    if (!vendorKey || !vendorEntries[vendorKey]) errors.push(`${key}:VENDOR_KEY_INVALID`);
    if (!Array.isArray(product.official_urls) || !product.official_urls.length) {
      errors.push(`${key}:OFFICIAL_URLS_REQUIRED`);
    } else {
      for (const value of product.official_urls) {
        const url = canonicalizeUrl(value);
        if (!url || !/^https:\/\//i.test(url)) errors.push(`${key}:OFFICIAL_URL_INVALID`);
      }
    }
    for (const field of ['aliases', 'product_prefixes']) {
      if (product[field] !== undefined && !Array.isArray(product[field])) errors.push(`${key}:${field.toUpperCase()}_INVALID`);
    }
    if (Array.isArray(product.product_prefixes)) {
      for (const prefix of product.product_prefixes.map(normalizeKey)) {
        if (!prefix || FORBIDDEN_PRODUCT_PREFIXES.has(prefix)) errors.push(`${key}:PRODUCT_PREFIX_INVALID`);
      }
    }
    if (product.update_sources !== undefined) {
      errors.push(...validateUpdateSources(key, product.update_sources));
    }
    if (!PRODUCT_LIFECYCLES.has(product.lifecycle)) errors.push(`${key}:LIFECYCLE_INVALID`);
    for (const field of ['last_verified_at', 'last_official_update_at']) {
      if (product[field] !== undefined && !isValidDate(product[field])) errors.push(`${key}:${field.toUpperCase()}_INVALID`);
    }
  }
  return { ok: errors.length === 0, errors, count: Object.keys(products).length };
}

function addProductUrlRegistryEntry(input, options = {}) {
  const name = String(input?.name || '').trim();
  const vendorKey = normalizeKey(input?.vendor_key);
  if (!name) throw new Error('PRODUCT_URL_REGISTRY_NAME_REQUIRED');
  if (!vendorKey) throw new Error('PRODUCT_URL_REGISTRY_VENDOR_KEY_REQUIRED');
  const officialUrls = [
    ...(Array.isArray(input?.official_urls) ? input.official_urls.map(String) : []),
    ...(Array.isArray(input?.official_url) ? input.official_url.map(String) : input?.official_url ? [String(input.official_url)] : []),
  ].map(canonicalizeUrl).filter(Boolean);
  if (!officialUrls.length) throw new Error('PRODUCT_URL_REGISTRY_URL_INVALID');
  const store = options.registry || loadProductUrlRegistry();
  const products = { ...(store.products || {}) };
  const productKey = normalizeKey(name);
  const existingProduct = products[productKey];
  const updateSources = input?.update_sources !== undefined
    ? normalizeUpdateSourcesForWrite(productKey, input.update_sources)
    : existingProduct?.update_sources;
  products[productKey] = {
    name,
    vendor_key: vendorKey,
    official_urls: officialUrls,
    ...(Array.isArray(input?.aliases) && input.aliases.length ? { aliases: [...input.aliases] } : {}),
    ...(productPrefixesOf(input?.product_prefixes).length ? { product_prefixes: productPrefixesOf(input.product_prefixes) } : {}),
    ...(updateSources !== undefined ? { update_sources: updateSources.map(source => ({ ...source })) } : {}),
    lifecycle: input?.lifecycle || 'active',
    ...(input?.last_verified_at ? { last_verified_at: String(input.last_verified_at) } : {}),
    ...(input?.last_official_update_at ? { last_official_update_at: String(input.last_official_update_at) } : {}),
    ...(input?.superseded_by ? { superseded_by: normalizeKey(input.superseded_by) } : {}),
  };
  const next = { schema_version: 1, kind: 'official_product_url_registry', ...store, products };
  const validation = validateProductUrlRegistry(next, { vendorRegistry: options.vendorRegistry || loadUrlRegistry() });
  if (!validation.ok) throw new Error(`PRODUCT_URL_REGISTRY_INVALID: ${validation.errors.join(',')}`);
  if (options.registry) Object.assign(options.registry, next);
  else {
    ensureRegistryDir();
    writeJsonAtomic(CATALOG_GENERATOR_FILES.productUrlRegistry, next, 'product-url-registry-add');
  }
  return { ok: true, product: products[normalizeKey(name)], count: Object.keys(products).length };
}

function removeProductUrlRegistryEntry(name, options = {}) {
  const key = normalizeKey(name);
  if (!key) throw new Error('PRODUCT_URL_REGISTRY_NAME_REQUIRED');
  const store = options.registry || loadProductUrlRegistry();
  const products = { ...(store.products || {}) };
  delete products[key];
  const next = { schema_version: 1, kind: 'official_product_url_registry', ...store, products };
  if (options.registry) Object.assign(options.registry, next);
  else {
    ensureRegistryDir();
    writeJsonAtomic(CATALOG_GENERATOR_FILES.productUrlRegistry, next, 'product-url-registry-remove');
  }
  return { ok: true, removed: key, count: Object.keys(products).length };
}

function auditProductUrlRegistry(options = {}) {
  const registry = options.registry || loadProductUrlRegistry();
  const validation = validateProductUrlRegistry(registry, { vendorRegistry: options.vendorRegistry || loadUrlRegistry() });
  if (!validation.ok) return { ok: false, code: 'PRODUCT_URL_REGISTRY_INVALID', errors: validation.errors, count: validation.count };
  const staleDays = Number.isFinite(Number(options.staleDays)) ? Math.max(0, Number(options.staleDays)) : 183;
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) return { ok: false, code: 'PRODUCT_URL_REGISTRY_AUDIT_DATE_INVALID' };
  const cutoff = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const products = Object.entries(registry.products).map(([key, product]) => {
    const reasons = [];
    const verifiedAt = product.last_verified_at ? Date.parse(`${product.last_verified_at}T00:00:00Z`) : NaN;
    const updateAt = product.last_official_update_at ? Date.parse(`${product.last_official_update_at}T00:00:00Z`) : NaN;
    if (!product.last_verified_at) reasons.push('last_verified_unverified');
    else if (verifiedAt < cutoff) reasons.push('last_verified_stale');
    if (!product.last_official_update_at) reasons.push('official_update_unverified');
    else if (updateAt < cutoff) reasons.push('official_update_stale');
    if (product.lifecycle !== 'active') reasons.push(`lifecycle_${product.lifecycle}`);
    return {
      product_key: key,
      name: product.name,
      lifecycle: product.lifecycle,
      last_verified_at: product.last_verified_at || null,
      last_official_update_at: product.last_official_update_at || null,
      status: reasons.length ? 'needs_review' : 'ok',
      reasons,
    };
  });
  const needsReview = products.filter(product => product.status === 'needs_review').length;
  return {
    ok: true,
    as_of: now.toISOString(),
    stale_days: staleDays,
    count: products.length,
    needs_review: needsReview,
    products,
  };
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
  loadProductUrlRegistry,
  listProductUrlRegistry,
  updateSourcesForProduct,
  validateProductUrlRegistry,
  validateUpdateSource,
  validateUpdateSources,
  UPDATE_SOURCE_KINDS,
  UPDATE_SOURCE_COLLECTORS,
  UPDATE_SOURCE_SURFACES,
  lookupOfficialUrl,
  addProductUrlRegistryEntry,
  removeProductUrlRegistryEntry,
  auditProductUrlRegistry,
  addUrlRegistryEntry,
  removeUrlRegistryEntry,
};
