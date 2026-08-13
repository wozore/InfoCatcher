'use strict';

const AREAS = Object.freeze([
  'vendor-card',
  'tool-card',
  'vendor-level1',
  'vendor-level2',
  'tool-level3',
]);

const VENDOR_CARD_FIELDS = Object.freeze([
  'id', 'vendor_key', 'title', 'icon', 'summary', 'feature_preview',
  'access_level', 'price_badge', 'search_terms', 'level1_ref',
]);
const TOOL_CARD_FIELDS = Object.freeze([
  'id', 'tool_key', 'vendor_key', 'title', 'vendor_label', 'icon', 'summary', 'theme',
  'scenes', 'best_for_preview', 'not_for_preview', 'price_badge',
  'access_level', 'search_terms', 'detail_ref', 'detail_kind',
]);
const VENDOR_LEVEL1_FIELDS = Object.freeze([
  'id', 'vendor_key', 'title', 'icon', 'official_url',
  'description', 'status', 'features', 'level2_refs',
]);
const VENDOR_LEVEL2_FIELDS = Object.freeze([
  'id', 'level1_ref', 'vendor_key', 'title', 'official_url', 'summary', 'status',
  'detail_refs',
]);
const TOOL_LEVEL3_FIELDS = Object.freeze([
  'id', 'vendor_key', 'detail_kind', 'theme', 'title', 'vendor_label', 'icon', 'official_url',
  'status', 'summary', 'one_m_context', 'api_pricing', 'plan',
  'applicable_scenarios', 'inapplicable_scenarios', 'sources', 'official_date',
]);

const ALLOWED_FIELDS = Object.freeze({
  'vendor-card': VENDOR_CARD_FIELDS,
  'tool-card': TOOL_CARD_FIELDS,
  'vendor-level1': VENDOR_LEVEL1_FIELDS,
  'vendor-level2': VENDOR_LEVEL2_FIELDS,
  'tool-level3': TOOL_LEVEL3_FIELDS,
});

const DETAIL_KINDS = Object.freeze(['tool', 'api_model', 'subscription_plan', 'product_variant']);
const TOOL_CARD_KINDS = Object.freeze(['tool', 'api_model', 'product_variant']);
const THEMES = Object.freeze(['general', 'dev', 'vision', 'media']);

const REF_TARGETS = Object.freeze({
  'vendor-card.level1_ref': 'vendor-level1',
  'vendor-level1.level2_refs': 'vendor-level2',
  'vendor-level2.detail_refs': 'tool-level3',
  'tool-card.detail_ref': 'tool-level3',
});

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function areaItems(snapshot, area) {
  const value = snapshot && snapshot[area];
  return Array.isArray(value) ? value : [];
}

function emptySnapshot() {
  return Object.fromEntries(AREAS.map(area => [area, []]));
}

function normalizeSnapshot(snapshot) {
  const normalized = emptySnapshot();
  for (const area of AREAS) normalized[area] = areaItems(snapshot, area);
  return normalized;
}

module.exports = {
  AREAS,
  ALLOWED_FIELDS,
  VENDOR_CARD_FIELDS,
  TOOL_CARD_FIELDS,
  VENDOR_LEVEL1_FIELDS,
  VENDOR_LEVEL2_FIELDS,
  TOOL_LEVEL3_FIELDS,
  DETAIL_KINDS,
  TOOL_CARD_KINDS,
  THEMES,
  REF_TARGETS,
  isHttpUrl,
  areaItems,
  emptySnapshot,
  normalizeSnapshot,
};
