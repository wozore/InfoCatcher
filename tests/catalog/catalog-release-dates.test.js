'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateCatalogReleaseDatesEntries, readCatalogReleaseDates, writeCatalogReleaseDates } = require('../../src/shared/catalog-release-dates');
const { buildCatalogReleaseDates } = require('../../src/catalog/catalog-shared-publish');

const SNAPSHOT = {
  'tool-level3': [
    { id: 'tool-level3:glm-5-3', detail_kind: 'api_model', vendor_key: 'zai', title: 'GLM-5.3', release_date: '2026-05-30' },
    { id: 'tool-level3:gemini-3-5-flash', detail_kind: 'api_model', vendor_key: 'google', title: 'Gemini 3.5 Flash', release_date: '2026-05-19' },
    { id: 'tool-level3:cursor', detail_kind: 'tool', vendor_key: 'cursor', title: 'Cursor', last_updated_date: '2026-08-19' },
    { id: 'tool-level3:pro-plan', detail_kind: 'subscription_plan', vendor_key: 'cursor', title: 'Pro Plan', release_date: '2026-01-01' },
    { id: 'tool-level3:no-date-model', detail_kind: 'api_model', vendor_key: 'openai', title: 'No Date Model' },
  ],
  'tool-card': [
    { id: 'tool-card:glm-5-3', tool_key: 'glm-5-3', detail_ref: { kind: 'tool-level3', id: 'tool-level3:glm-5-3' } },
  ],
};

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-release-dates-test-'));
  return path.join(dir, 'catalog-release-dates.json');
}

test('catalog-release-dates：buildCatalogReleaseDates 只投影 api_model/product_variant 且有 release_date', () => {
  const entries = buildCatalogReleaseDates(SNAPSHOT);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.detail_id), ['tool-level3:gemini-3-5-flash', 'tool-level3:glm-5-3'], '字典序排序');
  const glm = entries.find(e => e.detail_id === 'tool-level3:glm-5-3');
  assert.equal(glm.tool_key, 'glm-5-3');
  assert.equal(glm.vendor_key, 'zai');
  assert.equal(glm.title, 'GLM-5.3');
  assert.equal(glm.release_date, '2026-05-30');
});

test('catalog-release-dates：validateCatalogReleaseDatesEntries 逐条校验', () => {
  assert.equal(validateCatalogReleaseDatesEntries(buildCatalogReleaseDates(SNAPSHOT)).length, 0);
  const bad = validateCatalogReleaseDatesEntries([
    { detail_id: '', detail_kind: 'api_model', release_date: '2026-01-01' },
    { detail_id: 'x', detail_kind: 'tool', release_date: '2026-01-01' },
    { detail_id: 'x', detail_kind: 'product_variant', release_date: 'bad' },
    { detail_id: 'x', detail_kind: 'api_model', release_date: '2026-01-01', title: 1 },
  ]);
  assert.equal(bad.length, 4);
});

test('catalog-release-dates：writeCatalogReleaseDates 合法落盘 + 非法 fail-closed 不覆盖', () => {
  const file = tempFile();
  const ok = writeCatalogReleaseDates(buildCatalogReleaseDates(SNAPSHOT), file);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version, 1);
  const invalid = writeCatalogReleaseDates([{ detail_id: 'x', detail_kind: 'tool', release_date: '2026-01-01' }], file);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'SHARED_CATALOG_RELEASE_DATES_INVALID');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 2, '非法不覆盖已落盘内容');
});

test('catalog-release-dates：readCatalogReleaseDates 缺失/损坏回退空 + 冻结', () => {
  const missing = readCatalogReleaseDates(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-release-dates-test-')), 'nope.json'));
  assert.equal(missing.entries.length, 0);
  const file = tempFile();
  writeCatalogReleaseDates(buildCatalogReleaseDates(SNAPSHOT), file);
  const loaded = readCatalogReleaseDates(file);
  assert.equal(loaded.entries.length, 2);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.entries), true);
});
