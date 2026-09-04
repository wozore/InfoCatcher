import { state } from './state.js';
import { tokenFromFragment } from './auth.js';

export { tokenFromFragment };

export const API_ROOT = '/api/workbench/v1/';

export function unwrap(payload) {
  if (payload && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

export function revisionFrom(payload) {
  const candidates = [
    payload && payload.revision,
    payload && payload.meta && payload.meta.revision,
    payload && payload.data && payload.data.revision,
    payload && payload.data && payload.data.meta && payload.data.meta.revision,
  ];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) || '';
}

export function listFrom(payload, keys) {
  const value = unwrap(payload);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

export function countFrom(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) {
      const number = Number(value[key]);
      return Number.isFinite(number) ? number : null;
    }
  }
  return null;
}

export class ApiError extends Error {
  constructor(status, message, payload = null) {
    super(message || `API 请求失败（${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.code = payload?.code || payload?.error || null;
  }
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const timeoutMs = options.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const signal = controller
    ? (options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal)
    : options.signal;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  const fetchOptions = { ...options, headers };
  delete fetchOptions.timeoutMs;
  if (signal) fetchOptions.signal = signal;
  try {
    const response = await fetch(`${API_ROOT}${path}`, fetchOptions);
    let payload = null;
    try { payload = await response.json(); } catch (_) { payload = null; }
    if (!response.ok) {
      const serverMessage = payload && typeof payload.message === 'string'
        ? payload.message
        : (payload && typeof payload.error === 'string'
          ? payload.error
          : (payload && typeof payload.code === 'string' ? payload.code : ''));
      throw new ApiError(response.status, serverMessage, payload);
    }
    return payload;
  } catch (error) {
    if (controller && controller.signal.aborted && !(options.signal && options.signal.aborted)) {
      const timeout = new Error('请求超时，结果未确认，请先刷新状态后再决定是否重试。');
      timeout.code = 'CLIENT_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export function writeRequest(path, resource, body, options = {}) {
  const expectedRevision = state.revisions[resource];
  if (!expectedRevision) {
    const error = new Error('当前数据没有可用 revision，请先刷新后重试。');
    error.code = 'MISSING_REVISION';
    return Promise.reject(error);
  }
  return request(path, {
    method: 'POST',
    body: JSON.stringify({ ...body, expected_revision: expectedRevision }),
    ...options,
  });
}
