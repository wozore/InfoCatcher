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
