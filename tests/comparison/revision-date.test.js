'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRevisionDate, normalizeRevision } = require('../../src/comparison/series/revision-date');

const NOW = new Date('2026-08-26T00:00:00Z');

test('revision-date：MMDD 本年不显示年份，未来日期回退到上年', () => {
  assert.equal(normalizeRevision('0731', NOW), '07-31');        // 已过 → 今年
  assert.equal(normalizeRevision('0423', NOW), '04-23');        // 已过 → 今年
  assert.equal(normalizeRevision('1119', NOW), '2025-11-19');   // 未来 → 回退上年
  assert.equal(normalizeRevision('1220', NOW), '2025-12-20');   // 未来 → 回退上年
});

test('revision-date：YYYYMMDD / YYYY-MM-DD 本年去年份，往年保留', () => {
  assert.equal(normalizeRevision('20260731', NOW), '07-31');
  assert.equal(normalizeRevision('2026-07-31', NOW), '07-31');
  assert.equal(normalizeRevision('20240229', NOW), '2024-02-29');
  assert.equal(normalizeRevision('2025-11-19', NOW), '2025-11-19');
});

test('revision-date：YYMM 推断世纪，非本年保留年份', () => {
  assert.equal(normalizeRevision('2407', NOW), '2024-07');
  assert.equal(normalizeRevision('2509', NOW), '2025-09');
  assert.equal(normalizeRevision('2603', NOW), '03');           // 本年月份不显示年份
});

test('revision-date：MM-YYYY 与 4 位纯年份', () => {
  assert.equal(normalizeRevision('05-2026', NOW), '05');        // 本年月份
  assert.equal(normalizeRevision('08-2024', NOW), '2024-08');
  assert.equal(normalizeRevision('2026', NOW), '2026');         // 纯年份
});

test('revision-date：同一日期不同写法规范化后同键（可合并）', () => {
  assert.equal(normalizeRevision('0731', NOW), normalizeRevision('20260731', NOW));
  assert.equal(normalizeRevision('07-31', NOW), normalizeRevision('2026-07-31', NOW));
  assert.notEqual(normalizeRevision('0423', NOW), normalizeRevision('0731', NOW));
});

test('revision-date：无法解析的 token 保持原样', () => {
  assert.equal(normalizeRevision('abc', NOW), 'abc');
  assert.equal(normalizeRevision('', NOW), '');
});

test('revision-date：parseRevisionDate 结构解析', () => {
  assert.deepEqual(parseRevisionDate('20260731', NOW), { year: 2026, month: 7, day: 31 });
  assert.deepEqual(parseRevisionDate('0731', NOW), { year: 2026, month: 7, day: 31 });
  assert.deepEqual(parseRevisionDate('2407', NOW), { year: 2024, month: 7, day: null });
  assert.deepEqual(parseRevisionDate('1119', NOW), { year: 2025, month: 11, day: 19 });
  assert.equal(parseRevisionDate('0230', NOW), null);           // 2月30日无效
  assert.equal(parseRevisionDate('1320', NOW), null);           // 13月无效
});
