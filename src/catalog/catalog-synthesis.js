'use strict';

const { buildVendorCard, buildLevel1, buildLevel2, buildDetail, buildToolCard, ref } = require('./catalog-record-builders');
const { validatePlannedRecords, isExplicitValue } = require('./catalog-record-completeness');

const DETAIL_MISMATCH_FIELDS = Object.freeze(['access_level', 'price_badge', 'api_pricing']);

const MAX_FEATURE_TEXT = 60;

function splitFeatureText(text) {
  return String(text || '').split(/[。；;！？!]+|\s*[,，]\s*/).map(part => part.trim()).filter(Boolean);
}

function normalizeFeaturePreview(features) {
  if (!Array.isArray(features)) return features;
  const items = [];
  for (const item of features) {
    const text = String(item?.text || '').trim();
    if (!text) continue;
    const parts = text.length > MAX_FEATURE_TEXT ? splitFeatureText(text) : [text];
    if (parts.length > 1) {
      for (const part of parts) items.push({ tone: item.tone, text: part });
    } else {
      items.push({ tone: item.tone, text });
    }
  }
  return items;
}

const REQUIRED_LAYER_FIELDS = Object.freeze({
  vendor: ['vendor_summary', 'vendor_description', 'vendor_official_url', 'vendor_status', 'features'],
  group: ['group_summary', 'group_official_url', 'group_status'],
  detail: ['summary', 'official_url', 'detail_status', 'access_level', 'price_badge', 'scenes', 'best_for_preview', 'not_for_preview', 'applicable_scenarios', 'inapplicable_scenarios', 'official_date'],
});

function hasActive(plan, areas) {
  return areas.some(area => plan.layer_plan[area]
    && plan.layer_plan[area].operation !== 'noop'
    && plan.layer_plan[area].link_only !== true);
}

function expectedLayerFields(plan) {
  const fields = {};
  if (hasActive(plan, ['vendor-card', 'vendor-level1'])) fields.vendor = [...REQUIRED_LAYER_FIELDS.vendor];
  if (hasActive(plan, ['vendor-level2'])) fields.group = [...REQUIRED_LAYER_FIELDS.group];
  if (hasActive(plan, ['tool-level3', 'tool-card'])) {
    fields.detail = [...REQUIRED_LAYER_FIELDS.detail];
    for (const [field, status] of Object.entries(plan.applicability || {})) if (status === 'required') fields.detail.push(field);
  }
  return fields;
}

function isNonDefaultFieldValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return isExplicitValue(String(value));
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function fieldCoverageOf(output, plan) {
  const entries = [];
  for (const [layer, fields] of Object.entries(expectedLayerFields(plan))) {
    for (const field of fields) {
      const value = output?.layer_fields?.[layer]?.[field];
      const refs = output?.provenance?.[`${layer}.${field}`] || [];
      const validValue = isNonDefaultFieldValue(value) && (field !== 'official_date' || isIsoDate(value));
      const status = (validValue && refs.length > 0) ? 'covered' : 'missing';
      entries.push({ layer, field, status });
    }
  }
  return { entries, covered: entries.filter(item => item.status === 'covered'), missing: entries.filter(item => item.status === 'missing') };
}

function missingCoverageFailure(coverage, plan) {
  const missing = coverage.missing.map(item => `${item.layer}.${item.field}`);
  const apiMismatch = plan.profile.detail_kind === 'api_model'
    && missing.some(field => DETAIL_MISMATCH_FIELDS.some(key => field.endsWith(`.${key}`)));
  return {
    ok: false,
    code: apiMismatch ? 'PROFILE_MISMATCH_SUSPECTED' : 'SYNTHESIS_COVERAGE_INCOMPLETE',
    error: `缺少必需目录字段: ${[...new Set(missing)].join(', ')}`,
    missing_fields: [...new Set(missing)],
    ...(apiMismatch ? { suggested_detail_kind: 'product_variant' } : {}),
    coverage,
  };
}

function provenanceError(errors, path, message) {
  errors.push({ code: 'PROVENANCE_INVALID', path, message });
}

