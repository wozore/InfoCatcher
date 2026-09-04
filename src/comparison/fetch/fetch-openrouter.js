'use strict';

/**
 * fetch-openrouter.js — OpenRouter 模型列表抓取（官方免 key API）
 *
 * GET https://openrouter.ai/api/v1/models —— 一次拿全量模型的挂牌参考价。
 * 只存白名单字段（OPENROUTER_FIELDS），pricing 字符串转 number；校验 fail-closed，
 * 任一必需列缺失/类型不符 → 整文件拒绝、保留旧 raw 快照并 WARN（调用方隔离）。
 */

const { fetchJson } = require('./compare-http');
const { OPENROUTER_FIELDS, validateRowProjection } = require('../core/compare-schema');
const { writeRawSnapshot } = require('../core/compare-store');

const ENDPOINT = 'https://openrouter.ai/api/v1/models';

function mapOpenRouterModel(item) {
  const pricing = item.pricing || {};
  return {
    id: item.id,
    name: item.name || item.id,
    created: item.created ?? null,
    hugging_face_id: item.hugging_face_id ?? null,
    context_length: item.context_length ?? null,
    modality: item.architecture?.modality ?? null,
    input_modalities: Array.isArray(item.architecture?.input_modalities) ? item.architecture.input_modalities : [],
    output_modalities: Array.isArray(item.architecture?.output_modalities) ? item.architecture.output_modalities : [],
    prompt: pricing.prompt != null ? Number(pricing.prompt) : 0,
    completion: pricing.completion != null ? Number(pricing.completion) : 0,
    input_cache_read: pricing.input_cache_read != null ? Number(pricing.input_cache_read) : null,
  };
}

/**
 * 抓取 OpenRouter 模型列表并写 raw/openrouter.json。
 * @param {object} [options] { endpoint, write, fetchImpl }
 * @returns {Promise<{ok: boolean, count: number, errors: string[], file?: string}>}
 */
async function fetchOpenRouter(options = {}) {
  const endpoint = options.endpoint || ENDPOINT;
  const errors = [];
  let payload;
  try {
    payload = await fetchJson(endpoint, { retries: options.retries, timeoutMs: options.timeoutMs });
  } catch (error) {
    return { ok: false, count: 0, errors: [`OpenRouter 抓取失败：${error.message}`] };
  }
  const items = Array.isArray(payload.data) ? payload.data : null;
  if (!items) {
    return { ok: false, count: 0, errors: ['OpenRouter 响应缺少 data 数组'] };
  }
  const projected = [];
  items.forEach((item, i) => {
    const result = validateRowProjection(mapOpenRouterModel(item), OPENROUTER_FIELDS, `openrouter 行[${i}] (${item && item.id})`, errors);
    if (result) projected.push(result);
  });
  if (errors.length) return { ok: false, count: projected.length, errors };

  let file = null;
  if (options.write !== false) file = writeRawSnapshot('openrouter', { data: projected });
  return { ok: true, count: projected.length, errors, file };
}

module.exports = { fetchOpenRouter, mapOpenRouterModel, ENDPOINT };
