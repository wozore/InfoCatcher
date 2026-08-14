'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOfficialDiscoveryQuery } = require('../../src/catalog/ai/catalog-adapters');
const { synthesizeLayerFields } = require('../../src/catalog/ai/deepseek-catalog-ai');
const { revisionOf, previewHashOf } = require('../../src/catalog/catalog-revision');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');

function fakeResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

test('v3 discovery query expands API video pricing terms from predicates', () => {
  const query = buildOfficialDiscoveryQuery({
    plan: {
      seed: {
        name: 'Kling 2.6 Pro',
        vendor_name: '可灵',
        discovery_sources: [{ url: 'https://kling.ai/developer' }],
      },
      profile: { modality: 'video' },
    },
    scope: { kind: 'detail' },
    missing_predicates: ['api_available', 'price_rate', 'max_duration', 'output_resolution', 'audio_capability'],
  });
  assert.match(query, /developer API OpenAPI/);
  assert.match(query, /pricing credits/);
  assert.match(query, /billing price/);
  assert.match(query, /duration resolution audio languages/);
  assert.doesNotMatch(query, /site:/);
});

test('v3 synthesis adapter uses object JSON mode and reserves synthesis plus response budgets', async () => {
  const payloads = [];
  const reservations = [];
  const fetchImpl = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return fakeResponse({
      output_text: JSON.stringify({
        layer_fields: { detail: { summary: '可灵 2.6 Pro' } },
        provenance: { 'detail.summary': ['source-1'] },
        missing: [],
      }),
    });
  };
  const result = await synthesizeLayerFields({
    plan: { profile: { detail_kind: 'api_model', modality: 'video' }, applicability: {}, research_scopes: [] },
    expected_layer_fields: { detail: ['summary'] },
    research: { official_sources: [{ source_id: 'source-1', url: 'https://kling.ai', title: 'Kling', content: 'facts', discovered_for: ['detail:kling-2-6-pro'] }] },
    ledger: { reserve(category, amount) { reservations.push([category, amount]); return { ok: true }; } },
  }, { apiKey: 'test-key', fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.layer_fields.detail.summary, '可灵 2.6 Pro');
  assert.deepEqual(reservations, [['synthesis_calls', 1], ['responses_calls', 1]]);
  assert.deepEqual(payloads[0].reasoning, { effort: 'none' });
  assert.deepEqual(payloads[0].text, { format: { type: 'json_object' } });
  assert.match(payloads[0].instructions, /expected_layer_fields/);
  assert.match(payloads[0].instructions, /missing/);
  assert.match(payloads[0].input, /"layers"/);
});

test('revision and preview hashes are deterministic', () => {
  const snapshot = emptySnapshot();
  assert.equal(revisionOf(snapshot), revisionOf(JSON.parse(JSON.stringify(snapshot))));
  assert.equal(previewHashOf({ b: 1, a: 2 }), previewHashOf({ a: 2, b: 1 }));
});
