/**
 * scripts/build-news.js — 热点构建管线 CLI 入口（薄包装）
 *
 * 双重角色：直接运行时为 CLI（node scripts/build-news.js）；被 require 时
 * 透传 re-export src/news/pipeline/build-news 的全部导出，供 publish-news.js、
 * benchmark-news.js 复用同一份实现。
 */
'use strict';

// 先加载 .env（密钥只经环境变量注入，见 src/shared/env.js），再加载实现。
// 必须在 require 实现之前调用：实现模块顶层会读 process.env.DEEPSEEK_API_KEY。
const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const implementation = require('../src/news/pipeline/build-news');

// require.main === module：仅作为主入口直接执行时才跑管线；被 require（复用实现）时不产生副作用。
if (require.main === module) {
  implementation.main().catch(error => {
    console.error(`❌ 热点构建失败：${error.message}`);
    process.exit(1);
  });
}

module.exports = implementation;
