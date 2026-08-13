'use strict';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_RESPONSES_ENDPOINT = `${DEFAULT_BASE_URL}/responses`;

function classifyHttpError(status) {
  if (status === 401 || status === 403) return 'DEEPSEEK_AUTH_REQUIRED';
  if (status === 404) return 'DEEPSEEK_ENDPOINT_INVALID';
  if (status === 408 || status === 504) return 'DEEPSEEK_TIMEOUT';
  if (status === 429) return 'DEEPSEEK_RATE_LIMITED';
  if (status >= 500) return 'DEEPSEEK_PROVIDER_ERROR';
  return 'DEEPSEEK_OUTPUT_INVALID';
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 500);
}

async function requestDeepSeek(payload, options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = options.timeoutMs ?? 180000;
  const endpoint = options.endpoint || DEFAULT_RESPONSES_ENDPOINT;
  if (!apiKey) return { ok: false, code: 'DEEPSEEK_AUTH_REQUIRED', error: '缺少 DEEPSEEK_API_KEY' };
  if (!fetchImpl) return { ok: false, code: 'DEEPSEEK_NETWORK_ERROR', error: '当前运行环境无 fetch' };
  if (!/^https:\/\//.test(endpoint)) return { ok: false, code: 'DEEPSEEK_ENDPOINT_INVALID', error: 'DeepSeek endpoint 必须使用 HTTPS' };

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
    return { ok: false, code: timeout ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_NETWORK_ERROR', error: redact(error?.message || error) };
  }

  if (!response?.ok) {
    let detail = '';
    try { detail = redact(await response.text()); } catch {}
    return {
      ok: false,
      code: classifyHttpError(response?.status),
      status: response?.status,
      error: `DeepSeek HTTP ${response?.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, code: 'DEEPSEEK_OUTPUT_INVALID', error: `DeepSeek 响应不是 JSON: ${redact(error?.message || error)}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, code: 'DEEPSEEK_OUTPUT_INVALID', error: 'DeepSeek 响应为空对象' };
  return { ok: true, data, usage: data.usage || null };
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

function collectResponseSources(value, sources = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return sources;
  seen.add(value);
  if (typeof value.url === 'string' && /^https?:\/\//.test(value.url)) {
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    const excerpt = typeof value.excerpt === 'string' ? value.excerpt.trim() : (typeof value.snippet === 'string' ? value.snippet.trim() : '');
    if (title || excerpt) {
      const key = `${value.url}\n${title}`;
      if (!sources.some(source => `${source.url}\n${source.title}` === key)) sources.push({ title: title || value.url, url: value.url, excerpt });
    }
  }
  if (Array.isArray(value)) value.forEach(item => collectResponseSources(item, sources, seen));
  else Object.values(value).forEach(item => collectResponseSources(item, sources, seen));
  return sources;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_RESPONSES_ENDPOINT,
  classifyHttpError,
  redact,
  requestDeepSeek,
  textFromResponse,
  collectResponseSources,
};
