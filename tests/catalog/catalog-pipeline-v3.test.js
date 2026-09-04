'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { loadCatalogSnapshot } = require('../../src/catalog/catalog-snapshot-store');
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
  recoveryPlanForDraft,
} = require('../../src/catalog/catalog-assistant');
const { createDraft, deleteDraft } = require('../../src/catalog/catalog-draft-store');
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


test('assistant prepares a research-resume plan for evidence-blocked Drafts', () => {
  const current = loadCatalogSnapshot();
  const draft = createDraft({
    state: 'preview_blocked',
    base_revision: current.revision,
    research: { ok: true, official_sources: [], warnings: [] },
    coverage: { missing: [{ layer: 'detail', field: 'summary' }] },
    readiness: { status: 'blocked', blocking_reasons: ['缺少官方证据字段'] },
    last_error: { code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: ['detail.summary'] },
  });
  try {
    const result = recoveryPlanForDraft(draft.draft_id, { expectedRevision: current.revision, generatorOptions: { model: 'deepseek-v4-flash' } });
    assert.deepEqual(result, { ok: true, draft_id: draft.draft_id, expected_revision: current.revision, recovery_kind: 'evidence_required', recovery_mode: 'research_resume', error_code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: ['detail.summary'], missing_config_fields: [], suggested_detail_kind: null, cost_plan: { mode: 'research_resume', hard_limits: { search_queries: 4, pages: 8, responses_calls: 12, synthesis_calls: 1 }, previous_cost: null }, generator_options: { model: 'deepseek-v4-flash' }, recovery_token: result.recovery_token });
  } finally {
    deleteDraft(draft.draft_id);
  }
});

test('assistant recovers an orphaned resuming Draft but still forbids ready Drafts', () => {  const current = loadCatalogSnapshot();
  const orphan = createDraft({
    state: 'resuming',
    base_revision: current.revision,
    research: { ok: true, official_sources: [], warnings: [] },
    coverage: { missing: [{ layer: 'detail', field: 'summary' }] },
    readiness: { status: 'blocked', blocking_reasons: ['缺少官方证据字段'] },
    last_error: { code: 'SYNTHESIS_COVERAGE_INCOMPLETE', missing_fields: ['detail.summary'] },
    recovery_checkpoint: { recovery_token: 'sha256:orphan', recovery_mode: 'research_resume', started_at: new Date().toISOString() },
  });
  const ready = createDraft({
    state: 'preview_ready',
    base_revision: current.revision,
    research: { ok: true, official_sources: [], warnings: [] },
    readiness: { status: 'ready', blocking_reasons: [] },
  });
  try {
    const recovered = recoveryPlanForDraft(orphan.draft_id, { expectedRevision: current.revision, generatorOptions: { model: 'deepseek-v4-flash' } });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.recovery_kind, 'evidence_required');
    const forbidden = recoveryPlanForDraft(ready.draft_id, { expectedRevision: current.revision, generatorOptions: { model: 'deepseek-v4-flash' } });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.code, 'DRAFT_RECOVERY_FORBIDDEN');
  } finally {
    deleteDraft(orphan.draft_id);
    deleteDraft(ready.draft_id);
  }
});

test('assistant recovery plan treats kind-segmented schema failures as retryable', () => {
  const current = loadCatalogSnapshot();
  const draft = createDraft({
    state: 'preview_blocked',
    base_revision: current.revision,
    research: { ok: true, official_sources: [{ source_id: 'src-1', url: 'https://kling.ai/docs', title: 'Docs' }], warnings: [] },
    readiness: { status: 'blocked', blocking_reasons: ['ZhipuAI synthesis JSON 结构不符合契约'] },
    last_error: { code: 'DEEPSEEK_SYNTHESIS_SCHEMA_INVALID', recovery_kind: 'manual_required', error: 'ZhipuAI synthesis JSON 结构不符合契约', missing_fields: [], missing_config_fields: [] },
  });
  try {
    const plan = recoveryPlanForDraft(draft.draft_id, { expectedRevision: current.revision, generatorOptions: { model: 'deepseek-v4-flash' } });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.recovery_kind, 'retryable');
    assert.equal(plan.recovery_mode, 'synthesis_only');
  } finally {
    deleteDraft(draft.draft_id);
  }
});

