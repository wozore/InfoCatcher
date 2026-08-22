'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExclusionConfig, exclusionForModel, filterExcludedRecords } = require('../../src/comparison/model-exclusions');

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
