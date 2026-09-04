'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dateFieldForDetail,
  planDateRepair,
  planDateRepairBatch,
  approvedRepairsFromReviewQueue,
  applyDateRepair,
  applyDateRepairBatch,
  nonDateDetailFingerprint,
} = require('../../src/catalog/tool-update');
const { planToolUpdateCandidate } = require('../../src/catalog/tool-update/index');

function snapshot(detail = {}) {
  const item = {
    id: 'tool-level3:sample',
    vendor_key: 'sample',
    detail_kind: 'tool',
    theme: 'dev',
    title: 'Sample Tool',
    vendor_label: 'Sample',
    icon: 'S',
    official_url: 'https://example.com/product',
    status: 'active',
    summary: 'Sample summary',
    one_m_context: { status: 'not_applicable', reason: 'tool' },
    api_pricing: { status: 'not_applicable', reason: 'tool' },
    plan: { status: 'not_applicable', reason: 'tool' },
    applicable_scenarios: [{ title: 'Coding', description: 'Code work' }],
    inapplicable_scenarios: [{ title: 'Other', description: 'Other work' }],
    sources: [{ title: 'Official product', url: 'https://example.com/product' }],
    ...detail,
  };
  return {
    'vendor-card': [],
    'tool-card': [{
      id: 'tool-card:sample', tool_key: 'sample', vendor_key: 'sample', title: 'Sample Tool',
      vendor_label: 'Sample', icon: 'S', summary: 'Sample summary', theme: 'dev', scenes: ['Coding'],
      best_for_preview: 'Coding', not_for_preview: 'Other', price_badge: 'free', access_level: '开放',
      search_terms: ['Sample Tool'], detail_ref: { kind: 'tool-level3', id: item.id }, detail_kind: item.detail_kind,
    }],
    'vendor-level1': [],
    'vendor-level2': [],
    'tool-level3': [item],
  };
}

function repair(overrides = {}) {
  return {
    detail_id: 'tool-level3:sample',
    date: '2026-08-11',
    evidence: {
      title: 'Official changelog',
      url: 'https://docs.example.com/changelog',
      content: 'Latest stable release was published on August 11, 2026.',
    },
    ...overrides,
  };
}

test('date repair chooses the typed target field', () => {
  assert.equal(dateFieldForDetail({ detail_kind: 'tool' }), 'last_updated_date');
  assert.equal(dateFieldForDetail({ detail_kind: 'api_model' }), 'release_date');
  assert.equal(dateFieldForDetail({ detail_kind: 'product_variant' }), 'release_date');
  assert.equal(dateFieldForDetail({ detail_kind: 'subscription_plan' }), null);
});

test('date repair changes only the applicable date and appends one official source', () => {
  const before = snapshot();
  const result = planDateRepair(before, repair());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target_field, 'last_updated_date');
  const after = result.snapshot['tool-level3'][0];
  assert.equal(after.last_updated_date, '2026-08-11');
  assert.equal(after.sources.length, 2);
  assert.equal(nonDateDetailFingerprint(before['tool-level3'][0], result.target_field), nonDateDetailFingerprint(after, result.target_field));
});

