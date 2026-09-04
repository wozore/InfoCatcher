'use strict';

const crypto = require('crypto');
const conceptBatch = require('../../catalog/concept/index');
const pendingStore = require('../../pending/index');
const { feedbackFromSummaries, toolExists, conceptExists } = require('../../news/feedback/tool-feedback');
const { loadCatalogSnapshot } = require('../../catalog/core/index');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}

function pendingProjection(kind, api, formal = { tools: [], glossary: [] }) {
  const payload = api.read(kind);
  const projected = pendingStore.projectPending(kind, payload);
  const exists = kind === 'tools'
    ? (item) => toolExists(item.name, formal.tools)
    : (item) => conceptExists(item.term, formal.glossary);
  return {
    ...projected,
    items: projected.items.map(item => {
      if (item.review_status === 'approved' && exists(item)) return { ...item, workflow_state: 'completed' };
      return item;
    }),
  };
}

function projectConceptPreview(preview) {
  if (!preview) return null;
  return {
    schema_version: preview.schema_version,
    status: 'ready',
    preview_hash: preview.preview_hash || conceptBatch.conceptPreviewHashOf(preview),
    base_revision: preview.base_revision,
    source_pending_revision: preview.source_pending_revision,
    candidate_keys: preview.candidate_keys || [],
    items: Array.isArray(preview.cards) ? preview.cards : [],
  };
}

function createDefaultConceptsApi(options = {}, storeGetter) {
  return {
    readPreviews: () => conceptBatch.readConceptPreviews({ previewFile: options.conceptPreviewFile }),
    readPending: () => pendingStore.readPending('concepts', { conceptFile: options.pendingConceptFile }),
    readGlossary: () => conceptBatch.readGlossary({ glossaryFile: options.glossaryFile }),
    runBatch: (cards, batchOptions) => conceptBatch.runConceptBatch(cards, {
      ...batchOptions,
      readNewsEvidence: () => (storeGetter ? storeGetter().candidates : []),
      previewFile: options.conceptPreviewFile,
      glossaryFile: options.glossaryFile,
    }),
    apply: (preview, applyOptions) => conceptBatch.applyConceptPreviews(preview, { ...applyOptions, previewFile: options.conceptPreviewFile, glossaryFile: options.glossaryFile }),
  };
}

function createDefaultPendingApi(options = {}) {
  return {
    read: kind => pendingStore.readPending(kind, { toolFile: options.pendingToolFile, conceptFile: options.pendingConceptFile }),
    review: (kind, key, decision, revision) => pendingStore.reviewPending(kind, key, decision, revision, { toolFile: options.pendingToolFile, conceptFile: options.pendingConceptFile }),
  };
}

function createDefaultFeedbackApi(options = {}) {
  return {
    extract: (store, config) => feedbackFromSummaries(store, config, { ...(options.feedbackOptions || {}), pendingToolFile: options.pendingToolFile, pendingConceptFile: options.pendingConceptFile }),
  };
}

async function conceptPlan(concepts, store) {
  const pendingPayload = concepts.readPending();
  const glossary = concepts.readGlossary();
  const cards = (pendingPayload.cards || []).filter(card => card.review_status === 'approved');
  const glossaryRevision = conceptBatch.revisionOfGlossary(glossary);
  if (!cards.length) return { ok: false, code: 'PENDING_CANDIDATE_NOT_APPROVED', pending_revision: pendingPayload.revision, glossary_revision: glossaryRevision, candidate_keys: [] };
  const batch = await concepts.runBatch(cards, { store: store(), glossary, dryRun: true, skipVibeHub: true });
  const estimate = batch.estimate || conceptBatch.planConceptCost(cards);
  const plan = { pending_revision: pendingPayload.revision, glossary_revision: glossaryRevision, candidate_keys: cards.map(card => card.candidate_key), estimate, evidence_count: (batch.evidence || []).reduce((count, item) => count + (item.evidence || []).length, 0) };
  return { ok: true, status: 'cost_confirmation_required', ...plan, plan_hash: hash({ kind: 'concept-workbench-plan', ...plan }) };
}

async function assertConceptPlan(body, concepts, store) {
  const plan = await conceptPlan(concepts, store);
  if (!plan.ok) return plan;
  if (body.pending_revision !== plan.pending_revision || body.glossary_revision !== plan.glossary_revision) { const error = new Error('REVISION_CONFLICT'); error.code = 'REVISION_CONFLICT'; throw error; }
  if (body.plan_hash !== plan.plan_hash) { const error = new Error('PLAN_CHANGED'); error.code = 'PLAN_CHANGED'; throw error; }
  return plan;
}

