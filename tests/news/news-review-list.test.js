/**
 * news-review-list.test.js — 人工审核清单（review-list）测试
 *
 * 覆盖：
 *   buildReviewList（待审清单生成，文件名固定 review.json）：
 *     1. 只含 pending、每条带 id、评分倒序、写盘结构完整；
 *     2. 追加合并：清单已存在时保留人工结论并追加新 pending（按 id 去重），
 *        无新 pending 跳过不写盘；--force 强制重建。
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
const { buildReviewList, loadReviewList, applyReviewList, suggestReview } = require('../../src/news/min/review-list');

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
  // 文件名固定 review.json（去掉日期后缀）
  assert.ok(result.file.endsWith('review.json'));
  // 写盘可读、结构完整（kind / total_pending / candidates / human_lines）
  const written = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(written.kind, 'review_candidates');
  assert.equal(written.total_pending, 2);
  assert.equal(written.candidates.length, 2);
  assert.ok(Array.isArray(written.human_lines) && written.human_lines.length === 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildReviewList 追加合并：已存在清单保留人工结论并追加新 pending；无新则跳过；--force 强制重建', () => {
  const dir = tmpManual();
  const file = path.join(dir, 'review.json');
  // 模拟维护者已审核第一批：a1 approved、a2 pending
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    kind: 'review_candidates',
    date: '20260808',
    total_pending: 1,
    candidates: [
      { id: 'a1', review_status: 'approved', score: 70, summary: '摘要 A', suggestion: 'AI 产品/工具，建议 approved' },
      { id: 'a2', review_status: 'pending', score: 30, summary: '摘要 B', suggestion: 'AI 概念，建议看内容后定' },
    ],
    human_lines: [],
  }));
  // 第二次采集：候选层 a1 已 approved、a2 pending、新增 a3 pending
  const store2 = {
    schema_version: 1, updated_at: null,
    candidates: [
      { id: 'a1', title: 'AI 产品 A 发布', summary: '摘要 A', final_score: 70, review_status: 'approved', content_type: 'ai_product' },
      { id: 'a2', title: 'Day 5/100 学习打卡', summary: '摘要 B', final_score: 30, review_status: 'pending', content_type: 'ai_concept' },
      { id: 'a3', title: '新采集候选', summary: '摘要 C', final_score: 60, review_status: 'pending', content_type: 'ai_product' },
    ],
  };
  // 追加合并：保留 a1 approved、a2 已在清单，追加新 a3
  const merged = buildReviewList(store2, { manual_folder: dir }, { now: NOW });
  assert.equal(merged.skipped, false);
  assert.equal(merged.appended, 1);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.candidates.map(c => c.id), ['a1', 'a2', 'a3']);
  assert.equal(written.candidates[0].review_status, 'approved', '保留已有人工结论');
  assert.equal(written.candidates[2].review_status, 'pending', '新 pending 追加到尾部');
  assert.equal(written.total_pending, 2);
  // 清单无变化（再次运行同一候选层）→ 跳过不写盘
  const noNew = buildReviewList(store2, { manual_folder: dir }, { now: NOW });
  assert.equal(noNew.skipped, true);
  assert.equal(noNew.reason, 'no_new_pending');
  // force → 强制重建为最新 pending 清单
  const forced = buildReviewList(store2, { manual_folder: dir }, { now: NOW, force: true });
  assert.equal(forced.skipped, false);
  assert.equal(forced.replaced, true);
  const overwritten = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(overwritten.total_pending, 2);
  assert.ok(overwritten.candidates.every(c => c.review_status === 'pending'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadReviewList：读取并校验清单格式', () => {
  const dir = tmpManual();
  const file = path.join(dir, 'review.json');
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

test('suggestReview：不再按娱乐/二创关键词硬编码 discarded', () => {
  // L0 硬排除现由 YouTube 简介 AI 披露模板负责；review-list 不再猜测内容是否为娱乐。
  const suggestion = suggestReview({
    title: '【三角洲行动】AI剧情二创视频',
    content_type: 'ai_product',
  });
  assert.match(suggestion, /approved/);
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
