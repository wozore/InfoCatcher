'use strict';

/**
 * fetch-lmarena.js — LMArena 官方数据集抓取（datasets-server rows API 直取 JSON，零依赖）
 *
 * 主用 C 通路：`datasets-server.huggingface.co/rows`（HF 服务端把 parquet 转 JSON）。
 * 实测 rows API 的 filter 参数无效、text 榜整体 2700+ 行且每源每小时限流 → 采取
 * 「每 config 限量抓取」：数据按 category 排序（overall 在前），取前 MAX_ROWS 行即
 * 各榜精选 top；随后客户端按 category='overall' 收敛，行数有界（每 config ≤ 3 页）。
 * 绝不执行网络内容：只 JSON.parse + schema 白名单校验（fail-closed）。
 */

const { fetchJson } = require('./compare-http');
const { LMARENA_CONFIGS, validateLmarenaSnapshot } = require('../core/compare-schema');
const { writeRawSnapshot } = require('../core/compare-store');

const ROWS_API_BASE = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'lmarena-ai/leaderboard-dataset';
const PAGE_LENGTH = 100;
const MAX_PAGES = 3; // 每 config 至多 300 行（覆盖各榜 top，限流可控）

function rowsUrl(base, dataset, config, split, offset) {
  return `${base}?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${PAGE_LENGTH}`;
}

async function collectConfigRows(base, dataset, config, split) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = rowsUrl(base, dataset, config, split, page * PAGE_LENGTH);
    const payload = await fetchJson(url, { retries: 3, timeoutMs: 60000 });
    const batch = payload.rows;
    if (!Array.isArray(batch)) throw new Error(`config ${config} 响应缺少 rows`);
    batch.forEach(entry => {
      if (entry && typeof entry.row === 'object') rows.push(entry.row);
    });
    if (batch.length < PAGE_LENGTH) break;
    // 限速：datasets-server 有每小时配额，逐页间小憩
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return rows;
}

/**
 * 抓取 LMArena 15 个 config（精选）并写 raw/lmarena.json。
 * @param {object} [options] { rowsApiBase, dataset, split, write }
 * @returns {Promise<{ok: boolean, counts: object, errors: string[], file?: string}>}
 */
async function fetchLmarena(options = {}) {
  const base = options.rowsApiBase || ROWS_API_BASE;
  const dataset = options.dataset || DATASET;
  const split = options.split || 'latest';
  const errors = [];
  const configs = {};
  for (const config of LMARENA_CONFIGS) {
    try {
      const rows = await collectConfigRows(base, dataset, config, split);
      // 客户端收敛：只保留各榜 overall（子榜如语言/领域非本页维度所需）
      configs[config] = rows.filter(row => row.category === 'overall');
    } catch (error) {
      errors.push(`LMArena config ${config} 抓取失败：${error.message}`);
    }
  }
  if (errors.length) return { ok: false, counts: {}, errors };

  const validated = validateLmarenaSnapshot({ fetched_at: new Date().toISOString(), configs });
  if (!validated.ok) return { ok: false, counts: {}, errors: validated.errors };

  let file = null;
  if (options.write !== false) file = writeRawSnapshot('lmarena', { configs: validated.configs });
  const counts = {};
  for (const [config, rows] of Object.entries(validated.configs)) counts[config] = rows.length;
  return { ok: true, counts, errors, file };
}

module.exports = { fetchLmarena, rowsUrl, ROWS_API_BASE, DATASET };
