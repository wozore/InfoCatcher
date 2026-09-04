'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { candidateKeyOf } = require('../../src/news/feedback/pending-review-store');
const { createCatalogWorkbench } = require('../../src/catalog/catalog-workbench');


test('catalog recovery projects safe defaults and rejects sensitive or empty overrides', () => {
  const calls = [];
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    recoveryPlanForDraft: (draftId, input) => {
      calls.push({ draftId, input });
      return { ok: true, draft_id: draftId, recovery_token: 'recovery-token', recovery_mode: 'synthesis_only' };
    },
  });
  const result = coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].input.generatorOptions.model, 'deepseek-v4-flash');
  assert.equal(calls[0].input.generatorOptions.retrievalProvider, 'tavily');
  assert.throws(() => coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: '' },
  }), error => error.code === 'MODEL_REQUIRED');
  assert.throws(() => coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { apiKey: 'secret' },
  }), error => error.code === 'RECOVERY_OPTIONS_INVALID');
});

test('catalog workbench resume roundtrip matches recovery token', async () => {
  let resumeTokenSeen = null;
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    recoveryPlanForDraft: (draftId, input) => ({
      ok: true,
      draft_id: draftId,
      recovery_token: 'sha256:token-xyz',
      recovery_mode: 'synthesis_only',
      cost_plan: { hard_limits: {} },
    }),
    resumeCatalogDraft: async (draftId, options) => {
      resumeTokenSeen = options.recoveryToken;
      return { ok: true, draft: { draft_id: draftId, state: 'preview_ready', readiness: { status: 'ready' } } };
    },
  });
  const plan = coordinator.recoveryPlan('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
  });
  assert.equal(plan.ok, true);
  const resumed = await coordinator.resume('draft-blocked', {
    expected_revision: 'catalog-r1',
    generator_options: { model: 'deepseek-v4-flash' },
    recovery_token: plan.recovery_token,
    confirm_cost: true,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumeTokenSeen, 'sha256:token-xyz');
});

test('catalog workbench keeps cost, plan and explicit apply gates', async () => {
  const card = { name: 'Offline Tool', candidate_key: candidateKeyOf('tools', 'Offline Tool'), review_status: 'approved' };
  const calls = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    resolveBatchCandidates: async () => { calls.push('resolve'); return { seeds: [{ name: card.name }], unresolved: [] }; },
    prepareCatalogDraft: async () => { calls.push('prepare'); return { ok: true, draft: { draft_id: 'draft-offline', state: 'preview_ready', base_revision: 'catalog-r1', preview_hash: 'hash-1', readiness: { status: 'ready' } } }; },
    reviewCatalogDraft: () => ({ ok: true, currentRevision: 'catalog-r1', previewHash: 'hash-1' }),
    applyCatalogDraft: () => { calls.push('apply'); return { ok: true, targetRevision: 'catalog-r2' }; },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  assert.equal(plan.status, 'cost_confirmation_required');
  assert.equal((await coordinator.prepare({ ...plan, confirm_cost: false })).code, 'COST_CONFIRMATION_REQUIRED');
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.status, 'drafts_ready');
  assert.deepEqual(calls, ['resolve', 'prepare']);
  assert.equal(coordinator.apply({ draft_id: 'draft-offline', expected_revision: 'catalog-r1', preview_hash: 'hash-1', confirm: 'wrong' }).code, 'CONFIRMATION_INVALID');
  assert.equal(coordinator.apply({ draft_id: 'draft-offline', expected_revision: 'catalog-r1', preview_hash: 'hash-1', confirm: 'APPLY CATALOG DRAFT draft-offline' }).status, 'completed');
  assert.deepEqual(calls, ['resolve', 'prepare', 'apply']);
});

test('catalog workbench discard requires current catalog revision', () => {
  let discarded = false;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    discardCatalogDraft: () => { discarded = true; return { ok: true }; },
  });
  assert.equal(coordinator.discard('draft-abc', {}).code, 'REVISION_CONFLICT');
  assert.equal(coordinator.discard('draft-abc', { expected_revision: 'catalog-stale' }).code, 'REVISION_CONFLICT');
  assert.equal(discarded, false);
  assert.equal(coordinator.discard('draft-abc', { expected_revision: 'catalog-r1' }).ok, true);
  assert.equal(discarded, true);
});

