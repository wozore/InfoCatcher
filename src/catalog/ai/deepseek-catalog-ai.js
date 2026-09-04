'use strict';

const { requestStructuredJson } = require('../../shared/llm-gateway');
const { buildSynthesisInput, buildSynthesisInstructions } = require('./catalog-synthesis-prompt');

const MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

function isoDateFromText(text) {
  const value = String(text || '');
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const english = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/i);
  if (!english) return null;
  return `${english[3]}-${String(MONTHS[english[1].toLowerCase()]).padStart(2, '0')}-${String(english[2]).padStart(2, '0')}`;
}

function applyRepairEvidence(input, output) {
  const expectedDetailFields = input.expected_layer_fields?.detail || [];
  const dateField = ['release_date', 'last_updated_date'].find(field => expectedDetailFields.includes(field));
  if (!dateField) return output;
  const note = String(input.plan?.seed?.repair_note || '');
  const target = note.match(/(?:release_date|last_updated_date|发布日期|更新日期|更新时间)[^0-9]*(20\d{2}-\d{2}-\d{2})/)?.[1];
  if (!target) return output;
  const source = (input.research.official_sources || []).find(item => item.source_role === 'seed_official_hint'
    && isoDateFromText(item.content || item.excerpt) === target);
  if (!source) return output;
  return {
    ...output,
    layer_fields: {
      ...output.layer_fields,
      detail: { ...output.layer_fields?.detail, [dateField]: target },
    },
    provenance: {
      ...output.provenance,
      [`detail.${dateField}`]: [source.source_id],
    },
  };
}

/** 从共享 release_date 索引机械补填（AI 未给出 release_date 时的兜底；tool 走 last_updated_date 不填）。 */
function applyIntegratedReleaseDate(input, output) {
  const hint = input.plan?.seed?.known_fields?.integrated_release_date;
  if (!hint || !/^\d{4}-\d{2}-\d{2}$/.test(hint)) return output;
  if (input.plan?.profile?.detail_kind === 'tool') return output;
  const detail = output.layer_fields?.detail || {};
  if (detail.release_date) return output; // AI 已有值 → 不覆盖
  return {
    ...output,
    layer_fields: { ...output.layer_fields, detail: { ...detail, release_date: hint } },
    provenance: {
      ...output.provenance,
      'detail.release_date': [{ kind: 'deterministic', basis: 'comparison_integrated', source_ids: [] }],
    },
  };
}

async function synthesizeLayerFields(input, options = {}) {
  if (!input.ledger?.reserve) return { ok: false, code: 'COST_LEDGER_REQUIRED', error: '目录合成缺少成本账本' };
  const synthesisReserved = input.ledger.reserve('synthesis_calls', 1);
  if (!synthesisReserved.ok) return { ok: false, code: synthesisReserved.code, error: '目录合成次数预算不足' };
  const result = await requestStructuredJson({
    kind: 'synthesis',
    instructions: buildSynthesisInstructions(input.plan),
    input: JSON.stringify(buildSynthesisInput(input)),
    maxOutputTokens: options.maxOutputTokens || 12000,
    ledger: input.ledger,
    validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.layer_fields),
  }, options);
  if (!result.ok) return result;
  return { ok: true, ...applyIntegratedReleaseDate(input, applyRepairEvidence(input, result.value)), usage: result.usage };
}

module.exports = {
  synthesizeLayerFields,
  applyIntegratedReleaseDate,
  applyRepairEvidence,
};
