'use strict';

const { canonicalizeUrl } = require('../shared/tavily-client');
const { updateSourcesForProduct, loadProductUrlRegistry } = require('./official-url-registry');
const {
  REVIEW_SURFACES,
  REVIEW_VERDICTS,
  validateToolUpdateReviewValue,
} = require('./ai/tool-update-review-ai');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = Object.freeze({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});
const MONTH_TOKEN = '(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)';
const ORDINAL = '(?:st|nd|rd|th)?';
const DEFAULT_MIN_CONFIDENCE = 0.8;

function normalizeKey(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function validDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDateFromValue(value) {
  const match = String(value || '').match(/(?:^|\b)(20\d{2})-(\d{2})-(\d{2})(?=\b|T)/);
  const date = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  return date && validDate(date) ? date : null;
}

function dateFromParts(year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return validDate(date) ? date : null;
}

function explicitDates(text) {
  const value = String(text || '');
  const dates = new Set();
  for (const match of value.matchAll(/(?:^|\b)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?=\b|T)/g)) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`\\b${MONTH_TOKEN}(?:\\.|\\s)+\\s*(\\d{1,2})${ORDINAL},?\\s+(20\\d{2})\\b`, 'gi'))) {
    const date = dateFromParts(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+${MONTH_TOKEN}\\s+(20\\d{2})\\b`, 'gi'))) {
    const date = dateFromParts(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`(?:^|[^\\w])\\s*${MONTH_TOKEN}\\.?\\s+(20\\d{2})[\\s\\S]{0,200}?\\b${MONTH_TOKEN}(?:\\.|\\s)+\\s*(\\d{1,2})${ORDINAL}\\b`, 'gi'))) {
    if (MONTHS[match[1].toLowerCase()] === MONTHS[match[3].toLowerCase()]) {
      const date = dateFromParts(Number(match[2]), MONTHS[match[3].toLowerCase()], Number(match[4]));
      if (date) dates.add(date);
    }
  }
  for (const match of value.matchAll(/\b(20\d{2})年(\d{1,2})月(\d{1,2})日\b/g)) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  return [...dates];
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

function dateForEvidence(evidence, suggestion, options = {}) {
  const metadataDate = isoDateFromValue(evidence?.official_published_at);
  const supportingDates = explicitDates(suggestion?.supporting_excerpt);
  if (metadataDate) {
    if (supportingDates.length && supportingDates.some(date => date !== metadataDate)) {
      return { date: null, reason: 'EVIDENCE_DATE_MISMATCH' };
    }
    return { date: metadataDate };
  }
  const excerptDates = explicitDates(evidence?.excerpt);
  if (options.latest) {
    const candidates = [...new Set([...excerptDates, ...supportingDates])].sort();
    return candidates.length
      ? { date: candidates[candidates.length - 1] }
      : { date: null, reason: 'EVIDENCE_DATE_MISSING' };
  }
  const matched = excerptDates.filter(date => supportingDates.includes(date));
  if (matched.length === 1) return { date: matched[0] };
  if (matched.length > 1 || excerptDates.length > 1) return { date: null, reason: 'EVIDENCE_DATE_AMBIGUOUS' };
  if (excerptDates.length === 1) return { date: excerptDates[0] };
  return { date: null, reason: 'EVIDENCE_DATE_MISSING' };
}

function todayOf(value) {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  return isoDateFromValue(value) || (validDate(value) ? String(value) : null);
}

function baseItem(input, context = {}) {
  const evidence = input.evidence || {};
  const suggestion = input.suggestion || input.ai_suggestion || {};
  const source = context.source || {};
  const detail = context.detail || {};
  const product = context.product || {};
  const previousDate = validDate(detail.last_updated_date) ? detail.last_updated_date : null;
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
    ai_suggestion: validateToolUpdateReviewValue(suggestion) ? {
      verdict: suggestion.verdict,
      matched_surface: suggestion.matched_surface,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      supporting_excerpt: suggestion.supporting_excerpt,
    } : null,
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
  if (!validateToolUpdateReviewValue(normalizedSuggestion)) reasons.push('AI_OUTPUT_INVALID');
  else {
    if (normalizedSuggestion.verdict !== 'approve') reasons.push('AI_VERDICT_NOT_APPROVE');
    if (normalizedSuggestion.confidence < (options.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) reasons.push('AI_CONFIDENCE_LOW');
    if (!REVIEW_SURFACES.includes(source?.product_surface) || normalizedSuggestion.matched_surface !== source?.product_surface) {
      reasons.push('PRODUCT_SURFACE_MISMATCH');
    }
  }

  if (source && detail && normalizedEvidence.status === 'ready' && validateToolUpdateReviewValue(normalizedSuggestion)) {
    const dateResult = dateForEvidence(normalizedEvidence, normalizedSuggestion, { latest: source?.date_mode === 'latest' });
    proposedDate = dateResult.date;
    if (dateResult.reason) reasons.push(dateResult.reason);
    if (!proposedDate) reasons.push('PROPOSED_DATE_MISSING');
    const today = todayOf(options.now);
    if (proposedDate && today && proposedDate > today) reasons.push('PROPOSED_DATE_IN_FUTURE');
    if (validDate(detail.last_updated_date)) {
      if (proposedDate && proposedDate <= detail.last_updated_date) reasons.push('PROPOSED_DATE_NOT_AFTER_CURRENT');
    }
    // 无当前 last_updated_date 表示首次填充（fill_missing），Apply 阶段按 fill_missing 模式处理；
    // 候选仍须具备有效且不未来的证据日期（上面已校验）。
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
