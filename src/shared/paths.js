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
  tools: path.join(CATALOG_DIR, 'tools.json'),
  glossary: path.join(CATALOG_DIR, 'glossary.json'),
  scenes: path.join(CATALOG_DIR, 'scenes.json'),
  toolIntelligence: path.join(CATALOG_DIR, 'tool-intelligence.json'),
  featured: path.join(CATALOG_DIR, 'featured.json'),
});

const NEWS_FILES = Object.freeze({
  config: path.join(NEWS_CONFIG_DIR, 'news-config.json'),
  sources: path.join(NEWS_SOURCES_DIR, 'news-sources.json'),
  manualItems: path.join(NEWS_MANUAL_DIR, 'news-manual-items.json'),
  state: path.join(NEWS_RUNTIME_DIR, 'news-state.json'),
  registry: path.join(NEWS_RUNTIME_DIR, 'news-registry.json'),
  quota: path.join(NEWS_RUNTIME_DIR, 'news-quota.json'),
  authorizations: path.join(NEWS_RUNTIME_DIR, 'pending-authorizations.json'),
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
