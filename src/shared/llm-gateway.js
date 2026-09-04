'use strict';

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

const MAX_OUTPUT_PREVIEW = 1200;

function limit(value, max = MAX_OUTPUT_PREVIEW) {
  return String(value || '').slice(0, max);
}

function outputTypesOf(data) {
  return [...new Set((data?.output || []).map(item => item?.type).filter(Boolean))];
}

function diagnosticsOf(data, text) {
  const incompleteReason = typeof data?.incomplete_details?.reason === 'string'
    ? data.incomplete_details.reason
    : null;
  return {
    ...(typeof data?.status === 'string' ? { response_status: data.status } : {}),
    ...(incompleteReason ? { incomplete_reason: incompleteReason } : {}),
    ...(outputTypesOf(data).length ? { output_types: outputTypesOf(data) } : {}),
    ...(text ? { output_preview: limit(text) } : {}),
  };
}

function balancedJsonEnd(text, start) {
  const pairs = { '{': '}', '[': ']' };
  const stack = [pairs[text[start]]];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (pairs[character]) {
      stack.push(pairs[character]);
      continue;
    }
    if (character === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return index;
      continue;
    }
    if (character === '}' || character === ']') return -1;
  }
  return -1;
}

function extractJsonValues(text) {
  if (typeof text !== 'string') return [];
  const cleaned = text.replace(/^﻿/, '').trim();
  const values = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    if (cleaned[index] !== '{' && cleaned[index] !== '[') continue;
    const end = balancedJsonEnd(cleaned, index);
    if (end <= index) continue;
    try {
      values.push(JSON.parse(cleaned.slice(index, end + 1)));
    } catch {}
    index = end;
  }
  return values;
}

function reserveResponses(ledger) {
  if (!ledger?.reserve) return { ok: false, code: 'COST_LEDGER_REQUIRED', error: 'DeepSeek 结构化调用缺少成本账本' };
  return ledger.reserve('responses_calls', 1);
}

function failure(kind, code, error, diagnostics = {}) {
  return { ok: false, code: `DEEPSEEK_${kind.toUpperCase()}_${code}`, error, ...diagnostics };
}

/**
 * 本地 Bonsai 模型走 OpenAI 兼容 Chat Completions 端点：不带 reasoning / text.format
 * （兼容端点会忽略或报错），并把 instructions/input 折叠为 system/user messages；
 * 必须带 chat_template_kwargs 关闭思维链，否则思考过程会吃光 max_tokens 预算。
 */
