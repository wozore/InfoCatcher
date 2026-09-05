'use strict';

/**
 * llm-gateway.js — 统一 AI 调用网关入口
 *
 * 对外导出面（requestStructuredJson / requestLlmText / resolveTransportRoute 与
 * 结构化诊断工具）保持稳定；协议 payload 构建与 JSON 诊断的纯函数实现下沉在
 * llm-protocol-payload.js，此处只负责协议路由分发与调用编排。
 */

const {
  AI_PROTOCOLS,
  DEFAULT_PROVIDER_NAME,
  getProvider,
  resolveProvider,
} = require('./providers');
const {
  requestResponses,
  requestChatCompletions,
  requestMessages,
  textFromResponse,
} = require('./ai-transport');
const { ensureLocalModel } = require('./local-model');
const {
  diagnosticsOf,
  extractJsonValues,
  toChatCompletionsPayload,
  toMessagesPayload,
  toExternalChatPayload,
  adaptPayloadForChat,
  adaptPayloadForMessages,
  adaptPayloadForResponses,
} = require('./llm-protocol-payload');

function reserveResponses(ledger) {
  if (!ledger?.reserve) return { ok: false, code: 'COST_LEDGER_REQUIRED', error: 'DeepSeek 结构化调用缺少成本账本' };
  return ledger.reserve('responses_calls', 1);
}

function failure(kind, code, error, diagnostics = {}) {
  return { ok: false, code: `DEEPSEEK_${kind.toUpperCase()}_${code}`, error, ...diagnostics };
}

/**
 * 协议路由分发：按 provider 协议映射 transport 并自适应折叠 payload。
 * 对 local provider 或 localhost 端点自动调用 ensureLocalModel 并在 payload 中携带 chat_template_kwargs。
 */
async function resolveTransportRoute(payload, options = {}) {
  const isLocal = options.provider === 'local' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(options.endpoint || '');
  if (isLocal) {
    const localReady = await ensureLocalModel({
      fetchImpl: options.fetchImpl,
      notify: options.notify,
    });
    if (!localReady.ok) {
      return { ok: false, code: localReady.code || 'LOCAL_MODEL_UNAVAILABLE', error: localReady.error };
    }
    const provider = getProvider('local');
    const model = options.model || payload?.model || provider.defaultModel;
    const endpoint = options.endpoint || provider.chatEndpoint;
    const adaptedPayload = adaptPayloadForChat(payload, model, true);
    return {
      ok: true,
      isLocal: true,
      provider,
      protocol: AI_PROTOCOLS.CHAT,
      transport: requestChatCompletions,
      payload: adaptedPayload,
      options: {
        ...options,
        provider: 'local',
        endpoint,
      },
    };
  }

  const providerName = options.provider || DEFAULT_PROVIDER_NAME;
  const resolved = resolveProvider(providerName);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  if (provider.implemented === false) {
    return { ok: false, code: 'AI_PROVIDER_UNSUPPORTED', error: `不支持的 AI provider: ${providerName}` };
  }

  const protocol = options.protocol || provider.protocol;
  let transport;
  let adaptedPayload;
  let endpoint = options.endpoint;

  if (protocol === AI_PROTOCOLS.MESSAGES) {
    transport = requestMessages;
    endpoint = endpoint || provider.messagesEndpoint;
    const model = options.model || payload?.model || provider.defaultModel;
    adaptedPayload = adaptPayloadForMessages(payload, model);
  } else if (protocol === AI_PROTOCOLS.CHAT) {
    transport = requestChatCompletions;
    endpoint = endpoint || provider.chatEndpoint;
    const model = options.model || payload?.model || provider.defaultModel;
    adaptedPayload = adaptPayloadForChat(payload, model, false);
  } else {
    // RESPONSES
    transport = requestResponses;
    if (!endpoint && provider.name === 'deepseek') {
      if (payload?.messages && !payload?.input) {
        endpoint = provider.chatEndpoint;
      } else {
        endpoint = provider.responsesEndpoint;
      }
    } else if (!endpoint) {
      endpoint = provider.responsesEndpoint;
    }
    const model = options.model || payload?.model || provider.defaultModel;
    adaptedPayload = adaptPayloadForResponses(payload, model, endpoint);
  }

  return {
    ok: true,
    isLocal: false,
    provider,
    protocol,
    transport,
    payload: adaptedPayload,
    options: {
      ...options,
      provider: provider.name,
      endpoint,
    },
  };
}

/**
 * 统一文本生成网关：自动多协议分流（MESSAGES / RESPONSES / CHAT / local），
 * 返回归一化文本与原始数据。
 */
