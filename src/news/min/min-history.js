/**
 * min-history.js —— 热点候选轻量历史
 *
 * 每批只保存候选 id/title，供查看近期采集批次，不用于恢复候选详情。
 */

'use strict';

const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

const MIN_HISTORY_PATH = NEWS_FILES.minCandidatesHistory;
const MAX_BATCHES = 30;
const EMPTY_HISTORY = Object.freeze({ schema_version: 1, batches: [] });

function createMinHistory(existing) {
  if (!existing || !Array.isArray(existing.batches)) {
    return { schema_version: 1, batches: [] };
  }
  return {
    schema_version: existing.schema_version || 1,
    batches: existing.batches.filter(batch => batch && typeof batch === 'object').slice(-MAX_BATCHES),
  };
}

function formatBatchAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('批次时间无效');
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`
    + `-${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

function compactCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && candidate.id)
    .map(candidate => ({
      id: String(candidate.id),
      title: candidate.title == null ? '' : String(candidate.title),
    }));
}

function appendMinHistory(existing, candidates, batchAt) {
  const next = createMinHistory(existing);
  const batch = {
    batch_at: formatBatchAt(batchAt),
    items: compactCandidates(candidates),
  };
  const batches = next.batches.filter(item => item.batch_at !== batch.batch_at);
  batches.push(batch);
  return { schema_version: 1, batches: batches.slice(-MAX_BATCHES) };
}

function readMinHistory() {
  return createMinHistory(readJson(MIN_HISTORY_PATH, EMPTY_HISTORY));
}

function writeMinHistory(history, runId = 'min-history') {
  writeJsonAtomic(MIN_HISTORY_PATH, createMinHistory(history), runId);
}

module.exports = {
  MIN_HISTORY_PATH,
  MAX_BATCHES,
  createMinHistory,
  formatBatchAt,
  compactCandidates,
  appendMinHistory,
  readMinHistory,
  writeMinHistory,
};
