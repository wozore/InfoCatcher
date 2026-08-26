'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const comparisonValidation = require('../../src/maintenance/validate-comparison');

function validIndex(models) {
  return {
    schema_version: 2,
    model_count: models.length,
    sources: {
      openrouter: { count: 0 },
      lmarena: { count: 0 },
      livebench: { count: 0 },
      llm_stats: { count: 0 },
    },
    models,
  };
}

function model(canonical, identity, display) {
  return {
    canonical,
    identity,
    family: identity.split('-').slice(0, 2).join('-'),
    revisions: [],
    evaluation_profiles: [],
    offerings: {},
    display,
    vendor: canonical.split('--')[0],
    theme: 'general',
    has_composite: false,
    composite_score: null,
    degrees: {},
    sources: [],
    file: 'data.json',
  };
}

test('comparison 校验：v2 模型身份与同厂商可见名称唯一', () => {
  comparisonValidation.resetComparisonValidationForTests();
  comparisonValidation.validateIndex(validIndex([
    model('qwen--qwen3-8b', 'qwen3-8b', 'Qwen3 8B'),
    model('qwen--qwen3-32b', 'qwen3-32b', 'Qwen3 32B'),
  ]));
  assert.equal(comparisonValidation.failed, false);

  comparisonValidation.resetComparisonValidationForTests();
  comparisonValidation.validateIndex(validIndex([
    model('qwen--qwen3-8b', 'qwen3-8b', 'Qwen3'),
    model('qwen--qwen3-32b', 'qwen3-32b', 'Qwen3'),
  ]));
  assert.equal(comparisonValidation.failed, true);
});

test('comparison 校验：v2 alias 不允许一个源名称映射多个模型', () => {
  comparisonValidation.resetComparisonValidationForTests();
  comparisonValidation.validateModelsAlias({
    schema_version: 2,
    vendor_aliases: { qwen: ['qwen'] },
    entries: [
      { model_key: 'qwen--qwen3-8b', aliases: { openrouter: ['qwen/qwen3'] } },
      { model_key: 'qwen--qwen3-32b', aliases: { openrouter: ['qwen/qwen3'] } },
    ],
    never_merge: [],
  });
  assert.equal(comparisonValidation.failed, true);
});

test('comparison 校验：评测环境不能被写入 degree', () => {
  comparisonValidation.resetComparisonValidationForTests();
  const record = model('openai--gpt-5.5', 'gpt-5.5', 'GPT-5.5');
  record.degrees = { lmarena: ['codex-harness'] };
  comparisonValidation.validateIndex(validIndex([record]));
  assert.equal(comparisonValidation.failed, true);
});

test('comparison 校验：系列投影引用现有 canonical 且成员不能为空', () => {
  comparisonValidation.resetComparisonValidationForTests();
  const record = model('openai--gpt-5.5', 'gpt-5.5', 'GPT-5.5');
  Object.assign(record, {
    series_key: 'openai--gpt-5.5',
    series_display: 'GPT-5.5',
    member_key: 'openai--gpt-5.5',
    member_display: '基础版',
    member_order: 0,
    member_variant_count: 1,
  });
  const index = validIndex([record]);
  index.series_count = 1;
  index.series = [{
    series_key: 'openai--gpt-5.5',
    display: 'GPT-5.5',
    vendor: 'openai',
    members: [{
      member_key: 'openai--gpt-5.5',
      display: '基础版',
      default_canonical: 'openai--gpt-5.5',
      variant_count: 1,
      theme: 'general',
      variants: [{ canonical: 'openai--gpt-5.5', revision: null }],
    }],
  }];
  comparisonValidation.validateIndex(index);
  assert.equal(comparisonValidation.failed, false);

  comparisonValidation.resetComparisonValidationForTests();
  index.series[0].members[0].default_canonical = 'openai--missing';
  comparisonValidation.validateIndex(index);
  assert.equal(comparisonValidation.failed, true);
});
