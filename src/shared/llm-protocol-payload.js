'use strict';

/**
 * llm-protocol-payload.js — llm-gateway 的协议 payload 适配与 JSON 诊断纯函数层
 *
 * 职责（无 I/O、无状态，全部纯函数）：
 *   - 各协议（RESPONSES / MESSAGES / CHAT / local）payload 的构建与自适应折叠；
 *   - 响应文本中的 JSON 值提取（balancedJsonEnd 括号配平）与截断诊断投影。
 * llm-gateway.js 是协议路由与调用入口；本模块只负责"发什么"与"怎么读"。
 */

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

module.exports = {
  diagnosticsOf,
  extractJsonValues,
  toChatCompletionsPayload,
  toMessagesPayload,
  toExternalChatPayload,
  adaptPayloadForChat,
  adaptPayloadForMessages,
  adaptPayloadForResponses,
};
