'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, resetCatalogForTests } = require('../src/catalog-interface');

test.beforeEach(() => resetCatalogForTests());

test('five catalog areas expose list data through one interface', () => {
  for (const [area, expectedMinimum] of [['vendor-card', 11], ['tool-card', 60], ['vendor-level1', 11], ['vendor-level2', 15], ['tool-level3', 60]]) {
    const result = catalog({ area, operation: 'list' });
    assert.equal(result.ok, true);
    assert.ok(result.data.length >= expectedMinimum);
    assert.equal(new Set(result.data.map(item => item.id)).size, result.data.length);
  }
});

test('vendor cards expose only card, filter, and level1 reference fields', () => {
  const allowed = new Set([
    'id', 'vendor_key', 'title', 'icon', 'summary', 'feature_preview',
    'categories', 'scenes', 'access_level', 'price_status', 'search_terms', 'level1_ref',
  ]);
  const vendors = catalog({ area: 'vendor-card', operation: 'list' }).data;
  vendors.forEach(item => {
    assert.deepEqual(Object.keys(item).filter(key => !allowed.has(key)), []);
    assert.equal(item.level1_ref.kind, 'vendor-level1');
  });
});

test('tool cards and level2 previews expose only owned fields', () => {
  const toolCardFields = new Set([
    'id', 'tool_key', 'vendor_key', 'title', 'vendor_label', 'icon', 'summary', 'theme',
    'categories', 'scenes', 'best_for_preview', 'not_for_preview', 'price_badge',
    'access_level', 'search_terms', 'detail_ref', 'detail_kind',
  ]);
  const level2Fields = new Set([
    'id', 'level1_ref', 'vendor_key', 'title', 'kind', 'official_url', 'summary', 'status',
    'detail_refs', 'citations',
  ]);
  const cards = catalog({ area: 'tool-card', operation: 'list' }).data;
  const level2 = catalog({ area: 'vendor-level2', operation: 'list' }).data;
  cards.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !toolCardFields.has(key)), []));
  level2.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level2Fields.has(key)), []));
});

test('level1 and level3 records expose only owned fields', () => {
  const level1Fields = new Set([
    'id', 'vendor_key', 'title', 'entry_label', 'display_title', 'icon', 'official_url',
    'description', 'status', 'features', 'level2_refs', 'citations',
  ]);
  const level3Fields = new Set([
    'id', 'tool_key', 'vendor_key', 'kind', 'title', 'vendor_label', 'icon', 'official_url',
    'status', 'summary', 'weaknesses', 'one_m_context', 'api_pricing', 'cache_hit_rate', 'plan',
    'applicable_scenarios', 'inapplicable_scenarios', 'source_refs', 'sources', 'category', 'scenes',
    'access_level', 'access_barrier', 'free_tier', 'paid_tiers', 'last_updated',
  ]);
  const level1 = catalog({ area: 'vendor-level1', operation: 'list' }).data;
  const level3 = catalog({ area: 'tool-level3', operation: 'list' }).data;
  level1.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level1Fields.has(key)), []));
  level3.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level3Fields.has(key)), []));
  for (const item of level3) {
    assert.equal('rating_overall' in item, false);
    assert.equal('rating_chinese' in item, false);
    assert.equal('rating_ease' in item, false);
    assert.equal('rating_price' in item, false);
  }
  assert.deepEqual(new Set(level3.map(item => item.kind)), new Set(['tool', 'api_model', 'subscription_plan']));
});

test('cross-module references resolve to their target areas', () => {
  const vendors = catalog({ area: 'vendor-card', operation: 'list' }).data;
  const levels1 = catalog({ area: 'vendor-level1', operation: 'list' }).data;
  const levels2 = catalog({ area: 'vendor-level2', operation: 'list' }).data;
  const details = catalog({ area: 'tool-level3', operation: 'list' }).data;
  const level1Ids = new Set(levels1.map(item => item.id));
  const level2Ids = new Set(levels2.map(item => item.id));
  const detailIds = new Set(details.map(item => item.id));
  vendors.forEach(item => assert.equal(level1Ids.has(item.level1_ref.id), true));
  levels1.forEach(item => item.level2_refs.forEach(ref => assert.equal(level2Ids.has(ref.id), true)));
  levels2.forEach(item => item.detail_refs.forEach(ref => assert.equal(detailIds.has(ref.id), true)));
});

test('stable refs and missing refs use normalized errors', () => {
  const vendor = catalog({ area: 'vendor-card', operation: 'list' }).data[0];
  const resolved = catalog({ area: 'vendor-card', operation: 'resolve', id: vendor.level1_ref });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, 'INVALID_REF');
  const missing = catalog({ area: 'tool-level3', operation: 'get', id: 'tool-level3:missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
});

test('tool card and detail share one detail reference', () => {
  const cards = catalog({ area: 'tool-card', operation: 'list' }).data;
  const details = new Set(catalog({ area: 'tool-level3', operation: 'list' }).data.map(item => item.id));
  cards.forEach(card => assert.equal(details.has(card.detail_ref.id), true));
});
