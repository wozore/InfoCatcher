/**
 * news-audit.test.js — 审核审计字段测试（B16 决策 70）
 *
 * 验证审核流转写入完整审计字段：
 *   review_reason / reviewer / reviewed_at / from_status / candidate_version；
 *   batch_id（所属抓取批次）由采集时打上，审核流转不覆盖；
 *   公开投影剔除全部内部字段（含审计字段与字幕字段，决策 77/52/70）。
 *
 * 运行方式：node --test tests/news/news-audit.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCandidateStore,
  stampCandidateStatuses,
  mergeCandidates,
  toPublicItem,
  applyReviewTransition,
  setReviewStatus,
  setBatchReviewStatus,
  markHeld,
} = require('../../src/news/core/news-candidates');

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

function storeWith(items) {
  const store = createCandidateStore(null);
  store.candidates = items;
  return store;
}

const NOW = '2026-08-03T08:00:00.000Z';

// ── 第 1 组：applyReviewTransition ───────────────────────────

test('applyReviewTransition 写入 from_status / reviewed_at / candidate_version 递增', () => {
  const candidate = stampCandidateStatuses(baseItem());
  applyReviewTransition(candidate, 'held', { reason: '等待来源', reviewer: 'alice', now: NOW });
  assert.equal(candidate.from_status, 'pending');       // 变更前状态（新候选默认 pending）
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.review_reason, '等待来源');
  assert.equal(candidate.reviewer, 'alice');
  assert.equal(candidate.reviewed_at, NOW);
  assert.equal(candidate.candidate_version, 2);          // 初版 1 → 流转后 2
});

test('applyReviewTransition 连续流转 candidate_version 递增且 from_status 追踪上一状态', () => {
  const candidate = stampCandidateStatuses(baseItem());
  applyReviewTransition(candidate, 'held', { reviewer: 'alice', now: NOW });
  assert.equal(candidate.candidate_version, 2);
  assert.equal(candidate.from_status, 'pending');
  applyReviewTransition(candidate, 'approved', { reviewer: 'bob', now: NOW });
  assert.equal(candidate.candidate_version, 3);
  assert.equal(candidate.from_status, 'held');
  assert.equal(candidate.reviewer, 'bob');
});

test('applyReviewTransition 不覆盖已打上的 batch_id', () => {
  const candidate = stampCandidateStatuses({ ...baseItem(), batch_id: 'batch_20260803' });
  applyReviewTransition(candidate, 'held', { reviewer: 'alice', now: NOW });
  assert.equal(candidate.batch_id, 'batch_20260803');
});

// ── 第 2 组：setReviewStatus / setBatchReviewStatus ──────────

test('setReviewStatus 写入完整审计字段', () => {
  const store = storeWith([stampCandidateStatuses(baseItem())]);
  const next = setReviewStatus(store, 'youtube-test-video', 'discarded', {
    reason: '规则误判', reviewer: 'reviewer-1', now: NOW,
  });
  const candidate = next.candidates[0];
  assert.equal(candidate.review_status, 'discarded');
  assert.equal(candidate.review_reason, '规则误判');
  assert.equal(candidate.reviewer, 'reviewer-1');
  assert.equal(candidate.reviewed_at, NOW);
  assert.equal(candidate.from_status, 'pending');
  assert.equal(candidate.candidate_version, 2);
});

test('setReviewStatus 缺省 reviewer/now 时仍写 reviewed_at 与递增版本', () => {
  const store = storeWith([stampCandidateStatuses(baseItem())]);
  const next = setReviewStatus(store, 'youtube-test-video', 'held', { reason: '待复审' });
  const candidate = next.candidates[0];
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.reviewer, undefined);                 // 未提供则不写
  assert.ok(Number.isFinite(new Date(candidate.reviewed_at).getTime())); // 缺省为当前时间
  assert.equal(candidate.from_status, 'pending');
  assert.equal(candidate.candidate_version, 2);
});

test('setReviewStatus 流转到 held 时同时记录 hold_reason（决策 50 一致性）', () => {
  const store = storeWith([stampCandidateStatuses(baseItem())]);
  const next = setReviewStatus(store, 'youtube-test-video', 'held', { reason: '等待官方来源', reviewer: 'alice', now: NOW });
  const candidate = next.candidates[0];
  assert.equal(candidate.review_reason, '等待官方来源');       // 决策 70
  assert.equal(candidate.hold_reason, '等待官方来源');         // 决策 50
});

test('setBatchReviewStatus 逐条写入审计字段且不互相影响', () => {
  const store = storeWith([
    stampCandidateStatuses(baseItem({ id: 'a' })),
    stampCandidateStatuses(baseItem({ id: 'b' })),
    stampCandidateStatuses(baseItem({ id: 'c' })),
  ]);
  const result = setBatchReviewStatus(store, ['a', 'b', 'c'], 'approved', { reviewer: 'batch-reviewer', now: NOW });
  assert.equal(result.updated, 3);
  for (const id of ['a', 'b', 'c']) {
    const candidate = result.store.candidates.find(item => item.id === id);
    assert.equal(candidate.review_status, 'approved');
    assert.equal(candidate.reviewer, 'batch-reviewer');
    assert.equal(candidate.reviewed_at, NOW);
    assert.equal(candidate.from_status, 'pending'); // 新候选默认 pending，from_status 为变更前状态
    assert.equal(candidate.candidate_version, 2);
  }
});

// ── 第 3 组：markHeld 审计字段 ──────────────────────────────

test('markHeld 写入 held + hold_reason + 审计字段，不影响 ai_processing_status', () => {
  const candidate = markHeld(stampCandidateStatuses(baseItem()), {
    reason: '字幕缺失', reviewer: 'alice', now: NOW,
  });
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.hold_reason, '字幕缺失');
  assert.equal(candidate.reviewer, 'alice');
  assert.equal(candidate.reviewed_at, NOW);
  assert.equal(candidate.from_status, 'pending'); // 新候选默认 pending
  assert.equal(candidate.candidate_version, 2);
  assert.equal(candidate.ai_processing_status, 'completed');
});

// ── 第 4 组：mergeCandidates 保留版本号与批次号 ──────────────

test('mergeCandidates 重新采集保留 candidate_version 与 batch_id，不因内容刷新重置', () => {
  const existing = storeWith([stampCandidateStatuses(
    { ...baseItem({ title: '旧标题' }), candidate_version: 5, batch_id: 'batch_20260801' },
    { review_status: 'held' },
  )]);
  const incoming = stampCandidateStatuses({
    ...baseItem({ title: '新标题' }),
    candidate_version: 1,
    batch_id: 'batch_20260802',
  });
  const store = mergeCandidates(existing, [incoming], '2026-08-03T00:00:00Z');
  const candidate = store.candidates[0];
  assert.equal(candidate.title, '新标题');                 // 内容字段被覆盖
  assert.equal(candidate.candidate_version, 5);            // 版本号保留（只随审核递增）
  assert.equal(candidate.batch_id, 'batch_20260801');      // 所属抓取批次保留
  assert.equal(candidate.review_status, 'held');           // 人工结论保留
});

// ── 第 5 组：toPublicItem 剔除全部内部字段 ───────────────────

test('toPublicItem 剔除审计字段与字幕字段，保留公开字段', () => {
  const candidate = stampCandidateStatuses({
    ...baseItem(),
    reviewer: 'alice',
    reviewed_at: NOW,
    from_status: 'pending',
    candidate_version: 3,
    batch_id: 'batch_20260801',
    hold_reason: '字幕缺失',
    error_type: 'transcript_fetch_failed',
    retryable: true,
    retry_count: 1,
    transcript: { source_type: 'youtube_timedtext', fingerprint: 'x'.repeat(64), chars: 100 },
    transcript_status: 'ok',
    transcript_evidence: '……证据片段……',
    description: '公开描述',
  });
  const publicItem = toPublicItem(candidate);
  for (const key of [
    'review_status', 'ai_processing_status', 'review_reason', 'reviewer', 'reviewed_at',
    'from_status', 'candidate_version', 'batch_id', 'hold_reason', 'error_type',
    'retryable', 'retry_count', 'transcript', 'transcript_status', 'transcript_evidence',
  ]) {
    assert.equal(publicItem[key], undefined, `${key} 不应出现在公开项`);
  }
  assert.equal(publicItem.title, '测试候选');
  assert.equal(publicItem.description, '公开描述');
});
