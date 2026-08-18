'use strict';

/**
 * fetch-livebench.js — LiveBench 官方 CSV 抓取（livebench.ai table_<release>.csv）
 *
 * 官网 React SPA 从 `./table_<release>.csv` + `./categories_<release>.json` 取数
 * （release 形如 2026-06-25，网站默认取最新列表末位；refresh-config.json 可改）。
 * 类别分 = 该类别下各 task 分均值（即 all_groups.csv 聚合口径）。零依赖手写 CSV 解析。
 */

const { fetchText, fetchJson } = require('./compare-http');
const { LIVEBENCH_CATEGORY_MAP, validateRawRows, LIVEBENCH_GROUP_FIELDS } = require('./compare-schema');
const { writeRawSnapshot } = require('./compare-store');

const SITE_BASE = 'https://livebench.ai';
const CACHE_BUSTER = '?v=1787033560';
const DEFAULT_RELEASE = '2026-06-25';

/** 极简 CSV 解析（支持引号包裹与 "" 转义；零依赖）。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 聚合：每模型 × 类别 → 该类别 task 分均值。 */
function aggregateGroups(rows, categories) {
  const header = rows[0] || [];
  const taskIndex = new Map();
  header.forEach((name, i) => { if (i > 0) taskIndex.set(name, i); });

  const groups = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.length) continue;
    const model = String(cells[0] || '').trim();
    if (!model) continue;
    const groupScores = {};
    for (const [categoryName, tasks] of Object.entries(categories || {})) {
      const key = LIVEBENCH_CATEGORY_MAP[categoryName];
      if (!key) continue;
      const values = [];
      for (const task of tasks) {
        const idx = taskIndex.get(task);
        if (idx == null) continue;
        const num = Number(cells[idx]);
        if (Number.isFinite(num)) values.push(num);
      }
      if (values.length) {
        groupScores[key] = values.reduce((a, b) => a + b, 0) / values.length;
      }
    }
    if (Object.keys(groupScores).length) groups.push({ model, ...groupScores });
  }
  return groups;
}

/**
 * 抓取 LiveBench 分组数据并写 raw/livebench.json。
 * @param {object} [options] { siteBase, release, write }
 * @returns {Promise<{ok: boolean, count: number, errors: string[], file?: string}>}
 */
async function fetchLivebench(options = {}) {
  const base = options.siteBase || SITE_BASE;
  const release = options.release || DEFAULT_RELEASE;
  const tag = String(release).replace(/-/g, '_');
  const errors = [];
  let csvText;
  let categories;
  try {
    [csvText, categories] = await Promise.all([
      fetchText(`${base}/table_${tag}.csv${CACHE_BUSTER}`, { retries: 2, timeoutMs: 60000 }),
      fetchJson(`${base}/categories_${tag}.json${CACHE_BUSTER}`, { retries: 2, timeoutMs: 60000 }),
    ]);
  } catch (error) {
    return { ok: false, count: 0, errors: [`LiveBench 抓取失败：${error.message}`] };
  }
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, count: 0, errors: ['LiveBench CSV 无数据行'] };
  const groups = aggregateGroups(rows, categories);
  if (!groups.length) return { ok: false, count: 0, errors: ['LiveBench 聚合结果为空'] };

  const skipKeys = Object.keys(LIVEBENCH_GROUP_FIELDS).filter(key => key !== 'model');
  const validated = validateRawRows({ groups }, { rowsPath: ['groups'], spec: LIVEBENCH_GROUP_FIELDS, skipKeys, label: 'livebench' });
  if (!validated.ok) return { ok: false, count: groups.length, errors: validated.errors };

  let file = null;
  if (options.write !== false) file = writeRawSnapshot('livebench', { release, groups: validated.rows });
  return { ok: true, count: validated.rows.length, errors, file };
}

module.exports = { fetchLivebench, parseCsv, aggregateGroups, SITE_BASE, DEFAULT_RELEASE };
