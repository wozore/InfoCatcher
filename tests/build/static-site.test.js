'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStaticSite } = require('../../src/build/static-site');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowview-static-site-'));
  const dirs = {
    src: path.join(root, 'src', 'web'),
    public: path.join(root, 'public'),
    catalog: path.join(root, 'data', 'catalog'),
    hotspots: path.join(root, 'data', 'news', 'output'),
    comparison: path.join(root, 'data', 'comparison'),
    output: path.join(root, 'dist'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dirs.comparison, 'integrated'), { recursive: true });
  fs.mkdirSync(path.join(dirs.comparison, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(dirs.src, 'index.html'), 'src-page');
  fs.writeFileSync(path.join(dirs.public, 'robots.txt'), 'public-file');
  fs.writeFileSync(path.join(dirs.catalog, 'tool-cards.json'), '{"items":[]}');
  fs.writeFileSync(path.join(dirs.hotspots, 'hotspots.json'), '{"items":[]}');
  fs.writeFileSync(path.join(dirs.comparison, 'view-config.json'), '{"view":true}');
  fs.writeFileSync(path.join(dirs.comparison, 'models-alias.json'), '{"alias":true}');
  fs.writeFileSync(path.join(dirs.comparison, 'integrated', 'index.json'), '{"models":[]}');
  fs.writeFileSync(path.join(dirs.comparison, 'raw', 'openrouter.json'), '{"raw":true}');
  fs.writeFileSync(path.join(dirs.comparison, 'refresh-config.json'), '{"refresh":true}');
  return { root, dirs };
}

function clean(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('buildStaticSite copies the public site data set and excludes pipeline files', () => {
  const { root, dirs } = fixture();
  try {
    const result = buildStaticSite({
      srcDir: dirs.src,
      publicDir: dirs.public,
      catalogDir: dirs.catalog,
      hotspotsDir: dirs.hotspots,
      comparisonDir: dirs.comparison,
      outputDir: dirs.output,
    });
    assert.equal(result.outputDir, dirs.output);
    assert.equal(fs.readFileSync(path.join(dirs.output, 'index.html'), 'utf8'), 'src-page');
    assert.equal(fs.readFileSync(path.join(dirs.output, 'robots.txt'), 'utf8'), 'public-file');
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'catalog', 'tool-cards.json')), true);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'news', 'output', 'hotspots.json')), true);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'comparison', 'view-config.json')), true);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'comparison', 'models-alias.json')), true);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'comparison', 'integrated', 'index.json')), true);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'comparison', 'raw')), false);
    assert.equal(fs.existsSync(path.join(dirs.output, 'data', 'comparison', 'refresh-config.json')), false);
  } finally {
    clean(root);
  }
});

test('buildStaticSite replaces an existing output without retaining stale files', () => {
  const { root, dirs } = fixture();
  try {
    fs.mkdirSync(path.join(dirs.output, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(dirs.output, 'stale', 'old.txt'), 'stale');
    buildStaticSite({ ...dirs, srcDir: dirs.src, publicDir: dirs.public, catalogDir: dirs.catalog, hotspotsDir: dirs.hotspots, comparisonDir: dirs.comparison, outputDir: dirs.output });
    assert.equal(fs.existsSync(path.join(dirs.output, 'stale')), false);
  } finally {
    clean(root);
  }
});
