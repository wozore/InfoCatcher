'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');

function countFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return count;
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    if (fs.statSync(path.join(dir, entry)).isFile()) count += 1;
  }
  return count;
}

function buildStaticSite(options = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const outputDir = options.outputDir || path.join(projectDir, 'dist');
  const srcDir = options.srcDir || path.join(projectDir, 'src', 'web');
  const publicDir = options.publicDir || path.join(projectDir, 'public');
  const catalogDir = options.catalogDir || path.join(projectDir, 'data', 'catalog');
  const hotspotsDir = options.hotspotsDir || path.join(projectDir, 'data', 'news', 'output');
  const comparisonDir = options.comparisonDir || path.join(projectDir, 'data', 'comparison');

  if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(srcDir, outputDir, { recursive: true });
  for (const file of fs.readdirSync(publicDir)) {
    fs.cpSync(path.join(publicDir, file), path.join(outputDir, file), { recursive: true });
  }

  const dataDist = path.join(outputDir, 'data');
  fs.mkdirSync(path.join(dataDist, 'catalog'), { recursive: true });
  fs.mkdirSync(path.join(dataDist, 'news'), { recursive: true });
  fs.cpSync(catalogDir, path.join(dataDist, 'catalog'), { recursive: true });
  fs.cpSync(hotspotsDir, path.join(dataDist, 'news', 'output'), { recursive: true });

  if (fs.existsSync(comparisonDir)) {
    const comparisonDist = path.join(dataDist, 'comparison');
    fs.mkdirSync(path.join(comparisonDist, 'integrated'), { recursive: true });
    for (const name of ['view-config.json', 'models-alias.json']) {
      const file = path.join(comparisonDir, name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(comparisonDist, name));
    }
    const integratedSrc = path.join(comparisonDir, 'integrated');
    if (fs.existsSync(integratedSrc)) {
      fs.cpSync(integratedSrc, path.join(comparisonDist, 'integrated'), { recursive: true });
    }
  }

  return { outputDir, fileCount: countFiles(outputDir) };
}

module.exports = { buildStaticSite };
