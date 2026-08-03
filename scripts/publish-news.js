/**
 * publish-news.js —— 从内部候选层重建公开热点投影（B16 决策 59）
 *
 * 触发场景：热点审核 PR 合并到 main 后，由 .github/workflows/publish-news.yml
 * 调用；从 data/news/runtime/hotspot-candidates.json（内部候选层，含双状态轴）
 * 经公开资格门禁重建最终 hotspots.json 与 RSS feed。
 *
 * 候选层由采集管线（build-news.js）写入并附带投影快照（events/provenance/
 * assessments/coverage/热度定义），因此本脚本不重新采集、不调用 AI、不消费额度。
 *
 * 用法：node scripts/publish-news.js [--dry-run]
 *   --dry-run：只打印将生成的条目数，不写文件。
 */
'use strict';

const { readCandidateStore, buildProjectionFromStore } = require('../src/news/core/news-candidates');
const { writeJsonAtomic } = require('../src/news/core/news-storage');
const { NEWS_FILES } = require('../src/shared/paths');
const { generateRss } = require('../src/content/generate-rss');

const OUTPUT_PATH = NEWS_FILES.hotspots;

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const store = readCandidateStore();
  const output = buildProjectionFromStore(store, { generatedAt: new Date().toISOString() });

  console.log(`ℹ️ 候选层：${store.candidates.length} 条候选`);
  console.log(`✅ 公开投影：${output.items.length} 条通过公开资格门禁（completed + approved）`);

  if (dryRun) {
    console.log('   --dry-run：不写文件');
    return { dry_run: true, items: output.items.length };
  }

  writeJsonAtomic(OUTPUT_PATH, output, `publish-${Date.now()}`);
  console.log('📄 已写 hotspots.json');
  generateRss();
  console.log('📡 RSS 已同步');
  return { dry_run: false, items: output.items.length };
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}

module.exports = { main };
