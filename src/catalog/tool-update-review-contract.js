'use strict';

const REVIEW_VERDICTS = Object.freeze(['approve', 'hold', 'discard']);
const REVIEW_SURFACES = Object.freeze(['product', 'cli', 'desktop', 'ide_extension']);
const REVIEW_FIELDS = Object.freeze([
  'verdict',
  'matched_surface',
  'confidence',
  'reason',
  'supporting_excerpt',
]);
const DECISION_SOURCES = Object.freeze(['deterministic', 'ai']);
const REVIEW_MODES = Object.freeze(['deterministic', 'ai_fallback']);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExactKeys(value, fields) {
  const keys = Object.keys(value || {}).sort();
  return keys.length === fields.length && fields.every(field => keys.includes(field));
}

function validateToolUpdateReviewValue(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && hasExactKeys(value, REVIEW_FIELDS)
    && REVIEW_VERDICTS.includes(value.verdict)
    && REVIEW_SURFACES.includes(value.matched_surface)
    && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && isNonEmpty(value.reason)
    && isNonEmpty(value.supporting_excerpt)
    && value.supporting_excerpt.length <= 1200,
  );
}

function normalizeToolUpdateReviewValue(value) {
  return validateToolUpdateReviewValue(value)
    ? {
      verdict: value.verdict,
      matched_surface: value.matched_surface,
      confidence: value.confidence,
      reason: value.reason,
      supporting_excerpt: value.supporting_excerpt,
    }
    : null;
}

module.exports = {
  REVIEW_VERDICTS,
  REVIEW_SURFACES,
  REVIEW_FIELDS,
  DECISION_SOURCES,
  REVIEW_MODES,
  validateToolUpdateReviewValue,
  normalizeToolUpdateReviewValue,
};
