'use strict';

/**
 * release-date.js — 对比模型 release_date 解析（纯逻辑）
 *
 * 对比栏模型需要统一发布时间字段供 14 个月滚动删除（retention）判据使用。
 * 多源解析优先级：llm-stats `release_date` → catalog 反查（经共享投影
 * `data/shared/catalog-release-dates.json` 的 entries + models-alias `catalog_aliases` 对齐，
 * comparison 只读共享段不直接读 catalog 私有文件）→ openrouter `created`
 * （Unix 秒上架日，最后兜底）→ null（保守保留）。
 *
 * 同时提供 `filterByReleaseCutoff`：release_date 早于 cutoff 月首日的模型排除，
 * 无日期者保守保留并进入诊断清单。
 */

const { slugify } = require('../identity/model-identity');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_KINDS = new Set(['api_model', 'product_variant']);

function isIsoDate(value) {
  return ISO_DATE_RE.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isoFromUnixSeconds(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/**
 * 构建 catalog 反查 lookup：消费共享投影 `catalog-release-dates.json` 的 entries
 * （catalog 落盘后发布，comparison 只读共享段，不直接读 catalog 私有文件）。
 * @param {{catalogDates?: Array<{detail_id:string, detail_kind:string, title?:string, tool_key?:string, release_date:string}>, modelsAlias?: object}} sources
 * @returns {{catalogByAlias: Map<string,{release_date:string,detail_id:string}>, catalogAliasesByModel: Map<string,{model_key:string,catalog_aliases:string[]}>}}
 */
function buildReleaseLookup({ catalogDates = [], modelsAlias = {} } = {}) {
  const catalogByAlias = new Map(); // lowercased title|tool_key|detail_id|identity-slug → { release_date, detail_id }
  for (const entry of catalogDates) {
    if (!ALLOWED_KINDS.has(entry.detail_kind)) continue;
    if (!isIsoDate(entry.release_date)) continue;
    const aliases = [
      entry.title,
      entry.tool_key,
      String(entry.detail_id).replace(/^tool-level3:/, ''),
      slugify(entry.title),
    ].filter(Boolean);
    for (const alias of aliases) {
      const key = String(alias).trim().toLowerCase();
      if (!key) continue;
      catalogByAlias.set(key, { release_date: entry.release_date, detail_id: entry.detail_id });
    }
  }

  const catalogAliasesByModel = new Map(); // canonical → { model_key, catalog_aliases }
  for (const entry of modelsAlias.entries || []) {
    const modelKey = entry.model_key || entry.canonical;
    if (!modelKey) continue;
    catalogAliasesByModel.set(modelKey, { model_key: modelKey, catalog_aliases: entry.catalog_aliases || [] });
  }

  return { catalogByAlias, catalogAliasesByModel };
}

/** 反向查找：record → catalog release_date；Path A canonical 的 catalog_aliases，Path B identity-slug。 */
function reverseLookupCatalogReleaseDate(record, lookup) {
  if (!lookup || !lookup.catalogByAlias || !lookup.catalogByAlias.size) return null;
  const entry = record && lookup.catalogAliasesByModel.get(record.canonical);
  if (entry) {
    for (const alias of entry.catalog_aliases || []) {
      const hit = lookup.catalogByAlias.get(String(alias).trim().toLowerCase());
      if (hit && hit.release_date) return hit;
    }
  }
  const identity = String((record && record.identity) || '').trim().toLowerCase();
  if (!identity) return null;
  return lookup.catalogByAlias.get(identity) || lookup.catalogByAlias.get(slugify(identity)) || null;
}

/**
 * 解析模型 release_date。优先级 llm-stats → catalog 反查 → openrouter created。
 * @param {object} record collectSourceRecords 的记录（含 sources）
 * @param {object} [lookup] buildReleaseLookup 结果
 * @returns {{date: string|null, provenance: 'llm_stats'|'catalog'|'openrouter'|null}}
 */
function resolveReleaseDate(record, lookup) {
  const llm = record && record.sources && record.sources.llm_stats;
  if (llm && isIsoDate(llm.release_date)) return { date: llm.release_date, provenance: 'llm_stats' };
  const fromCatalog = reverseLookupCatalogReleaseDate(record, lookup);
  if (fromCatalog && fromCatalog.release_date) return { date: fromCatalog.release_date, provenance: 'catalog' };
  const created = record && record.sources && record.sources.openrouter && record.sources.openrouter.created;
  const date = isoFromUnixSeconds(created);
  if (date) return { date, provenance: 'openrouter' };
  return { date: null, provenance: null };
}

/**
 * 按 cutoff 过滤过期记录并投影 release_date。
 * @param {object} records 记录 Map（key → record）
 * @param {string|null} cutoffDate `YYYY-MM-01`；null 则不过滤只投影
 * @param {object} [lookup]
 * @returns {{records: object, filtered: object[], retained_null: object[]}}
 */
function filterByReleaseCutoff(records, cutoffDate, lookup) {
  const kept = {};
  const filtered = [];
  const retainedNull = [];
  for (const [key, record] of Object.entries(records || {})) {
    const { date, provenance } = resolveReleaseDate(record, lookup);
    record.release_date = date;
    record.release_date_provenance = provenance;
    if (date && cutoffDate && date < cutoffDate) {
      filtered.push({ canonical: record.canonical, identity: record.identity, release_date: date, provenance, record_key: key });
      continue;
    }
    if (!date) retainedNull.push({ canonical: record.canonical, identity: record.identity, record_key: key });
    kept[key] = record;
  }
  return { records: kept, filtered, retained_null: retainedNull };
}

/**
 * 构建共享 release_date 索引（写入 data/shared/model-release-dates.json，catalog 生成器只读）。
 * 只收录有 release_date 的模型，附带 catalog_aliases（供 catalog 侧按 tool_key/title 对齐）。
 * @param {object[]} models 已 build 的 integrated 模型
 * @param {object} [registry] models-alias 内容（entries 带 catalog_aliases）
 * @returns {{schema_version: number, entries: object[]}}
 */
function buildSharedReleaseIndex(models, registry = {}) {
  const aliasByCanonical = new Map();
  for (const entry of registry.entries || []) {
    const key = entry.model_key || entry.canonical;
    if (key) aliasByCanonical.set(key, (entry.catalog_aliases || []).filter(Boolean));
  }
  const entries = [];
  for (const model of models || []) {
    if (!isIsoDate(model.release_date)) continue;
    entries.push({
      model_key: model.canonical,
      release_date: model.release_date,
      catalog_aliases: aliasByCanonical.get(model.canonical) || [],
    });
  }
  entries.sort((a, b) => a.model_key.localeCompare(b.model_key));
  return { schema_version: 1, entries };
}

module.exports = {
  isIsoDate,
  isoFromUnixSeconds,
  buildReleaseLookup,
  reverseLookupCatalogReleaseDate,
  resolveReleaseDate,
  filterByReleaseCutoff,
  buildSharedReleaseIndex,
};
