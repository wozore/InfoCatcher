'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { attachSeriesMetadata, validateSeriesProjection } = require('../../src/comparison/model-series');

function model(canonical, identity, family, vendor, composite = null, revisions = []) {
  return {
    canonical,
    identity,
    family,
    vendor,
    theme: 'general',
    revisions,
    composite: composite == null ? null : { score: composite },
    source_names: { openrouter: [canonical] },
  };
}

test('model series：系列包含具体成员，revision 收拢为成员变体', () => {
  const models = [
    model('openai--gpt-5.5', 'gpt-5.5', 'gpt-5.5', 'openai', 80),
    model('openai--gpt-5.5-pro', 'gpt-5.5-pro', 'gpt-5.5', 'openai', 82),
    model('deepseek--deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4', 'deepseek', 70),
    model('deepseek--deepseek-v4-flash@0731', 'deepseek-v4-flash', 'deepseek-v4', 'deepseek', 75, ['0731']),
  ];
  const { series } = attachSeriesMetadata(models, {
    schema_version: 1,
    series: [
      {
        series_key: 'openai--gpt-5.5',
        display: 'GPT-5.5',
        vendor: 'openai',
        match: { vendor: 'openai', identity_prefix: 'gpt-5.5' },
        member_rules: [
          { identity: 'gpt-5.5', display: '基础版', order: 0 },
          { identity_prefix: 'gpt-5.5-pro', display: 'Pro', order: 10 },
        ],
      },
      {
        series_key: 'deepseek--deepseek-v4',
        display: 'DeepSeek V4',
        vendor: 'deepseek',
        match: { vendor: 'deepseek', identity_prefix: 'deepseek-v4' },
        member_rules: [{ identity_prefix: 'deepseek-v4-flash', display: 'Flash', order: 0 }],
      },
    ],
  });
  const gpt = series.find(item => item.series_key === 'openai--gpt-5.5');
  const flash = series.find(item => item.series_key === 'deepseek--deepseek-v4').members[0];
  assert.equal(gpt.member_count, 2);
  assert.equal(gpt.members[0].display, '基础版');
  assert.equal(gpt.members[1].display, 'Pro');
  assert.equal(flash.variant_count, 2);
  assert.equal(flash.default_canonical, 'deepseek--deepseek-v4-flash');
  assert.equal(validateSeriesProjection(series, models).length, 0);
  assert.equal(models[3].member_key, 'deepseek--deepseek-v4-flash');
});

test('model series：重叠登记按配置顺序确定唯一系列', () => {
  const models = [model('openai--gpt-5.5', 'gpt-5.5', 'gpt-5.5', 'openai')];
  const result = attachSeriesMetadata(models, {
    series: [
      { series_key: 'a', display: 'A', match: { vendor: 'openai', identity_prefix: 'gpt-5.5' } },
      { series_key: 'b', display: 'B', match: { vendor: 'openai', identity_prefix: 'gpt-5.5' } },
    ],
  });
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].series_key, 'a');
  assert.equal(validateSeriesProjection(result.series, models).length, 0);
});
