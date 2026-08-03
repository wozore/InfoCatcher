'use strict';

const implementation = require('../src/news/cli/news-cli');

if (require.main === module) {
  // main 为 async（transcript fetch 需要异步获取字幕），用 Promise catch 统一收错
  implementation.main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = implementation;
