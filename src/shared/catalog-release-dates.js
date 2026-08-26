'use strict';

const fs = require('fs');
const path = require('path');
const { SHARED_FILES } = require('./paths');

/**
 * catalog-release-dates.js — 共享段 `catalog-release-dates.json` 校验接口
 *
 * catalog api_model/product_variant 的 release_date 投影：catalog 落盘后发布写入、
 * comparison 反查只读。数据耦合（封装 + 只公开接口）：业务模块只调用
 * `readCatalogReleaseDates`（读）/ `writeCatalogReleaseDates`（写），不裸 fs；
 * 写路径逐条形状校验 fail-closed 防误篡改，读路径校验后冻结。
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_KINDS = new Set(['api_model', 'product_variant']);

function isIsoDate(value) {
  return ISO_DATE_RE.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** catalog release_date 投影单条 entry 形状校验（纯逻辑）；返回错误消息数组（空 = 合法）。 */
function validateCatalogReleaseDatesEntries(entries) {
  if (!Array.isArray(entries)) return ['entries 必须是数组'];
  const errors = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`entries[${i}] 应为对象`); continue; }
    if (typeof entry.detail_id !== 'string' || !entry.detail_id.trim()) errors.push(`entries[${i}].detail_id 缺失`);
    if (!ALLOWED_KINDS.has(entry.detail_kind)) errors.push(`entries[${i}].detail_kind 应为 api_model/product_variant`);
    if (!isIsoDate(entry.release_date)) errors.push(`entries[${i}].release_date 应为 ISO YYYY-MM-DD`);
    for (const field of ['vendor_key', 'title', 'tool_key']) {
      if (entry[field] != null && typeof entry[field] !== 'string') errors.push(`entries[${i}].${field} 应为字符串`);
    }
  }
  return errors;
}

/**
 * 读共享 catalog release_date 投影（comparison 反查只读；固定共享路径，`file` 仅供测试注入）。
 * 缺失/损坏回退空，返回校验后冻结结构，不抛。
 */
function readCatalogReleaseDates(file = SHARED_FILES.catalogReleaseDates) {
  try {
    if (!file || !fs.existsSync(file)) return Object.freeze({ schema_version: 1, entries: [] });
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return Object.freeze({ schema_version: 1, entries: [] });
    const errors = validateCatalogReleaseDatesEntries(value.entries);
    if (errors.length) {
      console.warn(`⚠️ 共享 catalog release_date 投影损坏：${errors.join('; ')}（回退空）`);
      return Object.freeze({ schema_version: 1, entries: [] });
    }
    const entries = Object.freeze(value.entries.map(entry => Object.freeze({ ...entry })));
    return Object.freeze({ schema_version: 1, entries });
  } catch {
    return Object.freeze({ schema_version: 1, entries: [] });
  }
}

/**
 * 写共享 catalog release_date 投影（catalog 落盘后发布；comparison 只读）。
 * 逐条形状校验 fail-closed：非法返回 {ok:false} 不落盘；原子写（临时文件 + rename）。
 * @returns {{ok: boolean, count?: number, code?: string, errors?: string[]}}
 */
function writeCatalogReleaseDates(entries, file = SHARED_FILES.catalogReleaseDates) {
  const errors = validateCatalogReleaseDatesEntries(entries);
  if (errors.length) return { ok: false, code: 'SHARED_CATALOG_RELEASE_DATES_INVALID', errors };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { schema_version: 1, generated_at: new Date().toISOString(), entries };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ok: false, code: 'SHARED_CATALOG_RELEASE_DATES_WRITE_FAILED', error: error.message };
  }
  return { ok: true, count: entries.length };
}

module.exports = { isIsoDate, validateCatalogReleaseDatesEntries, readCatalogReleaseDates, writeCatalogReleaseDates };