async function requestLlmText(payload, options = {}) {
  const route = await resolveTransportRoute(payload, options);
  if (!route.ok) return route;

  const response = await route.transport(route.payload, route.options);
  if (!response.ok) return response;

  const text = textFromResponse(response.data);
  return {
    ok: true,
    text,
    data: response.data,
    usage: response.usage || null,
  };
}

/**
 * 统一结构化 JSON 提取网关：多协议分流、成本预占、JSON 提取、截断诊断与 schema 校验。
 */
async function requestStructuredJson({ kind, instructions, input, maxOutputTokens, ledger, validate }, options = {}) {
  const isLocal = options.provider === 'local' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(options.endpoint || '');
  if (isLocal) {
    const localReady = await ensureLocalModel({
      fetchImpl: options.fetchImpl,
      notify: options.notify,
    });
    if (!localReady.ok) {
      return { ok: false, code: 'LOCAL_MODEL_UNAVAILABLE', error: localReady.error };
    }
  }
  const reserved = reserveResponses(ledger);
  if (!reserved.ok) return { ok: false, code: reserved.code, error: '结构化调用预算不足' };

  let providerLabel = 'DeepSeek';
  if (!isLocal) {
    const resolved = resolveProvider(options.provider || DEFAULT_PROVIDER_NAME);
    if (resolved.ok) providerLabel = resolved.provider.label;
  }

  let payload;
  let transport = requestResponses;
  let transportOptions = { ...options };

  if (isLocal) {
    payload = toChatCompletionsPayload({
      model: options.model || getProvider('local').defaultModel,
      instructions,
      input,
      maxOutputTokens,
    });
    transport = requestChatCompletions;
    transportOptions = { ...options, provider: 'local' };
  } else {
    const providerResolved = resolveProvider(options.provider || DEFAULT_PROVIDER_NAME);
    if (!providerResolved.ok) return providerResolved;
    if (providerResolved.provider.protocol === AI_PROTOCOLS.MESSAGES) {
      payload = toMessagesPayload({
        model: options.model || providerResolved.provider.defaultModel,
        instructions,
        input,
        maxOutputTokens,
      });
      transport = requestMessages;
    } else if (providerResolved.provider.protocol === AI_PROTOCOLS.CHAT) {
      payload = toExternalChatPayload({
        model: options.model || providerResolved.provider.defaultModel,
        instructions,
        input,
        maxOutputTokens,
        responseFormat: { type: 'json_object' },
      });
      transport = requestChatCompletions;
    } else {
      payload = {
        model: options.model || providerResolved.provider.defaultModel,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        stream: false,
        reasoning: { effort: 'none' },
        text: { format: { type: 'json_object' } },
      };
      transport = requestResponses;
    }
  }

  const response = await transport(payload, transportOptions);
  if (!response.ok) return response;

  const text = textFromResponse(response.data);
  const diagnostics = diagnosticsOf(response.data, text);
  const chatTruncated = response.data?.choices?.[0]?.finish_reason === 'length';
  const messagesTruncated = response.data?.stop_reason === 'max_tokens';
  if (response.data?.status === 'incomplete' || chatTruncated || messagesTruncated) {
    const reason = diagnostics.incomplete_reason || (chatTruncated || messagesTruncated ? 'max_output_tokens' : null);
    const incompleteDiagnostics = reason ? { ...diagnostics, incomplete_reason: reason } : diagnostics;
    return failure(kind, 'INCOMPLETE', `${providerLabel} ${kind} 响应不完整${reason ? `: ${reason}` : ''}`, incompleteDiagnostics);
  }
  if (response.data?.status === 'failed') return failure(kind, 'FAILED', `${providerLabel} ${kind} 响应失败`, diagnostics);
  if (!text) return failure(kind, 'EMPTY', `${providerLabel} ${kind} 响应没有文本`, diagnostics);

  const values = extractJsonValues(text);
  if (!values.length) return failure(kind, 'OUTPUT_INVALID', `${providerLabel} ${kind} 响应不是有效 JSON`, diagnostics);
  const value = values.find(candidate => validate(candidate));
  if (value === undefined) return failure(kind, 'SCHEMA_INVALID', `${providerLabel} ${kind} JSON 结构不符合契约`, { ...diagnostics, output_keys: Object.keys(values[0] || {}) });
  return { ok: true, value, usage: response.usage, shape: Array.isArray(value) ? 'array' : 'object' };
}

module.exports = {
  // 核心网关 Interface
  requestStructuredJson,
  requestLlmText,
  resolveTransportRoute,
  // 结构化与 JSON 诊断/折叠工具函数（实现位于 llm-protocol-payload.js，导出面不变）
  extractJsonValues,
  diagnosticsOf,
  toChatCompletionsPayload,
  toMessagesPayload,
  toExternalChatPayload,
};
