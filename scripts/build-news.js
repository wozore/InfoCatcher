'use strict';

// 先加载 .env（密钥只经环境变量注入，见 src/shared/env.js），再加载实现。
// 必须在 require 实现之前调用：实现模块顶层会读 process.env.DEEPSEEK_API_KEY。
const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const implementation = require('../src/news/pipeline/build-news');

if (require.main === module) {
  implementation.main().catch(error => {
    console.error(`❌ 热点构建失败：${error.message}`);
    process.exit(1);
  });
}

module.exports = implementation;
