# CODEBASE-MAP — 代码索引

维护约定：改动/新增/删除代码文件后，必须同步更新本文件。条目 = `文件名 — 职责。导出: 关键导出`。

## src/shared/ — 底层公共
- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录与数据文件路径常量（全仓唯一数据登记点，含 `NEWS_FILES.configV2`/`lastRun`）。导出: `DIRS, CATALOG_FILES, NEWS_FILES, ACQUISITION_FILES, SOURCE_LIST_PATH, RSS_FEED_PATH`

## src/web/ — 前端静态站（原生 ES module，无打包器；build-dist.js 原样复制到 dist/）
- [index.html](src/web/index.html) — 8 视图 DOM + 导航骨架，入口 `<script type="module" src="js/main.js">`（trending 视图静态文案已 data-i18n 化）
- [css/style.css](src/web/css/style.css) — 全站样式
- [i18n/zh.js](src/web/i18n/zh.js) — 语言字典（试点：trending 视图 + 共享工具；未来加 en.js 等）。导出: `messages`
- [js/i18n.js](src/web/js/i18n.js) — **前端 i18n 框架核心**（两层：UI 文案 t() + 内容数据 getLocalizedField）。导出: `t, setLang, getCurrentLang, getLocalizedField, applyStaticTranslations`
- [js/main.js](src/web/js/main.js) — 入口：共享状态、导航 switchView、全部事件绑定（DOMContentLoaded 先 applyStaticTranslations）。导出: `currentView, switchView`
- [js/data.js](src/web/js/data.js) — 数据加载(fetch JSON) + 过滤 + 平台元数据 + 通用工具（timeAgo/formatMetric/标签已接入 i18n 字典）。导出: 各数据状态与 setter、escapeHtml/timeAgo/formatPrice 等
- [js/search.js](src/web/js/search.js) — AI 搜索全链路（首页/结果/处理/概念标记）。导出: `searchState, submitSearchHome, renderSearchResults...`
- [js/tools.js](src/web/js/tools.js) — 工具库视图 + 筛选 + 详情弹窗。导出: `openDetail, closeModal, showModal, renderTools...`
- [js/compare.js](src/web/js/compare.js) — 对比模式。导出: `compareList, toggleCompareRef, quickCompare, renderCompare...`
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
- [review-v2.js](src/news/min/review-v2.js) — 热点管线 v2 审核层（L0 规则硬审 → L1 AI 审 → L2 AI 建议+人工；单状态轴 pending/discarded，不依赖旧双轴；复用 content-reviewer.reviewCandidate）。导出: `l0HardFilter, l1AiReview, l2AiAdvice, applyL1Verdicts, DEFAULT_COMMENTS_TOP_N, DEFAULT_AUTO_DISCARD_CONFIDENCE`
- [min-store.js](src/news/min/min-store.js) — v2 单状态轴候选层读写（min-candidates.json，人工结论不因重新采集重置；仅供 pipeline-min 等编排使用）。导出: `readMinStore, writeMinStore, mergeCandidatesMin, setReviewStatusMin, setBatchReviewStatusMin, isMinPublicEligible, toPublicItemMin`
- [daily-projection.js](src/news/min/daily-projection.js) — v2 每日 top N 公开投影（approved 按天分组取前 N：含 YouTube 取 8 / 纯 X 取 5，纯逻辑不调 enrich/filter 两步）。导出: `buildDailyProjection`
- [keyword-refine.js](src/news/min/keyword-refine.js) — 关键词提纯候选（收尾环节，每天一次：非 discarded 原文词频 + 新兴候选，输出候选清单交人工确认，**不直接改 ai_keywords**）。导出: `refineKeywords, tokenize, buildWordFreq, emergingByHistory`
- [pipeline-min.js](src/news/min/pipeline-min.js) — **热点管线 v2 总指挥（runMin 编排）**：采集(默认 YouTube+X 并行，`options.platforms` 支持分时单平台) → 去重 → L0 硬过滤 → 分类 → 评分(历史库) → L1/L2 审核 → 候选落地 → 总结/本地化 → 自动生成待审清单（review-list，`options.autoReviewList=false` 可关）→ 每日公开投影写 hotspots.json → 写采集运行记录 last-run.json（ai-top 判定 hasYouTube 用）。每步失败降级记 coverage 不抛错。导出: `runMin, loadV2Config, normalizeNow, resolveXWindow`
- [review-list.js](src/news/min/review-list.js) — 人工审核清单：自动生成待审清单 review-<date>.json（带 id、只含 pending、评分倒序、覆盖保护）+ 应用人工结论批量写回候选层（apply；pending 跳过、无 id 旧格式拒绝）。维护者一键入口：bat/apply-review.bat（应用后自动生成 top 名单）。导出: `scoreOf, suggestReview, buildReviewList, loadReviewList, applyReviewList`

### collectors/ — 各平台采集（会发网络请求）
- [collector-youtube-v2.js](src/news/collectors/collector-youtube-v2.js) — 热点管线 v2 的 YouTube 采集器（search.list 关键词发现，不依赖旧 quota/registry/scheduler）。导出: `collectYouTubeV2, buildItem, parseDuration, loadV2Config`
- [collector-x-v2.js](src/news/collectors/collector-x-v2.js) — 热点管线 v2 的 X(TwitterAPI.io) 采集器（博主时间窗 last_tweets + 关键词 advanced_search + 长文 article 补读，独立 credits 计数，不依赖旧 quota/registry/scheduler）。导出: `collectXV2, normalizeXV2Tweet, extractArticleText, hasArticleSignal, resolveConfig, loadV2Config`

