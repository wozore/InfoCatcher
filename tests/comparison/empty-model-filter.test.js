'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hasComparisonData, filterEmptyModels } = require('../../src/comparison/empty-model-filter');

function model(vendor, identity, canonical, dims = [], compositeScore = null) {
  const dimensions = {};
  dims.forEach(dim => { dimensions[dim] = { value: 42, source: 'llm_stats' }; });
  return {
    canonical,
    vendor,
    identity,
    dimensions,
    composite: compositeScore == null ? null : { score: compositeScore },
  };
}

test('空壳过滤：有维度或综合分的模型保留，无数据的移除', () => {
  const models = [
    model('openai', 'gpt-5.6-sol', 'openai--gpt-5.6-sol', ['reasoning'], null),
    model('openai', 'gpt-chat', 'openai--gpt-chat', [], null),
    model('deepseek', 'deepseek-v4', 'deepseek--deepseek-v4', [], 85.8),
  ];
  assert.equal(hasComparisonData(models[0]), true);
  assert.equal(hasComparisonData(models[1]), false);
  assert.equal(hasComparisonData(models[2]), true);
  const { kept, filtered } = filterEmptyModels(models);
  assert.deepEqual(kept.map(m => m.canonical), ['openai--gpt-5.6-sol', 'deepseek--deepseek-v4']);
  assert.deepEqual(filtered.map(m => m.canonical), ['openai--gpt-chat']);
});

test('空壳过滤：同一 identity 任一 revision 有数据则整组保留（不误杀主变体）', () => {
  const models = [
    model('mistral', 'mistral-large', 'mistral--mistral-large', ['reasoning'], 36.6),
    model('mistral', 'mistral-large', 'mistral--mistral-large@2512', [], null),
  ];
  const { kept, filtered } = filterEmptyModels(models);
  assert.equal(kept.length, 2);
  assert.equal(filtered.length, 0);
});

test('空壳过滤：identity 全空则所有 revision 一并移除', () => {
  const models = [
    model('openai', 'gpt', 'openai--gpt', [], null),
    model('openai', 'gpt', 'openai--gpt@2026-01-01', [], null),
  ];
  const { kept, filtered } = filterEmptyModels(models);
  assert.equal(kept.length, 0);
  assert.equal(filtered.length, 2);
});
