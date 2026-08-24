'use strict';

const { requestStructuredJson } = require('./deepseek-structured');
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
  if (!expectedDetailFields.includes('official_date')) return output;
  const note = String(input.plan?.seed?.repair_note || '');
  const target = note.match(/(?:official_date|发布日期)[^0-9]*(20\d{2}-\d{2}-\d{2})/)?.[1];
  if (!target) return output;
  const source = (input.research.official_sources || []).find(item => item.source_role === 'seed_official_hint'
    && isoDateFromText(item.content || item.excerpt) === target);
  if (!source) return output;
  return {
    ...output,
    layer_fields: {
      ...output.layer_fields,
      detail: { ...output.layer_fields?.detail, official_date: target },
    },
    provenance: {
      ...output.provenance,
      'detail.official_date': [source.source_id],
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
  return { ok: true, ...applyRepairEvidence(input, result.value), usage: result.usage };
}

module.exports = {
  synthesizeLayerFields,
};
