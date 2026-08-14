'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');

function ensureDraftDir() {
  fs.mkdirSync(CATALOG_GENERATOR_FILES.draftsDir, { recursive: true });
}

function newDraftId() {
  return `draft-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

function draftPath(draftId) {
  if (!/^draft-[A-Za-z0-9-]+$/.test(String(draftId || ''))) throw new Error('DRAFT_ID_INVALID');
  return path.join(CATALOG_GENERATOR_FILES.draftsDir, `${draftId}.json`);
}

function readDraft(draftId) {
  return readJson(draftPath(draftId));
}

function writeDraft(draft, runId = 'catalog-draft') {
  if (!draft?.draft_id) throw new Error('DRAFT_ID_REQUIRED');
  ensureDraftDir();
  const value = { ...draft, updated_at: new Date().toISOString() };
  writeJsonAtomic(draftPath(value.draft_id), value, runId);
  return value;
}

function createDraft(input) {
  const draft = {
    schema_version: input?.schema_version || 3,
    draft_id: input?.draft_id || newDraftId(),
    state: input?.state || 'researching',
    created_at: input?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    base_revision: input?.base_revision || null,
    seed: input?.seed || {},
    research: input?.research || { official_sources: [], warnings: [] },
    research_plan: input?.research_plan || null,
    coverage: input?.coverage || null,
    layer_patches: input?.layer_patches || [],
    synthesis: input?.synthesis || null,
    record_preview: input?.record_preview || null,
    cost: input?.cost || null,
    readiness: input?.readiness || { status: 'blocked', blocking_reasons: [], warnings: [] },
    change_preview: input?.change_preview || null,
    preview_hash: input?.preview_hash || null,
    apply_checkpoint: input?.apply_checkpoint || null,
    last_error: input?.last_error || null,
  };
  return writeDraft(draft, 'catalog-draft-create');
}

function updateDraft(draftId, patch, runId = 'catalog-draft-update') {
  return writeDraft({ ...readDraft(draftId), ...patch, draft_id: draftId }, runId);
}

function deleteDraft(draftId) {
  const file = draftPath(draftId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function listDrafts() {
  ensureDraftDir();
  return fs.readdirSync(CATALOG_GENERATOR_FILES.draftsDir)
    .filter(file => file.endsWith('.json'))
    .map(file => readDraft(file.slice(0, -5)));
}

module.exports = { newDraftId, draftPath, readDraft, writeDraft, createDraft, updateDraft, deleteDraft, listDrafts };
