'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalogDraftEnvelope, validateCatalogDraftEnvelope } = require('../../src/catalog/draft/index');

function plan() {
  return {
    schema_version: 1,
    seed: { detail_kind: 'api_model', modality: 'video', name: 'X', vendor_name: 'V' },
    research_scopes: [{ kind: 'detail', subject: { kind: 'detail', key: 'x' }, predicates: ['api_available'] }],
    layer_plan: { 'tool-level3': { area: 'tool-level3', id: 'tool-level3:x', operation: 'create' } },
    profile: { key: 'api_model:video', detail_kind: 'api_model', modality: 'video' },
    applicability: { one_m_context: 'not_applicable', api_pricing: 'required', plan: 'not_applicable' },
  };
}

function fullDetailFields() {
  return {
    summary: '可灵是视频生成平台。',
    official_url: 'https://kling.ai',
    detail_status: 'active',
    access_level: '开放',
    price_badge: 'usage_based',
    scenes: ['短视频生成'],
    best_for_preview: '适合短视频创作。',
    not_for_preview: '不适合超长视频。',
    api_pricing: { status: 'available', rate_cards: [{ label: '生成', pricing_basis: 'generation', currency: 'CREDIT', metrics: [{ label: '标准', amount: 1, unit: 'generation' }], conditions: '官方说明' }] },
    applicable_scenarios: [{ title: '短视频', description: '短视频创作。' }],
    inapplicable_scenarios: [{ title: '长视频', description: '超长视频不适合。' }],
    release_date: '2025-12-03',
  };
}

function research(sourceOverrides = {}) {
  return {
    ok: true,
    official_sources: [{ source_id: 's1', url: 'https://example.com', title: 'Official', excerpt: 'API is available.', content: 'API is available.', ...sourceOverrides }],
    warnings: [],
    cost: { limits: {}, spent: {}, remaining: {} },
  };
}

function synthesis(missing = []) {
  const detail = fullDetailFields();
  const provenance = {};
  for (const field of Object.keys(detail)) provenance[`detail.${field}`] = ['s1'];
  const missingFields = [];
  for (const field of missing) {
    delete detail[field];
    delete provenance[`detail.${field}`];
    missingFields.push(field);
  }
  return {
    ok: true,
    layer_patches: [{ area: 'tool-level3', id: 'tool-level3:x', operation: 'noop', record: null, provenance: {} }],
    synthesis: { layer_fields: { detail }, provenance },
    coverage: { entries: [], covered: [], missing: missingFields.map(field => ({ layer: 'detail', field })) },
    cost: { limits: {}, spent: {}, remaining: {} },
  };
}

test('draft envelope is ready only when field coverage and layer patches are valid', () => {
  const envelope = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research(), synthesis: synthesis() });
  assert.equal(envelope.schema_version, 3);
  assert.equal(envelope.state, 'preview_ready');
  assert.equal(envelope.readiness.status, 'ready');
  assert.equal(envelope.coverage.missing.length, 0);
  assert.equal(validateCatalogDraftEnvelope(envelope).ok, true);
});

test('field coverage gap creates preview_blocked envelope and cannot be relabeled ready', () => {
  const envelope = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research(), synthesis: synthesis(['access_level']) });
  assert.equal(envelope.state, 'preview_blocked');
  assert.equal(envelope.readiness.status, 'blocked');
  const forged = { ...envelope, readiness: { status: 'ready', blocking_reasons: [], warnings: [] } };
  const checked = validateCatalogDraftEnvelope(forged);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(error => error.code === 'READINESS_MISMATCH'));
  assert.ok(checked.recomputed_missing.includes('detail.access_level'));
});

test('failed research preserves bounded failure diagnostics', () => {
  const envelope = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: {
      ...research(),
      ok: false,
      code: 'TAVILY_SEARCH_FAILED',
      error: 'Tavily 搜索失败',
      response_status: 'error',
      output_types: ['message'],
      output_preview: 'x'.repeat(1200),
    },
    synthesis: null,
  });
  assert.equal(envelope.last_error.code, 'TAVILY_SEARCH_FAILED');
  assert.equal(envelope.last_error.response_status, 'error');
  assert.equal(envelope.last_error.output_preview.length, 1200);
});

test('draft envelope rejects missing or duplicate source_ids', () => {
  const missingId = buildCatalogDraftEnvelope({ seed: plan().seed, baseRevision: 'rev-1', researchPlan: plan(), research: research({ source_id: '' }), synthesis: synthesis() });
  assert.ok(validateCatalogDraftEnvelope(missingId).errors.some(error => error.code === 'SOURCE_ID_INVALID'));

  const duplicate = buildCatalogDraftEnvelope({
    seed: plan().seed,
    baseRevision: 'rev-1',
    researchPlan: plan(),
    research: {
      ...research(),
      official_sources: [
        { source_id: 's1', url: 'https://example.com', title: 'A', excerpt: 'x', content: 'x' },
        { source_id: 's1', url: 'https://example.com/other', title: 'B', excerpt: 'x', content: 'x' },
      ],
    },
    synthesis: synthesis(),
  });
  assert.ok(validateCatalogDraftEnvelope(duplicate).errors.some(error => error.code === 'SOURCE_ID_INVALID'));
});

test('legacy draft schemas are blocked from the new Apply path', () => {
  const checked = validateCatalogDraftEnvelope({ schema_version: 2, readiness: { status: 'ready' } });
  assert.equal(checked.ok, false);
  assert.equal(checked.errors[0].code, 'DRAFT_SCHEMA_UNSUPPORTED');
});
