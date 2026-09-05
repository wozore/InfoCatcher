/**
 * publish-news.js —— 从内部候选层重建公开热点投影（热点管线 v2 为默认）
 *
 * 触发场景：热点审核 PR 合并到 main 后，由 .github/workflows/publish-news.yml
 * 调用；从 data/news/runtime/min-candidates.json（v2 单状态轴候选层）
 * 经公开资格门禁重建最终 hotspots.json 与 RSS feed。
 *
 * 候选层由采集管线（build-news.js）写入并附带投影快照（coverage），
 * 因此本脚本不重新采集、不调用 AI、不消费额度。
 *
 * 用法：node scripts/publish-news.js [--dry-run]
 *   --dry-run：只打印将生成的条目数，不写文件。
 *   默认走热点管线 v2：从 min-candidates.json（单状态轴）读候选，
 *     approved 按每日 top N 重建 hotspots.json（buildDailyProjection +
 *     enrichHotspotProjection + filterProjectionByWindow，与 runMin 第 10 步同构）。
 */
'use strict';

const { filterProjectionByWindow } = require('../src/news/core/news-public-gate');
const { readJson, writeJsonAtomic } = require('../src/shared/json-store');
const { NEWS_FILES } = require('../src/shared/paths');
const { generateRss } = require('../src/content/generate-rss');
const { enrichHotspotProjection, buildProjectionInputs } = require('../src/news/pipeline/projection');
const { readMinStore } = require('../src/news/min/min-store');
const { buildDailyProjection } = require('../src/news/min/daily-projection');
const { createNewsCatalogApi } = require('../src/maintenance/workbench/news-domain');

const OUTPUT_PATH = NEWS_FILES.hotspots;

/**
 * 热点管线 v2 发布入口（默认）：只接线，复用 v2 模块，不重写。
 * approved 候选 → 每日 top N → 公开契约补充 → 近期窗口过滤 → 写 hotspots.json。
 */
function mainMin() {
  const dryRun = process.argv.includes('--dry-run');
  // news 域不直读 catalog：目录查询面由组合根注入。
  const { toolUrlIndex, relatedLexicon } = buildProjectionInputs(createNewsCatalogApi());
  const config = readJson(NEWS_FILES.configV2, null);
  const store = readMinStore();
  const projection = buildDailyProjection(store, config, { now: new Date() });
  enrichHotspotProjection(projection.items, toolUrlIndex, relatedLexicon);
  const output = {
    schema_version: 1,
    generated_at: projection.generated_at,
    items: projection.items,
    coverage: { status: 'published_min', source: 'min-candidates.json', generated_at: projection.generated_at },
  };
  // 与 runMin 第 10 步同构：近期窗口一致过滤（第二道防线），缺省 30 天窗口。
  const filtered = filterProjectionByWindow(output, { config, now: Date.now() });
  const approved = store.candidates.filter(candidate => candidate && candidate.review_status === 'approved').length;

  console.log(`ℹ️ v2 候选层（min-candidates.json）：${store.candidates.length} 条（approved ${approved} 条）`);
  console.log(`✅ v2 公开投影：${filtered.items.length} 条通过公开资格门禁（approved + 每日 top N + 近期窗口）`);

  if (dryRun) {
    console.log('   --dry-run：不写文件');
    return { dry_run: true, items: filtered.items.length };
  }
  if (filtered.items.length === 0) {
    console.log('ℹ️ v2 公开投影为空（候选层无 approved），hotspots.json 保持不变');
    return { dry_run: false, items: 0, skipped_empty: true };
  }

  writeJsonAtomic(OUTPUT_PATH, filtered, `publish-min-${Date.now()}`);
  console.log('📄 已写 hotspots.json（v2）');
  generateRss();
  console.log('📡 RSS 已同步');
  return { dry_run: false, items: filtered.items.length };
}

if (require.main === module) {
  try { mainMin(); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}

module.exports = { mainMin };
