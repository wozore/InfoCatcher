'use strict';

const OFFICIAL_URL = 'https://kling.ai/official-dossier';
const EXACT_QUOTE = 'Kling official dossier facts.';

function klingVideoSeed(overrides = {}) {
  return {
    detail_kind: 'api_model',
    modality: 'video',
    repair_layers: ['vendor-card', 'vendor-level1', 'vendor-level2', 'tool-level3', 'tool-card'],
    name: 'Kling 2.6 Pro',
    vendor_name: '可灵',
    vendor_key: 'kling',
    tool_key: 'kling-2-6-pro',
    official_url: OFFICIAL_URL,
    placement: {
      existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:kling' },
      existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:kling:models' },
      new_group_title: 'Models',
    },
    known_fields: { theme: 'media' },
    discovery_sources: [{ url: OFFICIAL_URL, kind: 'official_hint' }],
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
      features: [
        { tone: 'positive', text: '支持音画同步生成。' },
        { tone: 'negative', text: '视频时长受官方规格限制。' },
      ],
    },
    group: {
      group_summary: '可灵官方视频模型系列。',
      group_official_url: 'https://kling.ai',
      group_status: 'active',
    },
    detail: {
      summary: '面向短视频创作的音画同步生成模型。',
      official_url: OFFICIAL_URL,
      detail_status: 'active',
      access_level: '开放',
      price_badge: 'usage_based',
      scenes: ['短视频生成', '多角色对话'],
      best_for_preview: '适合需要音画同步的短视频。',
      not_for_preview: '不适合超过官方时长上限的长视频。',
      api_pricing: {
        status: 'available',
        rate_cards: [{
          label: '视频生成',
          pricing_basis: 'generation',
          currency: 'CREDIT',
          metrics: [{ label: '标准生成', amount: 1, unit: 'generation' }],
          conditions: '以官方 API 计费说明为准。',
        }],
      },
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

function reserve(ledger, category) {
  const result = ledger?.reserve ? ledger.reserve(category, 1) : { ok: true };
  return result.ok ? null : { ok: false, code: result.code, error: `${category} budget exhausted` };
}

function createKlingDossierAdapters(options = {}) {
  const missingFields = options.missingFields || [];
  const requested = [];
  return {
    requested,
    discover: async input => {
      requested.push({ scope: input.scope.kind, predicates: [...input.missing_predicates] });
      return { sources: [{ url: OFFICIAL_URL, title: 'Kling official dossier', excerpt: EXACT_QUOTE }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: EXACT_QUOTE })) }),
    synthesize: async input => {
      const synthesisFailure = reserve(input.ledger, 'synthesis_calls');
      if (synthesisFailure) return synthesisFailure;
      const responseFailure = reserve(input.ledger, 'responses_calls');
      if (responseFailure) return responseFailure;
      const sourceId = input.research.official_sources?.[0]?.source_id;
      if (!sourceId) return { ok: false, code: 'RESEARCH_SOURCE_MISSING', error: '缺少官方来源' };
      const layerFields = layerFieldsFor();
      const provenance = provenanceFor(sourceId);
      const missing = [];
      for (const layer of Object.keys(layerFields)) {
        if (!input.expected_layer_fields?.[layer]) {
          delete layerFields[layer];
          for (const key of Object.keys(provenance)) if (key.startsWith(`${layer}.`)) delete provenance[key];
        }
      }
      for (const field of missingFields) {
        const [layer, name] = field.split('.');
        if (layerFields[layer]?.[name] !== undefined) delete layerFields[layer][name];
        delete provenance[field];
        missing.push(field);
      }
      return { ok: true, layer_fields: layerFields, provenance, missing };
    },
  };
}

module.exports = {
  OFFICIAL_URL,
  EXACT_QUOTE,
  klingVideoSeed,
  createKlingDossierAdapters,
};
