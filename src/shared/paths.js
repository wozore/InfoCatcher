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
const NEWS_RUNTIME_DIR = path.join(NEWS_DIR, 'runtime');
const NEWS_OUTPUT_DIR = path.join(NEWS_DIR, 'output');
const COMPARISON_DIR = path.join(DATA_DIR, 'comparison'); // 模型对比：独立数据层（抓取 raw + 前端 integrated）
const COMPARISON_RAW_DIR = path.join(COMPARISON_DIR, 'raw'); // 4 源原样快照（管线写，前端不读）
const COMPARISON_INTEGRATED_DIR = path.join(COMPARISON_DIR, 'integrated'); // 前端唯一入口层（管线重建，前端只读）
const SHARED_DIR = path.join(DATA_DIR, 'shared'); // 跨模块共享数据段（comparison 写 / catalog 读，只数据耦合不代码耦合）
const REGISTRIES_DIR = path.join(DATA_DIR, 'manual', 'registries'); // 官方登记表与政策（URL/产品登记表、系列政策与 vibe-hub 缓存）
const TOOLS_DIR = path.join(DATA_DIR, 'manual', 'tools'); // 工具链路工作目录
const CONCEPTS_DIR = path.join(DATA_DIR, 'manual', 'concepts'); // 概念链路工作目录
const FIXTURE_DIR = path.join(TESTS_DIR, 'fixtures');
const AI_CONFIG_FILES = Object.freeze({
  local: path.join(PROJECT_DIR, 'config', 'catalog-generator.local.json'),
  example: path.join(PROJECT_DIR, 'config', 'catalog-generator.example.json'),
});

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
  newsRuntime: NEWS_RUNTIME_DIR,
  newsOutput: NEWS_OUTPUT_DIR,
  comparison: COMPARISON_DIR,
  comparisonRaw: COMPARISON_RAW_DIR,
  comparisonIntegrated: COMPARISON_INTEGRATED_DIR,
  shared: SHARED_DIR, // 跨模块共享数据段（retention / model-release-dates）
  fixtures: FIXTURE_DIR,
  registries: REGISTRIES_DIR, // 官方登记表与政策（URL/产品登记表、系列政策与 vibe-hub 缓存）
  tools: TOOLS_DIR, // 工具链路工作目录（工具种子/草稿/工具待补卡）
  concepts: CONCEPTS_DIR, // 概念链路工作目录（概念待补卡/合成预览）
  manual: path.join(DATA_DIR, 'manual'), // 新闻人工清单（review/top/keyword-refine/transcript-requests）
});

const REGISTRIES_FILES = Object.freeze({
  urlRegistry: path.join(REGISTRIES_DIR, 'official-url-registry.json'), // 厂商/模型人工官方 URL 登记表
  productUrlRegistry: path.join(REGISTRIES_DIR, 'official-product-url-registry.json'), // AI 产品官方 URL 登记表
  seriesPolicy: path.join(REGISTRIES_DIR, 'llm-series-policy.json'), // 厂商 LLM 系列分类政策
  vibeHubCache: path.join(REGISTRIES_DIR, 'vibe-hub-cache.json'), // vibe-hub 概念页本地缓存
});

