'use strict';

const { requestResponses, textFromResponse } = require('../../shared/deepseek-client');

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

async function requestStructuredJson({ kind, instructions, input, maxOutputTokens, ledger, validate }, options = {}) {
  const reserved = reserveResponses(ledger);
  if (!reserved.ok) return { ok: false, code: reserved.code, error: 'DeepSeek 结构化调用预算不足' };
  const response = await requestResponses({
    model: options.model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    stream: false,
    reasoning: { effort: 'none' },
    text: { format: { type: 'json_object' } },
  }, options);
  if (!response.ok) return response;

  const text = textFromResponse(response.data);
  const diagnostics = diagnosticsOf(response.data, text);
  if (response.data?.status === 'incomplete') {
    return failure(kind, 'INCOMPLETE', `DeepSeek ${kind} 响应不完整${diagnostics.incomplete_reason ? `: ${diagnostics.incomplete_reason}` : ''}`, diagnostics);
  }
  if (response.data?.status === 'failed') return failure(kind, 'FAILED', `DeepSeek ${kind} 响应失败`, diagnostics);
  if (!text) return failure(kind, 'EMPTY', `DeepSeek ${kind} 响应没有文本`, diagnostics);

  const values = extractJsonValues(text);
  if (!values.length) return failure(kind, 'OUTPUT_INVALID', `DeepSeek ${kind} 响应不是有效 JSON`, diagnostics);
  const value = values.find(candidate => validate(candidate));
  if (value === undefined) return failure(kind, 'SCHEMA_INVALID', `DeepSeek ${kind} JSON 结构不符合契约`, { ...diagnostics, output_keys: Object.keys(values[0] || {}) });
  return { ok: true, value, usage: response.usage, shape: Array.isArray(value) ? 'array' : 'object' };
}

module.exports = {
  extractJsonValues,
  diagnosticsOf,
  requestStructuredJson,
};
