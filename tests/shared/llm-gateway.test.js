'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestStructuredJson,
  requestLlmText,
  resolveTransportRoute,
  extractJsonValues,
  diagnosticsOf,
  toChatCompletionsPayload,
  toMessagesPayload,
  toExternalChatPayload,
} = require('../../src/shared/llm-gateway');
const { AI_PROTOCOLS, getProvider } = require('../../src/shared/ai-provider-registry');
const {
  requestResponses,
  requestChatCompletions,
  requestMessages,
} = require('../../src/shared/deepseek-client');

function okJsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

// ── 1. resolveTransportRoute 协议分流测试 ────────────────────────

test('resolveTransportRoute: MESSAGES 协议 (zhipu) 路由至 requestMessages', async () => {
  const payload = {
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
  };
  const route = await resolveTransportRoute(payload, { provider: 'zhipu' });
  assert.equal(route.ok, true);
  assert.equal(route.isLocal, false);
  assert.equal(route.protocol, AI_PROTOCOLS.MESSAGES);
  assert.equal(route.transport, requestMessages);
  assert.equal(route.options.endpoint, getProvider('zhipu').messagesEndpoint);
  assert.equal(route.payload.model, 'glm-5.3-flash');
  assert.equal(route.payload.system, '你是助手');
  assert.deepEqual(route.payload.messages, [{ role: 'user', content: '你好' }]);
  assert.deepEqual(route.payload.thinking, { type: 'disabled' });
});

test('resolveTransportRoute: RESPONSES 协议 (deepseek 结构化) 路由至 requestResponses', async () => {
  const payload = {
    instructions: '只输出 JSON',
    input: { hello: 'world' },
  };
  const route = await resolveTransportRoute(payload, { provider: 'deepseek' });
  assert.equal(route.ok, true);
  assert.equal(route.isLocal, false);
  assert.equal(route.protocol, AI_PROTOCOLS.RESPONSES);
  assert.equal(route.transport, requestResponses);
  assert.equal(route.options.endpoint, getProvider('deepseek').responsesEndpoint);
  assert.equal(route.payload.instructions, '只输出 JSON');
  assert.deepEqual(route.payload.input, { hello: 'world' });
});

test('resolveTransportRoute: RESPONSES 协议 (deepseek 带 messages) 历史兼容走 chatEndpoint', async () => {
  const payload = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
  };
  const route = await resolveTransportRoute(payload, { provider: 'deepseek' });
  assert.equal(route.ok, true);
  assert.equal(route.transport, requestResponses);
  assert.equal(route.options.endpoint, getProvider('deepseek').chatEndpoint);
  assert.equal(route.payload.messages.length, 2);
});

test('resolveTransportRoute: CHAT 协议 (外部 OpenAI 兼容) 路由至 requestChatCompletions 并清除 chat_template_kwargs', async () => {
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    chat_template_kwargs: { enable_thinking: false },
  };
  // 显式配置 CHAT 协议（如 OpenAI 兼容 chat/completions 端点）
  const route = await resolveTransportRoute(payload, {
    protocol: AI_PROTOCOLS.CHAT,
    endpoint: 'https://api.openai.com/v1/chat/completions',
  });
  assert.equal(route.ok, true);
  assert.equal(route.isLocal, false);
  assert.equal(route.protocol, AI_PROTOCOLS.CHAT);
  assert.equal(route.transport, requestChatCompletions);
  assert.equal(route.payload.chat_template_kwargs, undefined);
});

