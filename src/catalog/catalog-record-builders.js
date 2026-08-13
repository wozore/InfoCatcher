'use strict';

const { TOOL_CARD_KINDS, THEMES } = require('./catalog-contract');

function slugify(value, label) {
  const slug = String(value || '')
    .trim()
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!slug) throw new Error(`KEY_REQUIRED:${label}`);
  return slug;
}

function ref(kind, id) {
  return { kind, id };
}

function buildVendorCard({ vendorKey, title, icon, summary, featurePreview, accessLevel, priceBadge, searchTerms, level1Id }) {
  return {
    id: `vendor-card:${vendorKey}`,
    vendor_key: vendorKey,
    title,
    icon: icon || '',
    summary,
    feature_preview: featurePreview || [],
    access_level: accessLevel || '未知',
    price_badge: priceBadge || 'unknown',
    search_terms: searchTerms || [title, vendorKey].filter(Boolean),
    level1_ref: ref('vendor-level1', level1Id),
  };
}

function buildLevel1({ vendorKey, title, icon, officialUrl, description, status, features, level2Refs }) {
  return {
    id: `vendor-level1:${vendorKey}`,
    vendor_key: vendorKey,
    title,
    icon: icon || '',
    official_url: officialUrl || '',
    description,
    status: status || 'unknown',
    features: features || [],
    level2_refs: level2Refs || [],
  };
}

function buildLevel2({ vendorKey, level1Id, groupKey, title, officialUrl, summary, status, detailRefs }) {
  return {
    id: `vendor-level2:${vendorKey}:${groupKey}`,
    level1_ref: ref('vendor-level1', level1Id),
    vendor_key: vendorKey,
    title,
    official_url: officialUrl || '',
    summary,
    status: status || 'unknown',
    detail_refs: detailRefs || [],
  };
}

function buildDetail({ vendorKey, detailKind, theme, title, vendorLabel, icon, officialUrl, status, summary, oneMContext, apiPricing, plan, applicableScenarios, inapplicableScenarios, sources, officialDate }) {
  const detail = {
    vendor_key: vendorKey,
    detail_kind: detailKind,
    title,
    vendor_label: vendorLabel,
    icon: icon || '',
    official_url: officialUrl || '',
    status: status || 'unknown',
    summary,
    one_m_context: oneMContext ?? null,
    api_pricing: apiPricing ?? null,
    plan: plan ?? null,
    applicable_scenarios: applicableScenarios || [],
    inapplicable_scenarios: inapplicableScenarios || [],
    sources: sources || [],
    official_date: officialDate ?? null,
  };
  if (detailKind !== 'subscription_plan') detail.theme = theme || 'general';
  return detail;
}

function buildToolCard({ toolKey, vendorKey, title, vendorLabel, icon, summary, theme, scenes, bestForPreview, notForPreview, priceBadge, accessLevel, searchTerms, detailId, detailKind }) {
  if (!TOOL_CARD_KINDS.includes(detailKind)) throw new Error(`TOOL_CARD_KIND_INVALID:${detailKind}`);
  if (!THEMES.includes(theme)) throw new Error(`THEME_INVALID:${theme}`);
  return {
    id: `tool-card:${toolKey}`,
    tool_key: toolKey,
    vendor_key: vendorKey,
    title,
    vendor_label: vendorLabel,
    icon: icon || '',
    summary,
    theme,
    scenes: scenes || [],
    best_for_preview: bestForPreview || '',
    not_for_preview: notForPreview || '',
    price_badge: priceBadge || 'unknown',
    access_level: accessLevel || '未知',
    search_terms: searchTerms || [title, vendorLabel, toolKey].filter(Boolean),
    detail_ref: ref('tool-level3', detailId),
    detail_kind: detailKind,
  };
}

function deriveKeys(seed) {
  const vendorKey = slugify(seed.vendor_key || seed.vendor_name, 'vendor_key');
  const toolKey = seed.tool_key ? slugify(seed.tool_key, 'tool_key') : slugify(seed.name, 'tool_key');
  const groupKey = slugify(seed.group_key || seed.placement?.new_group_title || seed.name, 'group_key');
  const detailKey = seed.detail_key ? slugify(seed.detail_key, 'detail_key') : toolKey;
  return { vendorKey, toolKey, groupKey, detailKey };
}

module.exports = {
  slugify,
  ref,
  buildVendorCard,
  buildLevel1,
  buildLevel2,
  buildDetail,
  buildToolCard,
  deriveKeys,
};
