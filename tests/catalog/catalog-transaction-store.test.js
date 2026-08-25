'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { planRecordRemoval } = require('../../src/catalog/catalog-transaction-store');

function fixture() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:spark', vendor_key: 'spark', title: 'Spark', icon: 'x', summary: 'Spark', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:spark' } });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:spark', vendor_key: 'spark', title: 'Spark', icon: 'x', official_url: 'https://example.com', description: 'Spark', status: 'active', features: [{ tone: 'positive', text: 'Spark' }], level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:spark' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:spark', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:spark' }, vendor_key: 'spark', title: 'Spark', official_url: 'https://example.com', summary: 'Spark', status: 'active', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:spark' }] });
  snapshot['tool-level3'].push({ id: 'tool-level3:spark', vendor_key: 'spark', detail_kind: 'tool', theme: 'general', title: 'Spark', vendor_label: 'Spark', icon: 'x', official_url: 'https://example.com', status: 'active', summary: 'Spark', one_m_context: { status: 'not_applicable', reason: 'tool' }, api_pricing: { status: 'not_applicable', reason: 'tool' }, plan: { status: 'not_applicable', reason: 'tool' }, applicable_scenarios: [{ title: 'Spark', description: 'Spark' }], inapplicable_scenarios: [{ title: 'Other', description: 'Other' }], sources: [{ title: 'Official', url: 'https://example.com' }] });
  snapshot['tool-card'].push({ id: 'tool-card:spark', tool_key: 'spark', vendor_key: 'spark', title: 'Spark', vendor_label: 'Spark', icon: 'x', summary: 'Spark', theme: 'general', scenes: ['Spark'], best_for_preview: 'Spark', not_for_preview: 'Other', price_badge: 'free', access_level: '开放', search_terms: ['Spark'], detail_ref: { kind: 'tool-level3', id: 'tool-level3:spark' }, detail_kind: 'tool' });
  return snapshot;
}

test('planRecordRemoval removes exact records and their references atomically', () => {
  const result = planRecordRemoval(fixture(), [
    { area: 'vendor-card', id: 'vendor-card:spark' },
    { area: 'vendor-level1', id: 'vendor-level1:spark' },
    { area: 'vendor-level2', id: 'vendor-level2:spark' },
    { area: 'tool-level3', id: 'tool-level3:spark' },
    { area: 'tool-card', id: 'tool-card:spark' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  for (const items of Object.values(result.snapshot)) assert.equal(items.length, 0);
});

test('planRecordRemoval rejects an incomplete target set that would leave dangling refs', () => {
  const result = planRecordRemoval(fixture(), [{ area: 'tool-level3', id: 'tool-level3:spark' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_INVALID');
  assert.ok(result.errors.length > 0);
});

test('planRecordRemoval rejects missing exact IDs before writing', () => {
  const result = planRecordRemoval(fixture(), [{ area: 'tool-card', id: 'tool-card:not-spark' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REMOVE_TARGET_MISSING');
});
