/**
 * news-candidates.test.js — 内部候选层与公开资格门禁测试（B16 决策 49/69）
 *
 * 测试原理：
 *   这些测试不请求真实 API，直接针对 src/news/core/news-candidates.js 的纯函数，
 *   验证两层数据流程的关键不变量：
 *     1. 候选层初始化与合并（按 id 积累、保留既有人工/处理状态）；
 *     2. 双状态轴枚举合法性；
 *     3. 公开资格门禁只放行 completed + approved；
 *     4. 公开投影剔除内部状态字段，并过滤关联事件/溯源/评分。
 *
 * 运行方式：node --test tests/news/news-candidates.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_PROCESSING_STATUSES,
  REVIEW_STATUSES,
  DEFAULT_AI_PROCESSING_STATUS,
  DEFAULT_REVIEW_STATUS,
  createCandidateStore,
  stampCandidateStatuses,
  mergeCandidates,
  isPublicEligible,
  selectPublicEligible,
  toPublicItem,
  buildPublicProjection,
  assertValidReviewStatus,
  assertCanApprove,
  setReviewStatus,
  setBatchReviewStatus,
  markHeld,
  markAiError,
  reviewSummary,
  attachProjectionSnapshot,
  buildProjectionFromStore,
  LEGACY_ORIGINAL_SOURCE,
  convertLegacyHotspotToCandidate,
  importLegacyHotspots,
  legacySummary,
} = require('../../src/news/core/news-candidates');

function baseItem(overrides = {}) {
  return {
    id: 'x-item-1',
    platform: 'x',
    content_type: 'x_post',
    title: '测试候选',
    url: 'https://x.com/test/status/1',
    published_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

// ── 第 1 组：双状态轴与候选初始化 ────────────────────────────

test('双状态轴枚举与决策 16 一致', () => {
  assert.deepEqual(AI_PROCESSING_STATUSES, ['not_requested', 'queued', 'processing', 'completed', 'error']);
  assert.deepEqual(REVIEW_STATUSES, ['pending', 'approved', 'held', 'discarded']);
  assert.equal(DEFAULT_AI_PROCESSING_STATUS, 'completed');
  assert.equal(DEFAULT_REVIEW_STATUS, 'approved');
});

test('createCandidateStore 空输入返回空候选层', () => {
  const store = createCandidateStore(null);
  assert.equal(store.schema_version, 1);
  assert.deepEqual(store.candidates, []);
  assert.equal(store.updated_at, null);
});

test('createCandidateStore 保留既有候选', () => {
  const existing = { schema_version: 1, updated_at: '2026-07-01T00:00:00Z', candidates: [baseItem()] };
  const store = createCandidateStore(existing);
  assert.equal(store.candidates.length, 1);
  assert.equal(store.updated_at, '2026-07-01T00:00:00Z');
});

test('stampCandidateStatuses 写入桥接默认双状态轴', () => {
  const candidate = stampCandidateStatuses(baseItem());
  assert.equal(candidate.review_status, 'approved');
  assert.equal(candidate.ai_processing_status, 'completed');
  assert.equal(candidate.id, 'x-item-1');
});

test('stampCandidateStatuses 支持显式状态覆盖（测试/审核流注入）', () => {
  const candidate = stampCandidateStatuses(baseItem(), { review_status: 'held', ai_processing_status: 'error' });
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.ai_processing_status, 'error');
});

// ── 第 2 组：候选合并（决策 49/55/70）────────────────────────

test('mergeCandidates 新候选使用桥接默认', () => {
  const store = mergeCandidates(null, [stampCandidateStatuses(baseItem())], '2026-07-20T00:00:00Z');
  assert.equal(store.candidates.length, 1);
  assert.equal(store.candidates[0].review_status, 'approved');
  assert.equal(store.candidates[0].ai_processing_status, 'completed');
  assert.equal(store.updated_at, '2026-07-20T00:00:00Z');
});

test('mergeCandidates 重新采集不重置既有人工审核结论', () => {
  const existing = createCandidateStore(null);
  existing.candidates = [stampCandidateStatuses(baseItem({ title: '旧标题' }), { review_status: 'discarded' })];
  const store = mergeCandidates(existing, [stampCandidateStatuses(baseItem({ title: '新标题' }))], '2026-07-21T00:00:00Z');
  assert.equal(store.candidates.length, 1);
  assert.equal(store.candidates[0].title, '新标题');          // 内容字段被新采集覆盖
  assert.equal(store.candidates[0].review_status, 'discarded'); // 人工结论保留
});

test('mergeCandidates 按 id 积累不同候选', () => {
  const store = mergeCandidates(null, [stampCandidateStatuses(baseItem()), stampCandidateStatuses(baseItem({ id: 'x-item-2' }))], '2026-07-20T00:00:00Z');
  assert.equal(store.candidates.length, 2);
});

// ── 第 3 组：公开资格门禁（决策 69）──────────────────────────

test('isPublicEligible 仅放行 completed + approved', () => {
  assert.equal(isPublicEligible({ ai_processing_status: 'completed', review_status: 'approved' }), true);
  assert.equal(isPublicEligible({ ai_processing_status: 'completed', review_status: 'held' }), false);
  assert.equal(isPublicEligible({ ai_processing_status: 'completed', review_status: 'discarded' }), false);
  assert.equal(isPublicEligible({ ai_processing_status: 'completed', review_status: 'pending' }), false);
  assert.equal(isPublicEligible({ ai_processing_status: 'error', review_status: 'approved' }), false);
  assert.equal(isPublicEligible({ ai_processing_status: 'processing', review_status: 'approved' }), false);
  assert.equal(isPublicEligible(null), false);
});

test('selectPublicEligible 从混合候选筛出合格项', () => {
  const candidates = [
    stampCandidateStatuses(baseItem({ id: 'pass' })),
    stampCandidateStatuses(baseItem({ id: 'held' }), { review_status: 'held' }),
    stampCandidateStatuses(baseItem({ id: 'error' }), { ai_processing_status: 'error' }),
  ];
  const eligible = selectPublicEligible(candidates).map(candidate => candidate.id);
  assert.deepEqual(eligible, ['pass']);
});

test('系统失败(error)与人工决定(discarded)分属不同轴，互不覆盖', () => {
  // 同一条候选可以 error 但 pending（系统失败待人工处理），也可 completed 但 discarded（人工拒绝）。
  assert.equal(isPublicEligible({ ai_processing_status: 'error', review_status: 'pending' }), false);
  assert.equal(isPublicEligible({ ai_processing_status: 'completed', review_status: 'discarded' }), false);
});

// ── 第 4 组：公开投影构建（决策 49/77）───────────────────────

test('toPublicItem 剔除内部状态字段', () => {
  const publicItem = toPublicItem(stampCandidateStatuses(baseItem()));
  assert.equal(publicItem.review_status, undefined);
  assert.equal(publicItem.ai_processing_status, undefined);
  assert.equal(publicItem.title, '测试候选');
});

test('buildPublicProjection 只输出合格候选并过滤关联记录', () => {
  const pass = stampCandidateStatuses(baseItem({ id: 'pass' }));
  const held = stampCandidateStatuses(baseItem({ id: 'held' }), { review_status: 'held' });
  const output = buildPublicProjection({
    candidates: [pass, held],
    events: [
      { id: 'e1', content_ids: ['pass', 'held'] },
      { id: 'e2', content_ids: ['held'] },
    ],
    provenance: [
      { content_id: 'pass', relation: 'original' },
      { content_id: 'held', relation: 'original' },
    ],
    assessments: [
      { content_id: 'pass', score: 80 },
      { content_id: 'held', score: 40 },
    ],
    coverage: { status: 'complete' },
    generatedAt: '2026-07-20T00:00:00Z',
    heatDefinition: 'heat',
  });

  assert.equal(output.schema_version, 2);
  assert.equal(output.generated_at, '2026-07-20T00:00:00Z');
  assert.equal(output.heat_definition, 'heat');
  assert.deepEqual(output.items.map(item => item.id), ['pass']);
  assert.equal(output.items[0].review_status, undefined); // 公开项不含内部状态
  assert.deepEqual(output.events.map(event => event.id), ['e1']);
  assert.deepEqual(output.provenance.map(relation => relation.content_id), ['pass']);
  assert.deepEqual(output.assessments.map(assessment => assessment.content_id), ['pass']);
  assert.deepEqual(output.coverage, { status: 'complete' });
});

// ── 第 5 组：审核状态操作（决策 48/50/55/56/57/69）──────────────────

test('assertValidReviewStatus 拒绝非法状态值', () => {
  assert.throws(() => assertValidReviewStatus('published'), /非法审核状态/);
  assert.doesNotThrow(() => assertValidReviewStatus('approved'));
  assert.doesNotThrow(() => assertValidReviewStatus('held'));
  assert.doesNotThrow(() => assertValidReviewStatus('discarded'));
});

test('assertCanApprove 拒绝 AI 未完成的候选', () => {
  assert.doesNotThrow(() => assertCanApprove(stampCandidateStatuses(baseItem())));
  assert.throws(() => assertCanApprove(stampCandidateStatuses(baseItem(), { ai_processing_status: 'error' })), /决策 69/);
  assert.throws(() => assertCanApprove(stampCandidateStatuses(baseItem(), { ai_processing_status: 'processing' })), /决策 69/);
});

test('setReviewStatus 单条设置并写入可选 review_reason', () => {
  const store = createCandidateStore(null);
  store.candidates = [stampCandidateStatuses(baseItem())];
  const next = setReviewStatus(store, 'x-item-1', 'held', { reason: '等待官方来源' });
  assert.equal(next.candidates[0].review_status, 'held');
  assert.equal(next.candidates[0].review_reason, '等待官方来源');
});

test('setReviewStatus 未命中候选抛错', () => {
  const store = createCandidateStore(null);
  assert.throws(() => setReviewStatus(store, 'nope', 'held'), /候选不存在/);
});

test('setReviewStatus 禁止 AI 未完成时 approved，但可流转到其他状态', () => {
  const store = createCandidateStore(null);
  store.candidates = [stampCandidateStatuses(baseItem(), { ai_processing_status: 'error' })];
  assert.throws(() => setReviewStatus(store, 'x-item-1', 'approved'), /决策 69/);
  const next = setReviewStatus(store, 'x-item-1', 'discarded');
  assert.equal(next.candidates[0].review_status, 'discarded');
});

test('setBatchReviewStatus 只处理显式列出的 ids 并逐条报告（决策 56）', () => {
  const store = createCandidateStore(null);
  store.candidates = [
    stampCandidateStatuses(baseItem({ id: 'a' })),
    stampCandidateStatuses(baseItem({ id: 'b' }), { ai_processing_status: 'error', review_status: 'pending' }),
    stampCandidateStatuses(baseItem({ id: 'c' })),
  ];
  const result = setBatchReviewStatus(store, ['a', 'b', 'c', 'ghost'], 'approved');
  assert.equal(result.updated, 2);                                    // a、c 通过
  assert.deepEqual(result.blocked.map(item => item.id), ['b']);       // b 被 AI 未完成拒绝
  assert.deepEqual(result.missing, ['ghost']);                        // 未命中逐条报告
  assert.equal(result.store.candidates.find(item => item.id === 'a').review_status, 'approved');
  assert.equal(result.store.candidates.find(item => item.id === 'b').review_status, 'pending'); // 拒绝后保持原状态，未被覆盖
});

test('markHeld 写入 held + hold_reason，不影响 ai_processing_status', () => {
  const candidate = markHeld(stampCandidateStatuses(baseItem()), { reason: '字幕缺失' });
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.hold_reason, '字幕缺失');
  assert.equal(candidate.ai_processing_status, 'completed');
});

test('markAiError 写入 error + 错误字段，不覆盖 review_status', () => {
  const candidate = markAiError(stampCandidateStatuses(baseItem(), { review_status: 'pending' }), {
    errorType: 'transcript_unavailable', retryable: true, retryCount: 1,
  });
  assert.equal(candidate.ai_processing_status, 'error');
  assert.equal(candidate.error_type, 'transcript_unavailable');
  assert.equal(candidate.retryable, true);
  assert.equal(candidate.retry_count, 1);
  assert.equal(candidate.review_status, 'pending');
});

test('reviewSummary 统计状态分布', () => {
  const store = createCandidateStore(null);
  store.candidates = [
    stampCandidateStatuses(baseItem({ id: 'a' })),
    stampCandidateStatuses(baseItem({ id: 'b' }), { review_status: 'held' }),
    stampCandidateStatuses(baseItem({ id: 'c' }), { review_status: 'discarded' }),
  ];
  const summary = reviewSummary(store);
  assert.equal(summary.total, 3);
  assert.equal(summary.by_review_status.approved, 1);
  assert.equal(summary.by_review_status.held, 1);
  assert.equal(summary.by_review_status.discarded, 1);
  assert.equal(summary.by_ai_processing_status.completed, 3);
});

// ── 第 6 组：投影快照与从候选层重建（决策 49/59）──────────────────

test('attachProjectionSnapshot 存入选集重建所需的关联记录', () => {
  const store = attachProjectionSnapshot(createCandidateStore(null), {
    events: [{ id: 'e1' }],
    provenance: [{ content_id: 'x' }],
    assessments: [{ content_id: 'x' }],
    coverage: { status: 'complete' },
    heatDefinition: 'heat',
  });
  assert.equal(store.events.length, 1);
  assert.equal(store.coverage.status, 'complete');
  assert.equal(store.heat_definition, 'heat');
});

test('createCandidateStore 保留投影快照（向后兼容）', () => {
  const store = attachProjectionSnapshot(createCandidateStore(null), {
    events: [{ id: 'e1' }], coverage: { status: 'complete' }, heatDefinition: 'heat',
  });
  store.candidates = [stampCandidateStatuses(baseItem())];
  const round = createCandidateStore(store);
  assert.equal(round.events.length, 1);
  assert.equal(round.coverage.status, 'complete');
  assert.equal(round.heat_definition, 'heat');
  assert.equal(round.candidates.length, 1);
});

test('buildProjectionFromStore 从快照重建，只含 completed + approved', () => {
  const store = createCandidateStore(null);
  store.candidates = [
    stampCandidateStatuses(baseItem({ id: 'pass' })),
    stampCandidateStatuses(baseItem({ id: 'held' }), { review_status: 'held' }),
  ];
  attachProjectionSnapshot(store, {
    events: [
      { id: 'e1', content_ids: ['pass', 'held'] },
      { id: 'e2', content_ids: ['held'] },
    ],
    provenance: [{ content_id: 'pass', relation: 'original' }],
    assessments: [{ content_id: 'pass', score: 80 }],
    coverage: { status: 'complete' },
    heatDefinition: 'heat',
  });
  store.updated_at = '2026-07-20T00:00:00Z';
  const output = buildProjectionFromStore(store, { generatedAt: '2026-07-21T00:00:00Z' });
  assert.equal(output.schema_version, 2);
  assert.equal(output.generated_at, '2026-07-21T00:00:00Z');
  assert.equal(output.heat_definition, 'heat');
  assert.deepEqual(output.items.map(item => item.id), ['pass']);
  assert.equal(output.items[0].review_status, undefined);
  assert.deepEqual(output.events.map(event => event.id), ['e1']);
  assert.deepEqual(output.assessments.map(assessment => assessment.content_id), ['pass']);
  assert.deepEqual(output.coverage, { status: 'complete' });
});

// ── 第 7 组：legacy 旧热点迁移（决策 64）──────────────────────

test('convertLegacyHotspotToCandidate 标记 legacy 并以 pending 进入待审核流程', () => {
  const candidate = convertLegacyHotspotToCandidate(baseItem({ id: 'legacy-1' }));
  assert.equal(candidate.legacy, true);
  assert.equal(candidate.original_source, LEGACY_ORIGINAL_SOURCE);
  assert.equal(candidate.review_status, 'pending');          // 不自动公开，等待人工审核
  assert.equal(candidate.ai_processing_status, 'completed'); // 旧数据是既有处理产物
  assert.equal(candidate.id, 'legacy-1');
  assert.equal(candidate.title, '测试候选');                  // 内容字段保留
});

test('convertLegacyHotspotToCandidate 支持显式覆盖（测试/审核流注入）', () => {
  const candidate = convertLegacyHotspotToCandidate(baseItem({ id: 'legacy-2' }), {
    review_status: 'held', original_source: '自定义来源',
  });
  assert.equal(candidate.review_status, 'held');
  assert.equal(candidate.original_source, '自定义来源');
});

test('convertLegacyHotspotToCandidate 缺 id 返回 null', () => {
  assert.equal(convertLegacyHotspotToCandidate(null), null);
  assert.equal(convertLegacyHotspotToCandidate({ title: '无 id' }), null);
});

test('importLegacyHotspots 把旧数据导入候选层，不自动公开', () => {
  const result = importLegacyHotspots(null, [
    baseItem({ id: 'legacy-a' }),
    baseItem({ id: 'legacy-b' }),
  ], { now: '2026-08-01T00:00:00Z' });
  assert.deepEqual(result.imported.sort(), ['legacy-a', 'legacy-b']);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.store.candidates.length, 2);
  assert.equal(result.store.candidates[0].review_status, 'pending'); // 全部待审核
  assert.equal(result.store.updated_at, '2026-08-01T00:00:00Z');
});

test('importLegacyHotspots 跳过候选层中已存在的 id，保持其既有审核结论', () => {
  const existing = createCandidateStore(null);
  existing.candidates = [stampCandidateStatuses(baseItem({ id: 'already' }))]; // 已由新管线写入 approved
  const result = importLegacyHotspots(existing, [
    baseItem({ id: 'already' }),
    baseItem({ id: 'fresh-legacy' }),
  ], { now: '2026-08-01T00:00:00Z' });
  assert.deepEqual(result.imported, ['fresh-legacy']);
  assert.deepEqual(result.skipped, ['already']);
  // 已存在候选保持原状（approved），不被迁移覆盖为 pending
  assert.equal(result.store.candidates.find(item => item.id === 'already').review_status, 'approved');
  assert.equal(result.store.candidates.find(item => item.id === 'fresh-legacy').review_status, 'pending');
});

test('legacy 迁移后的候选不通过公开资格门禁（pending 不公开）', () => {
  const store = importLegacyHotspots(null, [baseItem({ id: 'legacy-x' })]).store;
  assert.equal(isPublicEligible(store.candidates[0]), false);
  assert.deepEqual(buildProjectionFromStore(store, { generatedAt: '2026-08-01T00:00:00Z' }).items, []);
});

test('legacySummary 统计 legacy 旧记录的迁移状态分布', () => {
  const store = importLegacyHotspots(null, [
    baseItem({ id: 'legacy-a' }),
    baseItem({ id: 'legacy-b' }),
  ]).store;
  const approved = store.candidates.find(item => item.id === 'legacy-a');
  approved.review_status = 'approved';
  const summary = legacySummary(store);
  assert.equal(summary.total, 2);
  assert.equal(summary.by_review_status.pending, 1);
  assert.equal(summary.by_review_status.approved, 1);
});
