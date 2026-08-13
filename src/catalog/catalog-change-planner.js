'use strict';

const { emptySnapshot, normalizeSnapshot } = require('./catalog-contract');
const { ref, buildVendorCard, buildLevel1, buildLevel2, buildDetail, buildToolCard, deriveKeys } = require('./catalog-record-builders');
const { previewHashOf } = require('./catalog-revision');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');

function snapshotFromCatalogResult(result) {
  if (!result || !result.ok) throw new Error(result?.error?.message || 'CATALOG_LOAD_FAILED');
  return normalizeSnapshot(result.data);
}

function indexBy(items, field) {
  return new Map((items || []).map(item => [item?.[field], item]));
}

function findPlacement(snapshot, seed, keys) {
  const level1Id = seed.placement?.existing_level1_ref?.id || `vendor-level1:${keys.vendorKey}`;
  const existingLevel1 = snapshot['vendor-level1'].find(item => item.id === level1Id || item.vendor_key === keys.vendorKey);
  const existingLevel2Id = seed.placement?.existing_level2_ref?.id;
  const existingLevel2 = existingLevel2Id
    ? snapshot['vendor-level2'].find(item => item.id === existingLevel2Id)
    : snapshot['vendor-level2'].find(item => item.vendor_key === keys.vendorKey && item.id === `vendor-level2:${keys.vendorKey}:${keys.groupKey}`);
  return { level1Id, existingLevel1, existingLevel2, existingLevel2Id };
}

function businessData(seed, aiDraft = {}) {
  return {
    vendor_name: seed.vendor_name,
    title: aiDraft.title || seed.name,
    vendor_label: aiDraft.vendor_label || seed.vendor_name,
    icon: aiDraft.icon || seed.icon || '',
    summary: aiDraft.summary || seed.known_fields?.summary || `${seed.vendor_name} ${seed.name}`,
    description: aiDraft.description || aiDraft.summary || seed.known_fields?.description || `${seed.vendor_name} ${seed.name}`,
    official_url: aiDraft.official_url || seed.official_url || '',
    status: aiDraft.status || seed.known_fields?.status || 'unknown',
    theme: aiDraft.theme || seed.known_fields?.theme || 'general',
    access_level: aiDraft.access_level || seed.known_fields?.access_level || '未知',
    price_badge: aiDraft.price_badge || seed.known_fields?.price_badge || 'unknown',
    tool_key: aiDraft.tool_key || seed.tool_key || seed.name,
    scenes: aiDraft.scenes || seed.known_fields?.scenes || [],
    best_for_preview: aiDraft.best_for_preview || seed.known_fields?.best_for_preview || '',
    not_for_preview: aiDraft.not_for_preview || seed.known_fields?.not_for_preview || '',
    features: aiDraft.features || [],
    one_m_context: aiDraft.one_m_context ?? null,
    api_pricing: aiDraft.api_pricing ?? null,
    plan: aiDraft.plan ?? null,
    applicable_scenarios: aiDraft.applicable_scenarios || [],
    inapplicable_scenarios: aiDraft.inapplicable_scenarios || [],
    sources: aiDraft.sources || [],
    official_date: aiDraft.official_date ?? null,
  };
}

function appendUniqueRef(refs, value) {
  const current = Array.isArray(refs) ? refs : [];
  return current.some(item => item.kind === value.kind && item.id === value.id) ? current : [...current, value];
}

