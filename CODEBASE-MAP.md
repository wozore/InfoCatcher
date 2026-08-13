# CODEBASE-MAP — 代码索引

维护约定：改动/新增/删除代码文件后，必须同步更新本文件。条目 = `文件名 — 职责。导出: 关键导出`。

## data/catalog/ — 五模块目录数据
- [vendor-cards.json](data/catalog/vendor-cards.json) — 厂商列表卡片数据；只含卡片展示、列表筛选/搜索字段和一级预览稳定引用，二级快捷入口与三级数量由目录数据动态派生。
- [tool-cards.json](data/catalog/tool-cards.json) — 工具列表卡片数据；每项仅通过 `detail_ref` 指向三级详情，卡片不重复保存详情访问门槛、状态和更新时间。
- [vendor-preview-level1.json](data/catalog/vendor-preview-level1.json) — 厂商一级预览数据；标题、描述、状态、特点和二级稳定引用由一级模块拥有，不保存固定 `tree_mode`。
- [vendor-preview-level2.json](data/catalog/vendor-preview-level2.json) — 厂商二级分组预览数据；通过 `detail_refs` 指向三级详情，不重复保存三级子卡片投影。
- [tool-preview-level3.json](data/catalog/tool-preview-level3.json) — 厂商三级预览/工具详情唯一数据源；层级由二级 `detail_refs` 表达，详情类型由 `kind` 表达，价格/访问/场景与来源信息由详情拥有。


- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录与数据文件路径常量（全仓唯一数据登记点，含五模块 catalog 文件、`NEWS_FILES.configV2`/`lastRun`）。导出: `DIRS, CATALOG_FILES, NEWS_FILES, ACQUISITION_FILES, SOURCE_LIST_PATH, RSS_FEED_PATH`
- [beijing-time.js](src/shared/beijing-time.js) — 北京时间（UTC+8 固定偏移）工具，不依赖运行环境时区（CI=UTC / 本地=北京）。导出: `BEIJING_OFFSET_MS, beijingDateKey, beijingDayKey, beijingMidnightIso`

## src/catalog/ — 目录数据接口
- [catalog-interface.js](src/catalog-interface.js) — Node 侧五模块目录唯一 Interface（列表、稳定引用解析、三级详情原子替换）。导出: `catalog, DATA_FILES, resetCatalogForTests`

## src/web/ — 前端静态站（原生 ES module，无打包器；build-dist.js 原样复制到 dist/）
- [css/style.css](src/web/css/style.css) — 全站样式；工具视图分类索引含极简编辑部科技风格、左侧独立定位、移动端横向布局与具体工具卡片主题/微纹理；厂商卡片与具体工具卡片的悬停样式作用域隔离；工具卡片适合/不适合提示使用颜色竖线
- [i18n/zh.js](src/web/i18n/zh.js) — 语言字典（试点：trending 视图 + 共享工具；未来加 en.js 等）。导出: `messages`
- [js/i18n.js](src/web/js/i18n.js) — **前端 i18n 框架核心**（两层：UI 文案 t() + 内容数据 getLocalizedField）。导出: `t, setLang, getCurrentLang, getLocalizedField, applyStaticTranslations`
- [js/main.js](src/web/js/main.js) — 入口：共享状态、导航 switchView、全部事件绑定（DOMContentLoaded 先 applyStaticTranslations，工具分类索引由 tools.js 的 ToolDirectoryView 自管理）。导出: `currentView, switchView`
- [js/catalog-interface.js](src/web/js/catalog-interface.js) — 浏览器侧五模块目录唯一 Interface（加载、查询、稳定引用解析）。导出: `catalog`
- [js/vendor-cards.js](src/web/js/vendor-cards.js) — 厂商卡片模块。导出: 默认厂商卡渲染器
- [js/tool-cards.js](src/web/js/tool-cards.js) — 工具卡片模块。导出: 默认工具卡渲染器
- [js/vendor-preview-level1.js](src/web/js/vendor-preview-level1.js) — 厂商一级预览模块。导出: 默认一级预览渲染器
- [js/vendor-preview-level2.js](src/web/js/vendor-preview-level2.js) — 厂商二级预览模块。导出: 默认二级预览渲染器
- [js/tool-preview-level3.js](src/web/js/tool-preview-level3.js) — 厂商三级预览/工具详情模块。导出: `renderToolLevel3`、默认详情渲染器

