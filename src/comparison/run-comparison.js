'use strict';

/**
 * run-comparison.js — 模型对比抓取编排（cron 每日调用）
 *
 * 每源独立计数全量 + 失败隔离（单源失败 WARN 不阻塞其余源）+ 全绿才重建。
 *   到间隔即抓 → count+1；count 达 full_every 该次升级为全量（归 0）。
 *   手动单跑（manual=true）不计 count。
 * 全绿判定：4 源 raw 快照都存在且 fetched_at 距今 ≤ 各自 interval_hours；
 *   任一源未就绪 → 停住不重建，列出待修源。
 */

const fs = require('fs');
const { COMPARISON_FILES } = require('../shared/paths');
const { readRawSnapshot, writeJsonAtomic } = require('./compare-store');
const { fetchOpenRouter } = require('./fetch-openrouter');
const { fetchLmarena } = require('./fetch-lmarena');
const { fetchLivebench } = require('./fetch-livebench');
const { fetchLlmStats } = require('./fetch-llm-stats');
const { rebuildIntegrated } = require('./rebuild-comparison');
const { advanceRetentionToNow } = require('../shared/retention');

const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

const FETCHERS = {
  openrouter: fetchOpenRouter,
  lmarena: fetchLmarena,
  livebench: fetchLivebench,
  llm_stats: fetchLlmStats,
};

function readConfig() {
  if (!fs.existsSync(COMPARISON_FILES.refreshConfig)) {
    throw new Error(`refresh-config.json 不存在：${COMPARISON_FILES.refreshConfig}`);
  }
  return JSON.parse(fs.readFileSync(COMPARISON_FILES.refreshConfig, 'utf8'));
}

function writeConfig(config) {
  writeJsonAtomic(COMPARISON_FILES.refreshConfig, config);
}

function ageHours(dateIso) {
  if (!dateIso) return Infinity;
  const time = new Date(dateIso).getTime();
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : Infinity;
}

/** 源是否就绪（快照存在且 ≤ 间隔）。 */
function isFresh(source, config) {
  const snapshot = readRawSnapshot(source);
  return Boolean(snapshot) && ageHours(snapshot.fetched_at) <= config.interval_hours;
}

/**
 * 抓取单个源（成功写 raw 快照；失败返回错误但保留旧快照）。
 * @returns {Promise<{ok: boolean, count: number, errors: string[]}>}
 */
async function fetchSource(source, config, options = {}) {
  const fetcher = FETCHERS[source];
  if (!fetcher) return { ok: false, count: 0, errors: [`未知源: ${source}`] };
  const fetchOptions = { ...options.fetchOptions };
  if (source === 'livebench' && config.release) fetchOptions.release = config.release;
  if (source === 'openrouter' && config.url) fetchOptions.endpoint = config.url;
  if (source === 'llm_stats' && config.url) fetchOptions.url = config.url;
  return fetcher(fetchOptions);
}

/**
 * 编排一次抓取 + 重建。
 * @param {object} [options] { manual, force, skipRebuild }
 * @returns {Promise<{fetched: string[], failed: string[], pending: string[], rebuilt: boolean, errors: object}>}
 */
async function runComparison(options = {}) {
  const config = readConfig();
  const summary = { fetched: [], failed: [], pending: [], rebuilt: false, errors: {} };

  // 每月初幂等推进共享 retention（cutoff = 当前年月 − 14 个月），漏跑自愈 snap 到正确目标；
  // 经 src/shared/retention.js 唯一写入口，写失败降级沿用旧 cutoff 不中断。
  const retention = advanceRetentionToNow();
  if (!retention.ok) console.warn('⚠️ retention 推进写失败（沿用当前 cutoff）：', retention.error);
  const cutoffDate = retention.cutoff_date;

  for (const source of SOURCE_ORDER) {
    const sourceConfig = config.sources[source];
    if (!sourceConfig) { summary.errors[source] = 'refresh-config 缺该源配置'; summary.failed.push(source); continue; }
    const snapshot = readRawSnapshot(source);
    const due = options.force || !snapshot || ageHours(snapshot.fetched_at) >= sourceConfig.interval_hours;
    if (!due) continue;
    const result = await fetchSource(source, sourceConfig, options);
    if (result.ok) {
      summary.fetched.push(source);
      // 每源独立计数全量：到间隔即抓 count+1，达 full_every 归 0（手动单跑不计）
      if (!options.manual) {
        sourceConfig.count = Number(sourceConfig.count || 0) + 1;
        if (sourceConfig.count >= (sourceConfig.full_every || 10)) sourceConfig.count = 0;
      }
      sourceConfig.last_run = new Date().toISOString();
      writeConfig(config);
    } else {
      summary.failed.push(source);
      summary.errors[source] = result.errors || [];
      console.warn(`⚠️  ${source} 抓取失败：${(result.errors || []).join('; ')}`);
    }
  }

  // 全绿才重建
  const pending = SOURCE_ORDER.filter(source => !isFresh(source, config.sources[source]));
  if (pending.length) {
    summary.pending = pending;
    console.warn(`⏸️  重建跳过：以下源未就绪（${pending.join(', ')}），修复后自动继续`);
  } else if (!options.skipRebuild) {
    const rebuild = rebuildIntegrated({ cutoffDate });
    if (rebuild.ok) {
      summary.rebuilt = true;
      console.log(`✅ integrated 重建完成：${rebuild.models.length} 个模型`);
    } else {
      summary.errors.rebuild = rebuild.errors;
      console.warn(`❌ integrated 重建失败：${rebuild.errors.join('; ')}`);
    }
  }
  return summary;
}

module.exports = { runComparison, fetchSource, isFresh, readConfig, SOURCE_ORDER };