test('date repair accepts an ISO date in official evidence', () => {
  const result = planDateRepair(snapshot({ detail_kind: 'api_model', official_url: 'https://developers.openai.com/api/docs/models/gpt-realtime-2' }), repair({
    date: '2026-05-07',
    official_roots: ['https://openai.com'],
    evidence: {
      title: 'Official model announcement',
      url: 'https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/',
      content: 'May 7, 2026. GPT-Realtime-2 is available in the Realtime API.',
    },
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target_field, 'release_date');
});

test('date repair accepts abbreviated month names from release pages', () => {
  const result = planDateRepair(snapshot(), repair({
    date: '2026-08-24',
    evidence: {
      title: 'Official GitHub release',
      url: 'https://github.com/example/tool/releases/tag/v1.0.0',
      content: 'Aug 24, 2026. Released the latest stable CLI build.',
    },
    official_roots: ['https://github.com'],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target_field, 'last_updated_date');
});

test('date repair rejects subscriptions, wrong target fields, untrusted URLs, and unsupported dates', () => {
  assert.equal(planDateRepair(snapshot({ detail_kind: 'subscription_plan' }), repair()).code, 'DATE_REPAIR_NOT_APPLICABLE');
  assert.equal(planDateRepair(snapshot(), repair({ target_field: 'release_date' })).code, 'DATE_REPAIR_TARGET_MISMATCH');
  assert.equal(planDateRepair(snapshot(), repair({ evidence: { title: 'Third party', url: 'https://other.example/changelog', content: 'August 11, 2026' } })).code, 'DATE_REPAIR_SOURCE_UNTRUSTED');
  assert.equal(planDateRepair(snapshot(), repair({ evidence: { title: 'Official changelog', url: 'https://docs.example.com/changelog', content: 'Updated last week.' } })).code, 'DATE_REPAIR_DATE_NOT_IN_EVIDENCE');
});

test('date repair refuses to overwrite an existing typed date', () => {
  assert.equal(planDateRepair(snapshot({ last_updated_date: '2026-08-01' }), repair()).code, 'DATE_REPAIR_ALREADY_PRESENT');
});


function advanceRepair(overrides = {}) {
  return {
    detail_id: 'tool-level3:sample',
    mode: 'advance_update',
    target_field: 'last_updated_date',
    date: '2026-08-11',
    as_of: '2026-08-25',
    official_roots: ['https://example.com/changelog'],
    evidence: {
      title: 'Official changelog',
      url: 'https://example.com/changelog',
      official_published_at: '2026-08-11T12:00:00Z',
      content: 'Published the stable update.',
    },
    ...overrides,
  };
}

const REVIEW_REGISTRY = {
  schema_version: 1,
  kind: 'official_product_url_registry',
  products: {
    sample: {
      name: 'Sample Tool',
      vendor_key: 'sample',
      official_urls: ['https://example.com/product'],
      update_sources: [{
        kind: 'changelog',
        url: 'https://example.com/changelog',
        collector: 'tavily_extract',
        product_surface: 'product',
        review_mode: 'ai_fallback',
      }],
      lifecycle: 'active',
    },
  },
};

function reviewCandidate(current, overrides = {}) {
  const date = overrides.date || '2026-08-11';
  const evidence = {
    product_key: 'sample',
    detail_id: 'sample:release',
    source_type: 'changelog',
    collector: 'tavily_extract',
    url: 'https://example.com/changelog',
    title: 'Official changelog',
    official_published_at: `${date}T12:00:00Z`,
    excerpt: `Published stable update on ${date}.`,
    content_hash: overrides.content_hash || 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    status: 'ready',
  };
  const ai = {
    verdict: 'approve',
    matched_surface: 'product',
    confidence: 0.95,
    reason: '明确的产品级更新。',
    supporting_excerpt: `Published stable update on ${date}.`,
  };
  return planToolUpdateCandidate('sample', evidence, ai, {
    registry: REVIEW_REGISTRY,
    detail: current['tool-level3'][0],
    now: '2026-08-25',
  }).candidate;
}

test('advance_update 只允许 tool.last_updated_date 且严格向前', () => {
  const before = snapshot({ last_updated_date: '2026-08-01' });
  const planned = planDateRepair(before, advanceRepair());
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.mode, 'advance_update');
  assert.equal(planned.preview.mode, 'advance_update');
  assert.equal(planned.snapshot['tool-level3'][0].last_updated_date, '2026-08-11');
  assert.equal(nonDateDetailFingerprint(before['tool-level3'][0], 'last_updated_date'), nonDateDetailFingerprint(planned.snapshot['tool-level3'][0], 'last_updated_date'));

  assert.equal(planDateRepair(before, advanceRepair({ date: '2026-08-01' })).code, 'DATE_REPAIR_DATE_NOT_FORWARD');
  assert.equal(planDateRepair(before, advanceRepair({ date: '2026-07-31' })).code, 'DATE_REPAIR_DATE_NOT_FORWARD');
  assert.equal(planDateRepair(before, advanceRepair({ date: '2026-09-01' })).code, 'DATE_REPAIR_DATE_IN_FUTURE');
  assert.equal(planDateRepair(snapshot({ detail_kind: 'api_model', release_date: '2026-08-01' }), advanceRepair()).code, 'DATE_REPAIR_ADVANCE_ONLY_TOOL');
});

test('advance_update 可用官方发布时间 metadata，不猜正文日期', () => {
  const planned = planDateRepair(snapshot({ last_updated_date: '2026-08-01' }), advanceRepair({ evidence: {
    title: 'Official release',
    url: 'https://example.com/changelog',
    official_published_at: '2026-08-11T12:00:00Z',
    content: 'The page body has no explicit calendar date.',
  } }));
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.date, '2026-08-11');
});

test('批量 advance preview 使用同一 base revision 且非日期字段零漂移', () => {
  const before = snapshot({ last_updated_date: '2026-08-01' });
  const second = { ...before['tool-level3'][0], id: 'tool-level3:second', title: 'Second Tool', last_updated_date: '2026-08-02' };
  before['tool-level3'].push(second);
  before['tool-card'].push({ ...before['tool-card'][0], id: 'tool-card:second', tool_key: 'second', title: 'Second Tool', detail_ref: { kind: 'tool-level3', id: second.id } });
  const planned = planDateRepairBatch(before, [
    advanceRepair({ date: '2026-08-11' }),
    advanceRepair({ detail_id: 'tool-level3:second', date: '2026-08-12', evidence: {
      title: 'Official changelog',
      url: 'https://example.com/changelog',
      official_published_at: '2026-08-12T12:00:00Z',
      content: 'Published the stable update.',
    } }),
  ], { asOf: '2026-08-25' });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.count, 2);
  assert.equal(planned.before_revision, require('../../src/catalog/core/index').revisionOf(before));
  assert.equal(planned.changes.length, 2);
  assert.equal(planned.snapshot['tool-level3'][0].last_updated_date, '2026-08-11');
  assert.equal(planned.snapshot['tool-level3'][1].last_updated_date, '2026-08-12');
  assert.notEqual(planned.preview_hash, undefined);
  assert.equal(planDateRepairBatch(before, [advanceRepair(), advanceRepair()], { asOf: '2026-08-25' }).code, 'DATE_REPAIR_BATCH_DUPLICATE_DETAIL');
});

test('批量 fill_missing 为无日期 tool 填充首次日期', () => {
  const before = snapshot();
  const planned = planDateRepairBatch(before, [
    advanceRepair({ mode: 'fill_missing', date: '2026-08-19', evidence: {
      title: 'Official changelog',
      url: 'https://example.com/changelog',
      official_published_at: '2026-08-19T12:00:00Z',
      content: 'Published the stable update.',
    } }),
  ], { asOf: '2026-08-25' });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.mode, 'fill_missing');
  assert.equal(planned.count, 1);
  assert.equal(planned.snapshot['tool-level3'][0].last_updated_date, '2026-08-19');
});

