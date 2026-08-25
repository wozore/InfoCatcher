'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditCatalogDates, repairFieldFromNote } = require('../../src/maintenance/catalog-date-audit');

function item(overrides = {}) {
  return {
    id: 'tool-level3:item',
    title: 'Item',
    detail_kind: 'tool',
    last_updated_date: '2026-08-03',
    sources: [{ title: 'Product Change Log', url: 'https://example.com/change-log' }],
    ...overrides,
  };
}

test('model announcement source signal verifies a typed release date', () => {
  const report = auditCatalogDates({
    items: [item({ detail_kind: 'api_model', release_date: '2026-05-07', sources: [{ title: 'Advancing voice intelligence with new models in the API', url: 'https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/' }] })],
  });
  assert.equal(report.items[0].category, 'verified_release');
});


test('GitHub release tags verify a tool update date', () => {
  const report = auditCatalogDates({
    items: [item({
      sources: [{ title: 'CLI Release v1.5.45', url: 'https://github.com/continuedev/continue/releases/tag/v1.5.45' }],
    })],
  });
  assert.equal(report.items[0].category, 'verified_update');
});

test('date audit classifies typed dates conservatively and preserves source evidence', () => {
  const report = auditCatalogDates({
    items: [
      item(),
      item({ id: 'tool-level3:model', title: 'Model', detail_kind: 'api_model', release_date: '2026-08-13', sources: [{ title: 'Release announcement', url: 'https://example.com/announcement' }] }),
      item({ id: 'tool-level3:pricing', title: 'Pricing Model', detail_kind: 'api_model', release_date: '2026-08-13', sources: [{ title: 'Pricing', url: 'https://example.com/pricing' }] }),
      item({ id: 'tool-level3:plan', title: 'Plan', detail_kind: 'subscription_plan', release_date: undefined, last_updated_date: undefined, sources: [{ title: 'Pricing', url: 'https://example.com/pricing' }] }),
      item({ id: 'tool-level3:missing-source', title: 'Missing Source', last_updated_date: '2026-01-01', sources: [] }),
    ],
  });

  assert.deepEqual(report.items.map(row => row.id), [
    'tool-level3:item',
    'tool-level3:missing-source',
    'tool-level3:model',
    'tool-level3:plan',
    'tool-level3:pricing',
  ]);
  const byId = new Map(report.items.map(row => [row.id, row]));
  assert.equal(byId.get('tool-level3:item').category, 'verified_update');
  assert.equal(byId.get('tool-level3:item').target_field, 'last_updated_date');
  assert.equal(byId.get('tool-level3:model').category, 'verified_release');
  assert.equal(byId.get('tool-level3:model').target_field, 'release_date');
  assert.equal(byId.get('tool-level3:pricing').category, 'ambiguous');
  assert.equal(byId.get('tool-level3:plan').category, 'ambiguous');
  assert.equal(byId.get('tool-level3:missing-source').category, 'invalid_source');
  assert.deepEqual(report.summary.by_category, { ambiguous: 2, invalid_source: 1, verified_release: 1, verified_update: 1 });
});

test('release evidence wins over negated page-update wording', () => {
  assert.equal(repairFieldFromNote('产品首次公开发布，不能使用页面更新时间。'), 'release_date');
  assert.equal(repairFieldFromNote('修复 last_updated_date 为 2026-08-03。'), 'last_updated_date');
  const conflicting = auditCatalogDates({
    items: [item()],
    repairEvidence: new Map([['tool-level3:item', { field: 'release_date', date: '2026-08-03', source_file: 'release.json' }]]),
  });
  assert.equal(conflicting.items[0].category, 'ambiguous');
});

test('repair evidence for a different historical date does not block a typed date', () => {
  const report = auditCatalogDates({
    items: [item()],
    repairEvidence: new Map([['tool-level3:item', { field: 'release_date', date: '2025-06-25', source_file: 'release.json' }]]),
  });
  assert.equal(report.items[0].category, 'verified_update');
});

test('matching repair evidence can verify a date without changing the input record', () => {
  const source = item();
  const before = JSON.stringify(source);
  const report = auditCatalogDates({
    items: [source],
    repairEvidence: new Map([['tool-level3:item', { field: 'last_updated_date', date: '2026-08-03', source_file: 'repair.json' }]]),
  });
  assert.equal(report.items[0].category, 'verified_update');
  assert.equal(report.items[0].repair_evidence.source_file, 'repair.json');
  assert.equal(JSON.stringify(source), before);
});
