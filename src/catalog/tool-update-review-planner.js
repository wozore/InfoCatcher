'use strict';

const { canonicalizeUrl } = require('../shared/tavily-client');
const { updateSourcesForProduct, loadProductUrlRegistry } = require('./official-url-registry');
const {
  REVIEW_SURFACES,
  DECISION_SOURCES,
  validateToolUpdateReviewValue,
  normalizeToolUpdateReviewValue,
} = require('./tool-update-review-contract');
const {
  isIsoDate,
  isoDateFromValue,
  explicitDates,
  dateForEvidence: evidenceDateForEvidence,
} = require('./tool-update-evidence');

const DEFAULT_MIN_CONFIDENCE = 0.8;

function normalizeKey(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function detailCandidates(options = {}) {
  const values = [
    options.detail,
    options.currentDetail,
    ...(Array.isArray(options.toolDetails) ? options.toolDetails : []),
    ...(Array.isArray(options.details) ? options.details : []),
    ...(Array.isArray(options.catalog?.toolPreviewLevel3?.items) ? options.catalog.toolPreviewLevel3.items : []),
    ...(Array.isArray(options.catalog?.toolPreviewLevel3) ? options.catalog.toolPreviewLevel3 : []),
  ].filter(value => value && typeof value === 'object');
  return values;
}

function comparableDetailKeys(detail) {
  return [detail.tool_key, detail.title, detail.id, detail.detail_id]
    .map(normalizeKey)
    .filter(Boolean)
    .flatMap(value => [value, value.replace(/^tool-level3[:/-]/, ''), value.replace(/^tool-card[:/-]/, '')]);
}

function matchingDetail(productKey, product, options = {}) {
  const names = [productKey, product?.name, ...(product?.aliases || []), ...(product?.product_prefixes || [])]
    .map(normalizeKey)
    .filter(Boolean);
  return detailCandidates(options).find(detail => {
    const keys = comparableDetailKeys(detail);
    return names.some(name => keys.includes(name));
  }) || null;
}

function findToolDetail(productKey, product, options = {}) {
  const detail = matchingDetail(productKey, product, options);
  return detail?.detail_kind === 'tool' ? detail : null;
}

function registryProductOf(productKey, options = {}) {
  const registry = options.registry || loadProductUrlRegistry();
  const key = normalizeKey(productKey);
  return { registry, key, product: registry?.products?.[key] || null };
}

function githubReleaseEvidenceMatchesSource(source, evidenceUrl) {
  if (source?.kind !== 'github_releases' || typeof source.repository !== 'string') return false;
  let parsed;
  try { parsed = new URL(evidenceUrl); } catch { return false; }
  const [owner, name] = source.repository.split('/');
  const parts = parsed.pathname.split('/').filter(Boolean);
  return parsed.protocol === 'https:'
    && parsed.hostname.toLowerCase() === 'github.com'
    && parts.length >= 4
    && parts[0].toLowerCase() === String(owner || '').toLowerCase()
    && parts[1].toLowerCase() === String(name || '').toLowerCase()
    && parts[2].toLowerCase() === 'releases';
}

function sourceForEvidence(productKey, evidence, registry) {
  const sources = updateSourcesForProduct(productKey, { registry });
  const url = canonicalizeUrl(evidence?.url);
  return sources.find(source => source.collector === evidence.collector
    && (canonicalizeUrl(source.url) === url || githubReleaseEvidenceMatchesSource(source, url))) || null;
}

function dateForEvidence(evidence, options = {}) {
  return evidenceDateForEvidence(evidence, options);
}

function deterministicDecision(source, evidence) {
  const supportingExcerpt = String(evidence?.excerpt || '').trim().slice(0, 1200);
  if (!REVIEW_SURFACES.includes(source?.product_surface) || !supportingExcerpt) return null;
  return {
    verdict: 'approve',
    matched_surface: source.product_surface,
    confidence: 1,
    reason: '官方登记来源与目标产品表面由确定性规则匹配。',
    supporting_excerpt: supportingExcerpt,
  };
}

function todayOf(value) {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  return isoDateFromValue(value) || (isIsoDate(value) ? String(value) : null);
}

function baseItem(input, context = {}) {
  const evidence = input.evidence || {};
  const suggestion = input.suggestion || input.ai_suggestion || {};
  const source = context.source || {};
  const detail = context.detail || {};
  const product = context.product || {};
  const previousDate = isIsoDate(detail.last_updated_date) ? detail.last_updated_date : null;
  return {
    candidate_key: context.candidateKey || null,
    release_key: context.releaseKey || null,
    product_key: context.productKey,
    detail_id: detail.id || detail.detail_id || evidence.detail_id || null,
    evidence_detail_id: evidence.detail_id || null,
    previous_date: previousDate,
    proposed_date: input.proposed_date || null,
    source_url: canonicalizeUrl(evidence.url) || source.url || null,
    source_type: evidence.source_type || source.kind || null,
    collector: evidence.collector || source.collector || null,
    product_surface: source.product_surface || null,
    repository: source.repository || null,
    evidence: {
      title: String(evidence.title || '').trim(),
      official_published_at: evidence.official_published_at || null,
      excerpt: String(evidence.excerpt || '').trim().slice(0, 4000),
      content_hash: evidence.content_hash || null,
      status: evidence.status || null,
    },
    ai_suggestion: normalizeToolUpdateReviewValue(suggestion) || null,
    ...(context.reviewDecision ? { review_decision: normalizeToolUpdateReviewValue(context.reviewDecision) } : {}),
    ...(DECISION_SOURCES.includes(context.decisionSource) ? { decision_source: context.decisionSource } : {}),
    blocked_reasons: [...(input.blocked_reasons || [])],
    status: input.status || 'blocked',
    review_status: input.review_status || 'pending',
    ...(product.name ? { product_name: product.name } : {}),
  };
}

function planToolUpdateCandidate(productKey, evidence, suggestion, options = {}) {
  const requestedKey = normalizeKey(productKey);
  const { registry, key, product } = registryProductOf(requestedKey, options);
  const normalizedEvidence = evidence || {};
  const normalizedSuggestion = suggestion?.suggestion || suggestion?.ai_suggestion || suggestion;
  const reasons = [];
  let source = null;
  let detail = null;
  let proposedDate = null;
  let reviewDecision = normalizeToolUpdateReviewValue(normalizedSuggestion);
  let decisionSource = reviewDecision ? 'ai' : null;

  if (!requestedKey || key !== requestedKey || !product) reasons.push('PRODUCT_NOT_IN_REGISTRY');
  if (normalizedEvidence.product_key && normalizeKey(normalizedEvidence.product_key) !== requestedKey) reasons.push('EVIDENCE_PRODUCT_MISMATCH');
  if (normalizedEvidence.status !== 'ready') reasons.push('EVIDENCE_NOT_READY');
  if (!normalizedEvidence.content_hash) reasons.push('EVIDENCE_HASH_MISSING');
  if (product) {
    source = sourceForEvidence(requestedKey, normalizedEvidence, registry);
    if (!source) reasons.push('SOURCE_NOT_IN_REGISTRY');
    const matchedDetail = matchingDetail(requestedKey, product, options);
    detail = matchedDetail;
    if (!matchedDetail) reasons.push('TOOL_DETAIL_NOT_FOUND');
    else if (matchedDetail.detail_kind !== 'tool') reasons.push('DETAIL_KIND_NOT_TOOL');
  }

  if (source?.review_mode === 'deterministic') {
    reviewDecision = deterministicDecision(source, normalizedEvidence);
    decisionSource = reviewDecision ? 'deterministic' : null;
    if (!reviewDecision) reasons.push('EVIDENCE_EXCERPT_MISSING');
  } else if (!reviewDecision) {
    reasons.push(source?.review_mode === 'ai_fallback' ? 'AI_REVIEW_REQUIRED' : 'AI_OUTPUT_INVALID');
  }
  if (reviewDecision) {
    if (reviewDecision.verdict !== 'approve') reasons.push('AI_VERDICT_NOT_APPROVE');
    if (reviewDecision.confidence < (options.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) reasons.push('AI_CONFIDENCE_LOW');
    if (!REVIEW_SURFACES.includes(source?.product_surface) || reviewDecision.matched_surface !== source?.product_surface) {
      reasons.push('PRODUCT_SURFACE_MISMATCH');
    }
  }

  if (source && detail && normalizedEvidence.status === 'ready') {
    const dateResult = dateForEvidence(normalizedEvidence, { latest: source?.date_mode === 'latest' });
    proposedDate = dateResult.date;
    if (dateResult.reason) reasons.push(dateResult.reason);
    if (!proposedDate) reasons.push('PROPOSED_DATE_MISSING');
    const today = todayOf(options.now);
    if (proposedDate && today && proposedDate > today) reasons.push('PROPOSED_DATE_IN_FUTURE');
    if (isIsoDate(detail.last_updated_date) && proposedDate && proposedDate <= detail.last_updated_date) {
      reasons.push('PROPOSED_DATE_NOT_AFTER_CURRENT');
    }
  }

  const sourceUrl = canonicalizeUrl(normalizedEvidence.url) || '';
  const releaseKey = `${requestedKey}|${sourceUrl}|${proposedDate || ''}`;
  const candidateKey = `${releaseKey}|${normalizedEvidence.content_hash || ''}`;
  const item = baseItem({
    evidence: normalizedEvidence,
    suggestion: normalizedSuggestion,
    proposed_date: proposedDate,
    blocked_reasons: [...new Set(reasons)],
    status: reasons.length ? 'blocked' : 'candidate',
  }, {
    registry,
    product,
    source,
    detail,
    productKey: requestedKey,
    releaseKey,
    candidateKey,
    reviewDecision,
    decisionSource,
  });
  return {
    ok: reasons.length === 0,
    candidate: item,
    blocked_reasons: item.blocked_reasons,
  };
}

function planToolUpdateCandidates(inputs, options = {}) {
  const results = (Array.isArray(inputs) ? inputs : []).map(input => planToolUpdateCandidate(
    input.product_key || input.productKey,
    input.evidence,
    input.suggestion || input.ai_suggestion,
    options,
  ));
  return {
    ok: results.every(result => result.ok),
    candidates: results.map(result => result.candidate),
    blocked: results.filter(result => !result.ok).map(result => result.candidate),
  };
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  explicitDates,
  dateForEvidence,
  findToolDetail,
  sourceForEvidence,
  planToolUpdateCandidate,
  planToolUpdateCandidates,
};
