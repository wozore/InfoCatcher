/**
 * news-review-list.test.js — 人工审核清单（review-list）测试
 *
 * 覆盖：
 *   buildReviewList（待审清单生成）：
 *     1. 只含 pending、每条带 id、评分倒序、写盘结构完整；
 *     2. 覆盖保护：目标清单已含人工结论不覆盖；--force 强制覆盖。
 *   loadReviewList：读取 + 校验 kind/candidates 格式。
 *   applyReviewList（审核结论应用）：
 *     3. pending 跳过，approved/discarded 批量写回（reviewed_at 刷新）；
 *     4. 无 id 条目（旧格式）抛错拒绝；
 *     5. 未命中 id 报告 + 状态相同跳过（幂等）；
 *     6. 非法 review_status 计入 invalid。
 *
 * 运行方式：node --test tests/news/news-review-list.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReviewList, loadReviewList, applyReviewList } = require('../../src/news/min/review-list');

/** 临时 manual 目录（buildReviewList 写盘目标），每测试独立，避免污染 data/manual/。 */
function tmpManual() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-list-test-'));
}

/** 候选层 store（a1 pending 高分 / a2 pending 低分 / a3 已 approved）。 */
function makeStore() {
  return {
    schema_version: 1,
    updated_at: '2026-08-08T00:00:00.000Z',
    candidates: [
      { id: 'a1', title: 'AI 产品 A 发布', summary: '摘要 A', final_score: 70, review_status: 'pending', content_type: 'ai_product' },
      { id: 'a2', title: 'Day 5/100 学习打卡', summary: '摘要 B', final_score: 30, review_status: 'pending', content_type: 'ai_concept' },
      { id: 'a3', title: '已审候选', summary: '摘要 C', final_score: 60, review_status: 'approved', content_type: 'ai_product' },
    ],
  };
}

const NOW = new Date('2026-08-08T12:00:00Z');

test('buildReviewList：只含 pending、带 id、评分倒序、写盘结构完整', () => {
  const dir = tmpManual();
  const result = buildReviewList(makeStore(), { manual_folder: dir }, { now: NOW });
  assert.equal(result.skipped, false);
  assert.equal(result.total_pending, 2);
  // 只含 pending（a1/a2），已 approved 的 a3 不进清单
  assert.deepEqual(result.candidates.map(c => c.id), ['a1', 'a2']);
  // 评分倒序：a1(70) 在前
  assert.equal(result.candidates[0].id, 'a1');
  // 每条带 id（新格式，apply 直连定位）
  assert.ok(result.candidates.every(c => typeof c.id === 'string' && c.id.length > 0));
  // 文件名含日期
  assert.ok(result.file.endsWith('review-20260808.json'));
  // 写盘可读、结构完整（kind / total_pending / candidates / human_lines）
  const written = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(written.kind, 'review_candidates');
  assert.equal(written.total_pending, 2);
  assert.equal(written.candidates.length, 2);
  assert.ok(Array.isArray(written.human_lines) && written.human_lines.length === 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildReviewList 覆盖保护：已含人工结论不覆盖；--force 强制覆盖', () => {
  const dir = tmpManual();
  const file = path.join(dir, 'review-20260808.json');
  // 模拟维护者已编辑：清单里已有 approved 结论
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    kind: 'review_candidates',
    date: '20260808',
    total_pending: 1,
    candidates: [{ id: 'a1', review_status: 'approved', score: 70, summary: '摘要 A', suggestion: 'AI 产品/工具，建议 approved' }],
    human_lines: [],
  }));
  // 不传 force → 跳过不覆盖（保留人工结论）
  const skipped = buildReviewList(makeStore(), { manual_folder: dir }, { now: NOW });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'existing_reviewed');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.candidates[0].review_status, 'approved');
  // force → 覆盖为最新 pending 清单
  const forced = buildReviewList(makeStore(), { manual_folder: dir }, { now: NOW, force: true });
  assert.equal(forced.skipped, false);
  const overwritten = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(overwritten.total_pending, 2);
  assert.ok(overwritten.candidates.every(c => c.review_status === 'pending'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadReviewList：读取并校验清单格式', () => {
  const dir = tmpManual();
  const file = path.join(dir, 'review-20260808.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, kind: 'review_candidates', candidates: [{ id: 'a1' }] }));
  const list = loadReviewList(file);
  assert.equal(list.kind, 'review_candidates');
  assert.equal(list.candidates.length, 1);
  // 非法清单（kind 不符 / 缺 candidates）抛错
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, kind: 'other' }));
  assert.throws(() => loadReviewList(file), /非法待审清单/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyReviewList：pending 跳过，approved/discarded 批量写回（reviewed_at 刷新）', () => {
  const store = makeStore();
  const list = {
    kind: 'review_candidates',
    candidates: [
      { id: 'a1', review_status: 'approved', score: 70, summary: '摘要 A' },
      { id: 'a2', review_status: 'discarded', score: 30, summary: '摘要 B' },
      { id: 'a3', review_status: 'pending', score: 60, summary: '摘要 C' }, // 清单标 pending → 跳过
    ],
  };
  const result = applyReviewList(store, list);
  assert.equal(result.applied.approved, 1);
  assert.equal(result.applied.discarded, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.changed, 2);
  const out = result.store.candidates;
  assert.equal(out.find(c => c.id === 'a1').review_status, 'approved');
  assert.equal(out.find(c => c.id === 'a2').review_status, 'discarded');
  assert.ok(out.find(c => c.id === 'a1').reviewed_at);
  assert.ok(out.find(c => c.id === 'a2').reviewed_at);
  // a3 未被触碰（保留原 approved）
  assert.equal(out.find(c => c.id === 'a3').review_status, 'approved');
});

test('applyReviewList：无 id 条目（旧格式）抛错拒绝', () => {
  const store = makeStore();
  const list = {
    kind: 'review_candidates',
    candidates: [
      { review_status: 'approved', score: 70, summary: '摘要 A' }, // 无 id（旧格式）
    ],
  };
  assert.throws(() => applyReviewList(store, list), /旧格式/);
});

test('applyReviewList：未命中 id 报告 + 状态相同跳过（幂等）', () => {
  const store = makeStore();
  const list = {
    kind: 'review_candidates',
    candidates: [
      { id: 'a3', review_status: 'approved' },  // 状态相同 → noop（不刷新 reviewed_at）
      { id: 'a9', review_status: 'discarded' }, // 未命中 → missing
      { id: 'a1', review_status: 'approved' },  // 新应用
    ],
  };
  const result = applyReviewList(store, list);
  assert.equal(result.applied.approved, 1);
  assert.equal(result.noop, 1);
  assert.deepEqual(result.missing, ['a9']);
  assert.equal(result.changed, 1);
});

test('applyReviewList：非法 review_status 计入 invalid，不写回', () => {
  const store = makeStore();
  const list = {
    kind: 'review_candidates',
    candidates: [
      { id: 'a1', review_status: 'weird' },
    ],
  };
  const result = applyReviewList(store, list);
  assert.equal(result.invalid, 1);
  assert.equal(result.changed, 0);
  assert.equal(result.store.candidates.find(c => c.id === 'a1').review_status, 'pending');
});