const DATA_FILES = Object.freeze({
  registries: REGISTRIES_FILES,
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

const CATALOG_GENERATOR_FILES = Object.freeze({
  draftsDir: path.join(TOOLS_DIR, 'catalog-drafts'),
  urlRegistry: REGISTRIES_FILES.urlRegistry, // 厂商/模型人工官方 URL 登记表（批量解析第一道命中源）
  productUrlRegistry: REGISTRIES_FILES.productUrlRegistry, // AI 产品官方 URL 登记表（由 registry Module 统一读取）
  batchSeedsPreview: path.join(TOOLS_DIR, 'batch-seeds-preview.json'), // 工具 batch dry-run 解析预览
  pendingTools: path.join(TOOLS_DIR, 'tool-cards-pending.json'), // 工具待补卡（feedback 产物，batch 输入）
  localConfig: AI_CONFIG_FILES.local,
  exampleConfig: AI_CONFIG_FILES.example,
  lock: path.join(CATALOG_DIR, '.catalog.lock'),
  transactionDir: path.join(CATALOG_DIR, '.transactions'),
  stagingDir: path.join(CATALOG_DIR, '.staging'),
  backupDir: path.join(CATALOG_DIR, '.backup'),
  journal: path.join(CATALOG_DIR, '.transactions', 'journal.json'),
  audit: path.join(CATALOG_DIR, '.transactions', 'audit.json'),
  dateAudit: path.join(TOOLS_DIR, 'catalog-date-audit.json'), // 日期语义审计清单（只读正式 catalog 后生成）
  toolUpdateReview: path.join(TOOLS_DIR, 'tool-update-review.json'), // 编程工具更新人工审核清单（后续步骤使用）
  seriesPolicy: REGISTRIES_FILES.seriesPolicy, // 厂商 LLM 系列分类政策（阶段 1 政策契约，阶段 2 迁移与阶段 4 AI 分类规则源）
});

const CONCEPT_FILES = Object.freeze({
  previews: path.join(CONCEPTS_DIR, 'concept-previews.json'), // 概念批量：DeepSeek 合成预览（待维护者 apply）
  vibeHubCache: REGISTRIES_FILES.vibeHubCache, // 概念批量：vibe-hub 概念页本地缓存（TTL 3 天）
  pendingConcepts: path.join(CONCEPTS_DIR, 'concept-cards-pending.json'), // 概念待补卡（feedback 产物，batch 输入）
});

const NEWS_FILES = Object.freeze({
  configV2: path.join(NEWS_CONFIG_DIR, 'news-config-v2.json'), // 热点管线 v2：采集/评分/审核/收尾配置
  minCandidates: path.join(NEWS_RUNTIME_DIR, 'min-candidates.json'),  // 热点管线 v2：单状态轴候选层，不发布到 dist/
  minCandidatesHistory: path.join(NEWS_RUNTIME_DIR, 'min-candidates-history.json'), // 热点管线 v2：最近 30 批候选轻量历史（仅 id/title），不发布到 dist/
  sourceHistory: path.join(NEWS_RUNTIME_DIR, 'source-history.json'),  // 评分 v2：来源长期质量历史库，不发布到 dist/
  lastRun: path.join(NEWS_RUNTIME_DIR, 'last-run.json'),              // 热点管线 v2：最后一次采集运行记录（ai-top 判定 hasYouTube 用），不发布到 dist/
  scheduleState: path.join(NEWS_RUNTIME_DIR, 'schedule-state.json'),  // 热点管线 v2：YouTube 调度到期闸状态（上次调度采集时间），仅 CI 调度运行写入，不发布到 dist/
  hotspots: path.join(NEWS_OUTPUT_DIR, 'hotspots.json'),              // 公开热点投影，发布到 dist/
});

// 模型对比数据层（data/comparison）：抓取编排配置 + 前端 integrated + raw 快照。
// 生命周期/语义/校验/许可与 catalog 四隔离，不入 catalog。管线不覆盖 view-config/models-alias。
const COMPARISON_FILES = Object.freeze({
  refreshConfig: path.join(COMPARISON_DIR, 'refresh-config.json'), // 抓取编排配置（频率/fullEvery/config 清单/count 状态）
  viewConfig: path.join(COMPARISON_DIR, 'view-config.json'),       // 前端展示配置（维护者可改，管线不覆盖）
  modelsAlias: path.join(COMPARISON_DIR, 'models-alias.json'),     // 主键对齐人工登记表（管线读取）
  modelExclusions: path.join(COMPARISON_DIR, 'model-exclusions.json'), // integrated 重建的整系列排除规则（raw 不删除）
  modelSeries: path.join(COMPARISON_DIR, 'model-series.json'),     // 系列分组人工登记与成员展示规则
  rawOpenRouter: path.join(COMPARISON_RAW_DIR, 'openrouter.json'),
  rawLmarena: path.join(COMPARISON_RAW_DIR, 'lmarena.json'),
  rawLivebench: path.join(COMPARISON_RAW_DIR, 'livebench.json'),
  rawLlmStats: path.join(COMPARISON_RAW_DIR, 'llm-stats.json'),
  integratedIndex: path.join(COMPARISON_INTEGRATED_DIR, 'index.json'),
  integratedData: path.join(COMPARISON_INTEGRATED_DIR, 'data.json'),
});

// 跨模块共享数据段（data/shared）：comparison 与 catalog 之间唯一跨层通道，只存在数据耦合。
// 每个文件单一写者、经 src/shared/ 校验接口访问（封装，业务模块不裸 fs、不读对方私有文件）：
//   retention            comparison 写（advanceRetentionToNow） / catalog prune + validate 读
//   model-release-dates  comparison 写（writeReleaseIndex）       / catalog 生成器读
//   catalog-release-dates catalog 写（落盘后发布）                / comparison 反查读
const SHARED_FILES = Object.freeze({
  retention: path.join(SHARED_DIR, 'retention.json'), // 14 个月滚动删除日期（cutoff 状态，comparison 写 / catalog prune 读）
  modelReleaseDates: path.join(SHARED_DIR, 'model-release-dates.json'), // 模型 release_date 查找索引（comparison 写 / catalog 生成器读）
  catalogReleaseDates: path.join(SHARED_DIR, 'catalog-release-dates.json'), // catalog api_model/product_variant release_date 投影（catalog 写 / comparison 反查读）
});

const RSS_FEED_PATH = path.join(PUBLIC_DIR, 'feed.xml');

module.exports = {
  DIRS,
  CATALOG_FILES,
  CATALOG_GENERATOR_FILES,
  CONCEPT_FILES,
  AI_CONFIG_FILES,
  NEWS_FILES,
  COMPARISON_FILES,
  SHARED_FILES,
  REGISTRIES_FILES,
  DATA_FILES,
  RSS_FEED_PATH,
};
