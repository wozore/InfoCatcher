'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { revisionOf } = require('../../src/catalog/catalog-revision');
const { planCatalogResearch } = require('../../src/catalog/catalog-profile-contract');
const { researchCatalog } = require('../../src/catalog/catalog-research');
const { synthesizeCatalog } = require('../../src/catalog/catalog-synthesis');
const { buildCatalogDraftEnvelope, validateCatalogDraftEnvelope } = require('../../src/catalog/catalog-draft-envelope');
const { planCatalogPatches } = require('../../src/catalog/catalog-change-planner');
const {
  prepareCatalogDraft,
  resumeCatalogDraft,
  reviewCatalogDraft,
  discardCatalogDraft,
  resumeResearchLimits,
} = require('../../src/catalog/catalog-assistant');
const { klingVideoSeed, createKlingDossierAdapters } = require('./fixtures/kling-video-dossier');

const LIMITS = {
  search_queries: 4,
  pages: 8,
  responses_calls: 12,
  synthesis_calls: 1,
};

const ASSISTANT_OPTIONS = {
  confirmCost: true,
  maxSearchQueries: 4,
  maxPages: 8,
  maxResponsesCalls: 12,
  maxSynthesisCalls: 1,
};

function repairSnapshot() {
  const snapshot = emptySnapshot();
  const ids = {
    'vendor-card': 'vendor-card:kuaishou',
    'vendor-level1': 'vendor-level1:kuaishou',
    'vendor-level2': 'vendor-level2:kuaishou:kling',
    'tool-level3': 'tool-level3:kling-2-6-pro',
    'tool-card': 'tool-card:kling-2-6-pro',
  };
  for (const [area, id] of Object.entries(ids)) snapshot[area].push({ id, vendor_key: 'kuaishou' });
  return snapshot;
}

function assertNoForbiddenDefaults(value, path = 'record') {
  if (value === null || value === undefined) assert.fail(`${path} contains null/undefined`);
  if (typeof value === 'string') {
    assert.notEqual(value.trim(), '', `${path} contains empty string`);
    assert.doesNotMatch(value, /^(unknown|未知)$/i, `${path} contains unknown placeholder`);
  }
  if (Array.isArray(value)) {
    assert.ok(value.length > 0, `${path} contains empty array`);
    value.forEach((item, index) => assertNoForbiddenDefaults(item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertNoForbiddenDefaults(item, `${path}.${key}`);
  }
}

async function buildOfflinePipeline(missingFields = []) {
  const snapshot = repairSnapshot();
  const plan = planCatalogResearch(klingVideoSeed(), snapshot);
  const research = await researchCatalog(plan, createKlingDossierAdapters(), { limits: LIMITS });
  const synthesis = await synthesizeCatalog(research, plan, createKlingDossierAdapters({ missingFields }));
  const envelope = buildCatalogDraftEnvelope({
    seed: plan.seed,
    baseRevision: revisionOf(snapshot),
    researchPlan: plan,
    research,
    synthesis,
  });
  return { snapshot, plan, research, synthesis, envelope };
}

test('complete Kling video API dossier produces a ready five-layer replace preview', async () => {
  const result = await buildOfflinePipeline();
  assert.equal(result.research.ok, true);
  assert.equal(result.synthesis.ok, true, JSON.stringify(result.synthesis.errors));
  assert.equal(result.synthesis.coverage.missing.length, 0);
  assert.equal(result.envelope.coverage.missing.length, 0);
  assert.equal(result.envelope.state, 'preview_ready');
  assert.equal(result.envelope.readiness.status, 'ready');
  assert.equal(validateCatalogDraftEnvelope(result.envelope).ok, true);

  const patchPlan = planCatalogPatches(result.snapshot, result.envelope.layer_patches);
  assert.equal(patchPlan.updates.length, 5);
  assert.equal(result.envelope.layer_patches.filter(patch => patch.operation === 'replace').length, 5);
  for (const patch of result.envelope.layer_patches) {
    assert.equal(patch.operation, 'replace');
    assertNoForbiddenDefaults(patch.record, `${patch.area}:${patch.id}`);
    for (const field of Object.keys(patch.record)) assert.ok(patch.provenance[field], `${patch.area}.${field} lacks provenance`);
  }
  const detail = result.envelope.layer_patches.find(patch => patch.area === 'tool-level3').record;
  assert.equal(detail.one_m_context.status, 'not_applicable');
  assert.equal(detail.plan.status, 'not_applicable');
  assert.equal(detail.api_pricing.status, 'available');
});

test('Kling dossier without API pricing/access remains blocked and suggests product_variant', async () => {
  const result = await buildOfflinePipeline(['detail.access_level', 'detail.price_badge', 'detail.api_pricing']);
  assert.equal(result.research.ok, true);
  assert.equal(result.synthesis.ok, false);
  assert.equal(result.synthesis.code, 'PROFILE_MISMATCH_SUSPECTED');
  assert.equal(result.synthesis.suggested_detail_kind, 'product_variant');
  assert.ok(result.synthesis.missing_fields.includes('detail.api_pricing'));
  assert.equal(result.envelope.state, 'preview_blocked');
  assert.equal(result.envelope.readiness.status, 'blocked');
  assert.equal(result.envelope.layer_patches.length, 0);
});

test('assistant refuses new before invoking adapters without explicit cost confirmation', async () => {
  let calls = 0;
  const adapters = {
    discover: async () => { calls += 1; return { sources: [] }; },
    acquire: async () => { calls += 1; return { contents: [] }; },
    synthesize: async () => { calls += 1; return {}; },
  };
  const result = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, confirmCost: false, catalogAdapters: adapters });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_CONFIRMATION_REQUIRED');
  assert.equal(calls, 0);
});

