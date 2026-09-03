'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_PROTOCOLS,
  AI_PROVIDERS,
  DEFAULT_PROVIDER_NAME,
  getProvider,
  resolveProvider,
  apiKeyForProvider,
} = require('../../src/shared/ai-provider-registry');
const { requestResponses, requestChatCompletions, requestMessages } = require('../../src/shared/deepseek-client');

test('provider registry maps each provider to its protocol and key env', () => {
  assert.equal(getProvider('deepseek').protocol, AI_PROTOCOLS.RESPONSES);
  assert.equal(getProvider('deepseek').apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(getProvider('openai').apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(getProvider('anthropic').protocol, AI_PROTOCOLS.MESSAGES);
  assert.equal(getProvider('local').protocol, AI_PROTOCOLS.CHAT);
  assert.equal(getProvider('local').apiKeyEnv, null);
  assert.equal(getProvider('local').defaultModel, 'bonsai');
  assert.equal(getProvider('local').chatEndpoint, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(apiKeyForProvider(getProvider('local')), 'local');
  assert.equal(apiKeyForProvider(getProvider('local'), 'custom-key'), 'custom-key');
  assert.equal(apiKeyForProvider(getProvider('local'), ''), 'local');
  assert.equal(apiKeyForProvider(getProvider('openai'), 'explicit-key'), 'explicit-key');
  assert.equal(resolveProvider('missing').code, 'AI_PROVIDER_UNSUPPORTED');
});

test('zhipu provider 是 MESSAGES 协议（Anthropic 端点适配 Lite 套餐）且为全局默认开关', () => {
  assert.equal(DEFAULT_PROVIDER_NAME, 'zhipu');
  assert.equal(resolveProvider().provider.name, 'zhipu');
  assert.equal(getProvider('zhipu').protocol, AI_PROTOCOLS.MESSAGES);
  assert.equal(getProvider('zhipu').apiKeyEnv, 'ZHIPU_API_KEY');
  assert.equal(getProvider('zhipu').defaultModel, 'glm-5.3-flash');
  assert.match(getProvider('zhipu').messagesEndpoint, /^https:\/\/open\.bigmodel\.cn\/api\/anthropic/);
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

test('Responses provider fails closed in Messages transport', async () => {
  const result = await requestMessages({}, {
    provider: 'deepseek',
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('must not call fetch'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_PROTOCOL_UNSUPPORTED');
});

test('messages transport 缺 key fail-closed 且不发请求', async () => {
  const result = await requestMessages({}, {
    provider: 'zhipu',
    apiKey: '',
    fetchImpl: async () => { throw new Error('must not call fetch'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZHIPU_AUTH_REQUIRED');
});

test('messages transport POST 到 provider messages 端点并带 x-api-key', async () => {
  const calls = [];
  const result = await requestMessages({ model: 'glm-5.3-flash', messages: [] }, {
    provider: 'zhipu',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 2, output_tokens: 1 } }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.usage.output_tokens, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, AI_PROVIDERS.zhipu.messagesEndpoint);
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(calls[0].init.body).model, 'glm-5.3-flash');
});
