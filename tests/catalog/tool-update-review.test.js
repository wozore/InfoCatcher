'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCostLedger } = require('../../src/catalog/catalog-research');
const {
  buildToolUpdateReviewInput,
  buildToolUpdateReviewInstructions,
  suggestToolUpdateReview,
  validateToolUpdateReviewValue,
} = require('../../src/catalog/ai/tool-update-review-ai');
const {
  planToolUpdateCandidate,
  planToolUpdateCandidates,
} = require('../../src/catalog/tool-update-review-planner');
const { explicitDates } = require('../../src/catalog/tool-update-evidence');
const {
  defaultReviewQueue,
  mergeReviewQueue,
  reviewQueueViews,
  readReviewQueue,
  setReviewStatusReviewQueue,
  removePendingBlockedReviewItems,
  writeReviewQueue,
} = require('../../src/catalog/tool-update-review-store');

const NOW = '2026-08-25T12:00:00.000Z';
const SOURCE = {
  kind: 'github_releases',
  url: 'https://github.com/acme/tool/releases',
  collector: 'github_web_release',
  product_surface: 'cli',
  repository: 'acme/tool',
  include_prerelease: false,
};
const REGISTRY = {
  schema_version: 1,
  kind: 'official_product_url_registry',
  products: {
    'acme-tool': {
      name: 'Acme Tool',
      vendor_key: 'acme',
      official_urls: ['https://acme.example'],
      update_sources: [SOURCE],
      lifecycle: 'active',
    },
  },
};

function evidence(overrides = {}) {
  return {
    product_key: 'acme-tool',
    detail_id: 'acme-tool:v2.0.0',
    source_type: 'github_releases',
    collector: 'github_web_release',
    url: SOURCE.url,
    title: 'Release v2.0.0',
    official_published_at: '2026-08-20T09:00:00Z',
    excerpt: '## v2.0.0\n\nReleased 2026-08-20\n\n- Added terminal workflows.',
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    collected_at: NOW,
    status: 'ready',
    ...overrides,
  };
}

function suggestion(overrides = {}) {
  return {
    verdict: 'approve',
    matched_surface: 'cli',
    confidence: 0.95,
    reason: '正文明确描述目标 CLI 的产品级发布。',
    supporting_excerpt: 'Added terminal workflows.',
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    id: 'tool-level3:acme-tool',
    tool_key: 'acme-tool',
    title: 'Acme Tool',
    vendor_key: 'acme',
    detail_kind: 'tool',
    last_updated_date: '2026-08-01',
    ...overrides,
  };
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-update-review-')), 'review.json');
}

function localResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    text: async () => '',
  };
}

test('AI 输入只包含证据/登记元数据/当前工具摘要，输出契约严格为五字段', () => {
  const input = JSON.parse(buildToolUpdateReviewInput({
    product_key: 'acme-tool',
    evidence: evidence(),
    product: REGISTRY.products['acme-tool'],
    source: SOURCE,
    detail: detail(),
  }));
  assert.equal(input.evidence.excerpt.includes('terminal'), true);
  assert.equal(input.registry.update_source.repository, 'acme/tool');
  assert.equal(input.current_detail.last_updated_date, '2026-08-01');
  assert.equal('content' in input.evidence, false);
  assert.equal(validateToolUpdateReviewValue(suggestion()), true);
  assert.equal(validateToolUpdateReviewValue({ ...suggestion(), url: SOURCE.url }), false);
  assert.match(buildToolUpdateReviewInstructions(), /不得创建、修改或纠正这些事实/);
});