function toChatCompletionsPayload({ model, instructions, input, maxOutputTokens, temperature }) {
  return {
    model,
    messages: [
      ...(instructions ? [{ role: 'system', content: instructions }] : []),
      { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
    ],
    max_tokens: maxOutputTokens,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

/**
 * Anthropic Messages 协议 provider（含 zhipu Anthropic 兼容端点）：
 * instructions 升为顶层 system，用户内容作为唯一 user message；
 * thinking:disabled 关闭思考模式避免消耗额外 token 且加快输出。
 */
function toMessagesPayload({ model, instructions, input, maxOutputTokens }) {
  return {
    model,
    max_tokens: maxOutputTokens,
    ...(instructions ? { system: instructions } : {}),
    messages: [
      { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
    ],
    thinking: { type: 'disabled' },
  };
}

/**
 * 外部 CHAT 协议 provider：与本地同源折叠，但不带 llama-server 专属的
 * chat_template_kwargs；仅当显式要求 responseFormat 时附加 response_format。
 */
function toExternalChatPayload({ model, instructions, input, maxOutputTokens, responseFormat }) {
  const format = responseFormat === true ? { type: 'json_object' } : responseFormat;
  return {
    model,
    messages: [
      ...(instructions ? [{ role: 'system', content: instructions }] : []),
      { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
    ],
    max_tokens: maxOutputTokens,
    stream: false,
    ...(format ? { response_format: format } : {}),
  };
}

function adaptPayloadForChat(payload, model, isLocal) {
  if (typeof payload === 'string') {
    return {
      model,
      messages: [{ role: 'user', content: payload }],
      stream: false,
      ...(isLocal ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
  }
  if (!payload.messages && (payload.instructions !== undefined || payload.input !== undefined)) {
    const responseFormat = payload.response_format || payload.responseFormat;
    return isLocal
      ? toChatCompletionsPayload({
          model,
          instructions: payload.instructions,
          input: payload.input,
          maxOutputTokens: payload.maxOutputTokens || payload.max_output_tokens || payload.max_tokens,
          temperature: payload.temperature,
        })
      : toExternalChatPayload({
          model,
          instructions: payload.instructions,
          input: payload.input,
          maxOutputTokens: payload.maxOutputTokens || payload.max_output_tokens || payload.max_tokens,
          responseFormat,
        });
  }
  const result = {
    ...payload,
    model: model || payload.model,
  };
  if (isLocal) {
    result.chat_template_kwargs = { enable_thinking: false };
  } else {
    delete result.chat_template_kwargs;
  }
  return result;
}

function adaptPayloadForMessages(payload, model) {
  if (typeof payload === 'string') {
    return {
      model,
      max_tokens: 800,
      messages: [{ role: 'user', content: payload }],
      thinking: { type: 'disabled' },
    };
  }
  if (!payload.messages && (payload.instructions !== undefined || payload.input !== undefined)) {
    return toMessagesPayload({
      model,
      instructions: payload.instructions,
      input: payload.input,
      maxOutputTokens: payload.maxOutputTokens || payload.max_output_tokens || payload.max_tokens || 800,
    });
  }
  let system;
  const messages = [];
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return {
    model: model || payload.model,
    max_tokens: payload.max_tokens || payload.max_output_tokens || 800,
    ...(system ? { system } : {}),
    messages,
    thinking: { type: 'disabled' },
  };
}

function adaptPayloadForResponses(payload, model, endpoint) {
  if (typeof payload === 'string') {
    return {
      model,
      instructions: undefined,
      input: [{ role: 'user', content: [{ type: 'input_text', text: payload }] }],
      max_output_tokens: 800,
      stream: false,
      reasoning: { effort: 'none' },
    };
  }
  // 如果 endpoint 是 chat 端点（例如 deepseek chat/completions 兼容路径），保持 chat payload 结构
  if (endpoint && endpoint.includes('/chat/completions')) {
    return {
      ...payload,
      model: model || payload.model,
    };
  }
  // 如果已是 Responses 格式
  if (payload.instructions !== undefined || payload.input !== undefined) {
    return {
      ...payload,
      model: model || payload.model,
    };
  }
  // 如果是 Messages 格式，折叠为 Responses
  let instructions;
  const input = [];
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      instructions = instructions ? `${instructions}\n\n${m.content}` : m.content;
    } else {
      input.push({
        role: m.role,
        content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      });
    }
  }
  return {
    model: model || payload.model,
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: payload.max_tokens || payload.max_output_tokens || 800,
    stream: false,
    reasoning: { effort: 'none' },
    ...(payload.response_format ? { text: { format: { type: 'json_object' } } } : {}),
  };
}

/**
 * 协议路由分发：按 provider 协议映射 transport 并自适应折叠 payload。
 * 对 local provider 或 localhost 端点自动调用 ensureLocalModel 并在 payload 中携带 chat_template_kwargs。
 */
async function resolveTransportRoute(payload, options = {}) {
  const isLocal = options.provider === 'local' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(options.endpoint || '');
  if (isLocal) {
    const localReady = await ensureLocalModel({ fetchImpl: options.fetchImpl });
    if (!localReady.ok) {
      console.error(`[local-model] ${localReady.error}`);
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
    const localReady = await ensureLocalModel({ fetchImpl: options.fetchImpl });
    if (!localReady.ok) {
      console.error(`[local-model] ${localReady.error}`);
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
  // 结构化与 JSON 诊断/折叠工具函数（向后兼容）
  extractJsonValues,
  diagnosticsOf,
  toChatCompletionsPayload,
  toMessagesPayload,
  toExternalChatPayload,
};