- [js/data.js](src/web/js/data.js) — 目录 Interface 兼容投影、独立数据加载、过滤、平台元数据与通用工具。导出: 五模块查询函数、各数据状态与 setter、escapeHtml/timeAgo/formatPrice 等
- [js/search.js](src/web/js/search.js) — AI 搜索全链路（首页/结果/处理/概念标记）。导出: `searchState, submitSearchHome, renderSearchResults...`
- [js/tools.js](src/web/js/tools.js) — 工具库视图（厂商/工具 Toggle）由独立 `VendorDirectoryView` / `ToolDirectoryView` 控制器分别管理；工具卡片四类主题、分组和快速索引 + 滤选 + 单级详情弹窗；具体工具/模型/套餐详情统一复用 GPT-5.6 Sol 叶节点视觉与详情渲染器，普通工具字段经适配层接入，仅 X 关闭；导出: `openDetail, openDirectoryDetail, closeModal, showModal, renderConcreteToolLeaf, getToolsViewMode, toggleToolsViewMode, renderTools...`
- [js/compare.js](src/web/js/compare.js) — 对比模式（访问、免费层、价格、场景和资料来源）。导出: `compareList, toggleCompareRef, quickCompare, renderCompare...`
- [js/featured.js](src/web/js/featured.js) — 推荐视图（精选/编辑推荐/热榜）。导出: `renderFeatured, renderFeaturedTabs...`
- [js/glossary.js](src/web/js/glossary.js) — AI 概念视图。导出: `activeGlossaryId, openGlossaryConcept, renderGlossary...`
- [js/trending.js](src/web/js/trending.js) — AI 热点视图（文案走 t()、内容走 getLocalizedField，试点）。导出: `renderTrending, openHotspotDetail, reloadHotspots...`
- [js/scenes.js](src/web/js/scenes.js) — 场景模式视图。导出: `activeSceneId, renderScenes, renderSceneDetail...`

## src/news/ — 新闻采集管线（CommonJS）
### core/ — 数据层（无网络副作用）
- [news-storage.js](src/news/core/news-storage.js) — JSON 读写 + 原子写 + 并发锁。导出: `readJson, writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock`
- [news-public-gate.js](src/news/core/news-public-gate.js) — 公开展示过滤。导出: `filterPublicItems, filterProjectionByWindow, isWithinPublicWindow, hasCompletePublicFields`

