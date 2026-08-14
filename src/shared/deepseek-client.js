'use strict';

const { AI_PROTOCOLS, apiKeyForProvider, resolveProvider } = require('./ai-provider-registry');

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
  if (!/^https:\/\//.test(endpoint)) return { ok: false, code: `${prefix}_ENDPOINT_INVALID`, error: 'AI endpoint 必须使用 HTTPS' };

  let response;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
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

function textFromResponse(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (typeof data?.choices?.[0]?.message?.content === 'string') return data.choices[0].message.content;
  const parts = [];
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
  textFromResponse,
};
