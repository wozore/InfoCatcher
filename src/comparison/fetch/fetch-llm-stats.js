'use strict';

/**
 * fetch-llm-stats.js — Open LLM Leaderboard（llm-stats.com）抓取
 *
 * 主路径确定性、无 LLM：解析 Next.js RSC flight payload（self.__next_f.push），
 * 取 initialData 模型数组，字段白名单校验 fail-closed（三道闸：结构化候选 →
 * 字段白名单 → 值域校验）。绝不拼整页 prose。RSC 结构改版解析失败时保留旧
 * raw 快照并 WARN（LLM 兜底为二期，本期不做）。
 */

const { fetchText } = require('./compare-http');
const { LLM_STATS_FIELDS, validateRowProjection } = require('../core/compare-schema');
const { writeRawSnapshot } = require('../core/compare-store');

const PAGE_URL = 'https://llm-stats.com/leaderboards/open-llm-leaderboard';
const MARKER = 'self.__next_f.push([1,';

/** 提取 RSC flight 分块字符串（处理双重转义：\\ 与 \" 都作为转义消费）。 */
function extractFlightChunks(html) {
  const chunks = [];
  let from = 0;
  while (true) {
    const start = html.indexOf(MARKER, from);
    if (start < 0) break;
    let i = start + MARKER.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '"') { from = start + MARKER.length; continue; }
    i++;
    let out = '';
    while (i < html.length) {
      const ch = html[i];
      if (ch === '\\') { out += ch + (html[i + 1] || ''); i += 2; continue; }
      if (ch === '"') break;
      out += ch; i++;
    }
    chunks.push(out);
    from = start + MARKER.length;
  }
  return chunks;
}

function unescapeJsString(s) {
  return JSON.parse('"' + s + '"');
}

/** 在分块中定位 initialData 数组并解析。 */
function extractInitialData(chunks) {
  for (const chunk of chunks) {
    if (!chunk.includes('initialData')) continue;
    const un = unescapeJsString(chunk);
    const idx = un.indexOf('initialData');
    const start = un.indexOf('[', idx);
    if (start < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < un.length; i++) {
      if (un[i] === '[') depth++;
      else if (un[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    return JSON.parse(un.slice(start, end + 1));
  }
  return null;
}

/** 投影到白名单（缺省 null）；值域校验（aime 等 0-1 benchmark ∈ [0,1]）。 */
function mapLlmStatsModel(record) {
  const out = {};
  for (const field of Object.keys(LLM_STATS_FIELDS)) {
    out[field] = record[field] == null ? null : record[field];
  }
  return out;
}

function inRange01(x) {
  return x == null || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1);
}

/**
 * 抓取 llm-stats RSC 并写 raw/llm-stats.json。
 * @param {object} [options] { url, write }
 * @returns {Promise<{ok: boolean, count: number, errors: string[], file?: string}>}
 */
async function fetchLlmStats(options = {}) {
  const url = options.url || PAGE_URL;
  const errors = [];
  let html;
  try {
    html = await fetchText(url, { retries: 2, timeoutMs: 90000 });
  } catch (error) {
    return { ok: false, count: 0, errors: [`llm-stats 抓取失败：${error.message}`] };
  }
  const initialData = extractInitialData(extractFlightChunks(html));
  if (!Array.isArray(initialData)) {
    return { ok: false, count: 0, errors: ['llm-stats RSC payload 未找到 initialData（结构可能改版）'] };
  }
  const projected = [];
  initialData.forEach((record, i) => {
    if (!record || typeof record !== 'object') return;
    const mapped = mapLlmStatsModel(record);
    // 值域校验：benchmark accuracy 必须 ∈ [0,1]（防异常值入库）
    for (const field of ['aime_2025_score', 'hle_score', 'gpqa_score', 'swe_bench_verified_score', 'swe_bench_pro_score', 'mmmu_pro_score']) {
      if (mapped[field] != null && !inRange01(mapped[field])) {
        errors.push(`llm-stats 行[${i}] ${field} 值域异常: ${mapped[field]}`);
        return;
      }
    }
    const result = validateRowProjection(mapped, LLM_STATS_FIELDS, `llm-stats 行[${i}] (${record.model_id || '?'})`, errors);
    if (result) projected.push(result);
  });
  if (errors.length) return { ok: false, count: projected.length, errors };

  let file = null;
  if (options.write !== false) file = writeRawSnapshot('llm_stats', { models: projected });
  return { ok: true, count: projected.length, errors, file };
}

module.exports = { fetchLlmStats, extractFlightChunks, extractInitialData, PAGE_URL };
