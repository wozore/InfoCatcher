'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/core/index');
const { planCatalogResearch } = require('../../src/catalog/core/index');

function videoSeed(overrides = {}) {
  return {
    detail_kind: 'api_model',
    modality: 'video',
    name: 'Kling 2.6 Pro',
    vendor_name: '可灵',
    vendor_key: 'kuaishou',
    tool_key: 'kling-2-6-pro',
    placement: { new_group_title: 'Kling' },
    known_fields: { theme: 'media' },
    ...overrides,
  };
}

function existingVendorSnapshot() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou', level2_refs: [] });
  return snapshot;
}

test('video API profile requires API/access/pricing facts and marks text context/plan inapplicable', () => {
  const plan = planCatalogResearch(videoSeed(), emptySnapshot());
  assert.equal(plan.profile.key, 'api_model:video');
  assert.ok(plan.required_predicates.includes('api_available'));
  assert.ok(plan.required_predicates.includes('access_conditions'));
  assert.ok(plan.required_predicates.includes('price_rate'));
  assert.ok(plan.required_predicates.includes('max_duration'));
  assert.equal(plan.applicability.one_m_context, 'not_applicable');
  assert.equal(plan.applicability.plan, 'not_applicable');
  assert.equal(plan.applicability.api_pricing, 'required');
});

test('group key removes a redundant -models suffix', () => {
  const plan = planCatalogResearch(videoSeed({
    vendor_name: 'Google',
    vendor_key: 'google',
    placement: { new_group_title: 'Gemini Models' },
  }), emptySnapshot());
  assert.equal(plan.keys.groupKey, 'gemini');
  assert.equal(plan.target_ids['vendor-level2'], 'vendor-level2:google:gemini');
});

test('existing vendor links a new group without re-researching vendor fields', () => {
  const plan = planCatalogResearch(videoSeed(), existingVendorSnapshot());
  assert.equal(plan.layer_plan['vendor-card'].operation, 'noop');
  assert.equal(plan.layer_plan['vendor-level1'].operation, 'replace');
  assert.equal(plan.layer_plan['vendor-level1'].link_only, true);
  assert.equal(plan.layer_plan['vendor-level2'].operation, 'create');
  assert.equal(plan.layer_plan['tool-level3'].operation, 'create');
  assert.equal(plan.layer_plan['tool-card'].operation, 'create');
  assert.equal(plan.research_scopes.some(scope => scope.kind === 'vendor'), false);
  assert.equal(plan.research_scopes.some(scope => scope.kind === 'detail'), true);
});

