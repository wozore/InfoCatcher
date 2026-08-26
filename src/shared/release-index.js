'use strict';

const fs = require('fs');
const path = require('path');
const { SHARED_FILES } = require('./paths');

/**
 * release-index.js — 共享段 `model-release-dates.json` 校验接口
 *
 * 模型 release_date 查找索引：comparison 重建时生成写入、catalog 生成器机械查找只读。
 * 数据耦合（封装 + 只公开接口）：业务模块只调用 `readReleaseIndex`（读）/ `writeReleaseIndex`（写），
 * 不裸 fs；写路径逐条形状校验 fail-closed 防误篡改，读路径校验后冻结。
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return ISO_DATE_RE.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** release_date 索引单条 entry 形状校验（纯逻辑）；返回错误消息数组（空 = 合法）。 */
function validateReleaseIndexEntries(entries) {
  if (!Array.isArray(entries)) return ['entries 必须是数组'];
  const errors = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`entries[${i}] 应为对象`); continue; }
    if (typeof entry.model_key !== 'string' || !entry.model_key.trim()) errors.push(`entries[${i}].model_key 缺失`);
    if (!isIsoDate(entry.release_date)) errors.push(`entries[${i}].release_date 应为 ISO YYYY-MM-DD`);
    if (entry.catalog_aliases != null && (!Array.isArray(entry.catalog_aliases) || entry.catalog_aliases.some(alias => typeof alias !== 'string'))) {
      errors.push(`entries[${i}].catalog_aliases 应为字符串数组`);
    }
  }
  return errors;
}

/**
 * 读共享 release_date 索引（固定共享路径；`file` 仅供测试注入，业务代码不传）。
 * 缺失/损坏回退空，返回校验后冻结结构，不抛。
 */
function readReleaseIndex(file = SHARED_FILES.modelReleaseDates) {
  try {
    if (!file || !fs.existsSync(file)) return Object.freeze({ schema_version: 1, entries: [] });
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return Object.freeze({ schema_version: 1, entries: [] });
    const errors = validateReleaseIndexEntries(value.entries);
    if (errors.length) {
      console.warn(`⚠️ 共享 release_date 索引损坏：${errors.join('; ')}（回退空）`);
      return Object.freeze({ schema_version: 1, entries: [] });
    }
    const entries = Object.freeze(value.entries.map(entry => Object.freeze({ ...entry })));
    return Object.freeze({ schema_version: 1, entries });
  } catch {
    return Object.freeze({ schema_version: 1, entries: [] });
  }
}

/**
 * 写共享 release_date 索引（comparison 重建生成；catalog 只读）。
 * 逐条形状校验 fail-closed：非法返回 {ok:false} 不落盘；原子写（临时文件 + rename）。
 * @returns {{ok: boolean, count?: number, code?: string, errors?: string[]}}
 */
function writeReleaseIndex(entries, file = SHARED_FILES.modelReleaseDates) {
  const errors = validateReleaseIndexEntries(entries);
  if (errors.length) return { ok: false, code: 'SHARED_RELEASE_INDEX_INVALID', errors };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { schema_version: 1, generated_at: new Date().toISOString(), entries };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ok: false, code: 'SHARED_RELEASE_INDEX_WRITE_FAILED', error: error.message };
  }
  return { ok: true, count: entries.length };
}

module.exports = { isIsoDate, validateReleaseIndexEntries, readReleaseIndex, writeReleaseIndex };
