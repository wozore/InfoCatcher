'use strict';

/**
 * revision-date.js — revision 日期规范化（纯逻辑）
 *
 * 对比栏 revision 原本混用 MMDD（0731）、YYYYMMDD（20260731）、YYMM（2507）、
 * MM-YYYY（05-2026）等格式，无法可靠比较同一天的不同写法。本模块把 revision
 * 解析成 (year, month, day) 并统一为两种展示形态：
 *   - 本年（year === 系统年份）：MM-DD（日级）或 MM（月级），不显示年份
 *   - 非本年：YYYY-MM-DD（日级）或 YYYY-MM（月级），保留年份
 *
 * 年份查证规则：无年份的 MMDD / MM-DD 先用系统年份推断，若推断日期仍落在
 * 未来（数据源给出的都是已发布版本，不可能是未来日期）则回退到上一年。
 * 4 位纯数字按月份有效性区分：前两位为 01-12 视为 MMDD，前两位 > 12 视为
 * YYMM（20xx）；其余视为纯年份。同一日期两种写法规范化后同键，自动合并。
 */

/** 解析 revision token 为 {year, month, day}；day 为 null 表示仅年月精度。无法解析返回 null。 */
function parseRevisionDate(token, now = new Date()) {
  const value = String(token || '').trim();
  if (!value) return null;
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(value))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})-(\d{2})$/.exec(value))) return validYm(+m[1], +m[2]);
  if ((m = /^(\d{4})(\d{2})$/.exec(value))) return validYm(+m[1], +m[2]);
  if ((m = /^(\d{2})-(\d{4})$/.exec(value))) return validYm(+m[2], +m[1]);
  if ((m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(value))) {
    const yy = +m[1];
    return validYmd(2000 + yy, +m[2], +m[3]);
  }
  if ((m = /^(\d{2})-(\d{2})$/.exec(value))) return inferMonthDay(now, +m[1], +m[2]);
  if ((m = /^(\d{4})$/.exec(value))) {
    const head = +value.slice(0, 2);
    const tail = +value.slice(2);
    if (head >= 1 && head <= 12 && tail >= 1 && tail <= 31) return inferMonthDay(now, head, tail); // MMDD
    if (head >= 13 && tail >= 1 && tail <= 12) return { year: 2000 + head, month: tail, day: null }; // YYMM
    return validYear(+value); // 纯年份
  }
  return null;
}

function validYmd(year, month, day) {
  const cand = new Date(Date.UTC(year, month - 1, day));
  if (cand.getUTCFullYear() !== year || cand.getUTCMonth() !== month - 1 || cand.getUTCDate() !== day) return null;
  return { year, month, day };
}

function validYm(year, month) {
  if (!(month >= 1 && month <= 12)) return null;
  return { year, month, day: null };
}

function validYear(year) {
  return year >= 1900 && year <= 2100 ? { year, month: null, day: null } : null;
}

/** 无年份 MMDD/MM-DD：按系统年份推断，日期在未来则回退上一年。 */
function inferMonthDay(now, month, day) {
  const ymd = validYmd(now.getFullYear(), month, day);
  if (!ymd) return null;
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (Date.UTC(ymd.year, ymd.month - 1, ymd.day) > todayUtc) ymd.year -= 1;
  return ymd;
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * 规范化 revision token 为统一展示形态；无法解析时返回原 token（不破坏现状）。
 * @param {string} token
 * @param {Date} [now]
 * @returns {string}
 */
function normalizeRevision(token, now = new Date()) {
  const parsed = parseRevisionDate(token, now);
  if (!parsed) return String(token == null ? '' : token);
  const currentYear = now.getFullYear();
  if (parsed.day == null) {
    if (parsed.month == null) return String(parsed.year); // 纯年份
    return parsed.year === currentYear ? pad2(parsed.month) : `${parsed.year}-${pad2(parsed.month)}`;
  }
  return parsed.year === currentYear
    ? `${pad2(parsed.month)}-${pad2(parsed.day)}`
    : `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`;
}

module.exports = { parseRevisionDate, normalizeRevision };
