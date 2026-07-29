'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS } = require('../src/shared/paths');

const DIST = path.join(DIRS.project, 'dist');

// Clean and recreate
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST);

// Copy web root
fs.cpSync(path.join(DIRS.src, 'web'), DIST, { recursive: true });

// Copy public assets
const publicDir = DIRS.public;
for (const f of fs.readdirSync(publicDir)) {
  fs.cpSync(path.join(publicDir, f), path.join(DIST, f));
}

// Copy data for browser consumption
const dataDir = DIRS.data;
const catalogSrc = path.join(dataDir, 'catalog');
const hotspotsSrc = path.join(dataDir, 'news', 'output');
const dataDist = path.join(DIST, 'data');
fs.mkdirSync(path.join(dataDist, 'catalog'), { recursive: true });
fs.mkdirSync(path.join(dataDist, 'news'), { recursive: true });
fs.cpSync(catalogSrc, path.join(dataDist, 'catalog'), { recursive: true });
fs.cpSync(hotspotsSrc, path.join(dataDist, 'news', 'output'), { recursive: true });

const countFiles = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { recursive: true }))
    if (fs.statSync(path.join(dir, e)).isFile()) n++;
  return n;
};

console.log(`dist/ 构建完成：${countFiles(DIST)} 个文件`);