test('existing group links a new detail without re-researching group fields', () => {
  const snapshot = existingVendorSnapshot();
  snapshot['vendor-level1'][0].level2_refs = [{ kind: 'vendor-level2', id: 'vendor-level2:kuaishou:kling' }];
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou', detail_refs: [] });
  const plan = planCatalogResearch(videoSeed({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:kuaishou:kling' } } }), snapshot);
  assert.equal(plan.layer_plan['vendor-level1'].operation, 'noop');
  assert.equal(plan.layer_plan['vendor-level2'].operation, 'replace');
  assert.equal(plan.layer_plan['vendor-level2'].link_only, true);
  assert.equal(plan.research_scopes.some(scope => scope.kind === 'group'), false);
  assert.equal(plan.research_scopes.some(scope => scope.kind === 'detail'), true);
});
test('existing group links an existing orphan detail without creating a research scope', () => {
  const snapshot = existingVendorSnapshot();
  snapshot['vendor-level1'][0].level2_refs = [{ kind: 'vendor-level2', id: 'vendor-level2:kuaishou:kling' }];
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou', detail_refs: [] });
  snapshot['tool-level3'].push({ id: 'tool-level3:kling-2-6-pro', vendor_key: 'kuaishou', detail_kind: 'api_model' });
  snapshot['tool-card'].push({ id: 'tool-card:kling-2-6-pro', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro' });
  const plan = planCatalogResearch(videoSeed({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:kuaishou:kling' } } }), snapshot);
  assert.equal(plan.layer_plan['vendor-level2'].operation, 'replace');
  assert.equal(plan.layer_plan['vendor-level2'].link_only, true);
  assert.deepEqual(plan.research_scopes, []);
});
test('repair layers replace only explicitly targeted existing records', () => {
  const snapshot = existingVendorSnapshot();
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou', detail_refs: [] });
  snapshot['tool-level3'].push({ id: 'tool-level3:kling-2-6-pro', vendor_key: 'kuaishou', detail_kind: 'api_model' });
  snapshot['tool-card'].push({ id: 'tool-card:kling-2-6-pro', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro' });
  const plan = planCatalogResearch(videoSeed({ repair_layers: ['vendor-card', 'vendor-level1', 'vendor-level2', 'tool-level3', 'tool-card'] }), snapshot);
  for (const area of ['vendor-card', 'vendor-level1', 'vendor-level2', 'tool-level3', 'tool-card']) {
    assert.equal(plan.layer_plan[area].operation, 'replace');
  }
  assert.deepEqual(plan.research_scopes.map(scope => scope.kind), ['vendor', 'group', 'detail']);
});

test('profile matrix keeps modality-specific predicates and applicability separate', () => {
  const cases = [
    { detail_kind: 'api_model', modality: 'text', profile: 'api_model:text', required: ['release_date', 'context_window', 'api_available', 'price_rate'], absent: ['last_updated_date', 'max_duration'], applicability: ['required', 'required', 'not_applicable'], toolCard: true },
    { detail_kind: 'api_model', modality: 'image', profile: 'api_model:image', required: ['release_date', 'output_resolution', 'api_available', 'price_rate'], absent: ['last_updated_date', 'context_window', 'audio_capability'], applicability: ['not_applicable', 'required', 'not_applicable'], toolCard: true },
    { detail_kind: 'api_model', modality: 'audio', profile: 'api_model:audio', required: ['release_date', 'audio_capability', 'supported_languages', 'price_rate'], absent: ['last_updated_date', 'context_window', 'max_duration'], applicability: ['not_applicable', 'required', 'not_applicable'], toolCard: true },
    { detail_kind: 'tool', modality: undefined, profile: 'tool:general', required: ['last_updated_date', 'access_conditions', 'pricing_model'], absent: ['release_date', 'api_available', 'price_rate'], applicability: ['not_applicable', 'not_applicable', 'not_applicable'], toolCard: true },
    { detail_kind: 'product_variant', modality: undefined, profile: 'product_variant:general', required: ['release_date', 'access_conditions', 'pricing_model'], absent: ['last_updated_date', 'api_available', 'price_rate'], applicability: ['not_applicable', 'not_applicable', 'not_applicable'], toolCard: true },
    { detail_kind: 'subscription_plan', modality: undefined, profile: 'subscription_plan:general', required: ['price_rate', 'billing_period', 'plan_conditions', 'included_models_status'], absent: ['release_date', 'last_updated_date', 'api_available', 'capability'], applicability: ['not_applicable', 'not_applicable', 'required'], toolCard: false },
  ];

  for (const item of cases) {
    const plan = planCatalogResearch(videoSeed({ detail_kind: item.detail_kind, modality: item.modality }), emptySnapshot());
    const detail = plan.research_scopes.find(scope => scope.kind === 'detail');
    assert.equal(plan.profile.key, item.profile);
    item.required.forEach(predicate => assert.ok(detail.predicates.includes(predicate), `${item.profile} missing ${predicate}`));
    item.absent.forEach(predicate => assert.equal(detail.predicates.includes(predicate), false, `${item.profile} unexpectedly requires ${predicate}`));
    assert.deepEqual([plan.applicability.one_m_context, plan.applicability.api_pricing, plan.applicability.plan], item.applicability);
    assert.equal(Boolean(plan.layer_plan['tool-card']), item.toolCard);
  }
});

test('profile planning rejects unsupported modality instead of falling back silently', () => {
  assert.throws(() => planCatalogResearch(videoSeed({ modality: 'hologram' }), emptySnapshot()), /CATALOG_PROFILE_UNSUPPORTED/);
});