function planCatalogChange(snapshotInput, seed, aiDraft = {}) {
  const snapshot = normalizeSnapshot(snapshotInput);
  if (!seed?.detail_kind || !seed?.name || !seed?.vendor_name) throw new Error('SEED_REQUIRED_FIELDS_MISSING');
  const keys = deriveKeys(seed);
  const data = businessData(seed, aiDraft);
  const placement = findPlacement(snapshot, seed, keys);
  const creates = Object.fromEntries(Object.keys(emptySnapshot()).map(area => [area, []]));
  const updates = [];
  const isSubscription = seed.detail_kind === 'subscription_plan';
  const level1Id = placement.existingLevel1?.id || `vendor-level1:${keys.vendorKey}`;
  const level2Id = placement.existingLevel2?.id || `vendor-level2:${keys.vendorKey}:${keys.groupKey}`;
  const detailId = `tool-level3:${keys.detailKey}`;
  const detailRef = ref('tool-level3', detailId);

  if (!placement.existingLevel1) {
    creates['vendor-card'].push(buildVendorCard({
      vendorKey: keys.vendorKey,
      title: data.vendor_label,
      icon: data.icon,
      summary: data.description,
      featurePreview: data.features,
      accessLevel: data.access_level,
      priceBadge: data.price_badge,
      searchTerms: [data.vendor_label, keys.vendorKey],
      level1Id,
    }));
    creates['vendor-level1'].push(buildLevel1({
      vendorKey: keys.vendorKey,
      title: data.vendor_label,
      icon: data.icon,
      officialUrl: data.official_url,
      description: data.description,
      status: data.status,
      features: data.features,
      level2Refs: [ref('vendor-level2', level2Id)],
    }));
  } else if (!placement.existingLevel2) {
    updates.push({ area: 'vendor-level1', id: level1Id, append: { level2_refs: ref('vendor-level2', level2Id) } });
  }

  if (!placement.existingLevel2) {
    creates['vendor-level2'].push(buildLevel2({
      vendorKey: keys.vendorKey,
      level1Id,
      groupKey: keys.groupKey,
      title: seed.placement?.new_group_title || data.title,
      officialUrl: data.official_url,
      summary: data.description,
      status: data.status,
      detailRefs: [detailRef],
    }));
  } else {
    updates.push({ area: 'vendor-level2', id: placement.existingLevel2.id, append: { detail_refs: detailRef } });
  }

  const detail = buildDetail({
    vendorKey: keys.vendorKey,
    detailKind: seed.detail_kind,
    theme: data.theme,
    title: data.title,
    vendorLabel: data.vendor_label,
    icon: data.icon,
    officialUrl: data.official_url,
    status: data.status,
    summary: data.summary,
    oneMContext: data.one_m_context,
    apiPricing: data.api_pricing,
    plan: data.plan,
    applicableScenarios: data.applicable_scenarios,
    inapplicableScenarios: data.inapplicable_scenarios,
    sources: data.sources,
    officialDate: data.official_date,
  });
  detail.id = detailId;
  creates['tool-level3'].push(detail);

  if (!isSubscription) {
    creates['tool-card'].push(buildToolCard({
      toolKey: keys.toolKey,
      vendorKey: keys.vendorKey,
      title: data.title,
      vendorLabel: data.vendor_label,
      icon: data.icon,
      summary: data.summary,
      theme: data.theme,
      scenes: data.scenes,
      bestForPreview: data.best_for_preview,
      notForPreview: data.not_for_preview,
      priceBadge: data.price_badge,
      accessLevel: data.access_level,
      searchTerms: [data.title, data.vendor_label, keys.toolKey, ...data.scenes].filter(Boolean),
      detailId,
      detailKind: seed.detail_kind,
    }));
  }

  for (const area of Object.keys(creates)) {
    const existing = new Set(snapshot[area].map(item => item.id));
    for (const item of creates[area]) {
      if (existing.has(item.id)) throw new Error(`ID_CONFLICT:${area}:${item.id}`);
    }
  }
  for (const update of updates) {
    const target = snapshot[update.area].find(item => item.id === update.id);
    if (!target) throw new Error(`REF_CONFLICT:${update.area}:${update.id}`);
  }

  const futureSnapshot = normalizeSnapshot(snapshot);
  for (const area of Object.keys(creates)) futureSnapshot[area].push(...creates[area]);
  for (const update of updates) {
    const target = futureSnapshot[update.area].find(item => item.id === update.id);
    const field = Object.keys(update.append)[0];
    target[field] = appendUniqueRef(target[field], update.append[field]);
  }
  const validation = validateCatalogSnapshot(futureSnapshot);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`SNAPSHOT_INVALID:${first.path}:${first.message}`);
  }
  const changePreview = {
    creates: Object.fromEntries(Object.entries(creates).map(([area, items]) => [area, items.map(item => item.id)])),
    updates: updates.map(update => ({ area: update.area, id: update.id, fields: Object.keys(update.append) })),
    detail_kind: seed.detail_kind,
    tool_card_created: !isSubscription,
  };
  return {
    snapshot: futureSnapshot,
    creates,
    updates,
    changePreview,
    previewHash: previewHashOf(changePreview),
    keys,
  };
}

module.exports = { planCatalogChange, snapshotFromCatalogResult, businessData };
