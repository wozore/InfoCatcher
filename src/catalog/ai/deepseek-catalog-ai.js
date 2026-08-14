'use strict';

const { requestStructuredJson } = require('./deepseek-structured');
const { buildSynthesisInput, buildSynthesisInstructions } = require('./catalog-synthesis-prompt');

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
  return { ok: true, ...result.value, usage: result.usage };
}

module.exports = {
  synthesizeLayerFields,
};
