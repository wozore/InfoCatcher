'use strict';

const { vibeHubSlugOf, fetchVibeHubDefinition } = require('./vibe-hub-evidence');

const DEFAULT_MAX_EVIDENCE_PER_TERM = 3;
const DEFAULT_MAX_EVIDENCE_CHARS = 1200;

function summaryScoreOf(item) {
  return Number(item?.final_score ?? item?.hot_score ?? 0);
}

async function readNewsEvidence(options = {}) {
  if (typeof options.readNewsEvidence === 'function') {
    const value = await options.readNewsEvidence();
    if (!Array.isArray(value)) throw new Error('CONCEPT_NEWS_EVIDENCE_INVALID');
    return value;
  }
  if (!Array.isArray(options.newsEvidence)) throw new Error('CONCEPT_NEWS_EVIDENCE_REQUIRED');
  return options.newsEvidence;
}

async function collectConceptEvidence(cards, options = {}) {
  const candidates = await readNewsEvidence(options);
  const approvedWithSummary = candidates
    .filter(item => item && item.review_status === 'approved' && item.summary)
    .sort((a, b) => summaryScoreOf(b) - summaryScoreOf(a));
  const maxPerTerm = options.maxEvidencePerTerm ?? DEFAULT_MAX_EVIDENCE_PER_TERM;
  const maxChars = options.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  const results = [];
  for (const card of cards || []) {
    const term = String(card?.term || '').trim();
    const lower = term.toLowerCase();
    const summaries = lower
      ? approvedWithSummary.filter(item => String(item.summary || '').toLowerCase().includes(lower)).slice(0, maxPerTerm)
        .map(item => ({
          kind: 'summary',
          title: String(item.title || item.author_name || 'approved 摘要').trim(),
          text: String(item.summary || '').trim().slice(0, maxChars),
          ...(item.url ? { url: item.url } : {}),
        }))
      : [];
    const evidence = [...summaries];
    if (!options.skipVibeHub && term && /^[\x00-\x7F]+$/.test(term)) {
      const slug = vibeHubSlugOf(term);
      if (slug) {
        try {
          const fetched = await fetchVibeHubDefinition(slug, options);
          if (fetched && fetched.ok) evidence.push({
            kind: 'vibe-hub',
            title: String(fetched.title || term).trim(),
            text: String(fetched.text || fetched.definition || '').trim().slice(0, maxChars),
            url: `https://vibe-hub.org/${slug}`,
          });
        } catch { /* 补充证据失败不阻塞主证据链 */ }
      }
    }
    results.push({ card, evidence });
  }
  return results;
}

module.exports = { readNewsEvidence, collectConceptEvidence };