test('本地 Bonsai 默认路径使用结构化输出和成本账本', async () => {
  const calls = [];
  const ledger = createCostLedger({ responses_calls: 1 });
  const result = await suggestToolUpdateReview({
    product_key: 'acme-tool', evidence: evidence(), product: REGISTRY.products['acme-tool'], source: SOURCE, detail: detail(),
  }, {
    ledger,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return localResponse(suggestion());
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'local');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(calls[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(ledger.snapshot().spent.responses_calls, 1);
});

test('缺 ledger 和 DeepSeek 未显式成本确认均 fail-closed', async () => {
  const noLedger = await suggestToolUpdateReview({ evidence: evidence() }, { fetchImpl: async () => { throw new Error('unexpected'); } });
  assert.equal(noLedger.code, 'COST_LEDGER_REQUIRED');
  const noConfirm = await suggestToolUpdateReview({ evidence: evidence() }, {
    provider: 'deepseek', ledger: createCostLedger({ responses_calls: 1 }), fetchImpl: async () => { throw new Error('unexpected'); },
  });
  assert.equal(noConfirm.code, 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED');
});

test('结构化输出无效时不生成 AI 建议', async () => {
  const result = await suggestToolUpdateReview({ evidence: evidence() }, {
    ledger: createCostLedger({ responses_calls: 1 }),
    fetchImpl: async () => localResponse({ verdict: 'approve' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.code, /SCHEMA_INVALID/);
});

test('确定性 planner 通过登记源、tool 详情、官方发布日期和向前日期门禁', () => {
  const result = planToolUpdateCandidate('acme-tool', evidence(), suggestion(), {
    registry: REGISTRY,
    detail: detail(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.status, 'candidate');
  assert.equal(result.candidate.review_status, 'pending');
  assert.equal(result.candidate.previous_date, '2026-08-01');
  assert.equal(result.candidate.proposed_date, '2026-08-20');
  assert.equal(result.candidate.source_url, SOURCE.url);
  assert.deepEqual(result.candidate.blocked_reasons, []);
  assert.match(result.candidate.candidate_key, /acme-tool\|https:\/\/github.com\/acme\/tool\/releases\|2026-08-20\|sha256:/);
});

test('确定性来源无需 AI 建议即可生成 candidate，并记录 decision_source', () => {
  const source = { ...SOURCE, review_mode: 'deterministic' };
  const registry = { ...REGISTRY, products: { 'acme-tool': { ...REGISTRY.products['acme-tool'], update_sources: [source] } } };
  const result = planToolUpdateCandidate('acme-tool', evidence({ url: source.url }), undefined, {
    registry,
    detail: detail(),
    now: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.decision_source, 'deterministic');
  assert.equal(result.candidate.review_decision.verdict, 'approve');
  assert.equal(result.candidate.ai_suggestion, null);
});

test('日期只能来自持久化 evidence，AI supporting_excerpt 不能单独造日期', () => {
  const result = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: null,
    excerpt: 'A product update without a calendar date.',
  }), suggestion({ supporting_excerpt: 'Released Aug 20, 2026.' }), {
    registry: REGISTRY,
    detail: detail(),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blocked_reasons.includes('EVIDENCE_DATE_MISSING'));
});
test('GitHub Release 具体 tag 页面绑定已登记的 releases 聚合源', () => {
  const result = planToolUpdateCandidate('acme-tool', evidence({
    url: 'https://github.com/acme/tool/releases/tag/v2.0.0',
  }), suggestion(), {
    registry: REGISTRY,
    detail: detail(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.source_url, 'https://github.com/acme/tool/releases/tag/v2.0.0');
  assert.deepEqual(result.candidate.blocked_reasons, []);
});
test('低置信度、实体/组件错配和非 tool 目标均 blocked', () => {
  const low = planToolUpdateCandidate('acme-tool', evidence(), suggestion({ confidence: 0.79 }), { registry: REGISTRY, detail: detail(), now: NOW });
  assert.equal(low.ok, false);
  assert.ok(low.blocked_reasons.includes('AI_CONFIDENCE_LOW'));

  const surface = planToolUpdateCandidate('acme-tool', evidence(), suggestion({ matched_surface: 'desktop' }), { registry: REGISTRY, detail: detail(), now: NOW });
  assert.equal(surface.ok, false);
  assert.ok(surface.blocked_reasons.includes('PRODUCT_SURFACE_MISMATCH'));

  const mismatch = planToolUpdateCandidate('other-tool', evidence(), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.blocked_reasons.includes('PRODUCT_NOT_IN_REGISTRY'));

  const nonTool = planToolUpdateCandidate('acme-tool', evidence(), suggestion(), {
    registry: REGISTRY, detail: detail({ detail_kind: 'api_model' }), now: NOW,
  });
  assert.equal(nonTool.ok, false);
  assert.ok(nonTool.blocked_reasons.includes('DETAIL_KIND_NOT_TOOL'));
});

test('日期缺失或未来时 blocked，当前日期及更早更新标记为 no-op', () => {
  const missing = planToolUpdateCandidate('acme-tool', evidence({ official_published_at: null, excerpt: 'New feature without a date.' }), suggestion({ supporting_excerpt: 'New feature without a date.' }), {
    registry: REGISTRY, detail: detail(), now: NOW,
  });
  assert.ok(missing.blocked_reasons.includes('EVIDENCE_DATE_MISSING'));

  const future = planToolUpdateCandidate('acme-tool', evidence({ official_published_at: '2026-09-01T00:00:00Z' }), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  });
  assert.ok(future.blocked_reasons.includes('PROPOSED_DATE_IN_FUTURE'));

  const same = planToolUpdateCandidate('acme-tool', evidence({ official_published_at: '2026-08-01T00:00:00Z' }), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  });
  assert.equal(same.ok, true);
  assert.equal(same.ignored, true);
  assert.equal(same.blocked_reasons.length, 0);

  const rollback = planToolUpdateCandidate('acme-tool', evidence({ official_published_at: '2026-07-31T00:00:00Z' }), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.ignored, true);
});

test('批量 planner 隔离 blocked 项且不改变正式数据', () => {
  const result = planToolUpdateCandidates([
    { product_key: 'acme-tool', evidence: evidence(), suggestion: suggestion() },
    { product_key: 'acme-tool', evidence: evidence({ status: 'discovery_only' }), suggestion: suggestion() },
  ], { registry: REGISTRY, detail: detail(), now: NOW });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.ok, false);
});

test('review queue 幂等合并、保留人工结论、同 release hash 变化重新 pending', () => {
  const first = planToolUpdateCandidate('acme-tool', evidence(), suggestion(), { registry: REGISTRY, detail: detail(), now: NOW }).candidate;
  const approved = { ...first, review_status: 'approved' };
  const same = mergeReviewQueue({ ...defaultReviewQueue(), items: [approved] }, [first], { now: NOW });
  assert.equal(same.queue.items.length, 1);
  assert.equal(same.queue.items[0].review_status, 'approved');
  assert.equal(same.appended, 0);

  const changed = planToolUpdateCandidate('acme-tool', evidence({ content_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  }).candidate;
  const reopened = mergeReviewQueue(same.queue, [changed], { now: NOW });
  assert.equal(reopened.queue.items.length, 2);
  assert.equal(reopened.queue.items[0].review_status, 'approved');
  assert.equal(reopened.queue.items[0].superseded_by, changed.candidate_key);
  assert.equal(reopened.queue.items[0].superseded_reason, 'newer_evidence');
  assert.equal(reopened.queue.items[1].review_status, 'pending');
  assert.equal(reopened.queue.items[1].candidate_key, changed.candidate_key);
  assert.equal(reopened.queue.items[1].blocked_reasons.includes('EVIDENCE_HASH_CHANGED'), false);
  assert.equal(mergeReviewQueue(reopened.queue, [changed], { now: NOW }).queue.items.length, 2);
});

test('队列视图按当前登记来源保留最新证据并隐藏旧来源历史', () => {
  const oldItem = planToolUpdateCandidate('acme-tool', evidence(), suggestion(), { registry: REGISTRY, detail: detail(), now: NOW }).candidate;
  const newItem = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: '2026-08-22T09:00:00Z',
    content_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    title: 'Release v2.1.0',
    excerpt: '## v2.1.0\\n\\nReleased 2026-08-22',
  }), suggestion(), { registry: REGISTRY, detail: detail(), now: '2026-08-23T12:00:00Z' }).candidate;
  const replacedSource = { ...oldItem, candidate_key: 'acme-tool|https://legacy.example/changelog|2026-08-19|sha256:cccc', release_key: 'acme-tool|https://legacy.example/changelog|2026-08-19', source_url: 'https://legacy.example/changelog', proposed_date: '2026-08-19' };
  const merged = mergeReviewQueue({ ...defaultReviewQueue(), items: [oldItem, replacedSource] }, [newItem], { registry: REGISTRY, now: '2026-08-23T12:00:00Z' });
  const views = reviewQueueViews(merged.queue, { registry: REGISTRY });
  assert.deepEqual(views.actionable.map(item => item.candidate_key), [newItem.candidate_key]);
  assert.equal(views.history.length, 2);
  assert.ok(views.history.every(item => item.history_reason === 'newer_evidence' || item.history_reason === 'source_replaced'));
});
test('已替代审核项不能再次写入人工结论', () => {
  const oldItem = planToolUpdateCandidate('acme-tool', evidence(), suggestion(), { registry: REGISTRY, detail: detail(), now: NOW }).candidate;
  const newItem = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: '2026-08-22T09:00:00Z',
    content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    title: 'Release v2.1.0',
    excerpt: '## v2.1.0\\n\\nReleased 2026-08-22',
  }), suggestion(), { registry: REGISTRY, detail: detail(), now: '2026-08-23T12:00:00Z' }).candidate;
  const merged = mergeReviewQueue({ ...defaultReviewQueue(), items: [{ ...oldItem, review_status: 'approved' }] }, [newItem], { registry: REGISTRY, now: '2026-08-23T12:00:00Z' });
  const file = tmpFile();
  writeReviewQueue(merged.queue, { file, now: '2026-08-23T12:00:00Z' });
  const revision = require('../../src/catalog/tool-update-review-store').reviewQueueRevision(readReviewQueue(file));
  const result = setReviewStatusReviewQueue(oldItem.candidate_key, 'rejected', { expectedRevision: revision, registry: REGISTRY, file });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UPDATE_REVIEW_NOT_CURRENT');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
test('review store 只持久化证据摘录，不保存整页正文', () => {
  const file = tmpFile();
  const candidate = planToolUpdateCandidate('acme-tool', evidence({ excerpt: 'short excerpt' }), suggestion(), {
    registry: REGISTRY, detail: detail(), now: NOW,
  }).candidate;
  writeReviewQueue({ ...defaultReviewQueue(), items: [candidate] }, { file, now: NOW });
  const loaded = readReviewQueue(file);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].evidence.excerpt, 'short excerpt');
  assert.equal('content' in loaded.items[0].evidence, false);
  assert.equal(loaded.items[0].review_status, 'pending');
});

test('删除旧 pending/blocked 时精确计数，保留 approved 与 rejected 项', () => {
  const file = tmpFile();
  const pending = planToolUpdateCandidate('acme-tool', evidence(), suggestion({ confidence: 0.2 }), { registry: REGISTRY, detail: detail(), now: NOW }).candidate;
  const approved = { ...planToolUpdateCandidate('acme-tool', evidence({ content_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), suggestion(), { registry: REGISTRY, detail: detail(), now: NOW }).candidate, review_status: 'approved' };
  const rejected = { ...planToolUpdateCandidate('acme-tool', evidence({ content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }), suggestion({ confidence: 0.2 }), { registry: REGISTRY, detail: detail(), now: NOW }).candidate, review_status: 'rejected' };
  writeReviewQueue({ ...defaultReviewQueue(), items: [pending, approved, rejected] }, { file, now: NOW });
  const revision = require('../../src/catalog/tool-update-review-store').reviewQueueRevision(readReviewQueue(file));
  const mismatch = removePendingBlockedReviewItems({ file, expectedRevision: revision, expectedCount: 2 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'TOOL_UPDATE_REVIEW_REMOVE_COUNT_MISMATCH');
  const removed = removePendingBlockedReviewItems({ file, expectedRevision: revision, expectedCount: 1, now: NOW });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 1);
  assert.deepEqual(readReviewQueue(file).items.map(item => item.review_status).sort(), ['approved', 'rejected']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('explicitDates 识别月份缩写与序数后缀', () => {
  assert.deepEqual(explicitDates('Released on Aug 21, 2026.'), ['2026-08-21']);
  assert.deepEqual(explicitDates('Released on August 21st, 2026.'), ['2026-08-21']);
  assert.deepEqual(explicitDates('Released on Aug 21, 2026 and Sep 3, 2026.').sort(), ['2026-08-21', '2026-09-03']);
  assert.deepEqual(explicitDates('Released on 21 Aug 2026.'), ['2026-08-21']);
});

test('date_mode latest 在多日期 changelog 页取最新日期', () => {
  const source = { ...SOURCE, date_mode: 'latest' };
  const registry = { ...REGISTRY, products: { 'acme-tool': { ...REGISTRY.products['acme-tool'], update_sources: [source] } } };
  const result = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: null,
    excerpt: '## Aug 19, 2026\n\nFirst entry.\n\n## Aug 21, 2026\n\nLatest entry.',
    content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  }), suggestion({ supporting_excerpt: 'Latest entry.' }), {
    registry,
    detail: detail(),
    now: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.proposed_date, '2026-08-21');

  const ambiguous = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: null,
    excerpt: '## Aug 19, 2026\n\nFirst entry.\n\n## Aug 21, 2026\n\nLatest entry.',
    content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  }), suggestion({ supporting_excerpt: 'Latest entry.' }), {
    registry: REGISTRY,
    detail: detail(),
    now: NOW,
  });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.blocked_reasons.includes('EVIDENCE_DATE_AMBIGUOUS'));
});

test('无当前 last_updated_date 的 detail 允许首次填充候选（fill_missing）', () => {
  const result = planToolUpdateCandidate('acme-tool', evidence({
    official_published_at: '2026-08-20T09:00:00Z',
  }), suggestion(), {
    registry: REGISTRY,
    detail: detail({ last_updated_date: undefined }),
    now: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.proposed_date, '2026-08-20');
  assert.deepEqual(result.blocked_reasons, []);
});