test('assistant creates and reviews a schema v3 ready Draft through offline adapters', async () => {
  const adapters = createKlingDossierAdapters();
  let draftId;
  try {
    const prepared = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: adapters });
    draftId = prepared.draft_id;
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.draft.schema_version, 3);
    assert.equal(prepared.draft.layer_patches.filter(patch => patch.operation === 'replace').length, 5);
    assert.equal(prepared.draft.cost.spent.synthesis_calls, 1);
    assert.equal(prepared.draft.cost.spent.extraction_calls, undefined);
    const reviewed = reviewCatalogDraft(draftId);
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.equal(reviewed.plan.updates.length, 5);
  } finally {
    if (draftId) discardCatalogDraft(draftId);
  }
});

test('assistant resume adds a new hard budget and requests only the missing detail scope', async () => {
  const incompleteAdapters = createKlingDossierAdapters({ missingFields: ['detail.access_level', 'detail.price_badge', 'detail.api_pricing'] });
  let draftId;
  try {
    const prepared = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: incompleteAdapters });
    draftId = prepared.draft_id;
    assert.equal(prepared.ok, false);
    assert.equal(prepared.code, 'PROFILE_MISMATCH_SUSPECTED');
    assert.equal(prepared.draft.cost.spent.synthesis_calls, 1);

    const unconfirmedAdapters = createKlingDossierAdapters();
    const unconfirmed = await resumeCatalogDraft(draftId, { ...ASSISTANT_OPTIONS, confirmCost: false, catalogAdapters: unconfirmedAdapters });
    assert.equal(unconfirmed.code, 'COST_CONFIRMATION_REQUIRED');
    assert.equal(unconfirmedAdapters.requested.length, 0);

    const expanded = resumeResearchLimits(ASSISTANT_OPTIONS, prepared.draft.cost);
    assert.equal(expanded.search_queries, prepared.draft.cost.spent.search_queries + ASSISTANT_OPTIONS.maxSearchQueries);
    assert.equal(expanded.synthesis_calls, prepared.draft.cost.spent.synthesis_calls + ASSISTANT_OPTIONS.maxSynthesisCalls);
    assert.equal(expanded.extraction_calls, undefined);

    const resumeAdapters = createKlingDossierAdapters();
    const resumed = await resumeCatalogDraft(draftId, { ...ASSISTANT_OPTIONS, catalogAdapters: resumeAdapters });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumeAdapters.requested.length, 1);
    assert.equal(resumeAdapters.requested[0].scope, 'detail');
    assert.equal(resumed.draft.cost.spent.search_queries, prepared.draft.cost.spent.search_queries + 1);
    assert.equal(resumed.draft.cost.spent.synthesis_calls, 2);
    assert.equal(reviewCatalogDraft(draftId).ok, true);
  } finally {
    if (draftId) discardCatalogDraft(draftId);
  }
});
