'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS } = require('../src/shared/paths');

function countFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return count;
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    if (fs.statSync(path.join(dir, entry)).isFile()) count += 1;
  }
  return count;
}

function buildDist(options = {}) {
  const outputDir = options.outputDir || path.join(DIRS.project, 'dist');
  const srcDir = options.srcDir || path.join(DIRS.src, 'web');
  const publicDir = options.publicDir || DIRS.public;
  const catalogDir = options.catalogDir || path.join(DIRS.data, 'catalog');
  const hotspotsDir = options.hotspotsDir || path.join(DIRS.data, 'news', 'output');
  if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(srcDir, outputDir, { recursive: true });
  for (const file of fs.readdirSync(publicDir)) fs.cpSync(path.join(publicDir, file), path.join(outputDir, file), { recursive: true });
  const dataDist = path.join(outputDir, 'data');
  fs.mkdirSync(path.join(dataDist, 'catalog'), { recursive: true });
  fs.mkdirSync(path.join(dataDist, 'news'), { recursive: true });
  fs.cpSync(catalogDir, path.join(dataDist, 'catalog'), { recursive: true });
  fs.cpSync(hotspotsDir, path.join(dataDist, 'news', 'output'), { recursive: true });
  // 模型对比数据（data/comparison）：只发布前端入口层 integrated/ + view-config + models-alias；
  // raw/ 快照与 refresh-config 为管线/维护者产物，不发布到站点。
  const comparisonSrc = options.comparisonDir || path.join(DIRS.data, 'comparison');
  if (fs.existsSync(comparisonSrc)) {
    const comparisonDist = path.join(dataDist, 'comparison');
    fs.mkdirSync(path.join(comparisonDist, 'integrated'), { recursive: true });
    for (const name of ['view-config.json', 'models-alias.json']) {
      const file = path.join(comparisonSrc, name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(comparisonDist, name));
    }
    const integratedSrc = path.join(comparisonSrc, 'integrated');
    if (fs.existsSync(integratedSrc)) fs.cpSync(integratedSrc, path.join(comparisonDist, 'integrated'), { recursive: true });
  }
  return { outputDir, fileCount: countFiles(outputDir) };
}

if (require.main === module) {
  const result = buildDist();
  console.log(`dist/ 构建完成：${result.fileCount} 个文件`);
}

module.exports = { buildDist, countFiles };