### min/ — 热点管线 v2 数据层（单状态轴审核/候选/投影 + 长期质量历史库）
- [history-store.js](src/news/min/history-store.js) — 来源长期质量历史库（source-history.json 持久化 + 三率加权长期质量分，纯本地无 API）。导出: `readHistoryStore, writeHistoryStore, appendSamples, evaluateLongTermQuality, computeThreeRateScore, sourceKeyOf, perSampleRates`
- [min-history.js](src/news/min/min-history.js) — 热点候选轻量历史（维护者手动归档；最近 30 批，每条仅保存 id/title，批次时间为北京时间 `YYYY-MM-DD-HH:MM:SS`）。导出: `readMinHistory, writeMinHistory, appendMinHistory, compactCandidates, formatBatchAt, archiveMinStore`
- [review-v2.js](src/news/min/review-v2.js) — 热点管线 v2 审核层（L0 规则硬审：字段/AI 关键词/广告 + YouTube 简介明确 AI 生成披露硬排除 → L1 AI 审：高置信 approve/discard 自动分流，争议项 pending → L2 AI 建议+人工；单状态轴 pending/approved/discarded，不依赖旧双轴；复用 content-reviewer.reviewCandidate）。导出: `l0HardFilter, l1AiReview, l2AiAdvice, applyL1Verdicts, AI_DISCLOSURE_PATTERNS, DEFAULT_COMMENTS_TOP_N, DEFAULT_AUTO_APPROVE_CONFIDENCE, DEFAULT_AUTO_DISCARD_CONFIDENCE`
- [min-store.js](src/news/min/min-store.js) — v2 单状态轴候选层读写（min-candidates.json；自动采集继续合并候选，维护者手动归档后才清空；人工结论不因重新采集重置）。导出: `readMinStore, writeMinStore, mergeCandidatesMin, setReviewStatusMin, setBatchReviewStatusMin, isMinPublicEligible, toPublicItemMin`
- [daily-projection.js](src/news/min/daily-projection.js) — v2 每日 top N 公开投影（approved 按北京时间自然日分组取前 N：含 YouTube 取 8 / 纯 X 取 5，纯逻辑不调 enrich/filter 两步）。导出: `buildDailyProjection`
- [keyword-refine.js](src/news/min/keyword-refine.js) — 人工首次审核后关键词提纯（只读 approved 顶层原文，规则召回 + DeepSeek 跨语言归并为 English 四字段清单，dateKey 北京时间，清单文件名固定 keyword-refine.json；维护者填 adopted_keywords；不直接改配置）。导出: `refineKeywords, collectApprovedOriginals, buildRuleCandidates`
- [pipeline-min.js](src/news/min/pipeline-min.js) — **热点管线 v2 总指挥（runMin 编排）**：严格读取 `collection.enabled` 统一总开关（关闭时全链零网络/零写入）→ 采集（默认 YouTube+X 并行，`options.platforms` 支持分时单平台；X credits/请求账本透传至 coverage 与 last-run）→ 去重 → L0 硬过滤 → 分类 → 评分（历史库）→ L1/L2 审核 → 候选落地 → 总结/本地化 → 自动生成待审清单（review-list，`options.autoReviewList=false` 可关）→ 每日公开投影写 hotspots.json → 写采集运行记录 last-run.json（ai-top 判定 hasYouTube 用）。X 采集窗口缺省「北京时间今天 0 点 → now」；每步失败降级记 coverage 不抛错。导出: `runMin, loadV2Config, isCollectionEnabled, normalizeNow, resolveXWindow`
- [review-list.js](src/news/min/review-list.js) — 人工审核清单：自动生成待审清单 review.json（文件名固定去掉日期后缀，date 为北京时间；带 id、只含 pending、评分倒序；已存在时追加新 pending、保留人工结论、--force 强制重建）+ 应用人工结论批量写回候选层（apply；pending 跳过、无 id 旧格式拒绝）。维护者入口：bat/after-first-review.bat、bat/archive-min.bat（归档时重置当日人工清单）。导出: `scoreOf, suggestReview, buildReviewList, mergeReviewCandidates, loadReviewList, applyReviewList`

### collectors/ — 各平台采集（会发网络请求）
- [collector-youtube-v2.js](src/news/collectors/collector-youtube-v2.js) — 热点管线 v2 的 YouTube 采集器（search.list 关键词发现，不依赖旧 quota/registry/scheduler）。导出: `collectYouTubeV2, buildItem, parseDuration, loadV2Config`
- [collector-x-v2.js](src/news/collectors/collector-x-v2.js) — 热点管线 v2 的 X(TwitterAPI.io) 采集器（博主时间窗 last_tweets + 关键词 advanced_search + 长文 article 补读；请求级 credits 预占/结算与重试预算；零/非法预算 fail closed、供应商单价/单页下界保护、超量响应完整结算并止损；独立 credits 计数，不依赖旧 quota/registry/scheduler）。导出: `collectXV2, normalizeXV2Tweet, extractArticleText, hasArticleSignal, resolveConfig, loadV2Config`

