'use strict';

/**
 * refresh-vibe-hub-cache.js —— 定时刷新 vibe-hub 概念缓存（CI 入口）
 *
 * 由 .github/workflows/refresh-vibe-hub-cache.yml 每 3 天（北京 19:00 / UTC 11:00，
 * YouTube 采集北京 20:00 前 1h）调用。只刷新 `fetched_at` 距今 > TTL（默认 3 天）的
 * 缓存条目；缓存文件不存在时跳过（首次空缓存零网络）；全新鲜时零网络。
 * 纯 HTTP，不消耗任何 API 额度，也不读任何 API Key。
 */

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const {
  loadVibeHubCache,
  saveVibeHubCache,
  refreshStaleVibeHubCache,
} = require('../src/catalog/concept/index');

async function main(argv = [], options = {}) {
  const cache = loadVibeHubCache(options);
  const entryCount = Object.keys(cache.entries || {}).length;
  if (!entryCount) {
    const report = { ok: true, cache_missing: true, message: 'vibe-hub 缓存为空，跳过刷新（零网络）' };
    if (!options.silent) console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const report = await refreshStaleVibeHubCache(cache, options);
  if (report.refreshed.length || report.failed.length) saveVibeHubCache(cache, options);
  const out = { ok: true, cache_entries: entryCount, ...report };
  if (!options.silent) console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
