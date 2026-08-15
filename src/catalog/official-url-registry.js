/**
 * official-url-registry.js —— 批量生成前置：人工官方 URL 登记表
 *
 * 在批量生成链路（②→③）中的位置：厂商/官方源解析的第一道命中源。
 * 维护者把已知工具的官方域名人工登记到 data/manual/official-url-registry.json，
 * 批量生成时优先查表，命中就不必花 Tavily/DeepSeek 去搜索解析。
 *
 * 数据形状（data/manual/official-url-registry.json）：
 *   { schema_version: 1, entries: { "<归一化名>": { vendor_name, official_url, aliases?: [] } } }
 *   归一化名 = 工具名或厂商名（同一命名空间），可配 aliases 别名扩展匹配。
 *
 * 纯本地读写，不发网络请求、不消费额度。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { canonicalizeUrl } = require('../shared/tavily-client');

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

/** 列出登记表全部条目。 */
function listUrlRegistry() {
  return loadUrlRegistry();
}

/**
 * 查找某名字（工具名或厂商名）的登记条目。
 * key + aliases 都做 normalizeKey 比对。
 * @param {string} name 工具名或厂商名
 * @param {object} [options] { registry } 注入登记表（测试用）；缺省读文件
 * @returns {Promise<{ok:true, vendor_name, official_url}> | {ok:false, code, error}}
 */
function lookupOfficialUrl(name, options = {}) {
  const store = options.registry || loadUrlRegistry();
  const entries = store && store.entries && typeof store.entries === 'object' ? store.entries : {};
  const needle = normalizeKey(name);
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const names = [key, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeKey);
    if (!names.includes(needle)) continue;
    const officialUrl = canonicalizeUrl(entry.official_url || '');
    if (!officialUrl) continue;
    return {
      ok: true,
      vendor_name: String(entry.vendor_name || name).trim() || name,
      official_url: officialUrl,
    };
  }
  return { ok: false, code: 'URL_REGISTRY_MISS', error: `登记表未命中: ${name}` };
}

/**
 * 新增/覆盖登记条目（原子写）。
 * @param {object} input { name, vendor_name, official_url, aliases? }
 * @param {object} [options] { registry } 注入登记表（测试用，不落盘）
 * @returns {{ok:true, entry, count}}
 */
function addUrlRegistryEntry(input, options = {}) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('URL_REGISTRY_NAME_REQUIRED');
  const officialUrl = canonicalizeUrl(input?.official_url || '');
  if (!officialUrl) throw new Error('URL_REGISTRY_URL_INVALID');
  const store = options.registry || loadUrlRegistry();
  const entries = { ...(store.entries || {}) };
  entries[normalizeKey(name)] = {
    vendor_name: String(input?.vendor_name || name).trim() || name,
    official_url: officialUrl,
    ...(Array.isArray(input?.aliases) && input.aliases.length ? { aliases: [...input.aliases] } : {}),
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
};
