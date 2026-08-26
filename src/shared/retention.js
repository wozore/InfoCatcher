'use strict';

const fs = require('fs');
const path = require('path');
const { SHARED_FILES, DIRS } = require('./paths');

/**
 * retention.js — 跨模块共享数据段：14 个月滚动删除日期（cutoff）
 *
 * 对比栏模型与 catalog 工具共用同一个删除边界：cutoff = 当前年月 − 14 个月，
 * 每月初自动推进一个月。模型/工具的时间字段（release_date / last_updated_date）
 * 早于 cutoff 月首日即视为过期删除；无时间字段者保守保留。
 *
 * 这是 comparison/catalog 四隔离的唯一跨层通道（数据耦合：封装 + 只公开接口）：
 *   - `data/shared/retention.json`：cutoff 状态（comparison 写 / catalog prune 读）
 *   - 业务模块只依赖 `readRetentionState`（读）与 `advanceRetentionToNow`（唯一写入口）；
 *     `readRetention`/`writeRetention` 是低层 IO（带可选 file 参数仅供测试注入），
 *     业务代码不直接使用，写路径形状校验 fail-closed 防误篡改。
 */

const DEFAULT_MONTHS = 14;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 当前生效 cutoff 年月：`now 的年月 − 14 个月` → `YYYY-MM`。 */
function currentCutoffYearMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - DEFAULT_MONTHS, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** `YYYY-MM` → 月首日 `YYYY-MM-01`；非法返回 null。 */
function cutoffDateOf(yearMonth) {
  return YEAR_MONTH_RE.test(String(yearMonth || '')) ? `${yearMonth}-01` : null;
}

/**
 * 幂等推进 retention：跨自然月时把 cutoff 推进到当前目标（漏跑会自愈 snap），同月返回 advanced:false。
 * @param {object} payload 现有 retention 内容 { months, retention_year_month, last_advanced_at }
 * @param {Date} [now]
 * @returns {{config: object, advanced: boolean}}
 */
function advanceRetentionCutoff(payload = {}, now = new Date()) {
  const target = currentCutoffYearMonth(now);
  const current = payload.retention_year_month || null;
  if (current === target) return { config: payload, advanced: false };
  return {
    config: {
      schema_version: 1,
      months: Number(payload.months) || DEFAULT_MONTHS,
      retention_year_month: target,
      last_advanced_at: new Date().toISOString(),
    },
    advanced: true,
  };
}

/** 从 retention 内容读出 { year_month, cutoff_date, months }。 */
function readRetentionFromPayload(payload = {}) {
  const yearMonth = YEAR_MONTH_RE.test(payload.retention_year_month || '') ? payload.retention_year_month : null;
  return {
    year_month: yearMonth,
    cutoff_date: cutoffDateOf(yearMonth),
    months: Number(payload.months) || DEFAULT_MONTHS,
  };
}

/** retention 状态形状校验（纯逻辑）；非法返回错误消息，合法返回 null。 */
function validateRetentionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'retention 应为对象';
  if (payload.schema_version !== 1) return 'schema_version 应为 1';
  if (!(Number(payload.months) > 0)) return 'months 应为正数';
  if (!YEAR_MONTH_RE.test(payload.retention_year_month || '')) return 'retention_year_month 应为 YYYY-MM';
  if (payload.last_advanced_at != null && typeof payload.last_advanced_at !== 'string') return 'last_advanced_at 应为字符串或 null';
  return null;
}

/**
 * 低层读 retention.json（固定共享路径；`file` 仅供测试注入，业务代码不传）。
 * 缺失/损坏返回默认，不抛。
 */
function readRetention(file = SHARED_FILES.retention) {
  try {
    if (!file || !fs.existsSync(file)) return { schema_version: 1, months: DEFAULT_MONTHS, retention_year_month: null, last_advanced_at: null };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : { schema_version: 1, months: DEFAULT_MONTHS, retention_year_month: null, last_advanced_at: null };
  } catch {
    return { schema_version: 1, months: DEFAULT_MONTHS, retention_year_month: null, last_advanced_at: null };
  }
}

/**
 * 低层写 retention.json（固定共享路径；`file` 仅供测试注入，业务代码不传）。
 * 形状校验 fail-closed：非法 payload 抛错，不落盘。
 */
function writeRetention(payload, file = SHARED_FILES.retention) {
  const invalid = validateRetentionPayload(payload);
  if (invalid) throw new Error(`RETENTION_INVALID: ${invalid}`);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 读端唯一入口：校验后冻结的 retention 状态（损坏/缺失回退默认，不抛）。 */
function readRetentionState(file = SHARED_FILES.retention) {
  const raw = readRetention(file);
  const base = {
    schema_version: 1,
    months: Number(raw.months) || DEFAULT_MONTHS,
    retention_year_month: YEAR_MONTH_RE.test(raw.retention_year_month || '') ? raw.retention_year_month : null,
    last_advanced_at: typeof raw.last_advanced_at === 'string' ? raw.last_advanced_at : null,
  };
  return Object.freeze({ ...base, ...readRetentionFromPayload(base) });
}

/**
 * 唯一写入口：推进 cutoff 并原子落盘（跨月推进/漏跑自愈/同月幂等）。
 * 写失败降级返回 {ok:false} 并沿用旧 cutoff（不抛，管线继续按旧边界过滤）。
 * @returns {{ok: boolean, advanced: boolean, year_month: string|null, cutoff_date: string|null, code?: string}}
 */
function advanceRetentionToNow(now = new Date(), file = SHARED_FILES.retention) {
  const current = readRetention(file);
  const { config, advanced } = advanceRetentionCutoff(current, now);
  if (!advanced) {
    const { year_month, cutoff_date } = readRetentionFromPayload(config);
    return { ok: true, advanced: false, year_month, cutoff_date };
  }
  try {
    writeRetention(config, file);
  } catch (error) {
    const fallback = readRetentionState(file);
    return { ok: false, code: error.message || 'RETENTION_WRITE_FAILED', error: error.message, advanced: true, ...fallback };
  }
  const { year_month, cutoff_date } = readRetentionFromPayload(config);
  return { ok: true, advanced: true, year_month, cutoff_date };
}

/** 目录是否就绪（建共享段目录）。 */
function ensureSharedDir(dir = DIRS.shared) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  DEFAULT_MONTHS,
  currentCutoffYearMonth,
  cutoffDateOf,
  advanceRetentionCutoff,
  readRetentionFromPayload,
  validateRetentionPayload,
  readRetentionState,
  advanceRetentionToNow,
  readRetention,
  writeRetention,
  ensureSharedDir,
};
