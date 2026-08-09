/**
 * beijing-time.js —— 北京时间（UTC+8）日期/时间工具
 *
 * 项目采集调度与人工清单统一按北京时间；GitHub Actions runner 系统时区为 UTC、
 * 本地 Windows 为北京时区，直接用 Date 的本地时区方法会导致 CI 与本地结果不一致。
 * 本模块一律用「UTC + 8h」固定偏移计算，不依赖运行环境时区。
 */

'use strict';

/** 北京时间相对 UTC 的固定偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 归一化输入为合法 Date；非法/缺失回退当前时间。 */
function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

/** 北京时间日期键 YYYYMMDD（文件名/JSON date 字段用）。 */
function beijingDateKey(value) {
  const d = toDate(value);
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`;
}

/** 北京时间自然日键 YYYY-MM-DD（投影按天分组用）。 */
function beijingDayKey(value) {
  const d = toDate(value);
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
}

/** 北京时间当天 0 点对应的 UTC ISO 字符串（X 采集回看窗口 since 用）。 */
function beijingMidnightIso(value) {
  const d = toDate(value);
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  const midnightUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_OFFSET_MS;
  return new Date(midnightUtcMs).toISOString();
}

module.exports = { BEIJING_OFFSET_MS, beijingDateKey, beijingDayKey, beijingMidnightIso };
