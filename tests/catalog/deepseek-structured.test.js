'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonValues, requestStructuredJson } = require('../../src/catalog/ai/deepseek-structured');
const { synthesizeLayerFields } = require('../../src/catalog/ai/deepseek-catalog-ai');

function response(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function synthesisValidate(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.layer_fields);
}

test('extractJsonValues accepts object, array, code fence, and surrounding text', () => {
  assert.deepEqual(extractJsonValues('{"layer_fields":{}}'), [{ layer_fields: {} }]);
  assert.deepEqual(extractJsonValues('[{"field":"f1"}]'), [[{ field: 'f1' }]]);
  assert.deepEqual(extractJsonValues('```json\n{"layer_fields":{}}\n```'), [{ layer_fields: {} }]);
  assert.deepEqual(extractJsonValues('结果如下：{"layer_fields":{}}。'), [{ layer_fields: {} }]);
});

test('requestStructuredJson distinguishes empty, incomplete, invalid, and schema failures', async () => {
  const cases = [
    [{ output: [] }, 'DEEPSEEK_SYNTHESIS_EMPTY'],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"layer_fields":' }, 'DEEPSEEK_SYNTHESIS_INCOMPLETE'],
    [{ output_text: 'not json' }, 'DEEPSEEK_SYNTHESIS_OUTPUT_INVALID'],
    [{ output_text: '{"items":[]}' }, 'DEEPSEEK_SYNTHESIS_SCHEMA_INVALID'],
  ];
  for (const [data, code] of cases) {
    const result = await requestStructuredJson({
      kind: 'synthesis',
      instructions: 'test',
      input: 'test',
      ledger: { reserve: () => ({ ok: true }) },
      validate: synthesisValidate,
    }, { apiKey: 'test-key', fetchImpl: async () => response(data) });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.ok(result.error);
    if (code.endsWith('INCOMPLETE')) assert.equal(result.incomplete_reason, 'max_output_tokens');
  }
});

test('synthesis adapter requires a cost ledger and reserves synthesis plus response budgets', async () => {
  const withoutLedger = await synthesizeLayerFields({
    plan: { profile: { detail_kind: 'api_model', modality: 'video' }, applicability: {}, research_scopes: [] },
    expected_layer_fields: { detail: ['summary'] },
    research: { official_sources: [] },
    ledger: null,
  }, { apiKey: 'test-key' });
  assert.equal(withoutLedger.ok, false);
  assert.equal(withoutLedger.code, 'COST_LEDGER_REQUIRED');

  const reservations = [];
  const payloads = [];
  const result = await synthesizeLayerFields({
    plan: { profile: { detail_kind: 'api_model', modality: 'video' }, applicability: {}, research_scopes: [] },
    expected_layer_fields: { detail: ['summary'] },
    research: { official_sources: [{ source_id: 'source-1', url: 'https://kling.ai', title: 'Kling', content: 'facts', discovered_for: ['detail:kling-2-6-pro'] }] },
    ledger: { reserve(category, amount) { reservations.push([category, amount]); return { ok: true }; } },
  }, {
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return response({ output_text: JSON.stringify({ layer_fields: { detail: { summary: '总结' } }, provenance: { 'detail.summary': ['source-1'] }, missing: [] }) });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.layer_fields.detail.summary, '总结');
  assert.deepEqual(reservations, [['synthesis_calls', 1], ['responses_calls', 1]]);
  assert.deepEqual(payloads[0].reasoning, { effort: 'none' });
  assert.deepEqual(payloads[0].text, { format: { type: 'json_object' } });
});

test('structured failure preserves bounded response diagnostics', async () => {
  const preview = 'x'.repeat(3000);
  const result = await requestStructuredJson({
    kind: 'synthesis',
    instructions: 'test',
    input: 'test',
    ledger: { reserve: () => ({ ok: true }) },
    validate: synthesisValidate,
  }, { apiKey: 'test-key', fetchImpl: async () => response({ status: 'completed', output_text: preview }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEEPSEEK_SYNTHESIS_OUTPUT_INVALID');
  assert.equal(result.output_preview.length, 1200);
});
