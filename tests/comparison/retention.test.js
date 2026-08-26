'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  currentCutoffYearMonth,
  cutoffDateOf,
  advanceRetentionCutoff,
  readRetentionFromPayload,
  validateRetentionPayload,
  readRetentionState,
  advanceRetentionToNow,
  writeRetention,
} = require('../../src/shared/retention');

const NOW = new Date('2026-08-26T00:00:00Z');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  return path.join(dir, 'retention.json');
}

test('retention：14 个月窗口，当前年月 − 14 个月', () => {
  assert.equal(currentCutoffYearMonth(new Date('2026-08-15T00:00:00Z')), '2025-06');
  assert.equal(currentCutoffYearMonth(new Date('2026-09-01T00:00:00Z')), '2025-07');
  assert.equal(currentCutoffYearMonth(new Date('2027-01-10T00:00:00Z')), '2025-11');
  assert.equal(currentCutoffYearMonth(new Date('2026-08-26T00:00:00Z')), '2025-06');
});

test('retention：cutoffDateOf 年月 → 月首日', () => {
  assert.equal(cutoffDateOf('2025-06'), '2025-06-01');
  assert.equal(cutoffDateOf('2025-06-01'), null); // 只接受 YYYY-MM
  assert.equal(cutoffDateOf(null), null);
  assert.equal(cutoffDateOf(''), null);
});

test('retention：同月幂等不推进，跨月推进恰好一个月', () => {
  const payload = { schema_version: 1, months: 14, retention_year_month: '2025-06', last_advanced_at: null };
  const same = advanceRetentionCutoff(payload, NOW);
  assert.equal(same.advanced, false);
  assert.equal(same.config.retention_year_month, '2025-06');

  const next = advanceRetentionCutoff(payload, new Date('2026-09-01T00:00:00Z'));
  assert.equal(next.advanced, true);
  assert.equal(next.config.retention_year_month, '2025-07');
  // 再次同月调用不再推进
  assert.equal(advanceRetentionCutoff(next.config, new Date('2026-09-15T00:00:00Z')).advanced, false);
});

test('retention：漏跑多个月自愈 snap 到正确目标', () => {
  const payload = { schema_version: 1, months: 14, retention_year_month: '2025-04', last_advanced_at: null };
  const result = advanceRetentionCutoff(payload, NOW); // 当前 2026-08 → 目标 2025-06，一次 snap 到位
  assert.equal(result.advanced, true);
  assert.equal(result.config.retention_year_month, '2025-06');
});

test('retention：readRetentionFromPayload 解析', () => {
  assert.deepEqual(readRetentionFromPayload({ retention_year_month: '2025-06', months: 14 }), {
    year_month: '2025-06', cutoff_date: '2025-06-01', months: 14,
  });
  assert.equal(readRetentionFromPayload({}).cutoff_date, null);
  assert.equal(readRetentionFromPayload({}).year_month, null);
});

test('retention：validateRetentionPayload 形状校验', () => {
  assert.equal(validateRetentionPayload({ schema_version: 1, months: 14, retention_year_month: '2025-06', last_advanced_at: null }), null);
  assert.ok(validateRetentionPayload({ schema_version: 1, months: 14, retention_year_month: '2025-06-01', last_advanced_at: null }), '日期型年月非法');
  assert.ok(validateRetentionPayload({ schema_version: 2, months: 14, retention_year_month: '2025-06', last_advanced_at: null }), 'schema_version 非 1');
  assert.ok(validateRetentionPayload({ schema_version: 1, months: 0, retention_year_month: '2025-06', last_advanced_at: null }), 'months 非正');
  assert.ok(validateRetentionPayload({ schema_version: 1, months: 14, retention_year_month: 'junk', last_advanced_at: null }), '年月非 YYYY-MM');
  assert.ok(validateRetentionPayload({ schema_version: 1, months: 14, retention_year_month: '2025-06', last_advanced_at: 123 }), 'last_advanced_at 非字符串');
});

test('retention：writeRetention 形状校验 fail-closed，非法不落盘', () => {
  const file = tempFile();
  assert.throws(() => writeRetention({ schema_version: 1, months: 0, retention_year_month: '2025-06' }, file), /RETENTION_INVALID/);
  assert.equal(fs.existsSync(file), false, '非法 payload 不得落盘');
});

test('retention：writeRetention 合法落盘 + readRetentionState 校验冻结', () => {
  const file = tempFile();
  writeRetention({ schema_version: 1, months: 14, retention_year_month: '2025-06', last_advanced_at: '2026-08-26T00:00:00.000Z' }, file);
  const state = readRetentionState(file);
  assert.equal(state.year_month, '2025-06');
  assert.equal(state.cutoff_date, '2025-06-01');
  assert.equal(state.months, 14);
  assert.equal(Object.isFrozen(state), true);
});

test('retention：readRetentionState 缺失/损坏回退默认', () => {
  const missing = readRetentionState(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-')), 'nope.json'));
  assert.equal(missing.cutoff_date, null);
  assert.equal(missing.year_month, null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-')), 'retention.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const corrupt = readRetentionState(file);
  assert.equal(corrupt.cutoff_date, null);
});

test('retention：advanceRetentionToNow 幂等 + 跨月推进写 + 写失败降级', () => {
  const file = tempFile();
  writeRetention({ schema_version: 1, months: 14, retention_year_month: '2025-06', last_advanced_at: null }, file);
  const idle = advanceRetentionToNow(new Date('2026-08-26T00:00:00Z'), file);
  assert.equal(idle.ok, true);
  assert.equal(idle.advanced, false);
  assert.equal(idle.year_month, '2025-06');
  assert.equal(idle.cutoff_date, '2025-06-01');
  const advanced = advanceRetentionToNow(new Date('2026-09-01T00:00:00Z'), file);
  assert.equal(advanced.ok, true);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.year_month, '2025-07');
  assert.equal(readRetentionState(file).year_month, '2025-07', '跨月推进已落盘');

  // 写失败降级：目标路径父级是普通文件，mkdirSync 失败 → 不抛、返回 ok:false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const failed = advanceRetentionToNow(new Date('2026-09-01T00:00:00Z'), path.join(blocker, 'retention.json'));
  assert.equal(failed.ok, false);
  assert.equal(failed.cutoff_date, null, '无旧状态时写失败沿用默认（不抛）');
});
