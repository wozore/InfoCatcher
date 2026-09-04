'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExclusionConfig, exclusionForModel, filterExcludedRecords } = require('../../src/comparison/identity/model-exclusions');

const config = {
  schema_version: 1,
  rules: [
    { vendor: 'openai', identity_prefix: 'gpt-5.2', reason: 'old' },
    { vendor: 'deepseek', identities: ['deepseek-chat', 'deepseek-reasoner'], reason: 'legacy alias' },
  ],
};

test('model exclusions use token-boundary identity prefixes', () => {
  assert.equal(validateExclusionConfig(config).ok, true);
  assert.ok(exclusionForModel({ vendor: 'openai', identity: 'gpt-5.2-codex', canonical: 'openai--gpt-5.2-codex' }, config));
  assert.equal(exclusionForModel({ vendor: 'openai', identity: 'gpt-5.20', canonical: 'openai--gpt-5.20' }, config), null);
  assert.ok(exclusionForModel({ vendor: 'deepseek', identity: 'deepseek-chat', canonical: 'deepseek--deepseek-chat' }, config));
});

test('model exclusions filter records and preserve diagnostics', () => {
  const result = filterExcludedRecords({
    a: { vendor: 'openai', identity: 'gpt-5.2', canonical: 'openai--gpt-5.2' },
    b: { vendor: 'openai', identity: 'gpt-5.6', canonical: 'openai--gpt-5.6' },
  }, config);
  assert.deepEqual(Object.keys(result.records), ['b']);
  assert.deepEqual(result.excluded.map(item => item.canonical), ['openai--gpt-5.2']);
  assert.equal(result.excluded[0].reason, 'old');
});

test('invalid exclusion rules fail closed', () => {
  const result = validateExclusionConfig({ schema_version: 1, rules: [{ vendor: 'openai', identity_prefix: 'gpt 5.2', identities: ['x'], reason: '' }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test('model exclusions support identity_prefixes array with token boundary', () => {
  const cfg = { schema_version: 1, rules: [{ vendor: 'tencent', identity_prefixes: ['hunyuan-hy3', 'hy3'], reason: 'no data' }] };
  assert.equal(validateExclusionConfig(cfg).ok, true);
  assert.ok(exclusionForModel({ vendor: 'tencent', identity: 'hy3', canonical: 'tencent--hy3' }, cfg));
  assert.ok(exclusionForModel({ vendor: 'tencent', identity: 'hy3-preview', canonical: 'tencent--hy3-preview' }, cfg));
  assert.ok(exclusionForModel({ vendor: 'tencent', identity: 'hunyuan-hy3-preview', canonical: 'tencent--hunyuan-hy3-preview' }, cfg));
  assert.equal(exclusionForModel({ vendor: 'tencent', identity: 'hy-mt2-7b', canonical: 'tencent--hy-mt2-7b' }, cfg), null);
  assert.equal(exclusionForModel({ vendor: 'qwen', identity: 'hy3', canonical: 'qwen--hy3' }, cfg), null);
});