test('catalog workbench rejects concurrent prepare to prevent duplicate drafts and spend', async () => {
  const card = { name: 'GPT-6', candidate_key: candidateKeyOf('tools', 'GPT-6'), review_status: 'approved' };
  let prepareCalls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    resolveBatchCandidates: async () => ({ seeds: [{ name: card.name }], unresolved: [] }),
    prepareCatalogDraft: async () => {
      prepareCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, draft: { draft_id: `draft-${prepareCalls}`, state: 'preview_ready', base_revision: 'catalog-r1', preview_hash: 'hash-1', readiness: { status: 'ready' } } };
    },
    listDrafts: () => [],
  });
  const plan = coordinator.plan();
  const [first, second] = await Promise.all([
    coordinator.prepare({ ...plan, confirm_cost: true }),
    coordinator.prepare({ ...plan, confirm_cost: true }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'PREPARE_IN_PROGRESS');
  assert.equal(prepareCalls, 1);
});

test('catalog workbench reuses resuming draft instead of creating a duplicate', async () => {
  const card = { name: 'GPT-6', candidate_key: candidateKeyOf('tools', 'GPT-6'), review_status: 'approved' };
  const calls = [];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: { responses_calls: 1 } } }),
    prepareCatalogDraft: async () => { calls.push('prepare'); return { ok: true, draft: {} }; },
    listDrafts: () => [{
      draft_id: 'draft-resuming',
      schema_version: 3,
      state: 'resuming',
      base_revision: 'catalog-r1',
      seed: { name: card.name, candidate_key: card.candidate_key },
      readiness: { status: 'blocked', warnings: [] },
    }],
  });
  const plan = coordinator.plan();
  const prepared = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(prepared.ok, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(prepared.reused, ['draft-resuming']);
  assert.equal(prepared.drafts.length, 1);
  assert.equal(prepared.drafts[0].draft_id, 'draft-resuming');
});


test('catalog draft projection exposes stable diagnostics without raw failure payloads', () => {
  const coordinator = createCatalogWorkbench({
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => [{
      draft_id: 'draft-blocked',
      schema_version: 3,
      state: 'preview_blocked',
      base_revision: 'catalog-r1',
      seed: { name: 'Blocked Tool' },
      readiness: { status: 'blocked', warnings: [] },
      last_error: { code: 'DEEPSEEK_OUTPUT_INVALID', error: 'missing field `model`; apiKey=secret' },
      research: { official_sources: [{ content: 'private research' }] },
    }],
  });
  const item = coordinator.list().items[0];
  assert.equal(item.error_code, 'MODEL_REQUIRED');
  assert.equal(item.recovery_kind, 'config_required');
  assert.equal(item.recovery_mode, 'synthesis_only');
  assert.deepEqual(item.missing_config_fields, ['model']);
  assert.equal('research' in item, false);
  assert.equal(JSON.stringify(item).includes('secret'), false);
  assert.equal(JSON.stringify(item).includes('private research'), false);
});

test('catalog workbench batches drafts from same vendor by merging relation patches', () => {
  const card1 = { name: 'Model A', candidate_key: 'key-a', review_status: 'approved' };
  const card2 = { name: 'Model B', candidate_key: 'key-b', review_status: 'approved' };
  const sharedVendor = { area: 'vendor-card', id: 'vendor-card:v1', operation: 'noop', record: null, provenance: {} };
  const level1PatchA = { area: 'vendor-level1', id: 'vendor-level1:v1', operation: 'replace', record: { id: 'vendor-level1:v1', level2_refs: [{ id: 'ref-1' }] }, provenance: {} };
  const level1PatchB = { area: 'vendor-level1', id: 'vendor-level1:v1', operation: 'replace', record: { id: 'vendor-level1:v1', level2_refs: [{ id: 'ref-2' }] }, provenance: {} };
  const d1 = { draft_id: 'draft-1', schema_version: 3, state: 'preview_ready', base_revision: 'c-r1', readiness: { status: 'ready' }, layer_patches: [sharedVendor, level1PatchA] };
  const d2 = { draft_id: 'draft-2', schema_version: 3, state: 'preview_ready', base_revision: 'c-r1', readiness: { status: 'ready' }, layer_patches: [sharedVendor, level1PatchB] };
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'p-r1', cards: [card1, card2] }),
    loadCatalog: () => ({ revision: 'c-r1', snapshot: { 'vendor-card': [{ id: 'vendor-card:v1' }], 'vendor-level1': [{ id: 'vendor-level1:v1', level2_refs: [] }] } }),
    listDrafts: () => [d1, d2],
    reviewCatalogDraftBatch: (ids) => {
      const plan = { changePreview: { creates: {}, updates: [], noops: [] } };
      const reviews = [d1, d2].map(d => ({ draft: d, previewHash: 'h', plan }));
      return { ok: true, draft_ids: ids, currentRevision: 'c-r1', batchToken: 'token', reviews, plan };
    },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.equal(preview.draft_count, 2);
});

