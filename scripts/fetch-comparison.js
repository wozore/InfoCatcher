'use strict';

/**
 * fetch-comparison.js — 模型对比数据管线 CLI（薄包装）
 *
 * 用法：
 *   node scripts/fetch-comparison.js run                 # 定时抓取 + 全绿重建（cron）
 *   node scripts/fetch-comparison.js fetch <source>      # 单源抓取（手动，不计 count）
 *   node scripts/fetch-comparison.js rebuild             # 直接重建 integrated
 *   node scripts/fetch-comparison.js review              # 输出待人工确认的名称歧义清单（零网络/零写入）
 *   node scripts/fetch-comparison.js status              # 打印 4 源快照新鲜度
 *
 * 本地代理：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node ...`
 * CI 不设代理走直连。
 */

const fs = require('fs');
const { COMPARISON_FILES } = require('../src/shared/paths');
const { runComparison, fetchSource, isFresh, readConfig } = require('../src/comparison/run-comparison');
const { readRawSnapshot } = require('../src/comparison/compare-store');
const { rebuildIntegrated } = require('../src/comparison/rebuild-comparison');
const { collectReviewCandidates } = require('../src/comparison/identity-review');

function printStatus() {
  const config = readConfig();
  const now = new Date().toISOString();
  console.log('模型对比数据管线状态');
  for (const source of ['openrouter', 'lmarena', 'livebench', 'llm_stats']) {
    const cfg = config.sources[source];
    const snapshot = readRawSnapshot(source);
    const fresh = snapshot ? isFresh(source, cfg) : false;
    const age = snapshot ? Math.round((Date.now() - new Date(snapshot.fetched_at).getTime()) / 3600000) : null;
    console.log(`  ${source}: ${snapshot ? `快照 ${snapshot.fetched_at}（${age}h 前）` : '无快照'} · ${fresh ? 'fresh' : 'STALE'} · count=${cfg.count} · 间隔 ${cfg.interval_hours}h`);
  }
  console.log(`  当前时间：${now}`);
}

function printIdentityReviewCandidates() {
  const snapshots = Object.fromEntries(['openrouter', 'lmarena', 'livebench', 'llm_stats']
    .map(source => [source, readRawSnapshot(source)]));
  const registry = fs.existsSync(COMPARISON_FILES.modelsAlias)
    ? JSON.parse(fs.readFileSync(COMPARISON_FILES.modelsAlias, 'utf8'))
    : { schema_version: 2, entries: [] };
  const candidates = collectReviewCandidates(snapshots, registry);
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    candidate_count: candidates.length,
    requires_human_approval: true,
    candidates,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'run') {
    const summary = await runComparison({ force: args.includes('--force') });
    console.log(`抓取 ${summary.fetched.length} 源，失败 ${summary.failed.length} 源${summary.rebuilt ? '，integrated 已重建' : ''}`);
    process.exit(summary.rebuilt || summary.failed.length === 0 ? 0 : 1);
    return;
  }
  if (command === 'fetch') {
    const source = args[1];
    if (!source) { console.error('用法：fetch <source>'); process.exit(1); }
    const config = readConfig();
    const cfg = config.sources[source];
    if (!cfg) { console.error(`未知源：${source}`); process.exit(1); }
    const result = await fetchSource(source, cfg, { manual: true });
    if (result.ok) { console.log(`✅ ${source} 抓取成功：${result.count} 条`); process.exit(0); }
    console.error(`❌ ${source} 抓取失败：${(result.errors || []).join('; ')}`);
    process.exit(1);
    return;
  }
  if (command === 'rebuild') {
    const result = rebuildIntegrated();
    if (result.ok) { console.log(`✅ integrated 重建完成：${result.models.length} 个模型`); process.exit(0); }
    console.error(`❌ integrated 重建失败：${result.errors.join('; ')}`);
    process.exit(1);
    return;
  }
  if (command === 'review') {
    printIdentityReviewCandidates();
    return;
  }
  if (command === 'status') {
    printStatus();
    return;
  }
  console.error('未知命令。用法：run | fetch <source> | rebuild | review | status');
  process.exit(1);
}

if (require.main === module) {
  main().catch(error => { console.error('管线异常：', error.message); process.exit(1); });
}

module.exports = { main };
