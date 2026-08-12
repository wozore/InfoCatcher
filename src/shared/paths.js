'use strict';

const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(PROJECT_DIR, 'scripts');
const TESTS_DIR = path.join(PROJECT_DIR, 'tests');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const RESOURCES_DIR = path.join(PROJECT_DIR, 'resources');
const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
const NEWS_DIR = path.join(DATA_DIR, 'news');
const NEWS_CONFIG_DIR = path.join(NEWS_DIR, 'config');
const NEWS_SOURCES_DIR = path.join(NEWS_DIR, 'sources');
const NEWS_MANUAL_DIR = path.join(NEWS_DIR, 'manual');
const NEWS_RUNTIME_DIR = path.join(NEWS_DIR, 'runtime');
const NEWS_OUTPUT_DIR = path.join(NEWS_DIR, 'output');
const ACQUISITION_DIR = path.join(DATA_DIR, 'acquisition');
const FIXTURE_DIR = path.join(TESTS_DIR, 'fixtures');

const DIRS = Object.freeze({
  project: PROJECT_DIR,
  src: SRC_DIR,
  scripts: SCRIPTS_DIR,
  tests: TESTS_DIR,
  data: DATA_DIR,
  public: PUBLIC_DIR,
  resources: RESOURCES_DIR,
  catalog: CATALOG_DIR,
  news: NEWS_DIR,
  newsConfig: NEWS_CONFIG_DIR,
  newsSources: NEWS_SOURCES_DIR,
  newsManual: NEWS_MANUAL_DIR,
  newsRuntime: NEWS_RUNTIME_DIR,
  newsOutput: NEWS_OUTPUT_DIR,
  acquisition: ACQUISITION_DIR,
  fixtures: FIXTURE_DIR,
});

const CATALOG_FILES = Object.freeze({
  vendorCards: path.join(CATALOG_DIR, 'vendor-cards.json'),
  toolCards: path.join(CATALOG_DIR, 'tool-cards.json'),
  vendorPreviewLevel1: path.join(CATALOG_DIR, 'vendor-preview-level1.json'),
  vendorPreviewLevel2: path.join(CATALOG_DIR, 'vendor-preview-level2.json'),
  toolPreviewLevel3: path.join(CATALOG_DIR, 'tool-preview-level3.json'),
  glossary: path.join(CATALOG_DIR, 'glossary.json'),
  scenes: path.join(CATALOG_DIR, 'scenes.json'),
  featured: path.join(CATALOG_DIR, 'featured.json'),
});

const NEWS_FILES = Object.freeze({
  config: path.join(NEWS_CONFIG_DIR, 'news-config.json'),
  configV2: path.join(NEWS_CONFIG_DIR, 'news-config-v2.json'), // 热点管线 v2：采集/评分/审核/收尾配置
  sources: path.join(NEWS_SOURCES_DIR, 'news-sources.json'),
  manualItems: path.join(NEWS_MANUAL_DIR, 'news-manual-items.json'),
  state: path.join(NEWS_RUNTIME_DIR, 'news-state.json'),
  registry: path.join(NEWS_RUNTIME_DIR, 'news-registry.json'),
  registryPruned: path.join(NEWS_RUNTIME_DIR, 'news-registry-pruned.json'), // N-P2：裁剪记录归档（可审计回滚），不发布到 dist/
  quota: path.join(NEWS_RUNTIME_DIR, 'news-quota.json'),
  authorizations: path.join(NEWS_RUNTIME_DIR, 'pending-authorizations.json'),
  candidates: path.join(NEWS_RUNTIME_DIR, 'hotspot-candidates.json'), // B16 决策 49：内部候选层，不发布到 dist/
  minCandidates: path.join(NEWS_RUNTIME_DIR, 'min-candidates.json'),  // 热点管线 v2：单状态轴候选层，不发布到 dist/
  minCandidatesHistory: path.join(NEWS_RUNTIME_DIR, 'min-candidates-history.json'), // 热点管线 v2：最近 30 批候选轻量历史（仅 id/title），不发布到 dist/
  reviewEvents: path.join(NEWS_RUNTIME_DIR, 'review-events.json'),    // B16 决策 70：追加式审核事件日志，不发布到 dist/
  sourceHistory: path.join(NEWS_RUNTIME_DIR, 'source-history.json'),  // 评分 v2：来源长期质量历史库，不发布到 dist/
  lastRun: path.join(NEWS_RUNTIME_DIR, 'last-run.json'),              // 热点管线 v2：最后一次采集运行记录（ai-top 判定 hasYouTube 用），不发布到 dist/

  adminAudit: path.join(NEWS_RUNTIME_DIR, 'news-admin-audit.json'),
  lock: path.join(NEWS_RUNTIME_DIR, '.news-build.lock'),
  hotspots: path.join(NEWS_OUTPUT_DIR, 'hotspots.json'),
});

const SOURCE_LIST_PATH = path.join(RESOURCES_DIR, 'source-lists', '热点信息源清单.md');

const ACQUISITION_FILES = Object.freeze({
  intelSources: path.join(ACQUISITION_DIR, 'intel-sources.json'),
});

const RSS_FEED_PATH = path.join(PUBLIC_DIR, 'feed.xml');

module.exports = { DIRS, CATALOG_FILES, NEWS_FILES, ACQUISITION_FILES, SOURCE_LIST_PATH, RSS_FEED_PATH };