test('catalog workbench batches drafts through one preview and one apply', () => {
  const card = { name: 'Batch Tool', candidate_key: candidateKeyOf('tools', 'Batch Tool'), review_status: 'approved' };
  const calls = [];
  const drafts = [{ draft_id: 'draft-b', schema_version: 3, state: 'preview_ready', base_revision: 'catalog-r1', seed: { name: 'Batch Tool', candidate_key: card.candidate_key }, readiness: { status: 'ready' } }];
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => drafts,
    reviewCatalogDraftBatch: ids => ({ ok: true, draft_ids: ids, currentRevision: 'catalog-r1', batchToken: 'batch-token', reviews: drafts.map(draft => ({ draft, plan: { changePreview: { creates: { 'tool-card': ['tool-1'] }, updates: [], noops: [] } } })), plan: { changePreview: { creates: { 'tool-card': ['tool-1'] }, updates: [], noops: [] } } }),
    applyCatalogDrafts: input => { calls.push(input); return { ok: true, status: 'completed', targetRevision: 'catalog-r2', appliedDraftIds: input.draftIds }; },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.equal(preview.draft_count, 1);
  assert.equal(coordinator.applyBatch({ draft_ids: ['draft-b'], expected_revision: 'catalog-r1', batch_token: 'batch-token', confirm: 'APPLY CATALOG DRAFTS batch-token' }).status, 'completed');
  assert.equal(calls.length, 1);
});


test('catalog batch preview keeps ready drafts usable when other drafts are blocked', () => {
  const ready = { draft_id: 'draft-ready', schema_version: 3, state: 'preview_ready', base_revision: 'catalog-r1', readiness: { status: 'ready' }, seed: { name: 'Ready', candidate_key: 'ready-key' } };
  const blocked = { draft_id: 'draft-blocked', schema_version: 3, state: 'preview_blocked', base_revision: 'catalog-r1', readiness: { status: 'blocked', blocking_reasons: ['missing source'] }, seed: { name: 'Blocked', candidate_key: 'blocked-key' } };
  let reviewed;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    listDrafts: () => [ready, blocked],
    reviewCatalogDraftBatch: ids => {
      reviewed = ids;
      return { ok: true, draft_ids: ids, currentRevision: 'catalog-r1', batchToken: 'batch-token', reviews: [{ draft: ready, plan: { changePreview: { creates: {}, updates: [], noops: [] } } }], plan: { changePreview: { creates: {}, updates: [], noops: [] } } };
    },
  });
  const preview = coordinator.batchPreview();
  assert.equal(preview.ok, true);
  assert.deepEqual(reviewed, ['draft-ready']);
  assert.equal(preview.blockers.length, 1);
  assert.equal(preview.blockers[0].draft_id, 'draft-blocked');
});

test('catalog prepare reuses a matching ready draft without resolving or preparing again', async () => {
  const card = { name: 'Reusable Tool', candidate_key: candidateKeyOf('tools', 'Reusable Tool'), review_status: 'approved' };
  let calls = 0;
  const coordinator = createCatalogWorkbench({
    readPending: () => ({ revision: 'pending-r1', cards: [card] }),
    loadCatalog: () => ({ revision: 'catalog-r1' }),
    planCatalogDraft: () => ({ ok: true, cost_plan: { hard_limits: {} } }),
    listDrafts: () => [{ draft_id: 'draft-reused', schema_version: 3, state: 'preview_ready', base_revision: 'catalog-r1', seed: { name: card.name, candidate_key: card.candidate_key }, readiness: { status: 'ready' } }],
    resolveBatchCandidates: async () => { calls += 1; return { seeds: [] }; },
    prepareCatalogDraft: async () => { calls += 1; return {}; },
  });
  const plan = coordinator.plan();
  const result = await coordinator.prepare({ ...plan, confirm_cost: true });
  assert.equal(result.reused[0], 'draft-reused');
  assert.equal(calls, 0);
});

test('projection reclassifies stale manual_required schema failures as retryable', () => {
  const { projectDraft } = require('../../src/catalog/catalog-workbench');
  const projected = projectDraft({
    draft_id: 'draft-1',
    state: 'preview_blocked',
    research: { ok: true, official_sources: [{ source_id: 's1' }] },
    readiness: { status: 'blocked', blocking_reasons: ['ZhipuAI synthesis JSON 结构不符合契约'] },
    last_error: { code: 'DEEPSEEK_SYNTHESIS_SCHEMA_INVALID', recovery_kind: 'manual_required', error: 'ZhipuAI synthesis JSON 结构不符合契约' },
  });
  assert.equal(projected.recovery_kind, 'retryable');
  assert.equal(projected.recovery_mode, 'synthesis_only');
  assert.equal(projected.error_code, 'DEEPSEEK_SCHEMA_INVALID');
});
