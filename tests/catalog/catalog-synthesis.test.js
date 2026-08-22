'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { planCatalogResearch } = require('../../src/catalog/catalog-profile-contract');
const { synthesizeCatalog, normalizeFeaturePreview } = require('../../src/catalog/catalog-synthesis');

function seed(overrides = {}) {
  return {
    detail_kind: 'api_model', modality: 'video', name: 'Kling 2.6 Pro', vendor_name: '可灵', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro',
    placement: { new_group_title: 'Models' }, known_fields: { theme: 'media' }, discovery_sources: [{ url: 'https://kling.ai', kind: 'official_hint' }],
    ...overrides,
  };
}

function layerFieldsFor() {
  return {
    vendor: {
      vendor_summary: '可灵是快手旗下的视频生成平台。',
      vendor_description: '可灵提供有官方资料支持的视频生成能力。',
      vendor_official_url: 'https://kling.ai',
      vendor_status: 'verified',
      features: [{ tone: 'positive', text: '支持音画同步生成。' }, { tone: 'negative', text: '视频时长受官方限制。' }],
    },
    group: {
      group_summary: '可灵官方视频模型系列。',
      group_official_url: 'https://kling.ai',
      group_status: 'active',
    },
    detail: {
      summary: '面向短视频创作的音画同步生成模型。',
      official_url: 'https://kling.ai',
      detail_status: 'active',
      access_level: '开放',
      price_badge: 'usage_based',
      scenes: ['短视频生成', '多角色对话'],
      best_for_preview: '适合需要音画同步的短视频。',
      not_for_preview: '不适合超过官方时长上限的长视频。',
      api_pricing: { status: 'available', rate_cards: [{ label: '视频生成', pricing_basis: 'generation', currency: 'CREDIT', metrics: [{ label: '标准生成', amount: 1, unit: 'generation' }], conditions: '以官方 API 计费说明为准。' }] },
      applicable_scenarios: [{ title: '短视频生成', description: '适合生成音画同步的短内容。' }],
      inapplicable_scenarios: [{ title: '长视频', description: '超过官方时长上限的内容不适合。' }],
      official_date: '2025-12-03',
    },
  };
}

function provenanceFor(sourceId) {
  const provenance = {};
  for (const layer of Object.keys(layerFieldsFor())) {
    for (const field of Object.keys(layerFieldsFor()[layer])) provenance[`${layer}.${field}`] = [sourceId];
  }
  return provenance;
}

function researchFor(plan) {
  return {
    ok: true,
    official_sources: [{ source_id: 'source-1', url: 'https://kling.ai', title: 'Official', excerpt: 'Official facts', content: 'Official facts' }],
    warnings: [],
    cost: { limits: {}, spent: {}, remaining: {} },
  };
}

function adapter(missingFields = []) {
  return {
    synthesize: async ({ research }) => {
      const sourceId = research.official_sources[0].source_id;
      const layerFields = layerFieldsFor();
      const provenance = provenanceFor(sourceId);
      for (const field of missingFields) {
        const [layer, name] = field.split('.');
        if (layerFields[layer]) delete layerFields[layer][name];
        delete provenance[field];
      }
      return { layer_fields: layerFields, provenance, missing: [...missingFields] };
    },
  };
}

function repairedSnapshot() {
  const snapshot = emptySnapshot();
  for (const [area, id] of Object.entries({ 'vendor-card': 'vendor-card:kuaishou', 'vendor-level1': 'vendor-level1:kuaishou', 'vendor-level2': 'vendor-level2:kuaishou:models', 'tool-level3': 'tool-level3:kling-2-6-pro', 'tool-card': 'tool-card:kling-2-6-pro' })) snapshot[area].push({ id, vendor_key: 'kuaishou' });
  return snapshot;
}

function healthyExistingVendorSnapshot() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({
    id: 'vendor-card:kuaishou', vendor_key: 'kuaishou', title: '可灵', icon: '🎬', summary: '已有厂商摘要。',
    feature_preview: [{ tone: 'positive', text: '已有能力。' }], access_level: '开放', price_badge: 'usage_based',
    search_terms: ['可灵'], level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:kuaishou' },
  });
  snapshot['vendor-level1'].push({
    id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou', title: '可灵', icon: '🎬', official_url: 'https://kling.ai',
    description: '已有厂商描述。', status: 'active', features: [{ tone: 'positive', text: '已有能力。' }], level2_refs: [],
  });
  return snapshot;
}
test('link-only parent patch appends the new group ref without re-synthesizing parent fields', async () => {
  const snapshot = healthyExistingVendorSnapshot();
  const plan = planCatalogResearch(seed(), snapshot);
  const research = researchFor(plan);
  const detailAdapter = adapter();
  const original = detailAdapter.synthesize;
  detailAdapter.synthesize = async input => {
    const value = await original(input);
    delete value.layer_fields.vendor;
    for (const key of Object.keys(value.provenance)) if (key.startsWith('vendor.')) delete value.provenance[key];
    return value;
  };

  const result = await synthesizeCatalog(research, plan, detailAdapter);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.coverage.missing.some(item => item.layer === 'vendor'), false);
  const parentPatch = result.layer_patches.find(patch => patch.area === 'vendor-level1');
  assert.equal(parentPatch.operation, 'replace');
  assert.deepEqual(parentPatch.record.level2_refs, [{ kind: 'vendor-level2', id: 'vendor-level2:kuaishou:models' }]);
  assert.equal(parentPatch.record.description, '已有厂商描述。');
  assert.equal(parentPatch.provenance.description.kind, 'deterministic');
});

