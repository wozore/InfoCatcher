'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let dateDisplay;
let detailKindLabel;
test.before(async () => {
  ({ getToolDateDisplay: dateDisplay, getToolDetailKindLabel: detailKindLabel } = await import('../src/web/js/date-display.mjs'));
});

test('typed dates use the detail kind contract', () => {
  assert.deepEqual(dateDisplay({ detail_kind: 'tool', last_updated_date: '2026-08-03' }), {
    label: '最近更新', value: '2026-08-03', kind: 'tool', freshnessEligible: true,
  });
  assert.deepEqual(dateDisplay({ detail_kind: 'api_model', release_date: '2026-08-13' }), {
    label: '发布日期', value: '2026-08-13', kind: 'api_model', freshnessEligible: true,
  });
});

test('missing dates and subscriptions have no date', () => {
  assert.equal(dateDisplay({ detail_kind: 'tool' }), null);
  assert.equal(dateDisplay({ detail_kind: 'subscription_plan' }), null);
  assert.equal(dateDisplay({ detail_kind: 'tool', last_updated_date: 'not-a-date' }), null);
});

test('detail kind labels distinguish scene cards', () => {
  assert.equal(detailKindLabel({ detail_kind: 'tool' }), '具体工具');
  assert.equal(detailKindLabel({ detail_kind: 'api_model' }), 'API 模型');
  assert.equal(detailKindLabel({ detail_kind: 'product_variant' }), '产品变体');
});
