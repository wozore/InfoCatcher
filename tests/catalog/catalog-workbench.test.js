'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { candidateKeyOf } = require('../../src/news/feedback/pending-review-store');
const { createCatalogWorkbench } = require('../../src/catalog/catalog-workbench');

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
