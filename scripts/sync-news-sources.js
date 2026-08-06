/**
 * scripts/sync-news-sources.js — 热点源清单 Markdown → JSON 同步入口（薄包装）
 * 直接运行时调用 src/maintenance/sync-news-sources 的 main；被 require 时透传全部导出。
 */
'use strict';

const implementation = require('../src/maintenance/sync-news-sources');

if (require.main === module) {
  try {
    implementation.main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

module.exports = implementation;
