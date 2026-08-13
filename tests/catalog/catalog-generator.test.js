'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchPayload, evidenceFromResponse, generateCatalogDraft } = require('../../src/catalog/ai/deepseek-catalog-ai');
const { planCatalogChange } = require('../../src/catalog/catalog-change-planner');
const { revisionOf, previewHashOf } = require('../../src/catalog/catalog-revision');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');

function fakeResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

test('DeepSeek search payload requests server-side web_search', () => {
  const payload = buildSearchPayload({ name: 'Example', vendor_name: 'Vendor' });
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.deepEqual(payload.tools, [{ type: 'web_search' }]);
  assert.deepEqual(payload.tool_choice, { type: 'web_search' });
});

test('search evidence requires auditable URL and excerpt', () => {
  const evidence = evidenceFromResponse({
    output_text: JSON.stringify([
      { field_path: 'official_url', value: 'https://example.com', source_url: 'https://example.com', source_title: 'Official', evidence_excerpt: 'Official page' },
      { field_path: 'summary', value: 'bad', source_url: '', source_title: 'No URL', evidence_excerpt: 'No source' },
    ]),
  }, '2026-08-14T00:00:00.000Z');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].retrieved_at, '2026-08-14T00:00:00.000Z');
});

test('draft output rejects unknown business fields then repairs once', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const content = calls === 1 ? JSON.stringify({ title: 'X', unexpected: true }) : JSON.stringify({ title: 'X', summary: 'Verified' });
    return fakeResponse({ output_text: content });
  };
  const result = await generateCatalogDraft({
    seed: { name: 'X', vendor_name: 'V', detail_kind: 'tool' },
    evidenceBundle: [{ field_path: 'summary', value: 'Verified', source_url: 'https://example.com', source_title: 'Official', evidence_excerpt: 'Verified' }],
    outputSchema: { allowed_fields: ['title', 'summary'] },
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(result.catalogDraft, { title: 'X', summary: 'Verified' });
});

test('planner creates tool card for api_model and no tool card for subscription plan', () => {
  const apiPlan = planCatalogChange(emptySnapshot(), { detail_kind: 'api_model', name: 'Example Model', vendor_name: 'Example Vendor', official_url: 'https://example.com', placement: { new_group_title: 'Models' } }, { title: 'Example Model', vendor_label: 'Example Vendor', summary: 'Summary', description: 'Description', official_url: 'https://example.com', theme: 'dev', sources: [{ title: 'Official', url: 'https://example.com' }] });
  assert.equal(apiPlan.creates['tool-card'].length, 1);
  const subscriptionPlan = planCatalogChange(emptySnapshot(), { detail_kind: 'subscription_plan', name: 'Example Plan', vendor_name: 'Example Vendor', official_url: 'https://example.com', placement: { new_group_title: 'Plans' } }, { title: 'Example Plan', vendor_label: 'Example Vendor', summary: 'Summary', description: 'Description', official_url: 'https://example.com', plan: { amount: 10, currency: 'USD', billing_period: 'month' }, sources: [{ title: 'Official', url: 'https://example.com' }] });
  assert.equal(subscriptionPlan.creates['tool-card'].length, 0);
  assert.equal(subscriptionPlan.creates['tool-level3'][0].detail_kind, 'subscription_plan');
});

test('revision and preview hashes are deterministic', () => {
  const snapshot = emptySnapshot();
  assert.equal(revisionOf(snapshot), revisionOf(JSON.parse(JSON.stringify(snapshot))));
  assert.equal(previewHashOf({ b: 1, a: 2 }), previewHashOf({ a: 2, b: 1 }));
});
