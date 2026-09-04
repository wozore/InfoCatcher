'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { canonicalizeUrl } = require('../../shared/tavily-client');
const { REVIEW_MODES } = require('../tool-update/tool-update-review-contract');
const { DATE_PATTERN } = require('../tool-update/tool-update-evidence');

function normalizeKey(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function ensureRegistryDir() {
  fs.mkdirSync(path.dirname(CATALOG_GENERATOR_FILES.productUrlRegistry), { recursive: true });
}

function loadUrlRegistry() {
  return readJson(CATALOG_GENERATOR_FILES.urlRegistry, { schema_version: 1, entries: {} });
}

function loadProductUrlRegistry() {
  return readJson(CATALOG_GENERATOR_FILES.productUrlRegistry, { schema_version: 1, kind: 'official_product_url_registry', products: {} });
}

function listProductUrlRegistry() {
  return loadProductUrlRegistry();
}

function updateSourcesForProduct(productKey, options = {}) {
  const registry = options.registry || options.productRegistry || loadProductUrlRegistry();
  const product = registry && registry.products && typeof registry.products === 'object'
    ? registry.products[normalizeKey(productKey)]
    : null;
  return Array.isArray(product?.update_sources)
    ? product.update_sources.map(source => ({ ...source }))
    : [];
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



module.exports = {
  normalizeKey,
  loadProductUrlRegistry,
  listProductUrlRegistry,
  updateSourcesForProduct,
  validateProductUrlRegistry,
  validateUpdateSource,
  validateUpdateSources,
  UPDATE_SOURCE_KINDS,
  UPDATE_SOURCE_COLLECTORS,
  UPDATE_SOURCE_SURFACES,
  addProductUrlRegistryEntry,
  removeProductUrlRegistryEntry,
  auditProductUrlRegistry,
};
