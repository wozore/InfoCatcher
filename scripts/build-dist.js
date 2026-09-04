'use strict';

const { loadDotEnv } = require('../src/shared/env');
const { buildStaticSite } = require('../src/build/static-site');

function main() {
  loadDotEnv();
  const result = buildStaticSite();
  console.log(`dist/ 构建完成：${result.fileCount} 个文件`);
  return result;
}

if (require.main === module) main();

module.exports = { main };
