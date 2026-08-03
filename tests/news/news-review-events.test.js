/**
 * news-review-events.test.js — 追加式审核事件日志测试（B16 决策 70 另一半）
 *
 * 测试原理：
 *   不写真实数据文件，直接针对 src/news/core/news-review-events.js 的纯函数，
 *   验证追加式日志的关键不变量：
 *     1. 日志初始化与既有事件保留；
 *     2. appendReviewEvent 只追加、绝不改写或删除既有事件；
 *     3. reviewEventFromCandidate 生成决策 70 完整审计字段；
 *     4. 同一候选可有多条事件，构成完整状态流转历史（可追溯）。
 *
 * 运行方式：node --test tests/news/news-review-events.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REVIEW_EVENTS_SCHEMA_VERSION,
  createReviewEventLog,
  appendReviewEvent,
  reviewEventFromCandidate,
} = require('../../src/news/core/news-review-events');
const { stampCandidateStatuses } = require('../../src/news/core/news-candidates');

const NOW = '2026-08-03T08:00:00.000Z';

function baseItem(overrides = {}) {
  return {
    id: 'youtube-test-video',
    platform: 'youtube',
    content_type: 'youtube_video',
    title: '测试候选',
    url: 'https://www.youtube.com/watch?v=test',
    published_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

// ── 第 1 组：日志初始化 ─────────────────────────────────────

test('createReviewEventLog 空输入返回空日志起点', () => {
  const log = createReviewEventLog(null);
  assert.equal(log.schema_version, REVIEW_EVENTS_SCHEMA_VERSION);
  assert.equal(log.updated_at, null);
  assert.deepEqual(log.events, []);
});

test('createReviewEventLog 保留既有事件（读取时不做任何改写）', () => {
  const existing = { schema_version: 1, updated_at: NOW, events: [{ candidate_id: 'a' }] };
  const log = createReviewEventLog(existing);
  assert.equal(log.events.length, 1);
  assert.equal(log.updated_at, NOW);
});

test('createReviewEventLog 复制事件数组，不共享引用', () => {
  const existing = { schema_version: 1, updated_at: null, events: [{ candidate_id: 'a' }] };
  const log = createReviewEventLog(existing);
  log.events.push({ candidate_id: 'b' });
  assert.equal(existing.events.length, 1, '原数组不应被后续写入修改');
});

// ── 第 2 组：追加式不变量（决策 70）─────────────────────────

test('appendReviewEvent 只追加，不改写或删除既有事件', () => {
  const log = createReviewEventLog(null);
  const first = appendReviewEvent(log, { candidate_id: 'a', review_status: 'approved', reviewed_at: NOW });
  const second = appendReviewEvent(first, { candidate_id: 'a', review_status: 'held', reviewed_at: NOW });
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 2);
  assert.deepEqual(second.events.map(event => event.candidate_id), ['a', 'a']);
  assert.equal(second.events[0].review_status, 'approved'); // 历史事件保持原样
  assert.equal(second.events[1].review_status, 'held');
});

test('appendReviewEvent 不修改传入的 log 对象（纯函数）', () => {
  const log = createReviewEventLog(null);
  const next = appendReviewEvent(log, { candidate_id: 'a', review_status: 'approved' });
  assert.equal(log.events.length, 0, '输入 log 不应被修改');
  assert.equal(next.events.length, 1);
});

test('appendReviewEvent 为事件写入 logged_at 并维护 updated_at', () => {
  const log = appendReviewEvent(createReviewEventLog(null), {
    candidate_id: 'a', review_status: 'approved', reviewed_at: NOW, logged_at: NOW,
  });
  assert.equal(log.events[0].logged_at, NOW);
  assert.equal(log.updated_at, NOW);
});

test('appendReviewEvent 的 updated_at 始终指向最近一次事件', () => {
  const later = '2026-08-03T10:00:00.000Z';
  const first = appendReviewEvent(createReviewEventLog(null), {
    candidate_id: 'a', review_status: 'approved', reviewed_at: NOW, logged_at: NOW,
  });
  const second = appendReviewEvent(first, {
    candidate_id: 'b', review_status: 'held', reviewed_at: NOW, logged_at: later,
  });
  assert.equal(second.updated_at, later);
});

test('appendReviewEvent 缺少 candidate_id 时抛错', () => {
  assert.throws(() => appendReviewEvent(createReviewEventLog(null), { review_status: 'approved' }), /candidate_id/);
});

// ── 第 3 组：决策 70 完整审计字段 ───────────────────────────

test('reviewEventFromCandidate 生成决策 70 完整字段', () => {
  const candidate = stampCandidateStatuses(baseItem({ batch_id: 'batch_20260801' }));
  // 模拟一次已完成的流转（from_status / reviewed_at / candidate_version 已写入候选）
  candidate.from_status = 'approved';
  candidate.review_status = 'held';
  candidate.review_reason = '等待来源';
  candidate.reviewer = 'alice';
  candidate.reviewed_at = NOW;
  candidate.candidate_version = 2;

  const event = reviewEventFromCandidate(candidate, { action: 'review_set' });
  assert.equal(event.candidate_id, 'youtube-test-video');
  assert.equal(event.action, 'review_set');
  assert.equal(event.from_status, 'approved');
  assert.equal(event.review_status, 'held');
  assert.equal(event.review_reason, '等待来源');
  assert.equal(event.reviewer, 'alice');
  assert.equal(event.reviewed_at, NOW);
  assert.equal(event.candidate_version, 2);
  assert.equal(event.batch_id, 'batch_20260801');
});

test('reviewEventFromCandidate 显式参数优先于候选字段', () => {
  const candidate = stampCandidateStatuses(baseItem());
  candidate.from_status = 'approved';
  candidate.review_status = 'discarded';
  candidate.reviewer = 'alice';
  candidate.reviewed_at = NOW;
  candidate.candidate_version = 2;
  const event = reviewEventFromCandidate(candidate, { action: 'review_batch', reviewer: 'bob', now: NOW });
  assert.equal(event.reviewer, 'bob'); // 显式 reviewer 优先
  assert.equal(event.action, 'review_batch');
});

test('同一候选多条事件构成完整流转历史（可追溯）', () => {
  const log = createReviewEventLog(null);
  let candidate = stampCandidateStatuses(baseItem());
  candidate.batch_id = 'batch_20260801';
  const approvedEvent = appendReviewEvent(log, reviewEventFromCandidate({ ...candidate, from_status: 'pending', review_status: 'approved', reviewer: 'alice', reviewed_at: NOW, candidate_version: 2 }, { action: 'review_set' }));
  const heldEvent = appendReviewEvent(approvedEvent, reviewEventFromCandidate({ ...candidate, from_status: 'approved', review_status: 'held', reviewer: 'bob', reviewed_at: NOW, candidate_version: 3 }, { action: 'review_set' }));
  assert.equal(heldEvent.events.length, 2);
  assert.deepEqual(heldEvent.events.map(event => event.review_status), ['approved', 'held']);
  assert.deepEqual(heldEvent.events.map(event => event.candidate_version), [2, 3]);
  assert.deepEqual(heldEvent.events.map(event => event.from_status), ['pending', 'approved']);
});
