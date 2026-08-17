/**
 * official-url-registry.js —— 批量生成前置：人工官方 URL 登记表
 *
 * 在批量生成链路（②→③）中的位置：厂商/官方源解析的第一道命中源。
 * 维护者把已知工具的官方域名人工登记到 data/manual/archive/official-url-registry.json，
 * 批量生成时优先查表，命中就不必花 Tavily/DeepSeek 去搜索解析。
 *
 * 数据形状（data/manual/archive/official-url-registry.json）：
 *   { schema_version: 1, entries: { "<厂商键>": { vendor_name, official_urls: [], model_prefixes?: [] } } }
 *   厂商键 = 小写厂商名（openai/anthropic/...，与五模块 vendor_key 同规范）。
 *   official_urls = 该厂商官方文档/开发者站数组（可多个：不同文档入口、国内/国际站），全部作 official_hint。
 *   model_prefixes = 该厂商旗下模型共用前缀（如 OpenAI 填 ["gpt"]），人工维护只填区分性最短前缀；
 *   批量解析用待补卡模型名做前缀匹配（无视大小写）命中厂商官方 URL，miss 走 Tavily 兜底。
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
 * 查找某模型名/工具名的登记条目（前缀匹配厂商）。
 * 匹配顺序：① key/aliases 归一化精确全等 → ② model_prefixes 前缀匹配（无视大小写）。
 * 厂商前缀由人工维护，只填区分性最短前缀，故同一名字命中多条不同厂商的概率由维护规避。
 * @param {string} name 模型名/工具名
 * @param {object} [options] { registry } 注入登记表（测试用）；缺省读文件
 * @returns {Promise<{ok:true, vendor_name, official_url, official_urls}> | {ok:false, code, error}>
 *   official_url = 首个有效官方 URL（兼容单值调用方）；official_urls = 全部官方 URL（作多个 official_hint）
 */
function lookupOfficialUrl(name, options = {}) {
  const store = options.registry || loadUrlRegistry();
  const entries = store && store.entries && typeof store.entries === 'object' ? store.entries : {};
  const needle = normalizeKey(name);
  if (!needle) return { ok: false, code: 'URL_REGISTRY_MISS', error: `登记表未命中: ${name}` };
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    // 多官方 URL：official_urls[] 优先，兼容 official_url 单值或数组
    const officialUrls = [
      ...(Array.isArray(entry.official_urls) ? entry.official_urls : []),
      ...(Array.isArray(entry.official_url) ? entry.official_url : entry.official_url ? [entry.official_url] : []),
    ].map(canonicalizeUrl).filter(Boolean);
    if (!officialUrls.length) continue;
    // ① 精确全等：key / aliases
    const exactNames = [key, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeKey);
    // ② 前缀匹配：模型名以任一厂商模型前缀开头（空前缀过滤，避免误命中所有）
    const prefixHit = Array.isArray(entry.model_prefixes)
      && entry.model_prefixes.map(normalizeKey).filter(Boolean).some(prefix => needle.startsWith(prefix));
    if (!exactNames.includes(needle) && !prefixHit) continue;
    return {
      ok: true,
      vendor_name: String(entry.vendor_name || name).trim() || name,
      official_url: officialUrls[0],
      official_urls: officialUrls,
    };
  }
  return { ok: false, code: 'URL_REGISTRY_MISS', error: `登记表未命中: ${name}` };
}

/**
 * 新增/覆盖登记条目（原子写）。
 * @param {object} input { name, vendor_name, official_url?, official_urls?, aliases?, model_prefixes? }
 *   name = 厂商键（openai/anthropic/...，建议与 vendor_key 同规范）；
 *   official_url / official_urls = 官方文档/开发者站（单值或数组，至少一个有效）；
 *   model_prefixes = 该厂商旗下模型共用前缀数组（匹配用）。
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
};
