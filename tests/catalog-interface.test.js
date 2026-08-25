'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { CATALOG_FILES } = require('../src/shared/paths');
const { catalog, resetCatalogForTests } = require('../src/catalog-interface');
const { validateCatalogSnapshot } = require('../src/catalog/catalog-snapshot-validator');

test.beforeEach(() => resetCatalogForTests());

test('five catalog areas expose list data through one interface', () => {
  for (const [area, expectedMinimum] of [['vendor-card', 11], ['tool-card', 43], ['vendor-level1', 11], ['vendor-level2', 15], ['tool-level3', 52]]) {
    const result = catalog({ area, operation: 'list' });
    assert.equal(result.ok, true);
    assert.ok(result.data.length >= expectedMinimum);
    assert.equal(new Set(result.data.map(item => item.id)).size, result.data.length);
  }
});

test('vendor cards expose only card, filter, and level1 reference fields', () => {
  const allowed = new Set([
    'id', 'vendor_key', 'title', 'icon', 'summary', 'feature_preview',
    'access_level', 'price_badge', 'search_terms', 'level1_ref',
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
    'scenes', 'best_for_preview', 'not_for_preview', 'price_badge',
    'access_level', 'search_terms', 'detail_ref', 'detail_kind',
  ]);
  const level2Fields = new Set([
    'id', 'level1_ref', 'vendor_key', 'title', 'official_url', 'summary', 'status',
    'detail_refs',
  ]);
  const cards = catalog({ area: 'tool-card', operation: 'list' }).data;
  const level2 = catalog({ area: 'vendor-level2', operation: 'list' }).data;
  cards.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !toolCardFields.has(key)), []));
  level2.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level2Fields.has(key)), []));
});

test('level1 and level3 records expose only owned fields', () => {
  const level1Fields = new Set([
    'id', 'vendor_key', 'title', 'icon', 'official_url',
    'description', 'status', 'features', 'level2_refs',
  ]);
  const level3Fields = new Set([
    'id', 'vendor_key', 'detail_kind', 'theme', 'title', 'vendor_label', 'icon', 'official_url',
    'status', 'summary', 'one_m_context', 'api_pricing', 'plan',
    'applicable_scenarios', 'inapplicable_scenarios', 'sources', 'release_date', 'last_updated_date',
  ]);
  const level1 = catalog({ area: 'vendor-level1', operation: 'list' }).data;
  const level3 = catalog({ area: 'tool-level3', operation: 'list' }).data;
  const vendors = catalog({ area: 'vendor-card', operation: 'list' }).data;
  const cards = catalog({ area: 'tool-card', operation: 'list' }).data;
  level1.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level1Fields.has(key)), []));
  level3.forEach(item => assert.deepEqual(Object.keys(item).filter(key => !level3Fields.has(key)), []));
  for (const item of level3) {
    assert.equal('rating_overall' in item, false);
    assert.equal('rating_chinese' in item, false);
    assert.equal('rating_ease' in item, false);
    assert.equal('rating_price' in item, false);
  }
  assert.deepEqual(new Set(level3.map(item => item.detail_kind)), new Set(['tool', 'api_model', 'subscription_plan']));
  assert.equal(level1.every(item => !('display_title' in item) && !('entry_label' in item) && !('citations' in item)), true);
  assert.equal(vendors.every(item => !('scenes' in item) && !('categories' in item)), true);
  const cardsByDetail = new Map(cards.map(card => [card.detail_ref.id, card]));
  assert.equal(cards.every(card => card.detail_kind !== 'subscription_plan'), true);
  assert.equal(level3.filter(item => item.detail_kind !== 'subscription_plan').every(item => cardsByDetail.has(item.id)), true);
  assert.equal(level3.filter(item => item.detail_kind === 'subscription_plan').every(item => !cardsByDetail.has(item.id)), true);
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

test('date contract accepts typed fields and rejects removed date fields', () => {
  const detail = {
    id: 'tool-level3:typed-date',
    vendor_key: 'typed-vendor',
    detail_kind: 'tool',
    theme: 'dev',
    title: 'Typed Date Tool',
    official_url: 'https://example.com/tool',
    release_date: '2025-01-02',
    last_updated_date: '2025-02-03',
    sources: [],
  };
  const card = {
    id: 'tool-card:typed-date',
    tool_key: 'typed-date',
    vendor_key: 'typed-vendor',
    title: 'Typed Date Tool',
    theme: 'dev',
    detail_kind: 'tool',
    detail_ref: { kind: 'tool-level3', id: detail.id },
  };
  const typed = validateCatalogSnapshot({
    'vendor-card': [],
    'tool-card': [card],
    'vendor-level1': [],
    'vendor-level2': [],
    'tool-level3': [detail],
  });
  assert.equal(typed.ok, true);
  assert.deepEqual(typed.errors, []);

  const removedDateField = ['official', 'date'].join('_');
  const legacy = validateCatalogSnapshot({
    'vendor-card': [],
    'tool-card': [{ ...card, id: 'tool-card:legacy', detail_ref: { kind: 'tool-level3', id: 'tool-level3:legacy' } }],
    'vendor-level1': [],
    'vendor-level2': [],
    'tool-level3': [{ ...detail, id: 'tool-level3:legacy', release_date: undefined, last_updated_date: undefined, [removedDateField]: '2025-01-02' }],
  });
  assert.equal(legacy.ok, false);
  assert.ok(legacy.errors.some(item => item.code === 'FIELD_NOT_ALLOWED'));
});

test('subscription plans reject typed public dates', () => {
  const result = validateCatalogSnapshot({
    'vendor-card': [],
    'tool-card': [],
    'vendor-level1': [],
    'vendor-level2': [],
    'tool-level3': [{
      id: 'tool-level3:plan',
      vendor_key: 'typed-vendor',
      detail_kind: 'subscription_plan',
      title: 'Typed Plan',
      release_date: '2025-01-02',
    }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'DATE_NOT_APPLICABLE'));
});


test('scene and featured recommendations use stable tool and detail references', () => {
  const cards = catalog({ area: 'tool-card', operation: 'list' }).data;
  const details = catalog({ area: 'tool-level3', operation: 'list' }).data;
  const toolKeys = new Set(cards.map(card => card.tool_key));
  const detailIds = new Set(details.map(detail => detail.id));
  const scenes = JSON.parse(fs.readFileSync(CATALOG_FILES.scenes, 'utf8')).scenes;
  const featured = JSON.parse(fs.readFileSync(CATALOG_FILES.featured, 'utf8'));

  for (const scene of scenes) {
    for (const task of scene.tasks || []) {
      for (const toolKey of task.tools || []) assert.equal(toolKeys.has(toolKey), true);
      for (const recommendation of task.recommendations || []) {
        assert.equal(toolKeys.has(recommendation.tool_id), true);
        assert.match(recommendation.detail_ref, /^tool-level3:/);
        assert.equal(detailIds.has(recommendation.detail_ref), true);
        assert.equal('item_id' in recommendation, false);
      }
    }
  }

  for (const pick of featured) {
    assert.equal(toolKeys.has(pick.tool_id), true);
    if (pick.detail_ref !== null) {
      assert.match(pick.detail_ref, /^tool-level3:/);
      assert.equal(detailIds.has(pick.detail_ref), true);
    }
    assert.equal('item_id' in pick, false);
  }
});
