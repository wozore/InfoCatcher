'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { beijingDateKey, beijingDayKey, beijingMidnightIso, BEIJING_OFFSET_MS } = require('../../src/shared/beijing-time');

test('北京时间日期键：UTC 晚 16 点后跨到北京次日', () => {
  // UTC 2026-08-07 18:00 = 北京 2026-08-08 02:00 → 北京日期 20260808
  assert.equal(beijingDateKey(new Date('2026-08-07T18:00:00Z')), '20260808');
  // UTC 2026-08-07 15:00 = 北京 2026-08-07 23:00 → 北京日期 20260807
  assert.equal(beijingDateKey('2026-08-07T15:00:00Z'), '20260807');
  // 本地（北京）与 CI（UTC）跑同一输入结果一致
  assert.equal(beijingDateKey(new Date('2026-08-07T16:00:00.000Z')), '20260808', '北京 0 点整属北京次日');
});

test('北京时间自然日键：YYYY-MM-DD，跨日边界正确', () => {
  assert.equal(beijingDayKey('2026-08-07T16:30:00Z'), '2026-08-08', '北京 0:30 属次日');
  assert.equal(beijingDayKey('2026-08-07T15:59:59Z'), '2026-08-07', '北京 23:59 属当日');
});

test('北京时间当天 0 点 = UTC 前一日 16:00', () => {
  assert.equal(beijingMidnightIso('2026-08-08T06:00:00Z'), '2026-08-07T16:00:00.000Z');
  assert.equal(beijingMidnightIso('2026-08-08T00:00:00Z'), '2026-08-07T16:00:00.000Z', '北京任意时刻取当天 0 点');
});

test('非法输入回退当前时间，不抛错', () => {
  assert.doesNotThrow(() => beijingDateKey('not-a-date'));
  assert.doesNotThrow(() => beijingDayKey(undefined));
  assert.doesNotThrow(() => beijingMidnightIso(null));
  assert.ok(BEIJING_OFFSET_MS === 8 * 60 * 60 * 1000);
});
