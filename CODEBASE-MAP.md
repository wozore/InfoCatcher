# CODEBASE-MAP — 代码索引

维护约定：改动/新增/删除代码文件后，必须同步更新本文件。条目 = `文件名 — 职责。导出: 关键导出`。

## src/shared/ — 底层公共
- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录与数据文件路径常量（全仓唯一数据登记点）。导出: `DIRS, CATALOG_FILES, NEWS_FILES, ACQUISITION_FILES, SOURCE_LIST_PATH, RSS_FEED_PATH`

## src/web/ — 前端静态站（原生 ES module，无打包器；build-dist.js 原样复制到 dist/）
- [index.html](src/web/index.html) — 8 视图 DOM + 导航骨架，入口 `<script type="module" src="js/main.js">`
- [css/style.css](src/web/css/style.css) — 全站样式
- [js/main.js](src/web/js/main.js) — 入口：共享状态、导航 switchView、全部事件绑定。导出: `currentView, switchView`
- [js/data.js](src/web/js/data.js) — 数据加载(fetch JSON) + 过滤 + 平台元数据 + 通用工具。导出: 各数据状态与 setter、escapeHtml/timeAgo/formatPrice 等
- [js/search.js](src/web/js/search.js) — AI 搜索全链路（首页/结果/处理/概念标记）。导出: `searchState, submitSearchHome, renderSearchResults...`
- [js/tools.js](src/web/js/tools.js) — 工具库视图 + 筛选 + 详情弹窗。导出: `openDetail, closeModal, showModal, renderTools...`
- [js/compare.js](src/web/js/compare.js) — 对比模式。导出: `compareList, toggleCompareRef, quickCompare, renderCompare...`
- [js/featured.js](src/web/js/featured.js) — 推荐视图（精选/编辑推荐/热榜）。导出: `renderFeatured, renderFeaturedTabs...`
- [js/glossary.js](src/web/js/glossary.js) — AI 概念视图。导出: `activeGlossaryId, openGlossaryConcept, renderGlossary...`
- [js/trending.js](src/web/js/trending.js) — AI 热点视图。导出: `renderTrending, openHotspotDetail, reloadHotspots...`
- [js/scenes.js](src/web/js/scenes.js) — 场景模式视图。导出: `activeSceneId, renderScenes, renderSceneDetail...`

## src/news/ — 新闻采集管线（CommonJS）
### core/ — 数据层（无网络副作用）
- [news-storage.js](src/news/core/news-storage.js) — JSON 读写 + 原子写 + 并发锁。导出: `readJson, writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock`
- [news-registry.js](src/news/core/news-registry.js) — 来源记录注册表。导出: `createRegistry, bulkDiscover, updateLifecycle, needsExpensiveProcessing, finalizeRegistry, pruneRegistry`
- [news-candidates.js](src/news/core/news-candidates.js) — 候选热点 store（最大 core 模块）。导出: `createCandidateStore, buildProjectionFromStore, markHeld, markAiError, reviewSummary...`
- [news-quota.js](src/news/core/news-quota.js) — 平台额度账本。导出: `createQuotaLedger, reserveQuota, consumeQuota, withQuota`
- [news-scheduler.js](src/news/core/news-scheduler.js) — 批次/时间层调度。导出: `classifyTimeLayer, validateTimeLayers, createSchedulerState, advanceLayer`
- [news-public-gate.js](src/news/core/news-public-gate.js) — 公开展示过滤。导出: `filterPublicItems, filterProjectionByWindow, isWithinPublicWindow, markAnomalousTimeCandidates`
- [news-authorization.js](src/news/core/news-authorization.js) — 待授权任务。导出: `createAuthorizationStore, createAuthorizationTask, decideAuthorization`
- [news-review-events.js](src/news/core/news-review-events.js) — 审核事件审计。导出: `createReviewEventLog, appendReviewEvent, recordReviewTransition`

### collectors/ — 各平台采集（会发网络请求）
- [news-youtube.js](src/news/collectors/news-youtube.js) — YouTube 采集。导出: `collectYouTubeLayerStep, collectYouTube, enrichYouTubeStatistics`
- [news-bilibili.js](src/news/collectors/news-bilibili.js) — B 站采集。导出: `collectBilibiliLayerStep, collectBilibili, probeBilibiliProvider`
- [news-x.js](src/news/collectors/news-x.js) — X(Twitter) 采集。导出: `collectX, normalizeTweet`
- [news-transcripts.js](src/news/collectors/news-transcripts.js) — 视频字幕获取/存储。导出: `fetchYouTubeTranscript, storeTranscript, enrichYouTubeTranscripts`