test('orphan relation repair bypasses model synthesis when every record already exists', async () => {
  const snapshot = healthyExistingVendorSnapshot();
  snapshot['vendor-level1'][0].level2_refs = [{ kind: 'vendor-level2', id: 'vendor-level2:kuaishou:models' }];
  snapshot['vendor-level2'].push({
    id: 'vendor-level2:kuaishou:models', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:kuaishou' }, vendor_key: 'kuaishou',
    title: 'Models', official_url: 'https://kling.ai', summary: '已有模型分组。', status: 'active', detail_refs: [],
  });
  const detail = { id: 'tool-level3:kling-2-6-pro', vendor_key: 'kuaishou', detail_kind: 'api_model', theme: 'media', title: 'Kling 2.6 Pro', vendor_label: '可灵', icon: '🎬', official_url: 'https://kling.ai', status: 'active', summary: '已有模型详情。', one_m_context: { status: 'not_applicable', reason: '视频模型。' }, api_pricing: { status: 'available', rate_cards: [{ label: '生成', pricing_basis: 'generation', currency: 'CREDIT', metrics: [{ label: '生成', amount: 1, unit: 'generation' }], conditions: '官方计费。' }] }, plan: { status: 'not_applicable', reason: '不是套餐。' }, applicable_scenarios: [{ title: '视频', description: '生成视频。' }], inapplicable_scenarios: [{ title: '长视频', description: '不适合长视频。' }], sources: [{ title: '官方', url: 'https://kling.ai' }], official_date: '2025-12-03' };
  snapshot['tool-level3'].push(detail);
  snapshot['tool-card'].push({ id: 'tool-card:kling-2-6-pro', tool_key: 'kling-2-6-pro', vendor_key: 'kuaishou', title: 'Kling 2.6 Pro', vendor_label: '可灵', icon: '🎬', summary: '已有工具卡。', theme: 'media', scenes: ['视频生成'], best_for_preview: '视频生成。', not_for_preview: '不适合长视频。', price_badge: 'usage_based', access_level: '开放', search_terms: ['Kling 2.6 Pro'], detail_ref: { kind: 'tool-level3', id: detail.id }, detail_kind: 'api_model' });
  const plan = planCatalogResearch(seed({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:kuaishou:models' } } }), snapshot);
  const result = await synthesizeCatalog(researchFor(plan), plan, null);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.coverage.entries, []);
  const groupPatch = result.layer_patches.find(patch => patch.area === 'vendor-level2');
  assert.deepEqual(groupPatch.record.detail_refs, [{ kind: 'tool-level3', id: detail.id }]);
  assert.equal(groupPatch.provenance.summary.kind, 'deterministic');
});
test('every active layer becomes a complete non-default patch with source provenance', async () => {
  const plan = planCatalogResearch(seed({ repair_layers: ['vendor-card', 'vendor-level1', 'vendor-level2', 'tool-level3', 'tool-card'] }), repairedSnapshot());
  const research = researchFor(plan);
  const result = await synthesizeCatalog(research, plan, adapter());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.coverage.missing.length, 0);
  assert.equal(result.layer_patches.filter(patch => patch.operation === 'replace').length, 5);
  const detailPatch = result.layer_patches.find(patch => patch.area === 'tool-level3');
  assert.equal(detailPatch.record.plan.status, 'not_applicable');
  assert.equal(detailPatch.record.one_m_context.status, 'not_applicable');
  assert.deepEqual(detailPatch.provenance.summary.source_ids, ['source-1']);
  assert.equal(detailPatch.record.api_pricing.rate_cards[0].pricing_basis, 'generation');
});

test('missing API pricing/access coverage blocks synthesis and suggests product_variant', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const research = researchFor(plan);
  const result = await synthesizeCatalog(research, plan, adapter(['detail.access_level', 'detail.price_badge', 'detail.api_pricing']));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROFILE_MISMATCH_SUSPECTED');
  assert.equal(result.suggested_detail_kind, 'product_variant');
  assert.ok(result.missing_fields.includes('detail.api_pricing'));
});

