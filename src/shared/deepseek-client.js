'use strict';

const { AI_PROTOCOLS, DEFAULT_PROVIDER_NAME, apiKeyForProvider, resolveProvider } = require('./providers');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_RESPONSES_ENDPOINT = `${DEFAULT_BASE_URL}/responses`;

function providerPrefix(provider) {
  return provider.name === 'deepseek' ? 'DEEPSEEK' : String(provider.name || 'AI').toUpperCase();
}

function classifyHttpError(status, prefix = 'DEEPSEEK') {
  if (status === 401 || status === 403) return `${prefix}_AUTH_REQUIRED`;
  if (status === 404) return `${prefix}_ENDPOINT_INVALID`;
  if (status === 408 || status === 504) return `${prefix}_TIMEOUT`;
  if (status === 429) return `${prefix}_RATE_LIMITED`;
  if (status >= 500) return `${prefix}_PROVIDER_ERROR`;
  return `${prefix}_OUTPUT_INVALID`;
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 500);
}

function requestSignal(timeoutMs, parentSignal) {
  const timeoutSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
  if (!parentSignal) return timeoutSignal;
  if (!timeoutSignal) return parentSignal;
  if (typeof AbortSignal?.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted || timeoutSignal.aborted) controller.abort();
  else {
    parentSignal.addEventListener('abort', abort, { once: true });
    timeoutSignal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

async function requestResponses(payload, options = {}) {
  const providerName = options.provider || 'deepseek';
  const resolved = resolveProvider(providerName);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  const prefix = providerPrefix(provider);
  if (provider.protocol !== AI_PROTOCOLS.RESPONSES) {
    return { ok: false, code: 'AI_PROTOCOL_UNSUPPORTED', error: `provider=${providerName} 使用 ${provider.protocol}，当前只实现 Responses API` };
  }

  const apiKey = apiKeyForProvider(provider, options.apiKey);
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = options.timeoutMs ?? 180000;
  const endpoint = options.endpoint || provider.responsesEndpoint;
  if (!apiKey) return { ok: false, code: `${prefix}_AUTH_REQUIRED`, error: `缺少 ${provider.apiKeyEnv}` };
  if (!fetchImpl) return { ok: false, code: `${prefix}_NETWORK_ERROR`, error: '当前运行环境无 fetch' };
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpoint)) {
    return { ok: false, code: `${prefix}_ENDPOINT_INVALID`, error: 'AI endpoint 必须使用 HTTPS 或本地 localhost' };
  }

  let response;
  try {
    const signal = requestSignal(timeoutMs, options.signal);
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError';
    return { ok: false, code: timeout ? `${prefix}_TIMEOUT` : `${prefix}_NETWORK_ERROR`, error: redact(error?.message || error) };
  }

  if (!response?.ok) {
    let detail = '';
    try { detail = redact(await response.text()); } catch {}
    return {
      ok: false,
      code: classifyHttpError(response?.status, prefix),
      status: response?.status,
      error: `${provider.label} HTTP ${response?.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应不是 JSON: ${redact(error?.message || error)}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应为空对象` };
  return { ok: true, data, usage: data.usage || null };
}

async function requestDeepSeek(payload, options = {}) {
  return requestResponses(payload, { ...options, provider: 'deepseek' });
}

/**
 * chat/completions 传输通道（zhipu 等 CHAT 协议 provider）。
 * 与 requestResponses 同构：POST + Bearer + JSON 解析；响应由调用方用
 * textFromResponse 解析（兼容 choices[0].message.content）。
 */
async function requestChatCompletions(payload, options = {}) {
  const providerName = options.provider || DEFAULT_PROVIDER_NAME;
  const resolved = resolveProvider(providerName);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  const prefix = providerPrefix(provider);
  if (provider.protocol !== AI_PROTOCOLS.CHAT && options.protocol !== AI_PROTOCOLS.CHAT && !options.endpoint) {
    return { ok: false, code: 'AI_PROTOCOL_UNSUPPORTED', error: `provider=${providerName} 使用 ${provider.protocol}，chat 通道只支持 CHAT 协议` };
  }

  const apiKey = apiKeyForProvider(provider, options.apiKey);
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = options.timeoutMs ?? 180000;
  const endpoint = options.endpoint || provider.chatEndpoint;
  if (!apiKey) return { ok: false, code: `${prefix}_AUTH_REQUIRED`, error: `缺少 ${provider.apiKeyEnv}` };
  if (!fetchImpl) return { ok: false, code: `${prefix}_NETWORK_ERROR`, error: '当前运行环境无 fetch' };
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpoint)) {
    return { ok: false, code: `${prefix}_ENDPOINT_INVALID`, error: 'AI endpoint 必须使用 HTTPS 或本地 localhost' };
  }

  let response;
  try {
    const signal = requestSignal(timeoutMs, options.signal);
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError';
    return { ok: false, code: timeout ? `${prefix}_TIMEOUT` : `${prefix}_NETWORK_ERROR`, error: redact(error?.message || error) };
  }

  if (!response?.ok) {
    let detail = '';
    try { detail = redact(await response.text()); } catch {}
    return {
      ok: false,
      code: classifyHttpError(response?.status, prefix),
      status: response?.status,
      error: `${provider.label} HTTP ${response?.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应不是 JSON: ${redact(error?.message || error)}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应为空对象` };
  return { ok: true, data, usage: data.usage || null };
}