### classify/ — AI 内容分类
- [content-classifier.js](src/news/classify/content-classifier.js) — L0 规则 + L1 AI 分类编排。导出: `classifyRuleBased, classifyCandidate, classifyCandidates, confirmContentType`
- [llm-provider.js](src/news/classify/llm-provider.js) — DeepSeek 请求封装（失败降级）。导出: `classifyWithDeepSeek, buildDeepSeekPayload`

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — RSS/XML/推文解析规范化。导出: `decodeXml, parseFeed, normalizeRssItem, normalizeTweet, requestText`
- [scoring.js](src/news/pipeline/scoring.js) — 评分/异常检测。导出: `scoreTimeliness, assessItem, applyAnomalyDetection, computeHotScores, HEAT_DEFINITION`
- [projection.js](src/news/pipeline/projection.js) — 热点投影/关联词库。导出: `enrichHotspotProjection, buildProvenance, buildRelatedTitleLexicon, buildToolUrlIndex`
- [build-news.js](src/news/pipeline/build-news.js) — **管线入口（编排 + 汇总 re-export 31 个）**。scripts/build-news.js、publish-news.js、benchmark-news.js 依赖其导出

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口（汇总 re-export 11 个）**。导出: `parseArgs, main, FILES, 各 command`
- [cmd-sources.js](src/news/cli/cmd-sources.js) — `sources` 子命令。导出: `sourceCommand, normalizeTags, validateSource, importSources`
- [cmd-content.js](src/news/cli/cmd-content.js) — `content/classify/transcript` 子命令。导出: `contentCommand, classifyCommand, transcriptCommand`
- [cmd-ops.js](src/news/cli/cmd-ops.js) — `authorization/quota/lock` 子命令。导出: `authorizationCommand, quotaCommand, lockCommand, optionalNumber`
- [cmd-registry.js](src/news/cli/cmd-registry.js) — `registry/review` 子命令。导出: `registryCommand, reviewCommand, legacyCommand`

## src/content/ — 内容产物
- [generate-rss.js](src/content/generate-rss.js) — RSS 生成。导出: `getFeedItems, generateRss`
- [generate-og-image.js](src/content/generate-og-image.js) — OG 图生成。导出: `generateOgImage`
- [news-manual.js](src/content/news-manual.js) — B 站人工条目规范化/导入。导出: `parseBilibiliUrl, normalizeManualItem, importManualItems`

## src/acquisition/ — 工具情报采集
- [fetch-intel-http.js](src/acquisition/fetch-intel-http.js) — HTTP 抓取层。导出: `requestText, fetchToolIntel`
- [normalize-intel.js](src/acquisition/normalize-intel.js) — 价格/表格解析与合并。导出: `extractDeepSeekPricing, assignPrices, mergeIntelData...`
- [fetch-tool-intel.js](src/acquisition/fetch-tool-intel.js) — **采集入口（编排 + 汇总 re-export 14 个）**。refresh-tool-intel.yml 依赖 `collectIntelligence`
- [validate-intel.js](src/acquisition/validate-intel.js) — 情报数据校验。导出: `validate, validateSourceConfig, validateIntelData`

## src/maintenance/ — 维护校验
- [validate.js](src/maintenance/validate.js) — **校验聚合入口（require 即运行 + process.exit 0/1）**。scripts/validate.js 直接引用，CI 三处工作流依赖
- [validate-catalog.js](src/maintenance/validate-catalog.js) — catalog 数据校验。导出: `validateCatalog, validateHtml`
- [validate-news.js](src/maintenance/validate-news.js) — news 数据校验。导出: `validateNews`
- [sync-news-sources.js](src/maintenance/sync-news-sources.js) — 热点源清单 → sources.json 同步。导出: `parseMarkdown, tagsFrom, main`

## scripts/ — 命令入口（薄包装；src/ 为纯逻辑）
- [build-news.js](scripts/build-news.js) / [news-cli.js](scripts/news-cli.js) / [sync-news-sources.js](scripts/sync-news-sources.js) / [validate.js](scripts/validate.js) — 各 re-export src/ 对应入口
- [build-dist.js](scripts/build-dist.js) — src/web + public + data → dist/
- [publish-news.js](scripts/publish-news.js) — 候选 → 公开投影 + RSS 发布
- [benchmark-news.js](scripts/benchmark-news.js) — 管线性能基准
- [check-secrets.js](scripts/check-secrets.js) — 密钥/高熵扫描（validate.js 反向依赖）
- [generate-og-image.js](scripts/generate-og-image.js) — OG 图生成入口
- [np6-analysis.js](scripts/np6-analysis.js) — 一次性运行时数据分析脚本
