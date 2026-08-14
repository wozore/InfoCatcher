'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_PROTOCOLS,
  getProvider,
  resolveProvider,
  apiKeyForProvider,
} = require('../../src/shared/ai-provider-registry');
const { requestResponses } = require('../../src/shared/deepseek-client');

test('provider registry maps each provider to its protocol and key env', () => {
  assert.equal(getProvider('deepseek').protocol, AI_PROTOCOLS.RESPONSES);
  assert.equal(getProvider('deepseek').apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(getProvider('openai').apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(getProvider('anthropic').protocol, AI_PROTOCOLS.MESSAGES);
  assert.equal(apiKeyForProvider(getProvider('openai'), 'explicit-key'), 'explicit-key');
  assert.equal(resolveProvider('missing').code, 'AI_PROVIDER_UNSUPPORTED');
});

test('Messages provider fails closed in Responses transport', async () => {
  const result = await requestResponses({}, {
    provider: 'anthropic',
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('must not call fetch'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_PROTOCOL_UNSUPPORTED');
});
