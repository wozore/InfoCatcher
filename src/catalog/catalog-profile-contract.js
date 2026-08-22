'use strict';

const { normalizeSnapshot } = require('./catalog-contract');
const { deriveKeys } = require('./catalog-record-builders');

const BASE_DETAIL_PREDICATES = Object.freeze([
  'official_product_url',
  'release_date',
  'availability_status',
  'capability',
  'limitation',
]);

const PROFILE_DEFINITIONS = Object.freeze({
  'api_model:text': Object.freeze({
    detail_kind: 'api_model',
    modality: 'text',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'api_available', 'access_conditions', 'price_rate', 'context_window'],
    applicability: { one_m_context: 'required', api_pricing: 'required', plan: 'not_applicable' },
  }),
  'api_model:video': Object.freeze({
    detail_kind: 'api_model',
    modality: 'video',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'api_available', 'access_conditions', 'price_rate', 'max_duration', 'output_resolution', 'audio_capability', 'supported_languages'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'required', plan: 'not_applicable' },
  }),
  'api_model:image': Object.freeze({
    detail_kind: 'api_model',
    modality: 'image',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'api_available', 'access_conditions', 'price_rate', 'output_resolution'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'required', plan: 'not_applicable' },
  }),
  'api_model:audio': Object.freeze({
    detail_kind: 'api_model',
    modality: 'audio',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'api_available', 'access_conditions', 'price_rate', 'audio_capability', 'supported_languages'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'required', plan: 'not_applicable' },
  }),
  'tool:general': Object.freeze({
    detail_kind: 'tool',
    modality: 'general',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'access_conditions', 'pricing_model'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'not_applicable', plan: 'not_applicable' },
  }),
  'product_variant:general': Object.freeze({
    detail_kind: 'product_variant',
    modality: 'general',
    required_predicates: [...BASE_DETAIL_PREDICATES, 'access_conditions', 'pricing_model'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'not_applicable', plan: 'not_applicable' },
  }),
  'subscription_plan:general': Object.freeze({
    detail_kind: 'subscription_plan',
    modality: 'general',
    required_predicates: ['official_product_url', 'availability_status', 'price_rate', 'billing_period', 'plan_conditions', 'included_models_status'],
    applicability: { one_m_context: 'not_applicable', api_pricing: 'not_applicable', plan: 'required' },
  }),
});

const VENDOR_PREDICATES = Object.freeze(['vendor_identity', 'vendor_official_url', 'vendor_status', 'vendor_capability', 'vendor_limitation']);
const GROUP_PREDICATES = Object.freeze(['product_family', 'official_product_url', 'availability_status']);
const LAYER_AREAS = Object.freeze(['vendor-card', 'vendor-level1', 'vendor-level2', 'tool-level3', 'tool-card']);

function inferModality(seed) {
  if (seed.detail_kind !== 'api_model') return 'general';
  if (seed.modality) return seed.modality;
  const theme = seed.known_fields?.theme;
  if (theme === 'media') return 'video';
  if (theme === 'vision') return 'image';
  return 'text';
}

function targetIds(seed, keys) {
  const level1Id = seed.placement?.existing_level1_ref?.id || `vendor-level1:${keys.vendorKey}`;
  const level2Id = seed.placement?.existing_level2_ref?.id || `vendor-level2:${keys.vendorKey}:${keys.groupKey}`;
  return {
    'vendor-card': `vendor-card:${keys.vendorKey}`,
    'vendor-level1': level1Id,
    'vendor-level2': level2Id,
    'tool-level3': `tool-level3:${keys.detailKey}`,
    'tool-card': `tool-card:${keys.toolKey}`,
  };
}

function repairSetOf(seed) {
  if (Array.isArray(seed.repair_layers)) return new Set(seed.repair_layers);
  if (seed.operation === 'replace') return new Set(LAYER_AREAS);
  return new Set();
}

function planLayer(snapshot, area, id, repairSet) {
  const current = snapshot[area].find(item => item.id === id) || null;
  return {
    area,
    id,
    operation: current ? (repairSet.has(area) ? 'replace' : 'noop') : 'create',
    current,
  };
}

function unique(values) {
  return [...new Set(values)];
}

function hasRef(values, value) {
  return Array.isArray(values) && values.some(item => item?.kind === value.kind && item?.id === value.id);
}

function planParentLink(layerPlan, parentArea, childArea, refField, childRef) {
  const parent = layerPlan[parentArea];
  const child = layerPlan[childArea];
  if (!parent?.current || parent.operation !== 'noop' || !child) return;
  if (child.operation === 'noop' && !child.current) return;
  if (hasRef(parent.current[refField], childRef)) return;
  parent.operation = 'replace';
  parent.link_only = true;
}

function planCatalogResearch(seed, snapshotInput) {
  if (!seed?.detail_kind || !seed?.name || !seed?.vendor_name) throw new Error('SEED_REQUIRED_FIELDS_MISSING');
  const modality = inferModality(seed);
  const profileKey = `${seed.detail_kind}:${modality}`;
  const definition = PROFILE_DEFINITIONS[profileKey];
  if (!definition) throw new Error(`CATALOG_PROFILE_UNSUPPORTED:${profileKey}`);
  const keys = deriveKeys(seed);
  const ids = targetIds(seed, keys);
  const snapshot = normalizeSnapshot(snapshotInput);
  const repairs = repairSetOf(seed);
  const areas = seed.detail_kind === 'subscription_plan' ? LAYER_AREAS.filter(area => area !== 'tool-card') : LAYER_AREAS;
  const layerPlan = Object.fromEntries(areas.map(area => [area, planLayer(snapshot, area, ids[area], repairs)]));
  planParentLink(layerPlan, 'vendor-level1', 'vendor-level2', 'level2_refs', { kind: 'vendor-level2', id: ids['vendor-level2'] });
  planParentLink(layerPlan, 'vendor-level2', 'tool-level3', 'detail_refs', { kind: 'tool-level3', id: ids['tool-level3'] });
  const isResearchActive = area => layerPlan[area] && layerPlan[area].operation !== 'noop' && layerPlan[area].link_only !== true;
  const vendorActive = ['vendor-card', 'vendor-level1'].some(isResearchActive);
  const groupActive = isResearchActive('vendor-level2');
  const detailActive = ['tool-level3', 'tool-card'].some(isResearchActive);
  const scopes = [];
  if (vendorActive) scopes.push({ kind: 'vendor', subject: { kind: 'vendor', key: keys.vendorKey }, predicates: [...VENDOR_PREDICATES] });
  if (groupActive) scopes.push({ kind: 'group', subject: { kind: 'group', key: `${keys.vendorKey}:${keys.groupKey}` }, predicates: [...GROUP_PREDICATES] });
  if (detailActive) scopes.push({ kind: 'detail', subject: { kind: 'detail', key: keys.detailKey }, predicates: [...definition.required_predicates] });
  const requiredPredicates = unique(scopes.flatMap(scope => scope.predicates));
  return {
    schema_version: 1,
    seed,
    keys,
    target_ids: ids,
    profile: { key: profileKey, detail_kind: definition.detail_kind, modality: definition.modality },
    applicability: { ...definition.applicability },
    layer_plan: layerPlan,
    research_scopes: scopes,
    required_predicates: requiredPredicates,
  };
}

module.exports = {
  PROFILE_DEFINITIONS,
  VENDOR_PREDICATES,
  GROUP_PREDICATES,
  inferModality,
  planCatalogResearch,
};