test('批量 Apply 重新读取 approved queue、校验 candidate hash、revision 和 preview hash', () => {
  const before = snapshot({ last_updated_date: '2026-08-01' });
  const candidate = reviewCandidate(before);
  assert.equal(candidate.status, 'candidate');
  const approvedItem = { ...candidate, review_status: 'approved' };
  const repair = advanceRepair();
  const planned = planDateRepairBatch(before, [repair], { asOf: '2026-08-25' });
  let committed = null;
  const applied = applyDateRepairBatch([{ candidate_key: candidate.candidate_key }], {
    snapshot: before,
    registry: REVIEW_REGISTRY,
    reviewQueue: { schema_version: 1, kind: 'tool_update_review', updated_at: null, items: [approvedItem] },
    expectedRevision: planned.before_revision,
    previewHash: planned.preview_hash,
    asOf: '2026-08-25',
    commitSnapshotChange(target, options) {
      committed = { target, options };
      return { ok: true, beforeRevision: options.expectedRevision, targetRevision: planned.target_revision };
    },
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.count, 1);
  assert.equal(committed.target['tool-level3'][0].last_updated_date, '2026-08-11');
  assert.equal(committed.options.operation, 'catalog-date-repair-batch');

  const wrongPreview = applyDateRepairBatch([{ candidate_key: candidate.candidate_key }], {
    snapshot: before,
    registry: REVIEW_REGISTRY,
    reviewQueue: { schema_version: 1, kind: 'tool_update_review', updated_at: null, items: [approvedItem] },
    expectedRevision: planned.before_revision,
    previewHash: 'sha256:wrong',
    asOf: '2026-08-25',
    commitSnapshotChange() { throw new Error('preview conflict must not commit'); },
  });
  assert.equal(wrongPreview.code, 'DATE_REPAIR_PREVIEW_CONFLICT');

  const pending = applyDateRepairBatch([{ candidate_key: candidate.candidate_key }], {
    snapshot: before,
    registry: REVIEW_REGISTRY,
    reviewQueue: { schema_version: 1, kind: 'tool_update_review', updated_at: null, items: [candidate] },
    expectedRevision: planned.before_revision,
    previewHash: planned.preview_hash,
    asOf: '2026-08-25',
  });
  assert.equal(pending.code, 'DATE_REPAIR_NO_APPROVED_ITEMS');

  const newer = reviewCandidate(before, { date: '2026-08-12', content_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const staleApproved = applyDateRepairBatch([{ candidate_key: candidate.candidate_key }], {
    snapshot: before,
    registry: REVIEW_REGISTRY,
    reviewQueue: { schema_version: 1, kind: 'tool_update_review', updated_at: null, items: [{ ...approvedItem }, { ...newer, review_status: 'pending' }] },
    expectedRevision: planned.before_revision,
    previewHash: planned.preview_hash,
    asOf: '2026-08-25',
  });
  assert.equal(staleApproved.code, 'DATE_REPAIR_NO_APPROVED_ITEMS');
});
test('apply requires revision and preview hash and commits only a reviewed snapshot', () => {
  const before = snapshot();
  const planned = planDateRepair(before, repair());
  assert.equal(applyDateRepair(repair(), { snapshot: before, expectedRevision: planned.before_revision, previewHash: 'sha256:wrong' }).code, 'DATE_REPAIR_PREVIEW_CONFLICT');
  let committed;
  const result = applyDateRepair(repair(), {
    snapshot: before,
    expectedRevision: planned.before_revision,
    previewHash: planned.preview_hash,
    commitSnapshotChange(target, options) {
      committed = { target, options };
      return { ok: true, beforeRevision: options.expectedRevision, targetRevision: planned.target_revision };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(committed.target['tool-level3'][0].last_updated_date, '2026-08-11');
  assert.equal(committed.options.operation, 'catalog-date-repair');
});
