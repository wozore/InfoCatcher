'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchPayload, buildDraftPayload, evidenceFromResponse, generateCatalogDraft } = require('../../src/catalog/ai/deepseek-catalog-ai');
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

test('DeepSeek draft payload uses JSON mode without reasoning by default', () => {
  const payload = buildDraftPayload(
    { name: 'Example', vendor_name: 'Vendor', detail_kind: 'tool' },
    [{ field_path: 'summary', value: 'Verified' }],
    { allowed_fields: ['title', 'summary'] },
  );
  assert.deepEqual(payload.text, { format: { type: 'json_object' } });
  assert.deepEqual(payload.reasoning, { effort: 'none' });
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
  const payloads = [];
  const fetchImpl = async (_url, init) => {
    calls += 1;
    payloads.push(JSON.parse(init.body));
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
  assert.deepEqual(payloads.map(payload => payload.text), [
    { format: { type: 'json_object' } },
    { format: { type: 'json_object' } },
  ]);
  assert.deepEqual(payloads.map(payload => payload.reasoning), [
    { effort: 'none' },
    { effort: 'none' },
  ]);
});

test('draft output reports an incomplete repaired response with a bounded preview', async () => {
  const fetchImpl = async () => fakeResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output_text: '{"title":"truncated',
  });
  const result = await generateCatalogDraft({
    seed: { name: 'X', vendor_name: 'V', detail_kind: 'tool' },
    evidenceBundle: [{ field_path: 'summary', value: 'Verified', source_url: 'https://example.com', source_title: 'Official', evidence_excerpt: 'Verified' }],
    outputSchema: { allowed_fields: ['title', 'summary'] },
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEEPSEEK_OUTPUT_INVALID');
  assert.equal(result.error, '草案响应不完整: max_output_tokens');
  assert.equal(result.response_status, 'incomplete');
  assert.equal(result.incomplete_reason, 'max_output_tokens');
  assert.equal(result.output_preview, '{"title":"truncated');
});

test('draft repair fixes invalid official date and source shapes before planning', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const content = calls === 1
      ? JSON.stringify({ official_date: { release_date: '2025-12-03', announcement_date: '2025-12-05' }, sources: ['https://example.com'] })
      : JSON.stringify({ official_date: '2025-12-03', sources: [{ title: 'Official', url: 'https://example.com' }] });
    return fakeResponse({ output_text: content });
  };
  const result = await generateCatalogDraft({
    seed: { name: 'X', vendor_name: 'V', detail_kind: 'tool' },
    evidenceBundle: [{ field_path: 'official_date', value: '2025-12-03', source_url: 'https://example.com', source_title: 'Official', evidence_excerpt: 'Released' }],
    outputSchema: { allowed_fields: ['official_date', 'sources'] },
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(result.catalogDraft, { official_date: '2025-12-03', sources: [{ title: 'Official', url: 'https://example.com' }] });
});

test('draft validation rejects malformed official date without repair', async () => {
  const fetchImpl = async () => fakeResponse({ output_text: JSON.stringify({ official_date: '2025/12/03' }) });
  const result = await generateCatalogDraft({
    seed: { name: 'X', vendor_name: 'V', detail_kind: 'tool' },
    evidenceBundle: [{ field_path: 'summary', value: 'Verified', source_url: 'https://example.com', source_title: 'Official', evidence_excerpt: 'Verified' }],
    outputSchema: { allowed_fields: ['official_date'] },
  }, { apiKey: 'test-key', fetchImpl, maxRepairCalls: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEEPSEEK_OUTPUT_INVALID');
  assert.equal(result.error, 'official_date 必须是 null 或 YYYY-MM-DD 字符串');
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
