/**
 * scripts/news-cli.js — 新闻采集管线 CLI 入口（薄包装）
 *
 * 双重角色：直接运行时为 CLI（node scripts/news-cli.js ...）；被 require 时
 * 透传 re-export src/news/cli/news-cli 的全部导出（含 min-review 命令组），供其它命令文件复用。
 */
'use strict';

// 先加载 .env（密钥只经环境变量注入，见 src/shared/env.js），再加载实现。
const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const implementation = require('../src/news/cli/news-cli');

// require.main === module：仅作为主入口直接执行时才分发命令；被引用时不产生副作用。
if (require.main === module) {
  // main 为 async（transcript fetch 需要异步获取字幕），用 Promise catch 统一收错
  implementation.main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = implementation;