test('requestChatCompletions: 放行 options 显式指定的 CHAT 协议与 endpoint', async () => {
  const fetchImpl = async () => okJsonResponse({
    choices: [{ message: { content: 'chat resp' } }],
  });
  // provider 是 zhipu (默认 protocol 是 MESSAGES)，但通过 options 显式指定 CHAT 协议与 endpoint
  const res = await requestChatCompletions({ messages: [] }, {
    provider: 'zhipu',
    protocol: AI_PROTOCOLS.CHAT,
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: 'test-key',
    fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.choices[0].message.content, 'chat resp');
});

test('resolveTransportRoute: local provider 自动识别、调用 ensureLocalModel 并带 chat_template_kwargs', async () => {
  const payload = {
    messages: [{ role: 'user', content: 'ping' }],
  };
  const route = await resolveTransportRoute(payload, {
    provider: 'local',
    fetchImpl: async () => okJsonResponse({}),
  });
  assert.equal(route.ok, true);
  assert.equal(route.isLocal, true);
  assert.equal(route.protocol, AI_PROTOCOLS.CHAT);
  assert.equal(route.transport, requestChatCompletions);
  assert.equal(route.payload.model, 'bonsai');
  assert.equal(route.options.endpoint, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.deepEqual(route.payload.chat_template_kwargs, { enable_thinking: false });
});

test('resolveTransportRoute: localhost endpoint 自动识别为 local 路由', async () => {
  const payload = {
    messages: [{ role: 'user', content: 'ping' }],
  };
  const route = await resolveTransportRoute(payload, {
    endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    fetchImpl: async () => okJsonResponse({}),
  });
  assert.equal(route.ok, true);
  assert.equal(route.isLocal, true);
  assert.equal(route.options.provider, 'local');
  assert.deepEqual(route.payload.chat_template_kwargs, { enable_thinking: false });
});

test('resolveTransportRoute: 未知 provider fail-closed', async () => {
  const route = await resolveTransportRoute({}, { provider: 'unknown_provider' });
  assert.equal(route.ok, false);
  assert.equal(route.code, 'AI_PROVIDER_UNSUPPORTED');
});

// ── 2. requestLlmText 跨协议文本提取测试 ────────────────────────

test('requestLlmText: MESSAGES 协议成功提取文本与 usage', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return okJsonResponse({
      content: [{ type: 'text', text: '智谱返回的内容' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };

  const result = await requestLlmText(
    { messages: [{ role: 'user', content: 'hello' }] },
    { provider: 'zhipu', apiKey: 'test-key', fetchImpl }
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, '智谱返回的内容');
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(calls[0].url, getProvider('zhipu').messagesEndpoint);
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
});

test('requestLlmText: RESPONSES 协议成功提取 output_text', async () => {
  const fetchImpl = async () => okJsonResponse({
    output_text: 'DeepSeek 输出文本',
    usage: { total_tokens: 20 },
  });

  const result = await requestLlmText(
    { instructions: 'sys', input: { query: 'q' } },
    { provider: 'deepseek', apiKey: 'test-key', fetchImpl }
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, 'DeepSeek 输出文本');
  assert.equal(result.usage.total_tokens, 20);
});

test('requestLlmText: CHAT / local 协议成功提取 choices[0].message.content', async () => {
  const fetchImpl = async () => okJsonResponse({
    choices: [{ message: { content: '本地模型回答' } }],
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  });

  const result = await requestLlmText(
    { messages: [{ role: 'user', content: 'ping' }] },
    { provider: 'local', apiKey: 'local-bonsai', fetchImpl }
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, '本地模型回答');
});

test('requestLlmText: 支持字符串入参自适应转 user message', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return okJsonResponse({ choices: [{ message: { content: 'pong' } }] });
  };

  const result = await requestLlmText('纯字符串 prompt', {
    provider: 'local',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(bodies[0].messages[0].content, '纯字符串 prompt');
  assert.equal(bodies[0].messages[0].role, 'user');
});

test('requestLlmText: 传输层错误透传 fail-closed', async () => {
  // 缺 key
  const noKey = await requestLlmText({ messages: [] }, { provider: 'zhipu', apiKey: '' });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'ZHIPU_AUTH_REQUIRED');

  // HTTP 500
  const fetch500 = async () => ({
    ok: false,
    status: 500,
    async text() { return 'Internal Server Error'; },
  });
  const httpErr = await requestLlmText({ messages: [] }, { provider: 'zhipu', apiKey: 'key', fetchImpl: fetch500 });
  assert.equal(httpErr.ok, false);
  assert.equal(httpErr.status, 500);

  // 网络抛错
  const fetchNet = async () => { throw new Error('ECONNRESET'); };
  const netErr = await requestLlmText({ messages: [] }, { provider: 'zhipu', apiKey: 'key', fetchImpl: fetchNet });
  assert.equal(netErr.ok, false);
  assert.equal(netErr.code, 'ZHIPU_NETWORK_ERROR');
});

// ── 3. requestStructuredJson 网关全覆盖 ─────────────────────────

test('requestStructuredJson: 缺少 ledger 严格 fail-closed', async () => {
  const result = await requestStructuredJson({
    kind: 'test',
    instructions: 'sys',
    input: 'usr',
    validate: () => true,
  }, { apiKey: 'key' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_LEDGER_REQUIRED');
});

test('requestStructuredJson: 本地 Bonsai 走 CHAT 协议与 local transport', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return okJsonResponse({
      choices: [{ message: { content: '{"result":"ok"}' }, finish_reason: 'stop' }],
    });
  };

  const ledger = { reserve: () => ({ ok: true }) };
  const result = await requestStructuredJson({
    kind: 'synthesis',
    instructions: '结构化指令',
    input: { key: 'val' },
    maxOutputTokens: 200,
    ledger,
    validate: val => val && val.result === 'ok',
  }, {
    provider: 'local',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { result: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(calls[0].body.model, 'bonsai');
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
});

test('requestStructuredJson: RESPONSES 协议默认模型兜底与 JSON 校验', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return okJsonResponse({
      output_text: '{"status":"ok"}',
    });
  };

  const ledger = { reserve: () => ({ ok: true }) };
  const result = await requestStructuredJson({
    kind: 'synthesis',
    instructions: '结构化指令',
    input: { key: 'val' },
    ledger,
    validate: val => val && val.status === 'ok',
  }, {
    provider: 'deepseek',
    apiKey: 'test-key',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { status: 'ok' });
  assert.equal(calls[0].body.model, getProvider('deepseek').defaultModel);
  assert.deepEqual(calls[0].body.text, { format: { type: 'json_object' } });
});

test('adaptPayloadForChat: 通用文本转换不应强制注入 response_format: json_object', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return okJsonResponse({
      choices: [{ message: { content: '普通文本回复' } }],
    });
  };

  const result = await requestLlmText({
    instructions: '你是一个助手',
    input: '请用普通文本回答',
  }, {
    protocol: AI_PROTOCOLS.CHAT,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'test-key',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, '普通文本回复');
  assert.equal(calls[0].body.response_format, undefined);
});

test('requestStructuredJson: 辅助工具函数向后兼容性', () => {
  assert.deepEqual(extractJsonValues('前置文字{"a":1}后置文字'), [{ a: 1 }]);
  assert.equal(diagnosticsOf({ status: 'completed' }, 'preview').response_status, 'completed');
  assert.equal(toChatCompletionsPayload({ model: 'm', instructions: 'i', input: 'in', maxOutputTokens: 50 }).max_tokens, 50);
  assert.equal(toMessagesPayload({ model: 'm', instructions: 'i', input: 'in', maxOutputTokens: 50 }).system, 'i');
  assert.equal(toExternalChatPayload({ model: 'm', instructions: 'i', input: 'in', maxOutputTokens: 50 }).response_format, undefined);
  assert.deepEqual(toExternalChatPayload({ model: 'm', instructions: 'i', input: 'in', maxOutputTokens: 50, responseFormat: { type: 'json_object' } }).response_format, { type: 'json_object' });
});
