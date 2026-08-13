'use strict';

function pendingCandidateToSeed(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('PENDING_CANDIDATE_INVALID');
  const name = String(candidate.name || candidate.title || '').trim();
  if (!name) throw new Error('PENDING_CANDIDATE_NAME_REQUIRED');
  return {
    detail_kind: 'tool',
    name,
    vendor_name: candidate.vendor_name || candidate.vendor_label || name,
    vendor_key: candidate.vendor_key || null,
    tool_key: candidate.tool_key || null,
    official_url: candidate.url || candidate.official_url || null,
    placement: { existing_level2_ref: null, new_group_title: '待核验工具' },
    known_fields: {
      summary: candidate.description || '',
      source_hotspot: candidate.source_hotspot === true,
    },
    discovery_sources: candidate.source_url ? [{ url: candidate.source_url, kind: 'hotspot' }] : [],
  };
}

module.exports = { pendingCandidateToSeed };