async function handleConceptPrepare(body, concepts, store, options = {}) {
  if (body?.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
  const plan = await assertConceptPlan(body, concepts, store);
  if (!plan.ok) return plan;
  const pendingPayload = concepts.readPending();
  const cards = (pendingPayload.cards || []).filter(card => card.review_status === 'approved');
  const existingPreview = concepts.readPreviews();
  const expectedKeys = cards.map(card => card.candidate_key).sort();
  const existingKeys = Array.isArray(existingPreview?.candidate_keys) ? existingPreview.candidate_keys.slice().sort() : [];
  const reusableCheck = existingPreview?.schema_version === 2
    && existingPreview.base_revision === plan.glossary_revision
    && existingPreview.source_pending_revision === plan.pending_revision
    && existingPreview.plan_hash === plan.plan_hash
    && JSON.stringify(existingKeys) === JSON.stringify(expectedKeys)
    && conceptBatch.validateConceptPreview(existingPreview, { baseRevision: plan.glossary_revision, sourcePendingRevision: plan.pending_revision }).ok;
  if (reusableCheck) {
    return {
      ok: true,
      status: 'preview_ready',
      reused: true,
      base_revision: plan.glossary_revision,
      source_pending_revision: plan.pending_revision,
      preview: projectConceptPreview(existingPreview),
      cost: { responses_calls: 0, synthesis_calls: 0 },
    };
  }
  const result = await concepts.runBatch(cards, {
    ...(options.conceptBatchOptions || {}),
    store: store(),
    glossary: concepts.readGlossary(),
    confirmCost: true,
    sourcePendingRevision: plan.pending_revision,
    baseGlossaryRevision: plan.glossary_revision,
    planHash: plan.plan_hash,
    skipVibeHub: options.conceptBatchOptions?.skipVibeHub,
  });
  const preview = concepts.readPreviews();
  return {
    ok: result?.ok === true,
    status: result?.ok ? 'preview_ready' : 'blocked',
    code: result?.code || null,
    base_revision: plan.glossary_revision,
    source_pending_revision: plan.pending_revision,
    preview: preview?.schema_version === 2 ? projectConceptPreview(preview) : null,
    failed: Array.isArray(result?.failed) ? result.failed.map(item => ({ term: item.term, reason: String(item.reason || 'OPERATION_FAILED').split(':')[0] })) : [],
    cost: result?.cost || result?.estimate || null,
  };
}

function handleConceptPreviews(concepts) {
  const preview = concepts.readPreviews();
  if (preview?.schema_version === 2) return projectConceptPreview(preview);
  const items = Array.isArray(preview?.cards) ? preview.cards : [];
  const glossary = concepts.readGlossary();
  const completed_terms = items
    .map(item => String(item?.term || '').trim())
    .filter(term => term && conceptExists(term, glossary));
  return {
    schema_version: preview?.schema_version || null,
    status: preview ? 'legacy_preview' : 'no_preview',
    code: preview ? 'PREVIEW_SCHEMA_UNSUPPORTED' : 'PREVIEW_INVALID',
    items,
    completed_terms,
  };
}

function handleConceptApply(body, concepts, expectedRevision) {
  const preview = concepts.readPreviews();
  if (!preview || preview.schema_version !== 2) return { ok: false, code: 'PREVIEW_INVALID' };
  const pendingPayload = concepts.readPending();
  const applyAll = body?.apply_all === true;
  if (applyAll && body?.terms !== undefined) return { ok: false, code: 'CONCEPT_APPLY_MODE_INVALID' };
  if (!applyAll) {
    const previewHash = String(body?.preview_hash || '').trim();
    if (!previewHash || String(body?.confirm || '').trim() !== `APPLY CONCEPTS ${previewHash}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
    return concepts.apply(preview, {
      strict: true,
      terms: body?.terms,
      expectedRevision: expectedRevision(body),
      previewHash,
      sourcePendingRevision: pendingPayload.revision,
    });
  }
  const previewHash = conceptBatch.conceptPreviewHashOf(preview);
  return concepts.apply(preview, {
    strict: true,
    applyAll: true,
    expectedRevision: expectedRevision(body),
    previewHash,
    sourcePendingRevision: pendingPayload.revision,
  });
}

async function handleExtractKnowledge(body, store, news, feedback, pending, expectedRevision) {
  const revision = expectedRevision(body);
  const current = store();
  if (news.revisionOfStore(current) !== revision) throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
  const result = await feedback.extract(current, news.readConfig());
  const toolPending = pending.read('tools');
  const conceptPending = pending.read('concepts');
  return {
    ok: true,
    tools_found: (result.toolsFound || []).length,
    concepts_found: (result.conceptsFound || []).length,
    tools_pending: (result.toolsPending || []).length,
    concepts_pending: (result.conceptsPending || []).length,
    pending_revisions: { tools: toolPending.revision, concepts: conceptPending.revision },
  };
}

function getPendingTools(pending) {
  let formal = { tools: [], glossary: [] };
  try {
    const { snapshot } = loadCatalogSnapshot();
    formal = { tools: [...(snapshot['tool-card'] || []), ...(snapshot['tool-level3'] || [])], glossary: [] };
  } catch (_) { /* 缺正式 catalog：视为无命中 */ }
  return pendingProjection('tools', pending, formal);
}

function getPendingConcepts(pending, concepts) {
  let formal = { tools: [], glossary: [] };
  try {
    const { snapshot } = loadCatalogSnapshot();
    formal = { tools: snapshot['tool-card'] || [], glossary: concepts.readGlossary() };
  } catch (_) { /* 同上 */ }
  return pendingProjection('concepts', pending, formal);
}

module.exports = {
  pendingProjection,
  projectConceptPreview,
  createDefaultConceptsApi,
  createDefaultPendingApi,
  createDefaultFeedbackApi,
  conceptPlan,
  handleConceptPrepare,
  handleConceptPreviews,
  handleConceptApply,
  handleExtractKnowledge,
  getPendingTools,
  getPendingConcepts,
};