function validateSynthesisOutput(output, research) {
  const errors = [];
  if (!output?.layer_fields || typeof output.layer_fields !== 'object' || Array.isArray(output.layer_fields)) {
    errors.push({ code: 'SYNTHESIS_OUTPUT_INVALID', path: 'layer_fields', message: '缺少 layer_fields 对象' });
    return { ok: false, errors };
  }
  const sources = new Map((research.official_sources || []).map(source => [source.source_id, source]));
  for (const [path, refs] of Object.entries(output?.provenance || {})) {
    if (!Array.isArray(refs) || !refs.length) {
      provenanceError(errors, path, '派生字段必须引用至少一个官方来源');
      continue;
    }
    for (const id of refs) if (!sources.has(id)) provenanceError(errors, path, `来源不存在: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

function deterministic(basis) {
  return { kind: 'deterministic', basis, source_ids: [] };
}

function fromSources(sourceIds) {
  return { kind: 'derived', source_ids: [...new Set((sourceIds || []).filter(Boolean))] };
}

function notApplicable(reason) {
  return { value: { status: 'not_applicable', reason }, provenance: { kind: 'not_applicable', basis: 'CatalogProfile', source_ids: [] } };
}

function appendRef(values, value) {
  const current = Array.isArray(values) ? values : [];
  return current.some(item => item.kind === value.kind && item.id === value.id) ? current : [...current, value];
}

function sourcesForCatalog(research) {
  return (research.official_sources || []).map(source => ({ title: source.title || source.url, url: source.url }));
}

function fieldSourceIds(output, layer, field) {
  return output.provenance?.[`${layer}.${field}`] || [];
}

function fullProvenance(record, mappings = {}) {
  return Object.fromEntries(Object.keys(record).map(field => [field, mappings[field] || deterministic('record structure')]));
}

function buildPatches(plan, research, output) {
  const patches = [];
  const keys = plan.keys;
  const ids = plan.target_ids;
  const vendor = output.layer_fields?.vendor || {};
  const vendorFeatures = normalizeFeaturePreview(vendor.features);
  const group = output.layer_fields?.group || {};
  const detailFields = output.layer_fields?.detail || {};
  const detailId = ids['tool-level3'];
  const detailRef = ref('tool-level3', detailId);
  const level2Ref = ref('vendor-level2', ids['vendor-level2']);
  const icon = plan.seed.known_fields?.icon || ({ video: '🎬', image: '🖼️', audio: '🎵', text: '🤖' }[plan.profile.modality] || '🧩');
  const theme = plan.seed.known_fields?.theme || ({ video: 'media', audio: 'media', image: 'vision', text: 'general' }[plan.profile.modality] || 'general');
  const sources = sourcesForCatalog(research);

  const applicability = {};
  for (const [field, status] of Object.entries(plan.applicability || {})) {
    if (status === 'not_applicable') applicability[field] = notApplicable(
      field === 'one_m_context' ? '当前 CatalogProfile 不使用文本上下文窗口。'
        : field === 'plan' ? '当前记录不是订阅套餐。'
          : '当前 CatalogProfile 不使用此类 API 计价字段。',
    );
  }
  const oneMContext = applicability.one_m_context?.value || detailFields.one_m_context;
  const apiPricing = applicability.api_pricing?.value || detailFields.api_pricing;
  const planValue = applicability.plan?.value || detailFields.plan;

  const existingLevel1 = plan.layer_plan['vendor-level1']?.current;
  const existingLevel2 = plan.layer_plan['vendor-level2']?.current;
  const level2Refs = appendRef(existingLevel1?.level2_refs, level2Ref);
  const detailRefs = appendRef(existingLevel2?.detail_refs, detailRef);

  const records = {};
  if (hasActive(plan, ['vendor-card', 'vendor-level1'])) {
    records['vendor-card'] = buildVendorCard({ vendorKey: keys.vendorKey, title: plan.seed.vendor_name, icon, summary: vendor.vendor_summary, featurePreview: vendorFeatures, accessLevel: detailFields.access_level, priceBadge: detailFields.price_badge, searchTerms: [plan.seed.vendor_name, keys.vendorKey], level1Id: ids['vendor-level1'] });
    records['vendor-level1'] = buildLevel1({ vendorKey: keys.vendorKey, title: plan.seed.vendor_name, icon, officialUrl: vendor.vendor_official_url, description: vendor.vendor_description, status: vendor.vendor_status, features: vendorFeatures, level2Refs });
  }
  if (hasActive(plan, ['vendor-level2'])) records['vendor-level2'] = buildLevel2({ vendorKey: keys.vendorKey, level1Id: ids['vendor-level1'], groupKey: keys.groupKey, title: plan.seed.placement?.new_group_title || plan.seed.name, officialUrl: group.group_official_url, summary: group.group_summary, status: group.group_status, detailRefs });
  if (hasActive(plan, ['tool-level3', 'tool-card'])) {
    const detail = buildDetail({ vendorKey: keys.vendorKey, detailKind: plan.profile.detail_kind, theme, title: plan.seed.name, vendorLabel: plan.seed.vendor_name, icon, officialUrl: detailFields.official_url, status: detailFields.detail_status, summary: detailFields.summary, oneMContext, apiPricing, plan: planValue, applicableScenarios: detailFields.applicable_scenarios, inapplicableScenarios: detailFields.inapplicable_scenarios, sources, officialDate: detailFields.official_date });
    detail.id = detailId;
    records['tool-level3'] = detail;
    if (plan.layer_plan['tool-card']) records['tool-card'] = buildToolCard({ toolKey: keys.toolKey, vendorKey: keys.vendorKey, title: plan.seed.name, vendorLabel: plan.seed.vendor_name, icon, summary: detailFields.summary, theme, scenes: detailFields.scenes, bestForPreview: detailFields.best_for_preview, notForPreview: detailFields.not_for_preview, priceBadge: detailFields.price_badge, accessLevel: detailFields.access_level, searchTerms: [plan.seed.name, plan.seed.vendor_name, keys.toolKey, ...detailFields.scenes], detailId, detailKind: plan.profile.detail_kind });
  }
  for (const area of ['vendor-level1', 'vendor-level2']) {
    const layer = plan.layer_plan[area];
    if (!layer?.link_only) continue;
    const current = layer.current;
    records[area] = area === 'vendor-level1'
      ? { ...current, level2_refs: level2Refs }
      : { ...current, detail_refs: detailRefs };
  }

  const valueMappings = {
    'vendor-card': { summary: fromSources(fieldSourceIds(output, 'vendor', 'vendor_summary')), feature_preview: fromSources(fieldSourceIds(output, 'vendor', 'features')), access_level: fromSources(fieldSourceIds(output, 'detail', 'access_level')), price_badge: fromSources(fieldSourceIds(output, 'detail', 'price_badge')) },
    'vendor-level1': { official_url: fromSources(fieldSourceIds(output, 'vendor', 'vendor_official_url')), description: fromSources(fieldSourceIds(output, 'vendor', 'vendor_description')), status: fromSources(fieldSourceIds(output, 'vendor', 'vendor_status')), features: fromSources(fieldSourceIds(output, 'vendor', 'features')) },
    'vendor-level2': { official_url: fromSources(fieldSourceIds(output, 'group', 'group_official_url')), summary: fromSources(fieldSourceIds(output, 'group', 'group_summary')), status: fromSources(fieldSourceIds(output, 'group', 'group_status')) },
    'tool-level3': {
      official_url: fromSources(fieldSourceIds(output, 'detail', 'official_url')), status: fromSources(fieldSourceIds(output, 'detail', 'detail_status')), summary: fromSources(fieldSourceIds(output, 'detail', 'summary')),
      one_m_context: applicability.one_m_context?.provenance || fromSources(fieldSourceIds(output, 'detail', 'one_m_context')),
      api_pricing: applicability.api_pricing?.provenance || fromSources(fieldSourceIds(output, 'detail', 'api_pricing')),
      plan: applicability.plan?.provenance || fromSources(fieldSourceIds(output, 'detail', 'plan')),
      applicable_scenarios: fromSources(fieldSourceIds(output, 'detail', 'applicable_scenarios')), inapplicable_scenarios: fromSources(fieldSourceIds(output, 'detail', 'inapplicable_scenarios')),
      sources: { kind: 'official_sources', source_ids: research.official_sources.map(source => source.source_id) }, official_date: fromSources(fieldSourceIds(output, 'detail', 'official_date')),
    },
    'tool-card': { summary: fromSources(fieldSourceIds(output, 'detail', 'summary')), scenes: fromSources(fieldSourceIds(output, 'detail', 'scenes')), best_for_preview: fromSources(fieldSourceIds(output, 'detail', 'best_for_preview')), not_for_preview: fromSources(fieldSourceIds(output, 'detail', 'not_for_preview')), price_badge: fromSources(fieldSourceIds(output, 'detail', 'price_badge')), access_level: fromSources(fieldSourceIds(output, 'detail', 'access_level')) },
  };

  for (const [area, layer] of Object.entries(plan.layer_plan)) {
    if (layer.operation === 'noop') {
      patches.push({ area, id: layer.id, operation: 'noop', record: null, provenance: {} });
      continue;
    }
    const record = records[area];
    const provenance = layer.link_only ? fullProvenance(record) : fullProvenance(record, valueMappings[area]);
    patches.push({ area, id: layer.id, operation: layer.operation, record, provenance });
  }
  return patches;
}

function validateLayerPatches(patches) {
  const errors = [];
  const recordsByArea = {};
  for (const patch of patches) {
    if (patch.operation === 'noop') continue;
    if (!patch.record || patch.record.id !== patch.id) errors.push({ code: 'PATCH_RECORD_INVALID', path: `${patch.area}:${patch.id}`, message: 'Patch record 缺失或 id 不匹配' });
    else {
      (recordsByArea[patch.area] ||= []).push(patch.record);
      for (const field of Object.keys(patch.record)) if (!patch.provenance?.[field]) errors.push({ code: 'PATCH_PROVENANCE_MISSING', path: `${patch.area}:${patch.id}.${field}`, message: '记录字段缺少 provenance' });
    }
  }
  const strict = validatePlannedRecords(recordsByArea);
  errors.push(...strict.errors);
  return { ok: errors.length === 0, errors };
}

async function synthesizeCatalog(research, plan, adapter) {
  if (!research?.ok) return research || { ok: false, code: 'RESEARCH_REQUIRED', error: '缺少 ResearchResult' };
  const expected = expectedLayerFields(plan);
  const hasSynthesisFields = Object.values(expected).some(fields => fields.length > 0);
  if (!hasSynthesisFields) {
    const output = { layer_fields: {}, provenance: {} };
    const coverage = fieldCoverageOf(output, plan);
    const patches = buildPatches(plan, research, output);
    const patchValidation = validateLayerPatches(patches);
    if (!patchValidation.ok) return { ok: false, code: 'LAYER_PATCH_INVALID', errors: patchValidation.errors, cost: research._cost_ledger?.snapshot ? research._cost_ledger.snapshot() : research.cost };
    return { ok: true, layer_patches: patches, synthesis: { ...output, coverage }, coverage, cost: research._cost_ledger?.snapshot ? research._cost_ledger.snapshot() : research.cost };
  }
  if (!adapter?.synthesize) return { ok: false, code: 'SYNTHESIS_ADAPTER_REQUIRED', error: '缺少 synthesize adapter' };
  const output = await adapter.synthesize({ research, plan, expected_layer_fields: expected, ledger: research._cost_ledger });
  const cost = research._cost_ledger?.snapshot ? research._cost_ledger.snapshot() : research.cost;
  if (output?.ok === false) return { ...output, cost };
  const validation = validateSynthesisOutput(output, research);
  if (!validation.ok) return { ok: false, code: 'SYNTHESIS_INVALID', errors: validation.errors, cost };
  const coverage = fieldCoverageOf(output, plan);
  if (coverage.missing.length) return { ...missingCoverageFailure(coverage, plan), cost };
  const patches = buildPatches(plan, research, output);
  const patchValidation = validateLayerPatches(patches);
  if (!patchValidation.ok) return { ok: false, code: 'LAYER_PATCH_INVALID', errors: patchValidation.errors, cost };
  return { ok: true, layer_patches: patches, synthesis: { ...output, coverage }, coverage, cost };
}

module.exports = {
  DETAIL_MISMATCH_FIELDS,
  REQUIRED_LAYER_FIELDS,
  expectedLayerFields,
  isNonDefaultFieldValue,
  fieldCoverageOf,
  missingCoverageFailure,
  validateSynthesisOutput,
  validateLayerPatches,
  normalizeFeaturePreview,
  synthesizeCatalog,
};
