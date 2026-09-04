'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { CATALOG_FILES, CONCEPT_FILES } = require('../../shared/paths');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\n', 'utf8').digest('hex')}`;
}

function termKeyOf(term) {
  return String(term || '').trim().toLowerCase();
}

function revisionOfGlossary(glossary = []) {
  return digest(Array.isArray(glossary) ? glossary : []);
}

function conceptPreviewHashOf(preview) {
  if (!preview || typeof preview !== 'object') return digest(null);
  const { preview_hash: _ignored, ...withoutHash } = preview;
  return digest(withoutHash);
}

function validateConceptPreview(preview, options = {}) {
  const errors = [];
  if (!preview || typeof preview !== 'object' || !Array.isArray(preview.cards)) return { ok: false, errors: [{ code: 'PREVIEW_INVALID' }] };
  if (preview.schema_version !== 2) errors.push({ code: 'PREVIEW_SCHEMA_UNSUPPORTED' });
  const expectedHash = conceptPreviewHashOf(preview);
  if (preview.preview_hash !== expectedHash) errors.push({ code: 'PREVIEW_CHANGED' });
  if (options.baseRevision && preview.base_revision !== options.baseRevision) errors.push({ code: 'REVISION_CONFLICT' });
  if (options.sourcePendingRevision && preview.source_pending_revision !== options.sourcePendingRevision) errors.push({ code: 'REVISION_CONFLICT' });
  if (!Array.isArray(preview.candidate_keys)) errors.push({ code: 'PREVIEW_CANDIDATES_INVALID' });
  const keys = new Set(preview.candidate_keys || []);
  for (const card of preview.cards) {
    const term = String(card?.term || '').trim();
    if (!term) errors.push({ code: 'CONCEPT_TERM_NOT_FOUND' });
    if (card?.candidate_key && !keys.has(card.candidate_key)) errors.push({ code: 'PREVIEW_CANDIDATES_INVALID' });
  }
  return { ok: errors.length === 0, errors, expectedHash };
}

function readGlossary(options = {}) {
  if (Array.isArray(options.glossary)) return options.glossary;
  return readJson(options.glossaryFile || CATALOG_FILES.glossary, []);
}

function writeConceptPreview(preview, options = {}) {
  const file = options.previewFile || CONCEPT_FILES.previews;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, preview, 'concept-batch');
  return file;
}

function readConceptPreviews(options = {}) {
  return readJson(options.previewFile || CONCEPT_FILES.previews, null);
}

function normalizeGlossaryEntry(card) {
  const term = String(card?.term || '').trim();
  return {
    term,
    full_name: String(card?.full_name || '').trim() || term,
    category: String(card?.category || '').trim(),
    summary: String(card?.summary || '').trim(),
    related_terms: Array.isArray(card?.related_terms)
      ? card.related_terms.map(String).map(s => s.trim()).filter(Boolean)
      : [],
    source: {
      name: String(card?.source?.name || '').trim(),
      ...(card?.source?.url ? { url: String(card.source.url).trim() } : {}),
    },
    relevance: String(card?.relevance || '').trim(),
  };
}

function applyStrictConceptPreviews(data, options = {}) {
  const checked = validateConceptPreview(data, { sourcePendingRevision: options.sourcePendingRevision });
  if (!checked.ok) return { ok: false, code: checked.errors[0]?.code || 'PREVIEW_CHANGED' };
  const glossary = readGlossary(options);
  const actualRevision = revisionOfGlossary(glossary);
  const expectedRevision = String(options.expectedRevision || data.base_revision || '').trim();
  if (!expectedRevision || actualRevision !== expectedRevision || data.base_revision !== actualRevision) return { ok: false, code: 'REVISION_CONFLICT' };
  if (options.previewHash && options.previewHash !== checked.expectedHash) return { ok: false, code: 'PREVIEW_CHANGED' };
  const applyAll = options.applyAll === true;
  if (applyAll && options.terms !== undefined) return { ok: false, code: 'CONCEPT_APPLY_MODE_INVALID' };
  const terms = applyAll
    ? data.cards.map(card => termKeyOf(card?.term)).filter(Boolean)
    : (Array.isArray(options.terms) ? options.terms.map(termKeyOf).filter(Boolean) : []);
  if (!terms.length) return { ok: false, code: 'CONCEPT_TERMS_REQUIRED' };
  if (new Set(terms).size !== terms.length) return { ok: false, code: 'CONCEPT_TERMS_INVALID' };
  const cardsByTerm = new Map(data.cards.map(card => [termKeyOf(card?.term), card]));
  const selected = terms.map(term => cardsByTerm.get(term));
  if (selected.some(card => !card)) return { ok: false, code: 'CONCEPT_TERM_NOT_FOUND' };
  const existing = new Set(glossary.map(entry => termKeyOf(entry.term)));
  if (selected.some(card => existing.has(termKeyOf(card.term)))) return { ok: false, code: 'CONCEPT_TERM_ALREADY_EXISTS' };
  const candidateKeys = new Set(data.candidate_keys || []);
  if (selected.some(card => !card.candidate_key || !candidateKeys.has(card.candidate_key))) return { ok: false, code: 'PREVIEW_CANDIDATES_INVALID' };
  for (const card of selected) {
    if (!card.category || !card.summary || !card.source || !String(card.source.name || '').trim()) return { ok: false, code: 'CONCEPT_PREVIEW_INCOMPLETE' };
  }
  const next = [...glossary, ...selected.map(normalizeGlossaryEntry)];
  writeJsonAtomic(options.glossaryFile || CATALOG_FILES.glossary, next, 'concept-apply');
  return { ok: true, added: selected.map(card => ({ term: card.term, candidate_key: card.candidate_key })), skipped: [], glossary_count: next.length, target_revision: revisionOfGlossary(next) };
}

function applyConceptPreviews(preview, options = {}) {
  const data = preview || readConceptPreviews(options);
  if (!data || typeof data !== 'object' || data.schema_version !== 2) {
    return { ok: false, code: 'PREVIEW_SCHEMA_UNSUPPORTED', error: '仅支持 schema_version 2 概念预览，请重新生成预览后 Apply' };
  }
  return applyStrictConceptPreviews(data, options);
}

module.exports = {
  readGlossary,
  writeConceptPreview,
  revisionOfGlossary,
  conceptPreviewHashOf,
  validateConceptPreview,
  readConceptPreviews,
  normalizeGlossaryEntry,
  applyConceptPreviews,
};