### classify/ — AI 内容分类/总结/审核建议/本地化
- [content-classifier.js](src/news/classify/content-classifier.js) — L0 规则 + L1 AI 分类编排（L0 不按娱乐/二创关键词硬排除；普通关键词仅用于分类，AIGC 披露硬排除由 review-v2 负责）。导出: `classifyRuleBased, classifyCandidate, classifyCandidates, confirmContentType`
- [content-summarizer.js](src/news/classify/content-summarizer.js) — 候选内容总结（标题+描述+字幕 → summary/key_points）。导出: `summarizeCandidate, summarizeCandidates, enrichCandidateSummaries`
- [content-reviewer.js](src/news/classify/content-reviewer.js) — AI 审核建议（标题+描述+字幕+总结 → ai_review verdict/reasons/confidence；runPool 为分类/审核并发池，供 pipeline-min 复用）。导出: `reviewCandidate, reviewCandidates, runPool`
- [content-localizer.js](src/news/classify/content-localizer.js) — 候选内容本地化（标题+描述 → localizations[locale]，原文保留顶层）。导出: `collectLocalizeSource, localizeCandidate, localizeCandidates, enrichCandidateLocalizations`
- [llm-provider.js](src/news/classify/llm-provider.js) — DeepSeek 请求封装（分类/总结/审核/本地化/关键词提纯；关键词提纯失败由调用层显式阻断）。导出: `classifyWithDeepSeek, summarizeWithDeepSeek, reviewWithDeepSeek, localizeWithDeepSeek, refineKeywordsWithDeepSeek, buildKeywordRefinePayload`

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — 网络请求 + URL/标识规范化。导出: `normalizeUrl, hash, numberOrNull, requestText, extractTweetArray`
- [scoring-v2.js](src/news/pipeline/scoring-v2.js) — 热点管线 v2 评分层（6 权重加权，长期质量来自 history-store，互动用真实三率）。导出: `assessItemV2, scoreTimelinessV2, detectLightExperienceV2, scoreSourceReliability, scoreTypePreference`
- [projection.js](src/news/pipeline/projection.js) — 公开热点投影补充（hot_score/evidence_excerpt/related_resources + 内容去重）。导出: `enrichHotspotProjection, buildRelatedTitleLexicon, dedupeItems, buildToolUrlIndex`

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口**（仅保留 v2 命令组）。导出: `parseArgs, main, minReviewCommand`
- [cmd-content.js](src/news/cli/cmd-content.js) — `classify/localize preview` 子命令（纯函数预览；批量分类/本地化已由 v2 管线内建）。导出: `classifyCommand, localizeCommand`
- [cmd-min.js](src/news/cli/cmd-min.js) — **v2 `min-review` 命令组**（操作 min-candidates.json；`refine` 从 approved 原文调 DeepSeek 生成关键词清单，`refine-apply` 校验 adopted_keywords 后原子幂等追加配置；`ai-top` 产物带 id；`top-apply` 应用 top_selected=true；`apply` 写回首审结论；`archive` 由维护者确认后把当前候选压缩为轻量历史、清空候选层，并重置 data/manual 当日人工清单）。维护者入口：bat/after-first-review.bat、bat/archive-min.bat。导出: `minReviewCommand, applyRefineKeywords, applyTopSelectedList, resolveAiTopConfig, removeManualLists, MANUAL_LIST_FILES`

### transcripts/ — 收尾环节：字幕人工获取通知（独立于主链，只写清单文件）
- [transcript-notify.js](src/news/transcripts/transcript-notify.js) — 每日"待人工获取字幕"清单（min 候选层挑评分最高 notify_count 个 YouTube，写 transcript-requests.json 交人工，文件名固定去掉日期后缀、dateKey 北京时间；不碰主链/不调采集总结）。导出: `notifyTranscripts, parseNotifyCount, scoreOf`

### feedback/ — 收尾环节：工具库/概念库反哺（独立于主链，只写待补卡文件）
- [tool-feedback.js](src/news/feedback/tool-feedback.js) — 从 approved summary 提取 AI 工具/概念名（缺省正则 / options.llmExtract 注入），与 tools.json/glossary.json 比对，缺失写 tool-cards-pending.json / concept-cards-pending.json 待补卡（文件名固定去掉日期后缀、dateKey 北京时间），不直接改知识库。导出: `feedbackFromSummaries, extractEntities, toolExists, conceptExists`

## src/content/ — 内容产物
- [generate-rss.js](src/content/generate-rss.js) — RSS 生成。导出: `getFeedItems, generateRss`
- [generate-og-image.js](src/content/generate-og-image.js) — OG 图生成。导出: `generateOgImage`