test('assistant resume reuses completed research after a missing-model synthesis failure', async () => {
  const requested = [];
  let synthesisCalls = 0;
  const adapters = {
    discover: async input => {
      requested.push(`discover:${input.scope.kind}`);
      return { sources: [{ url: 'https://kling.ai/official-dossier', title: 'Kling official dossier', excerpt: 'Official facts.' }] };
    },
    acquire: async input => {
      requested.push(`acquire:${input.scope.kind}`);
      return { contents: input.sources.map(source => ({ url: source.url, content: 'Official facts.' })) };
    },
    synthesize: async input => {
      synthesisCalls += 1;
      if (synthesisCalls === 1) return { ok: false, code: 'DEEPSEEK_OUTPUT_INVALID', error: 'missing field `model`', cost: input.ledger.snapshot() };
      return createKlingDossierAdapters().synthesize(input);
    },
  };
  let draftId;
  try {
    const prepared = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: adapters });
    draftId = prepared.draft_id;
    assert.equal(prepared.ok, false);
    assert.equal(prepared.code, 'MODEL_REQUIRED');
    assert.equal(prepared.draft.last_error.recovery_kind, 'config_required');
    assert.deepEqual(prepared.draft.last_error.missing_config_fields, ['model']);
    const recovery = require('../../src/catalog/catalog-assistant').recoveryPlanForDraft(draftId, {
      expectedRevision: prepared.draft.base_revision,
      generatorOptions: { model: 'deepseek-v4-flash' },
    });
    const recoveryWithCost = require('../../src/catalog/catalog-assistant').recoveryPlanForDraft(draftId, {
      expectedRevision: prepared.draft.base_revision,
      generatorOptions: { model: 'deepseek-v4-flash', confirmCost: true },
    });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.recovery_token, recoveryWithCost.recovery_token);
    assert.equal(recovery.recovery_mode, 'synthesis_only');
    assert.equal(recovery.cost_plan.hard_limits.search_queries, 0);
    assert.equal(recovery.cost_plan.hard_limits.pages, 0);

    const staleAdapters = createKlingDossierAdapters();
    const staleToken = await resumeCatalogDraft(draftId, {
      ...ASSISTANT_OPTIONS,
      model: 'deepseek-v4-flash',
      expectedRevision: prepared.draft.base_revision,
      recoveryToken: 'sha256:stale',
      catalogAdapters: staleAdapters,
    });
    assert.equal(staleToken.code, 'RECOVERY_TOKEN_CHANGED');
    assert.equal(staleAdapters.requested.length, 0);

    const researchCallsBeforeResume = requested.slice();
    const resumed = await resumeCatalogDraft(draftId, {
      ...ASSISTANT_OPTIONS,
      model: 'deepseek-v4-flash',
      expectedRevision: prepared.draft.base_revision,
      recoveryToken: recovery.recovery_token,
      catalogAdapters: adapters,
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.draft.state, 'preview_ready');
    assert.equal(synthesisCalls, 2);
    assert.deepEqual(requested, researchCallsBeforeResume);
  } finally {
    if (draftId) discardCatalogDraft(draftId);
  }
});


test('assistant allows only one concurrent resume claim for a Draft', async () => {
  let synthesisCalls = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const adapters = {
    discover: async () => ({ sources: [{ url: 'https://kling.ai/official-dossier', title: 'Kling official dossier', excerpt: 'Official facts.' }] }),
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official facts.' })) }),
    synthesize: async input => {
      synthesisCalls += 1;
      if (synthesisCalls === 1) return { ok: false, code: 'DEEPSEEK_OUTPUT_INVALID', error: 'missing field `model`', cost: input.ledger.snapshot() };
      await waiting;
      return createKlingDossierAdapters().synthesize(input);
    },
  };
  let draftId;
  try {
    const prepared = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: adapters });
    draftId = prepared.draft_id;
    const options = { ...ASSISTANT_OPTIONS, model: 'deepseek-v4-flash', expectedRevision: prepared.draft.base_revision, catalogAdapters: adapters };
    const first = resumeCatalogDraft(draftId, options);
    const second = await resumeCatalogDraft(draftId, options);
    assert.equal(second.code, 'DRAFT_RECOVERY_IN_PROGRESS');
    release();
    assert.equal((await first).ok, true);
    assert.equal(synthesisCalls, 2);
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
    // 定向补字段的重跑会先窄域再扩域（同厂商注册域根）各搜一次
    assert.equal(resumeAdapters.requested.length, 2);
    assert.equal(resumeAdapters.requested[0].scope, 'detail');
    assert.equal(resumeAdapters.requested[0].domain_scope, 'seed');
    assert.equal(resumeAdapters.requested[1].scope, 'detail');
    assert.equal(resumeAdapters.requested[1].domain_scope, 'registrant');
    assert.equal(resumed.draft.cost.spent.search_queries, prepared.draft.cost.spent.search_queries + 2);
    assert.equal(resumed.draft.cost.spent.synthesis_calls, 2);
    assert.equal(reviewCatalogDraft(draftId).ok, true);
  } finally {
    if (draftId) discardCatalogDraft(draftId);
  }
});

test('reviewCatalogDraftBatch merges duplicate vendor patches across drafts without duplicate error', async () => {
  const { reviewCatalogDraftBatch } = require('../../src/catalog/catalog-assistant');
  const adapters = createKlingDossierAdapters();
  const prep1 = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: adapters });
  const prep2 = await prepareCatalogDraft(klingVideoSeed(), { ...ASSISTANT_OPTIONS, catalogAdapters: adapters });
  assert.equal(prep1.ok, true);
  assert.equal(prep2.ok, true);
  try {
    const result = reviewCatalogDraftBatch([prep1.draft_id, prep2.draft_id]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.draft_ids.length, 2);
  } finally {
    discardCatalogDraft(prep1.draft_id);
    discardCatalogDraft(prep2.draft_id);
  }
});