test('non-api_model missing fields fail with SYNTHESIS_COVERAGE_INCOMPLETE without reclassifying', async () => {
  const plan = planCatalogResearch(seed({ detail_kind: 'tool', modality: 'general' }), emptySnapshot());
  const research = researchFor(plan);
  const result = await synthesizeCatalog(research, plan, adapter(['detail.official_date']));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNTHESIS_COVERAGE_INCOMPLETE');
  assert.equal(result.suggested_detail_kind, undefined);
  assert.ok(result.missing_fields.includes('detail.official_date'));
});

test('provenance referencing a nonexistent source_id is rejected', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const research = researchFor(plan);
  const bad = adapter();
  const original = bad.synthesize;
  bad.synthesize = async input => {
    const value = await original(input);
    value.provenance['detail.summary'] = ['source-nonexistent'];
    return value;
  };
  const result = await synthesizeCatalog(research, plan, bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNTHESIS_INVALID');
  assert.ok(result.errors.some(error => error.path === 'detail.summary'));
});

test('model-reported missing cannot fake away a real field gap', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const research = researchFor(plan);
  const lying = adapter(['detail.official_date']);
  const original = lying.synthesize;
  lying.synthesize = async input => {
    const value = await original(input);
    value.missing = [];
    return value;
  };
  const result = await synthesizeCatalog(research, plan, lying);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNTHESIS_COVERAGE_INCOMPLETE');
  assert.ok(result.missing_fields.includes('detail.official_date'));
});

test('partial official date is treated as missing before planning', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const research = researchFor(plan);
  const bad = adapter();
  const original = bad.synthesize;
  bad.synthesize = async input => {
    const value = await original(input);
    value.layer_fields.detail.official_date = 'July 8';
    return value;
  };
  const result = await synthesizeCatalog(research, plan, bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNTHESIS_COVERAGE_INCOMPLETE');
  assert.ok(result.missing_fields.includes('detail.official_date'));
});
test('placeholder field values are treated as missing by field coverage', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const research = researchFor(plan);
  const bad = adapter();
  const original = bad.synthesize;
  bad.synthesize = async input => {
    const value = await original(input);
    value.layer_fields.vendor.vendor_summary = 'unknown';
    return value;
  };
  const result = await synthesizeCatalog(research, plan, bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNTHESIS_COVERAGE_INCOMPLETE');
  assert.ok(result.missing_fields.includes('vendor.vendor_summary'));
});

test('existing vendor layers remain unchanged when their group ref already exists', async () => {
  const snapshot = healthyExistingVendorSnapshot();
  snapshot['vendor-level1'][0].level2_refs = [{ kind: 'vendor-level2', id: 'vendor-level2:kuaishou:models' }];
  snapshot['vendor-level2'].push({
    id: 'vendor-level2:kuaishou:models', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:kuaishou' }, vendor_key: 'kuaishou',
    title: 'Models', official_url: 'https://kling.ai', summary: '已有模型分组。', status: 'active', detail_refs: [],
  });
  const plan = planCatalogResearch(seed({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:kuaishou:models' } } }), snapshot);
  const research = researchFor(plan);
  const detailAdapter = adapter();
  const original = detailAdapter.synthesize;
  detailAdapter.synthesize = async input => {
    const value = await original(input);
    delete value.layer_fields.vendor;
    delete value.layer_fields.group;
    for (const key of Object.keys(value.provenance)) if (key.startsWith('vendor.') || key.startsWith('group.')) delete value.provenance[key];
    return value;
  };
  const result = await synthesizeCatalog(research, plan, detailAdapter);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.layer_patches.find(patch => patch.area === 'vendor-card').operation, 'noop');
  assert.equal(result.layer_patches.find(patch => patch.area === 'vendor-level1').operation, 'noop');
  const groupPatch = result.layer_patches.find(patch => patch.area === 'vendor-level2');
  assert.equal(groupPatch.operation, 'replace');
  assert.equal(groupPatch.provenance.summary.kind, 'deterministic');
});

test('normalizeFeaturePreview splits overlong merged entries but keeps short items intact', () => {
  const longPositive = '视听同步生成：语音节奏、环境音与画面动作紧密对齐，消除视觉与音频分离感。音频质量：支持语音、音效、环境音等多种类型，音质更清晰、层次更丰富。语义理解：对文本描述、口语和复杂剧情有较强的语义理解。增强创作效率：同时生成画面、语音和音效，显著提升创作效率。';
  const normalized = normalizeFeaturePreview([
    { tone: 'positive', text: longPositive },
    { tone: 'negative', text: '有官方时长限制。' },
  ]);
  assert.ok(normalized.length > 2, '超长合并项应拆成多个 feature');
  assert.equal(normalized[0].tone, 'positive');
  assert.equal(normalized.find(item => item.tone === 'negative').text, '有官方时长限制。');
  assert.ok(normalized.every(item => item.text.length <= 60), '拆分后每项应是短句');
  assert.equal(normalizeFeaturePreview(undefined), undefined);
  assert.equal(normalizeFeaturePreview([]).length, 0);
  assert.equal(normalizeFeaturePreview([{ tone: 'positive', text: '无分隔'.repeat(40) }]).length, 1);
});