## src/acquisition/ — 工具情报采集
- [fetch-intel-http.js](src/acquisition/fetch-intel-http.js) — HTTP 抓取层。导出: `requestText, fetchToolIntel`
- [normalize-intel.js](src/acquisition/normalize-intel.js) — 价格/表格解析与合并。导出: `extractDeepSeekPricing, assignPrices, mergeIntelData...`
- [fetch-tool-intel.js](src/acquisition/fetch-tool-intel.js) — **采集入口（编排 + 汇总 re-export 14 个）**。refresh-tool-intel.yml 依赖 `collectIntelligence`
- [validate-intel.js](src/acquisition/validate-intel.js) — 情报数据校验。导出: `validate, validateSourceConfig, validateIntelData`

## src/maintenance/ — 维护校验
- [validate.js](src/maintenance/validate.js) — **校验聚合入口（require 即运行 + process.exit 0/1）**。scripts/validate.js 直接引用，CI 三处工作流依赖
- [validate-catalog.js](src/maintenance/validate-catalog.js) — catalog 数据校验。导出: `validateCatalog, validateHtml`
- [validate-news.js](src/maintenance/validate-news.js) — news 数据校验（news-config-v2 采集安全配置 + last-run X credits/request 账本 + hotspots + v2 候选层 min-candidates）。导出: `validateNews, validateMinNews, validateNewsConfig, validateLastRun`

## tests/ — 自动化回归
- [catalog-interface.test.js](tests/catalog-interface.test.js) — 五模块目录 Interface、稳定引用和工具卡→三级详情关系回归。
- [collector-x-v2.test.js](tests/news/collector-x-v2.test.js) — X 请求级 credits 硬预算回归：窗外/空长文/重试/零预算/低配置/超量响应/直接门禁。
- [news-pipeline-min.test.js](tests/news/news-pipeline-min.test.js) — v2 全链编排、总开关、采集状态汇总、credits→last-run 透传回归。
- [validate-news-config.test.js](tests/maintenance/validate-news-config.test.js) — news-config-v2 安全字段与 last-run X credits/request schema 校验。

## scripts/ — 命令入口（薄包装；src/ 为纯逻辑）
- [build-news.js](scripts/build-news.js) — 热点构建 CLI（**默认走 v2 runMin**；统一开关关闭时明确输出 disabled 且正常退出；X 采集输出 credits/请求/重试用量；`--platforms youtube|x` 分时采集；`--fixture` 注入 mock 采集跑通全链；`--min` 兼容 no-op；导出 `{ main: mainMin, mainMin, buildMinFixtureOptions }`）
- [news-cli.js](scripts/news-cli.js) — CLI 分发入口（透传 src/news/cli/news-cli，含 **`min-review` 命令组**）
- [validate.js](scripts/validate.js) — 校验聚合入口
- [build-dist.js](scripts/build-dist.js) — src/web + public + data → dist/（维护者入口：bat/build-dist.bat）
- [publish-news.js](scripts/publish-news.js) — 候选 → 公开投影 + RSS 发布（**默认走 v2：min-candidates approved 按每日 top 重建 hotspots.json**；`--min` 兼容 no-op）
- [run-after-first-review.js](scripts/run-after-first-review.js) — 首次审核结论落地后安全并行 `refine` 与 `ai-top`；任一失败仅终止本次记录子进程并整体失败。导出: `runAfterFirstReview`
- [check-secrets.js](scripts/check-secrets.js) — 密钥/高熵扫描（validate.js 反向依赖）
- [generate-og-image.js](scripts/generate-og-image.js) — OG 图生成入口

- [migrate-catalog-five-modules.js](scripts/migrate-catalog-five-modules.js) — 旧目录迁移为五模块 catalog 数据及引用报告。
- [after-first-review.bat](bat/after-first-review.bat) — 首次人工审核后：应用 review 清单，再安全并行生成关键词提纯与 AI top 清单。
- [apply-keywords.bat](bat/apply-keywords.bat) — 应用维护者填写的 keyword-refine 清单；仅更新后续采集关键词，不发布或构建。
- [apply-top.bat](bat/apply-top.bat) — 应用 top_selected 并发布公开投影。
- [build-dist.bat](bat/build-dist.bat) — 重建静态 dist。