/**
 * /v1/messages 传输通道（Anthropic Messages 协议 provider，含 zhipu 的 Anthropic 兼容端点）。
 * POST + x-api-key + anthropic-version，响应由 textFromResponse 解析（兼容 content 块中的 text 类型）。
 */
async function requestMessages(payload, options = {}) {
  const providerName = options.provider || DEFAULT_PROVIDER_NAME;
  const resolved = resolveProvider(providerName);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  const prefix = providerPrefix(provider);
  if (provider.protocol !== AI_PROTOCOLS.MESSAGES) {
    return { ok: false, code: 'AI_PROTOCOL_UNSUPPORTED', error: `provider=${providerName} 使用 ${provider.protocol}，messages 通道只支持 MESSAGES 协议` };
  }

  const apiKey = apiKeyForProvider(provider, options.apiKey);
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = options.timeoutMs ?? 180000;
  const endpoint = options.endpoint || provider.messagesEndpoint;
  if (!apiKey) return { ok: false, code: `${prefix}_AUTH_REQUIRED`, error: `缺少 ${provider.apiKeyEnv}` };
  if (!fetchImpl) return { ok: false, code: `${prefix}_NETWORK_ERROR`, error: '当前运行环境无 fetch' };
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpoint)) {
    return { ok: false, code: `${prefix}_ENDPOINT_INVALID`, error: 'AI endpoint 必须使用 HTTPS 或本地 localhost' };
  }

  let response;
  try {
    const signal = requestSignal(timeoutMs, options.signal);
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError';
    return { ok: false, code: timeout ? `${prefix}_TIMEOUT` : `${prefix}_NETWORK_ERROR`, error: redact(error?.message || error) };
  }

  if (!response?.ok) {
    let detail = '';
    try { detail = redact(await response.text()); } catch {}
    return {
      ok: false,
      code: classifyHttpError(response?.status, prefix),
      status: response?.status,
      error: `${provider.label} HTTP ${response?.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应不是 JSON: ${redact(error?.message || error)}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, code: `${prefix}_OUTPUT_INVALID`, error: `${provider.label} 响应为空对象` };
  return { ok: true, data, usage: data.usage || null };
}

function textFromResponse(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (typeof data?.choices?.[0]?.message?.content === 'string') return data.choices[0].message.content;
  const parts = [];
  if (Array.isArray(data?.content)) {
    for (const block of data.content) {
      if (block?.type === 'text' && typeof block?.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length) return parts.join('\n').trim();
  }
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_RESPONSES_ENDPOINT,
  classifyHttpError,
  redact,
  requestResponses,
  requestDeepSeek,
  requestChatCompletions,
  requestMessages,
  textFromResponse,
};
