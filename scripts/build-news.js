'use strict';

const implementation = require('../src/news/pipeline/build-news');

if (require.main === module) {
  implementation.main().catch(error => {
    console.error(`❌ 热点构建失败：${error.message}`);
    process.exit(1);
  });
}

module.exports = implementation;