### classify/ — AI 内容分类/总结/审核建议/本地化
- [content-classifier.js](src/news/classify/content-classifier.js) — L0 规则 + L1 AI 分类编排。导出: `classifyRuleBased, classifyCandidate, classifyCandidates, confirmContentType`
- [content-summarizer.js](src/news/classify/content-summarizer.js) — 候选内容总结（标题+描述+字幕 → summary/key_points）。导出: `summarizeCandidate, summarizeCandidates, enrichCandidateSummaries`
- [content-reviewer.js](src/news/classify/content-reviewer.js) — AI 审核建议（标题+描述+字幕+总结 → ai_review verdict/reasons/confidence；runPool 为分类/审核并发池，供 pipeline-min 复用）。导出: `reviewCandidate, reviewCandidates, runPool`
- [content-localizer.js](src/news/classify/content-localizer.js) — 候选内容本地化（标题+描述 → localizations[locale]，原文保留顶层）。导出: `collectLocalizeSource, localizeCandidate, localizeCandidates, enrichCandidateLocalizations`
- [llm-provider.js](src/news/classify/llm-provider.js) — DeepSeek 请求封装（分类/总结/审核/本地化，失败降级）。导出: `classifyWithDeepSeek, summarizeWithDeepSeek, reviewWithDeepSeek, localizeWithDeepSeek, buildDeepSeekPayload, buildSummaryPayload, buildReviewPayload, buildLocalizePayload`

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — 网络请求 + URL/标识规范化。导出: `normalizeUrl, hash, numberOrNull, requestText, extractTweetArray`
- [scoring-v2.js](src/news/pipeline/scoring-v2.js) — 热点管线 v2 评分层（6 权重加权，长期质量来自 history-store，互动用真实三率）。导出: `assessItemV2, scoreTimelinessV2, detectLightExperienceV2, scoreSourceReliability, scoreTypePreference`
- [projection.js](src/news/pipeline/projection.js) — 公开热点投影补充（hot_score/evidence_excerpt/related_resources + 内容去重）。导出: `enrichHotspotProjection, buildRelatedTitleLexicon, dedupeItems, buildToolUrlIndex`

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口**（仅保留 v2 命令组）。导出: `parseArgs, main, minReviewCommand`
- [cmd-content.js](src/news/cli/cmd-content.js) — `classify/localize preview` 子命令（纯函数预览；批量分类/本地化已由 v2 管线内建）。导出: `classifyCommand, localizeCommand`
- [cmd-min.js](src/news/cli/cmd-min.js) — **v2 `min-review` 命令组**（操作 min-candidates.json，不触碰旧候选层；list 支持 `--top N` 按评分取前 N 供人工审，缺省读 review_top_pure_x / review_top_with_youtube；`ai-top` 从 approved 调 AI 挑 top 待选项，有 YouTube 判定按 **last-run.json 实际采到内容 items>0**（15）否则 10，失败一律抛错；`apply` 从待审清单批量应用人工结论。维护者一键入口：bat/apply-review.bat（应用结论 + 自动生成 top 名单两步连续）。导出: `minReviewCommand, scoreOf, loadV2Config, assertStoreFlag, hasYouTubeInLastRun, resolveAiTopConfig`

### transcripts/ — 收尾环节：字幕人工获取通知（独立于主链，只写清单文件）
- [transcript-notify.js](src/news/transcripts/transcript-notify.js) — 每日"待人工获取字幕"清单（min 候选层挑评分最高 notify_count 个 YouTube，写 transcript-requests-<YYYYMMDD>.json 交人工，不碰主链/不调采集总结）。导出: `notifyTranscripts, parseNotifyCount, scoreOf`

### feedback/ — 收尾环节：工具库/概念库反哺（独立于主链，只写待补卡文件）
- [tool-feedback.js](src/news/feedback/tool-feedback.js) — 从 approved summary 提取 AI 工具/概念名（缺省正则 / options.llmExtract 注入），与 tools.json/glossary.json 比对，缺失写 tool-cards-pending / concept-cards-pending-<YYYYMMDD>.json 待补卡，不直接改知识库。导出: `feedbackFromSummaries, extractEntities, toolExists, conceptExists`

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
- [validate-news.js](src/maintenance/validate-news.js) — news 数据校验（hotspots + v2 候选层 min-candidates）。导出: `validateNews`

## scripts/ — 命令入口（薄包装；src/ 为纯逻辑）
- [build-news.js](scripts/build-news.js) — 热点构建 CLI（**默认走 v2 runMin**；`--platforms youtube|x` 分时采集；`--fixture` 注入 mock 采集跑通全链；`--min` 兼容 no-op；导出 `{ main: mainMin, mainMin, buildMinFixtureOptions }`）
- [news-cli.js](scripts/news-cli.js) — CLI 分发入口（透传 src/news/cli/news-cli，含 **`min-review` 命令组**）
- [validate.js](scripts/validate.js) — 校验聚合入口
- [build-dist.js](scripts/build-dist.js) — src/web + public + data → dist/
- [publish-news.js](scripts/publish-news.js) — 候选 → 公开投影 + RSS 发布（**默认走 v2：min-candidates approved 按每日 top 重建 hotspots.json**；`--min` 兼容 no-op）
- [check-secrets.js](scripts/check-secrets.js) — 密钥/高熵扫描（validate.js 反向依赖）
- [generate-og-image.js](scripts/generate-og-image.js) — OG 图生成入口
