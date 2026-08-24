# CODEBASE-MAP — 代码索引

维护约定：改动/新增/删除代码文件后，必须同步更新本文件。条目 = `文件名 — 职责。导出: 关键导出`。

## data/catalog/ — 五模块目录数据
- [vendor-cards.json](data/catalog/vendor-cards.json) — 厂商列表卡片数据；只含卡片展示、访问/价格判断、搜索字段和一级预览稳定引用，不保存场景推荐字段，二级快捷入口与三级数量由目录数据动态派生。
- [tool-cards.json](data/catalog/tool-cards.json) — 工具列表卡片数据；包含具体工具和 API 模型工具，不包含订阅套餐；通过 `detail_ref` 指向三级详情，卡片不重复保存三级来源与价格详情。
- [vendor-preview-level1.json](data/catalog/vendor-preview-level1.json) — 厂商一级预览数据；标题、描述、状态、特点和二级稳定引用由一级模块拥有。
- [vendor-preview-level2.json](data/catalog/vendor-preview-level2.json) — 厂商二级分组预览数据；通过 `detail_refs` 指向三级详情，不重复保存来源或三级子卡片投影。
- [tool-preview-level3.json](data/catalog/tool-preview-level3.json) — 厂商三级预览/工具详情唯一数据源；由 `detail_kind` 区分工具、API 模型和订阅套餐，层级由二级 `detail_refs` 表达，价格/访问/场景与来源信息由详情拥有。
- [scenes.json](data/catalog/scenes.json) — 场景演示数据（AI 搜索示例 + 场景模式共用）；`name`/`search_terms` 为关键词索引词表，`description` 为场景导语，`example` 为搜索首页「你可以试试」的自然语言示例问句（点击整句填入输入框，按关键词索引命中对应场景）。

## data/manual/archive/ — 生成器与概念链路归档数据
- [official-url-registry.json](data/manual/archive/official-url-registry.json) — 厂商/模型人工官方 URL 登记表；只保存厂商级来源与模型前缀，产品来源位于独立产品登记表。
- [official-product-url-registry.json](data/manual/archive/official-product-url-registry.json) — 具体 AI 产品官方来源登记表；通过 `vendor_key` 引用厂商登记，含产品别名、词边界前缀和 lifecycle/核验日期。

## data/comparison/ — 模型对比数据层（独立于 catalog，四隔离）
- [refresh-config.json](data/comparison/refresh-config.json) — 抓取编排配置（每源 interval_hours/full_every/count/last_run，管线专用）。
- [view-config.json](data/comparison/view-config.json) — 前端展示配置（默认维度/雷达上限/模型上限，维护者可改，管线不覆盖）。
- [models-alias.json](data/comparison/models-alias.json) — 主键对齐人工登记表（canonical → 各源原始名别名）及 catalog 标题/tool_key → canonical 的 `catalog_aliases` 人工桥接；管线与前端读取。
- [model-exclusions.json](data/comparison/model-exclusions.json) — integrated 重建的整系列排除登记表；按 vendor + token-boundary identity prefix 或 exact identity 过滤，保留 raw 快照不删除。
- [model-series.json](data/comparison/model-series.json) — 模型系列人工登记与成员展示规则；只组织现有 canonical，不改变跨源实体或评测分数。
- [integrated/index.json](data/comparison/integrated/index.json) — 前端唯一入口层（小）：模型列表 + composite_score + degrees + sources + `file` 指针。
- [integrated/data.json](data/comparison/integrated/data.json) — 前端懒加载完整层：dimensions/lmarena_scores/livebench_scores/composite/pricing/value。
## 根领域文档
- [CONTEXT.md](CONTEXT.md) — catalog 领域词汇表；定义 CatalogProfile、ResearchScope、OfficialSource、FieldCoverage、DerivedField、LayerPatch、CatalogDraft、Readiness 与 Apply。

## src/shared/ — 跨模块基础能力
- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录、catalog 文件与生成器事务路径常量，以及统一 AI 配置文件路径（全仓唯一数据登记点，含五模块 catalog、厂商/产品官方 URL 登记表、草案、锁、staging、backup、journal 与概念链路 previews/vibeHubCache；data/manual 下分 archive 喂 AI 搜索历史 / tools 工具链路 / concepts 概念链路，待补卡路径已收拢为 CATALOG_GENERATOR_FILES.pendingTools / CONCEPT_FILES.pendingConcepts）。导出: `DIRS, CATALOG_FILES, CATALOG_GENERATOR_FILES, CONCEPT_FILES, AI_CONFIG_FILES, NEWS_FILES, ACQUISITION_FILES, SOURCE_LIST_PATH, RSS_FEED_PATH`
- [ai-provider-registry.js](src/shared/ai-provider-registry.js) — AI provider 注册表、Responses/Messages 协议枚举、provider 到 `.env` Key 字段映射和解析。导出: `AI_PROTOCOLS, AI_PROVIDERS, getProvider, resolveProvider, apiKeyForProvider`
- [ai-config.js](src/shared/ai-config.js) — 按业务大模块读取、合并和校验 provider/model/protocol 与 Tavily retrieval 配置。导出: `DEFAULT_MODULE_CONFIGS, readAiConfig, loadAiModuleConfig, validateModuleConfig`
- [deepseek-client.js](src/shared/deepseek-client.js) — provider-aware Responses transport、认证/HTTP/超时错误归一化；保留 DeepSeek 兼容包装；endpoint 校验放行本地 localhost HTTP（本地 Bonsai 接入点）。导出: `requestResponses, requestDeepSeek, textFromResponse`
- [llm-endpoints.js](src/shared/llm-endpoints.js) — 本地 Bonsai 模型 OpenAI 兼容端点与模型名常量（news 侧 5 个 + catalog 侧 3 个本地化任务统一引用）。导出: `LOCAL_API_BASE, LOCAL_MODEL`
- [local-model.js](src/shared/local-model.js) — 本地 Bonsai 自动启动：调用本地 LLM 前确保服务在线——探测离线自动 spawn 启动脚本并轮询就绪（幂等 TTL 缓存、超时后 TTL 内不重复拉起）；注入自定义 fetchImpl（测试 mock）一律放行不探测不启动。导出: `LOCAL_MODEL_SCRIPT, buildProbePayload, probeLocal, startLocalServer, ensureLocalModel, resetLocalModelState, autostartEnabled`
- [tavily-client.js](src/shared/tavily-client.js) — Tavily Search/Extract 原生 fetch transport；keyless/keyed 按端点混用认证（search/extract 默认 keyless 免费、缺 key 可用，任意 keyless 429 都自动切 keyed 并进入冷却，冷却后恢复 keyless；cap code/detail 用于诊断，本地节流/冷却可注入）、Key/HTTP/超时错误归一化和 URL canonicalization。导出: `SEARCH_ENDPOINT, EXTRACT_ENDPOINT, canonicalizeUrl, resolveAccessMode, isKeylessCapResult, searchTavily, extractTavily, probeTavily`

## src/catalog/ — 目录数据接口与生成器
- [catalog-interface.js](src/catalog-interface.js) — Node 侧五模块目录唯一 Interface；三级批量替换委托共同事务。导出: `catalog, DATA_FILES, resetCatalogForTests`
- [catalog-contract.js](src/catalog/catalog-contract.js) — 五模块字段、枚举、引用和快照形状契约。导出: `AREAS, ALLOWED_FIELDS, DETAIL_KINDS, TOOL_CARD_KINDS, THEMES`
- [catalog-snapshot-validator.js](src/catalog/catalog-snapshot-validator.js) — FutureSnapshot 兼容性结构/引用纯校验；严格新记录完整性由 catalog-record-completeness 单独门禁。导出: `validateCatalogSnapshot`
- [catalog-record-completeness.js](src/catalog/catalog-record-completeness.js) — schema v3 正式记录字段齐全和非缺省门禁，拒绝 null、空字符串、空数组、unknown/未知。导出: `NOT_APPLICABLE_STATUS, FORBIDDEN_PLACEHOLDERS, isExplicitValue, validatePlannedRecords`
- [catalog-profile-contract.js](src/catalog/catalog-profile-contract.js) — 按 `detail_kind + modality` 选择 CatalogProfile，计算适用谓词、ResearchScope、稳定目标 ID 与逐层 create/replace/noop LayerPlan；父层缺少新分组/详情稳定引用时规划 `replace + link_only`，仅维护关系且不增加研究范围。导出: `PROFILE_DEFINITIONS, VENDOR_PREDICATES, GROUP_PREDICATES, inferModality, planCatalogResearch`
- [catalog-research.js](src/catalog/catalog-research.js) — Tavily 来源发现与正文获取编排（discover+acquire）、官方域名信任、URL canonicalization、字段级增量 resume（按缺失字段收敛到对应层 scope）和硬 CostLedger 深 Module；保留预算/Adapter 失败时的来源进度。导出: `DEFAULT_LIMITS, createCostLedger, canonicalizeUrl, officialRootsOf, isTrustedOfficialUrl, sourceIdOf, sourcesForScope, scopeKindsOfFields, researchCatalog`
- [catalog-synthesis.js](src/catalog/catalog-synthesis.js) — 按层从官方来源正文合成完整记录和来源 provenance（source_ids）；字段级 FieldCoverage 覆盖门禁，api_model 缺 access/price 关键字段建议 product_variant，字段值缺省/占位 fail-closed；对 `link_only` 父层只克隆当前记录并确定性追加子级引用，不重写父级字段。导出: `DETAIL_MISMATCH_FIELDS, REQUIRED_LAYER_FIELDS, expectedLayerFields, isNonDefaultFieldValue, fieldCoverageOf, missingCoverageFailure, validateSynthesisOutput, validateLayerPatches, synthesizeCatalog`
- [catalog-draft-envelope.js](src/catalog/catalog-draft-envelope.js) — schema v3 CatalogDraft Envelope 构建与 Apply 前重算门禁；只消费 ResearchPlan、official_sources、字段级 coverage 和 LayerPatches，ready 时用 fieldCoverageOf 重算防伪造。导出: `buildCatalogDraftEnvelope, validateCatalogDraftEnvelope`
- [catalog-revision.js](src/catalog/catalog-revision.js) — 五模块稳定序列化、revision 和 preview hash。导出: `stableStringify, revisionOf, previewHashOf`
- [catalog-draft-store.js](src/catalog/catalog-draft-store.js) — schema v3 临时 Draft 创建、读取、更新、列举和删除；持久化 ResearchPlan、OfficialSources、字段级 Coverage、LayerPatches、Readiness 与成本账本。导出: `createDraft, readDraft, updateDraft, deleteDraft, listDrafts`
- [catalog-record-builders.js](src/catalog/catalog-record-builders.js) — 确定性五类记录 Builder 和业务键规范化；严格生成路径由上游契约保证非缺省输入。导出: `buildVendorCard, buildLevel1, buildLevel2, buildDetail, buildToolCard, deriveKeys`
- [catalog-change-planner.js](src/catalog/catalog-change-planner.js) — LayerPatches 到 FutureSnapshot 的确定性规划；逐层 create/replace/noop，普通 create 不静默覆盖。导出: `planCatalogPatches`
- [catalog-transaction-store.js](src/catalog/catalog-transaction-store.js) — catalog 共同锁、五文件 staging、staged dist、journal、回滚和恢复；schema v3 通过 LayerPatches 复用事务；支持带 expected revision 和精确 area/id 列表的关系安全删除；dist 目录交换在 Windows 被占用（IDE/杀软持有目录句柄）时 rename 会 EPERM，自动回退删除重建（build-dist 同法，backup_dist 兜底）。导出: `commitCatalogChange, replaceToolLevel3, removeCatalogRecords, planRecordRemoval, recoverCatalogTransaction`
- [catalog-assistant.js](src/catalog/catalog-assistant.js) — schema v3 生成器深 Module；统一离线 plan、按缺失字段研究/resume、单段合成、Review、Apply、取消和恢复 Interface；resume 的明确成本确认获得一组增量硬预算。导出: `planCatalogDraft, prepareCatalogDraft, resumeCatalogDraft, reviewCatalogDraft, applyCatalogDraft, discardCatalogDraft, recoverCatalogTransactions, researchLimits, resumeResearchLimits, estimateResearchCost, probeCatalogCapabilities`
- [catalog/ai/deepseek-structured.js](src/catalog/ai/deepseek-structured.js) — 结构化 JSON 深 Module；统一预算预占（ledger 必传，缺省 fail-closed）、JSON 外壳归一化、empty/incomplete/invalid/schema-invalid 分类和有限响应诊断；按 endpoint 分支——DeepSeek 走 Responses（reasoning/text.format），本地 Bonsai 走 Chat Completions（messages + chat_template_kwargs 关思维链），本地分支请求前经 ensureLocalModel 自动启动服务（失败报错 fail-closed）。导出: `extractJsonValues, diagnosticsOf, requestStructuredJson`
- [catalog/ai/deepseek-catalog-ai.js](src/catalog/ai/deepseek-catalog-ai.js) — DeepSeek 结构化 Catalog Adapter；单段式调用结构化深 Module，基于官方来源正文直接合成各层字段与来源 provenance；定向 repair 仅在 seed 指定日期且 `seed_official_hint` 正文包含同一日期时确定性修复 `official_date` 并绑定该来源。导出: `synthesizeLayerFields`
- [catalog/ai/catalog-synthesis-prompt.js](src/catalog/ai/catalog-synthesis-prompt.js) — 目录合成 prompt 纯函数构建；按层分组官方来源正文（截断/限量）与字段清单，保留 seed 官方来源角色与定向 repair context，要求 `official_date` 使用产品实体首次发布日期/GA 而非后续功能更新时间，生成 instructions 与 input；硬性要求 rate_cards[].conditions 非空字符串、one_m_context 必须输出（原生 1M 或 not_applicable），否则相应字段/整层列入 missing。导出: `DEFAULT_MAX_SOURCES_PER_LAYER, DEFAULT_MAX_SOURCE_CHARS, sourcesForLayer, buildSynthesisInput, buildSynthesisInstructions`
- [catalog/ai/catalog-adapters.js](src/catalog/ai/catalog-adapters.js) — 目录检索/模型 Adapter 组合；Tavily 负责来源发现和清洗正文，detail scope 会把 seed 的 `official_url` / `official_hint` 直接纳入正文提取，DeepSeek 负责单段字段合成（目录合成留 DeepSeek）；另含批量生成前置的厂商/官方源解析（Tavily 搜工具名 → 本地 Bonsai 提取厂商名+官方域名，fail-closed），能力探针回显显式 `access_mode`。导出: `buildOfficialDiscoveryQuery, discoverOfficialSources, acquireOfficialSources, probeCatalogCapabilities, createCatalogAiAdapters, buildVendorResolutionInstructions, resolveOfficialSource`
- [catalog/ai/concept-synthesis-prompt.js](src/catalog/ai/concept-synthesis-prompt.js) — 概念合成 prompt 纯函数构建；待补概念卡 + 证据（approved 摘要 + vibe-hub）→ input，分类枚举与硬规则（中文、禁编造、source.url 无把握只给 name）。导出: `DEFAULT_CONCEPT_CATEGORIES, buildConceptSynthesisInput, buildConceptSynthesisInstructions`
- [catalog/ai/concept-synthesis-ai.js](src/catalog/ai/concept-synthesis-ai.js) — 概念合成 Adapter（本地 Bonsai）；单段式调用结构化深 Module，ledger 必传 fail-closed，合成次数预占，返回 7 字段 glossary 条目（term 以待补卡为准防改词）。导出: `validateConceptValue, normalizeConceptEntry, synthesizeConceptFields`
- [catalog-batch.js](src/catalog/catalog-batch.js) — **批量生成编排层（②→③ 链路）**：待补卡 → 三层查重（正式目录/进行中 draft/同批）→ 厂商/官方源解析（人工登记表 | Tavily）→ 成本估算/全局确认 → 逐 seed prepare→review→自动 apply → 批量报告；单 seed 失败跳过保留 draft 可 resume。导出: `readPendingCards, dedupeBatchCandidates, resolveBatchCandidates, planBatchCost, runCatalogBatch, runBatchFromCards`
- [official-url-registry.js](src/catalog/official-url-registry.js) — 批量生成前置：厂商/产品人工官方 URL 登记的统一 Module；双表 loader 与 schema/引用/URL/lifecycle 校验，`lookupOfficialUrl` 按 detailKind 在产品表和厂商表之间选择匹配，返回产品来源 URL 与厂商身份。导出: `normalizeKey, loadUrlRegistry, listUrlRegistry, loadProductUrlRegistry, listProductUrlRegistry, validateProductUrlRegistry, lookupOfficialUrl, addUrlRegistryEntry, removeUrlRegistryEntry`
- [concept-batch.js](src/catalog/concept-batch.js) — **概念批量生成编排层（concept-cards-pending → 预览 → 人工 apply → glossary.json）**：查重（同批 + 正式 glossary）→ 回读 approved 摘要作主证据 + vibe-hub 自动补充 → 成本估算/确认 → 逐概念 DeepSeek 合成写预览文件 → 显式 `concept apply` 原子写 glossary（轻量，不套五层 Draft 事务）。导出: `readPendingConcepts, dedupeConceptCandidates, collectConceptEvidence, planConceptCost, runConceptBatch, readConceptPreviews, applyConceptPreviews`
- [vibe-hub-evidence.js](src/catalog/vibe-hub-evidence.js) — vibe-hub.org 概念页提取与本地缓存（纯 HTTP 零 API 成本）：term→英文 kebab slug（含中文返回 null）、JSON-LD/正文结构化提取、缓存优先 + 串行 ≥500ms 节流、TTL 默认 3 天、过期重抓。导出: `vibeHubSlugOf, extractVibeHubText, loadVibeHubCache, saveVibeHubCache, fetchVibeHubDefinition, fetchPage, refreshStaleVibeHubCache`

## src/comparison/ — 模型对比数据管线（CommonJS；抓取 4 公开源 → 重建 integrated）
- [compare-schema.js](src/comparison/compare-schema.js) — 共享契约：源 key、维度键枚举（契约 §2）、各源 raw 快照 schema 白名单（fail-closed）、口径归一化（LMArena `(x+0.3)/0.5×100`、llm-stats index `(x+20)/80×100`、benchmark accuracy×100）。导出: `SOURCES, DIMENSION_KEYS, LMARENA_CONFIGS, validateRowProjection, validateRawRows, validateLmarenaSnapshot, normalizeLmarena, normalizeIndex, normalizeBenchmark`
- [compare-http.js](src/comparison/compare-http.js) — 抓取共享 HTTP 层：合理 UA + 有限重试 + 429 指数退避 + 超时。导出: `fetchText, fetchJson`
- [compare-store.js](src/comparison/compare-store.js) — raw 快照读写（原子写临时文件 + rename）。导出: `readRawSnapshot, writeRawSnapshot, writeJsonAtomic`
- [fetch-openrouter.js](src/comparison/fetch-openrouter.js) — OpenRouter 官方免 key models API 抓取（pricing 字符串转 number，白名单投影），写 raw/openrouter.json。导出: `fetchOpenRouter, mapOpenRouterModel`
- [fetch-lmarena.js](src/comparison/fetch-lmarena.js) — LMArena 官方数据集抓取（datasets-server rows API 直取 JSON，零依赖；实测 filter 参数无效 → 每 config 限量 3 页取各榜 top + 客户端收敛 overall）。导出: `fetchLmarena`
- [fetch-livebench.js](src/comparison/fetch-livebench.js) — LiveBench 官方 CSV（table_<release>.csv + categories_<release>.json，类别分=类别内 task 均值聚合），零依赖 CSV 解析。导出: `fetchLivebench, parseCsv, aggregateGroups`
- [fetch-llm-stats.js](src/comparison/fetch-llm-stats.js) — llm-stats RSC flight payload 确定性解析（initialData 数组），字段白名单 + 值域校验 fail-closed。导出: `fetchLlmStats, extractFlightChunks, extractInitialData`
- [model-identity.js](src/comparison/model-identity.js) — 模型身份解析深 Module：安全统一厂商、跨源格式、服务方式、评测挡位与评测环境（如 `codex-harness`），保留参数/MoE/模式等实体差异；唯一返回 model_key/revision/offering/degree/evaluation_profile，人工 alias 命中优先且别名冲突 fail-closed。导出: `resolveModelIdentity, createModelIdentityResolver, parseModelNameMetadata, normalizeVendor`
- [model-series.js](src/comparison/model-series.js) — 模型系列分组深 Module：读取人工系列登记，按 series/member/configuration 三层生成稳定系列投影；revision 聚合为成员变体，canonical 不被系列合并。导出: `readSeriesConfig, seriesInfoFor, memberInfoFor, attachSeriesMetadata, validateSeriesProjection`
- [model-exclusions.js](src/comparison/model-exclusions.js) — integrated 重建排除规则深 Module：读取/严格校验 `vendor + identity_prefix` token-boundary 或 exact identity 规则，过滤 source records 并返回命中诊断；只影响 integrated，不删除 raw。导出: `validateExclusionConfig, readExclusionConfig, exclusionForModel, filterExcludedRecords`
- [identity-review.js](src/comparison/identity-review.js) — 名称歧义离线审计 Module：只收集确定性解析未分类 token，协调本地 Bonsai 建议与按阈值升级的 DeepSeek 复核；所有结果强制人工确认，不写正式 alias/数据。导出: `collectReviewCandidates, shouldEscalate, reviewCandidates`
- [identity-review-ai.js](src/comparison/identity-review-ai.js) — 名称歧义 AI 建议 Adapter：复用结构化 JSON transport，本地 Bonsai 默认、DeepSeek 可显式升级；统一 prompt/schema，ledger 缺失 fail-closed。导出: `suggestIdentityReview`
- [rebuild-comparison.js](src/comparison/rebuild-comparison.js) — **integrated 重建核心**：只消费统一模型身份解析（厂商限定 `model_key` + 明确 revision 隔离）→ 合并 4 源记录 → 先按 model-exclusions 过滤整系列 → 重新计算 Elo bounds/维度/综合分/性价比 → 系列投影；profile 分数进入 `lmarena_profiles`，不生成选择器行，同厂商同展示名最终强制追加身份消歧，写 index/data.json；排除只影响 integrated，raw 保留。导出: `rebuildIntegrated, buildModelRecord, slugify, buildAliasMap, livebenchParse, cleanModelDisplay`
- [run-comparison.js](src/comparison/run-comparison.js) — 抓取编排（cron 每日）：每源独立计数全量 + 失败隔离 WARN + 全绿才重建。导出: `runComparison, fetchSource, isFresh, readConfig`

## src/web/ — 前端静态站（原生 ES module，无打包器；build-dist.js 原样复制到 dist/）
- [index.html](src/web/index.html) — 页面骨架与八视图 HTML 结构；AI 搜索首页为左中右布局（左侧「怎么用」三步引导栏 + 中间原样搜索主区 + 右侧留白），结果页三栏答案引擎。
- [css/style.css](src/web/css/style.css) — 全站样式；工具视图分类索引含极简编辑部科技风格、左侧独立定位、移动端横向布局与具体工具卡片主题/微纹理；厂商卡片与具体工具卡片的悬停样式作用域隔离；工具卡片适合/不适合提示使用颜色竖线；搜索主区热点概念层知识块（热点在上、概念在下）；搜索首页左中右引导栏布局（<main> 限宽按 :has 条件放开，窄视口收起为单列）
- [i18n/zh.js](src/web/i18n/zh.js) — 语言字典（试点：trending 视图 + 共享工具；未来加 en.js 等）。导出: `messages`
- [js/i18n.js](src/web/js/i18n.js) — **前端 i18n 框架核心**（两层：UI 文案 t() + 内容数据 getLocalizedField）。导出: `t, setLang, getCurrentLang, getLocalizedField, applyStaticTranslations`
- [js/main.js](src/web/js/main.js) — 入口：共享状态、导航 switchView、全部事件绑定（DOMContentLoaded 先 applyStaticTranslations，工具分类索引由 tools.js 的 ToolDirectoryView 自管理）。导出: `currentView, switchView`
- [js/brand-icons.js](src/web/js/brand-icons.js) — 手工品牌图标清单加载与统一渲染；按模型→系列→工具→厂商→emoji 兜底，系列图标通过二级 detail_refs 反查应用到其全部三级详情。导出: `loadIcons, resolveSeriesKey, resolveBrandIcon, brandIconHtml`
- [icons/](src/web/icons/) — 手工维护的品牌图标资产与 `manifest.json` 映射；build-dist 原样复制到 dist/icons，二级系列 icon 不直接渲染，仅供其三级详情继承。
- [js/catalog-interface.js](src/web/js/catalog-interface.js) — 浏览器侧五模块目录唯一 Interface（加载、查询、稳定引用解析）。导出: `catalog`
- [js/vendor-cards.js](src/web/js/vendor-cards.js) — 厂商卡片模块。导出: 默认厂商卡渲染器
- [js/tool-cards.js](src/web/js/tool-cards.js) — 工具卡片模块；价格/访问状态多分支渲染，旧 `unknown` 使用中性“待核验”而不误报付费/受限；具体工具/API 模型复用详情页对比按钮。导出: `renderPriceTag, renderAccessTag`、默认工具卡渲染器。
- [js/vendor-preview-level1.js](src/web/js/vendor-preview-level1.js) — 厂商一级预览模块；旧 unknown 状态显示中性待核验。导出: 默认一级预览渲染器
- [js/vendor-preview-level2.js](src/web/js/vendor-preview-level2.js) — 厂商二级预览模块。导出: 默认二级预览渲染器
- [js/tool-preview-level3.js](src/web/js/tool-preview-level3.js) — 厂商三级预览/工具详情模块；严格场景对象、结构化 not_applicable、通用视频/图像/credit 计价与旧 token 价格兼容渲染。导出: `renderToolLevel3, renderScenario, renderRateCard, notApplicableHtml`、默认详情渲染器

- [js/data.js](src/web/js/data.js) — 五模块目录领域查询、独立数据加载、过滤、平台元数据与通用工具；不再构造旧 `tools.json` / `tool-intelligence.json` 兼容投影。导出: 五模块查询函数、各数据状态与 setter、escapeHtml/timeAgo/formatPrice 等
- [js/search.js](src/web/js/search.js) — AI 搜索视图（四层关键词索引答案引擎）：首页/处理/结果三态；首页为左中右布局（左侧「怎么用」三步引导栏 + 中间主区），「你可以试试」示例按钮用场景自然语言问句渲染（scene.example）；统一提取器 extractKeywords 从混杂查询提取关键词（≥2 字符、长词优先），三层词表依次命中——场景层（复用 scenes.json 场景搜索词，与场景模式共用映射）→ 内容层（工具卡 title/vendor_label/search_terms + 品牌短形式派生，如 gpt→GPT-5.5）→ 热点概念层（glossary 词 + 热点标题英文 token），命中后主区渲染含知识块（热点在上、概念在下）；一句话答案（内嵌 [n] 引用→工具 mini 卡）+ 左栏本页概念索引 + 右栏最新热点；「了解更多」跳工具库按 query 过滤 + 强制 tool toggle；概念词全站联动。导出: `searchState, submitSearchHome, renderSearchResults, renderSearchView, openSearchToolDetail, openSearchMoreTools...`
- [js/tools.js](src/web/js/tools.js) — 工具库视图（厂商/工具 Toggle）由独立 `VendorDirectoryView` / `ToolDirectoryView` 控制器分别管理；工具卡片四类主题、分组和快速索引 + 滤选 + 单级详情弹窗；厂商一级/二级与工具/模型/套餐三级详情统一按稳定 ref 打开，仅 X 关闭。导出: `openDetail, closeModal, showModal, getToolsViewMode, toggleToolsViewMode, setToolsViewMode, clearToolFilters, renderTools...`
- [js/compare.js](src/web/js/compare.js) — 对比视图双 tab（模型对比 ↔ 工具对比）+ 工具对比（catalog）引擎；api_model 卡 +对比 经标题→canonical 桥接路由到模型 tab、tool/套餐路由到工具 tab；isCompareSelected 模型感知。导出: `compareList, getCompareTab, setCompareTab, renderCompareView, compareKey, isCompareSelected, toggleCompareRef, compareGroupLeaves, updateCompareCount, renderCompare, removeCompare, quickCompare...`
- [js/compare-models.js](src/web/js/compare-models.js) — **模型对比引擎（读 integrated/ + view-config + models-alias）**：选择器搜索 `display/vendor/family/identity`、模型卡 `tool_key` 先经人工 `catalog_aliases` 桥接再回退 v2 identity/raw alias 到 canonical；前端只消费管线已消歧的记录，绝不按名称合并。其余：变体圆圈、综合分/性价比图表与表格能力同现有契约。导出: `renderModelCompare, bindModelCompareEvents, bridgeToCanonical, canonicalForTool, modelCompareIsSelected, modelCap, routeApiModelToCompare`
- [js/featured.js](src/web/js/featured.js) — 推荐视图（编辑精选通过工具 `tool_key` + 三级 `detail_ref` 导航，热门模型按正式工具卡 `detail_kind/theme` 分类；访问/资料状态使用中性未知语义，价格兼容通用计价单位）。导出: `renderFeatured, renderFeaturedTabs...`
- [js/glossary.js](src/web/js/glossary.js) — AI 概念视图。导出: `activeGlossaryId, openGlossaryConcept, renderGlossary...`
- [js/trending.js](src/web/js/trending.js) — AI 热点视图（文案走 t()、内容走 getLocalizedField；相关工具资源解析为正式工具卡和三级详情引用）。导出: `renderTrending, openHotspotDetail, reloadHotspots...`
- [js/scenes.js](src/web/js/scenes.js) — 场景模式视图；任务引用正式工具 `tool_key`，具体模型推荐通过完整三级 `detail_ref` 打开，复用工具卡价格/访问多状态标签避免 unknown 误报。导出: `activeSceneId, renderScenes, renderSceneDetail...`

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
- [llm-provider.js](src/news/classify/llm-provider.js) — 内容加工模型提供方封装（分类/总结/审核/本地化/选 top/关键词提纯；关键词提纯失败由调用层显式阻断）；分类留 DeepSeek（max_tokens 8 成本可忽略，本地分类有 ai_product 偏好偏差），其余 5 个任务走本地 Bonsai（LOCAL_API_BASE + chat_template_kwargs 关思维链），请求前经 ensureLocalModel 自动启动本地服务（离线自动拉起、失败报错）。导出: `classifyWithDeepSeek, summarizeWithDeepSeek, reviewWithDeepSeek, localizeWithDeepSeek, selectTopWithDeepSeek, refineKeywordsWithDeepSeek, buildKeywordRefinePayload, API_BASE, LOCAL_API_BASE, LOCAL_MODEL`

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — 网络请求 + URL/标识规范化。导出: `normalizeUrl, hash, numberOrNull, requestText, extractTweetArray`
- [scoring-v2.js](src/news/pipeline/scoring-v2.js) — 热点管线 v2 评分层（6 权重加权，长期质量来自 history-store，互动用真实三率）。导出: `assessItemV2, scoreTimelinessV2, detectLightExperienceV2, scoreSourceReliability, scoreTypePreference`
- [projection.js](src/news/pipeline/projection.js) — 公开热点投影补充（hot_score/evidence_excerpt/related_resources + 内容去重）。导出: `enrichHotspotProjection, buildRelatedTitleLexicon, dedupeItems, buildToolUrlIndex`

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口**（仅保留 v2 命令组）。导出: `parseArgs, main, minReviewCommand`
- [cmd-content.js](src/news/cli/cmd-content.js) — `classify/localize preview` 子命令（纯函数预览；批量分类/本地化已由 v2 管线内建）。导出: `classifyCommand, localizeCommand`
- [cmd-min.js](src/news/cli/cmd-min.js) — **v2 `min-review` 命令组**（操作 min-candidates.json；`feedback` 默认接入 LLM 实体提取，feedback.llm_extract=false 关 / LLM 失败降级正则；`refine` 从 approved 原文调 DeepSeek 生成关键词清单，`refine-apply` 校验 adopted_keywords 后原子幂等追加配置；`ai-top` 产物带 id；`top-apply` 应用 top_selected=true；`apply` 写回首审结论；`archive` 由维护者确认后把当前候选压缩为轻量历史、清空候选层，并重置 data/manual 当日人工清单）。维护者入口：bat/after-first-review.bat、bat/archive-min.bat。导出: `minReviewCommand, applyRefineKeywords, applyTopSelectedList, resolveAiTopConfig, removeManualLists, MANUAL_LIST_FILES`

### transcripts/ — 收尾环节：字幕人工获取通知（独立于主链，只写清单文件）
- [transcript-notify.js](src/news/transcripts/transcript-notify.js) — 每日"待人工获取字幕"清单（min 候选层挑评分最高 notify_count 个 YouTube，写 transcript-requests.json 交人工，文件名固定去掉日期后缀、dateKey 北京时间；不碰主链/不调采集总结）。导出: `notifyTranscripts, parseNotifyCount, scoreOf`

### feedback/ — 收尾环节：工具库/概念库反哺（独立于主链，只写待补卡文件）
- [tool-feedback.js](src/news/feedback/tool-feedback.js) — 从 approved summary 提取带类型实体（默认正则 / options.llmExtract 注入 LLM），按类型路由（tool/model→待补工具卡并带 detail_kind_hint、concept→待补概念卡、vague→排除），isVagueName 兜底拦截产品/平台/模型家族笼统名（可灵/通义千问等）绝不进待补工具卡；与五模块工具卡/glossary.json 比对，缺失写待补卡（data/manual/tools/tool-cards-pending.json、data/manual/concepts/concept-cards-pending.json，路径走 CATALOG_GENERATOR_FILES.pendingTools / CONCEPT_FILES.pendingConcepts），不直接改知识库。导出: `feedbackFromSummaries, extractEntities, extractEntitiesDefault, normalizeEntities, isVagueName, toolExists, conceptExists`
- [llm-entity-extract.js](src/news/feedback/llm-entity-extract.js) — 摘要 AI 实体提取（本地 Bonsai 替代默认正则）：找 AI 概念/工具/模型并输出带类型 JSON 数组 `{name,type}`（type∈tool/model/concept/vague，笼统名标 vague；完整名、排除泛称/人名/机构、检查遗漏、无则输出 []）；复用 requestStructuredJson + ledger fail-closed，缺 ledger 内部自建；调用失败抛错由 cmd-min 降级正则。导出: `ENTITY_TYPES, buildEntityExtractInstructions, validateExtractOutput, toEntityList, toNameList, extractEntitiesWithLlm`
- [catalog-draft-adapter.js](src/news/feedback/catalog-draft-adapter.js) — 将热点待补工具候选转换为 Seed（接受解析结果 vendor_name/official_url/official_urls[]，多官方 URL 全部进 discovery_sources 作 official_hint；透传候选显式 modality；保留候选显式指定的 existing level1/level2 稳定引用以加入已有分组；detail_kind 由候选 detail_kind_hint 决定——api_model→具体模型，缺省 tool→具体工具；isVagueName 拒绝笼统名 PENDING_CANDIDATE_VAGUE；不设 new_group_title 时分组名由 deriveKeys 回退 seed.name），不直接写正式目录。导出: `pendingCandidateToSeed`

## docs/manual/ — 用户说明
- [catalog-generator.md](docs/manual/catalog-generator.md) — schema v3 五模块目录生成器手册；CatalogProfile/OfficialSource/FieldCoverage/LayerPatch、plan/new/resume/review/apply、硬成本账本和恢复安全规则。
- [comparison-data-sources.md](docs/manual/comparison-data-sources.md) — 对比页数据源选型核实记录；AA/SWE-bench/LiveBench/HF Leaderboard/OpenRouter 可用通路、LMArena 仅第三方快照、DeepSWE 抓站、HF 网络镜像坑与推荐组合。
- [comparison-data-contract.md](docs/manual/comparison-data-contract.md) — 对比页数据契约（integrated 层）：文件布局、维度键枚举与归一化口径、index.json/data.json/view-config/models-alias 契约、raw 快照形状、前端渲染规则映射、i18n 键、管线实现红线。
- [icons.md](docs/manual/icons.md) — 品牌图标资产维护说明：官方 logo 获取、Simple Icons 备选、manifest 键规则和三级模型按系列继承/单模型覆盖。

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
- [validate-comparison.js](src/maintenance/validate-comparison.js) — 模型对比数据校验（先校验 model-exclusions 规则与 integrated 无命中残留，再校验 index/data 交叉一致性、canonical/同厂商 display 唯一、series/member 引用完整性、identity/evaluation_profiles 契约、degree 不得伪装评测环境、composite 与 raw 自洽、维度 0-100、view-config/models-alias 契约形状；raw 快照存在则 schema 校验、缺失优雅跳过）。导出: `validateComparison, validateIndex, validateData`

## tests/ — 自动化回归
- [catalog-interface.test.js](tests/catalog-interface.test.js) — 五模块目录 Interface、字段所有权、稳定引用、工具卡→三级详情以及场景/精选详情引用回归。
- [catalog-generator.test.js](tests/catalog/catalog-generator.test.js) — v3 官方查询、单段 Synthesis Adapter、LayerPatch planner 和 revision 回归。
- [catalog-synthesis-prompt.test.js](tests/catalog/catalog-synthesis-prompt.test.js) — 合成 prompt 按层分组、来源截断限量、跳过无正文来源与指令规则回归。
- [catalog-adapters.test.js](tests/catalog/catalog-adapters.test.js) — Tavily 官方域名发现、清洗正文、能力探针与 DeepSeek 组合 Adapter 回归。
- [catalog-batch.test.js](tests/catalog/catalog-batch.test.js) — 批量生成编排回归：读卡、三层查重、双表登记/解析/detail_kind_hint、dry-run 预览、全局成本门禁、批量循环失败隔离、登记表增删。
- [concept-batch.test.js](tests/catalog/concept-batch.test.js) — 概念批量编排回归：读卡、双层查重、approved 摘要证据匹配与 K 上限、vibe-hub 补充/失败静默、成本估算、dry-run 零网络零写入、成本门禁、合成失败隔离、预览文件、apply 必填校验/去重/合并保序/terms 子集。
- [vibe-hub-evidence.test.js](tests/catalog/vibe-hub-evidence.test.js) — vibe-hub 提取回归：term→slug（中文 null）、JSON-LD/正文结构化提取、缓存命中零网络、未命中 GET+写缓存、TTL 过期重抓、404/网络失败 null、串行节流、过期刷新与失败保留。
- [deepseek-structured.test.js](tests/catalog/deepseek-structured.test.js) — DeepSeek 结构化 JSON 外壳、空/截断/非法响应、synthesis 预算预占与缺账本回归。
- [catalog-profile-contract.test.js](tests/catalog/catalog-profile-contract.test.js) — CatalogProfile 适用性、video API 必需谓词、稳定目标与逐层 create/replace/noop 规划回归。
- [catalog-research.test.js](tests/catalog/catalog-research.test.js) — 官方域名过滤、Tavily-only 成本、字段级 missing-only resume 和硬成本账本回归。
- [catalog-synthesis.test.js](tests/catalog/catalog-synthesis.test.js) — 完整层字段合成、来源 provenance、字段级 Profile mismatch、占位/伪造覆盖拒绝和 noop 层回归。
- [catalog-transaction-store.test.js](tests/catalog/catalog-transaction-store.test.js) — 精确 area/id 删除规划、引用清理、缺失目标和不完整删除集回归。
- [catalog-draft-envelope.test.js](tests/catalog/catalog-draft-envelope.test.js) — schema v3 Readiness 字段级重算、Source 校验与旧 Draft Apply 拒绝回归。
- [catalog-pipeline-v3.test.js](tests/catalog/catalog-pipeline-v3.test.js) — Kling video API 完整/缺字段 dossier 全链 mock；五层 replace、非缺省字段、字段级 blocked 改类建议和 Assistant new/resume/review 回归。
- [kling-video-dossier.js](tests/catalog/fixtures/kling-video-dossier.js) — 完全离线的 Kling video API 官方 dossier 与受约束单段合成 Adapter fixture。导出: `OFFICIAL_URL, EXACT_QUOTE, klingVideoSeed, createKlingDossierAdapters`
- [catalog-cli.test.js](tests/catalog/catalog-cli.test.js) — CLI 参数、vendor/product 官方 URL 登记增删、纯本地 freshness audit、热点 Seed、catalog Tavily/DeepSeek 模块配置、Tavily 能力 fail-closed 和共享 DeepSeek transport 回归。
- [tavily-client.test.js](tests/shared/tavily-client.test.js) — Tavily Search/Extract 请求、Key、URL canonicalization、失败响应和正文映射回归。
- [ai-provider-registry.test.js](tests/shared/ai-provider-registry.test.js) — provider 协议、Key 环境变量映射和 Messages API fail-closed 回归。
- [ai-config.test.js](tests/shared/ai-config.test.js) — 业务模块配置合并、Tavily retrieval 配置和 protocol 校验回归。
- [collector-x-v2.test.js](tests/news/collector-x-v2.test.js) — X 请求级 credits 硬预算回归：窗外/空长文/重试/零预算/低配置/超量响应/直接门禁。
- [news-pipeline-min.test.js](tests/news/news-pipeline-min.test.js) — v2 全链编排、总开关、采集状态汇总、credits→last-run 透传回归。
- [validate-news-config.test.js](tests/maintenance/validate-news-config.test.js) — news-config-v2 安全字段与 last-run X credits/request schema 校验。
- [model-exclusions.test.js](tests/comparison/model-exclusions.test.js) — 排除规则 schema、token-boundary prefix、exact identity、命中诊断和 fail-closed 回归。
- [rebuild-comparison.test.js](tests/comparison/rebuild-comparison.test.js) — 模型对比管线回归：4 源对齐/合并、models-alias 覆盖、维度归一化、综合分缺源重分配、性价比、单源/无综合分模型、整系列排除在 Elo/value/series 前生效且不写 raw、LiveBench CSV 聚合、llm-stats RSC 解析、LMArena 快照 fail-closed。
- [model-series.test.js](tests/comparison/model-series.test.js) — 系列投影回归：系列/成员/修订变体聚合、人工成员展示名与重叠登记优先级。
- [fixtures/raw/](tests/comparison/fixtures/raw/) — 模型对比管线测试 raw 快照 fixtures（openrouter/lmarena/livebench/llm-stats 各源小样本）。

## scripts/ — 命令入口（薄包装；src/ 为纯逻辑）
- [catalog-generator.js](scripts/catalog-generator.js) — schema v3 五模块目录生成器 CLI；`plan/prepare` 零网络，`new/resume/probe/batch` 要求显式 `--tavily-access-mode` 并透传到 Tavily，Apply 要求维护者输入完整确认；支持 `remove --targets` 精确 ID 删除（revision/确认值/事务回滚）、`batch`（`--confirm-cost` 全局确认自动 apply / `--dry-run` 预览 / `--from-preview` 复用解析）以及双表 `url-registry vendor/product` 维护和纯本地 product freshness audit。导出: `parseArgs, main, readSeed, tavilyAccessModeFromFlags, generatorOptionsFromFlags`
- [concept-generator.js](scripts/concept-generator.js) — **AI 概念库生成器 CLI（与五模块目录生成器分离）**：`batch --file <待补概念卡> --dry-run/--confirm-cost` 合成预览 → `preview` → `apply [--terms]` 人工写 glossary。导出: `parseArgs, main`
- [refresh-vibe-hub-cache.js](scripts/refresh-vibe-hub-cache.js) — 定时刷新 vibe-hub 概念缓存（CI 入口，由 refresh-vibe-hub-cache.yml 每 3 天北京 19:00 调用）；只刷 `fetched_at` 距今 > 3 天 TTL 的条目，空缓存/全新鲜零网络，纯 HTTP 不读任何 Key。导出: `main`
- [news-cli.js](scripts/news-cli.js) — CLI 分发入口（透传 src/news/cli/news-cli，含 **`min-review` 命令组**）
- [fetch-comparison.js](scripts/fetch-comparison.js) — 模型对比数据管线 CLI（run 定时抓取+全绿重建 / fetch <source> 手动单跑 / rebuild / review 输出零网络零写入的待人工名称歧义清单 / status）；`.github/workflows/refresh-comparison.yml` 每日 cron 调用。
- [identity-review.bat](bat/identity-review.bat) — 模型身份歧义审计维护入口；双击调用 `fetch-comparison.js review`，只生成待人工确认清单，不调用 AI、不写正式数据。
- [validate.js](scripts/validate.js) — 校验聚合入口
- [build-dist.js](scripts/build-dist.js) — src/web + public + data → dist/（维护者入口：bat/build-dist.bat）
- [browser-acceptance.js](scripts/browser-acceptance.js) — 依赖零安装的 Edge/CDP 真实页面验收：读取被忽略的 `config/browser.local.json`，启动 dist 静态站与临时 Edge profile，检查 18 张模型卡搜索/详情、对比搜索、旧 Spark/xunfei 隐藏和排除模型不可见。
- [publish-news.js](scripts/publish-news.js) — 候选 → 公开投影 + RSS 发布（**默认走 v2：min-candidates approved 按每日 top 重建 hotspots.json**）
- [run-after-first-review.js](scripts/run-after-first-review.js) — 首次审核结论落地后安全并行 `refine` 与 `ai-top`；任一失败仅终止本次记录子进程并整体失败。导出: `runAfterFirstReview`
- [check-secrets.js](scripts/check-secrets.js) — 密钥/高熵扫描（validate.js 反向依赖）
- [generate-og-image.js](scripts/generate-og-image.js) — OG 图生成入口

- [migrate-catalog-five-modules.js](scripts/migrate-catalog-five-modules.js) — 旧目录迁移为五模块 catalog 数据及引用报告。
- [after-first-review.bat](bat/after-first-review.bat) — 首次人工审核后：应用 review 清单，再安全并行生成关键词提纯与 AI top 清单。
- [apply-keywords.bat](bat/apply-keywords.bat) — 应用维护者填写的 keyword-refine 清单；仅更新后续采集关键词，不发布或构建。
- [apply-top.bat](bat/apply-top.bat) — 应用 top_selected 并发布公开投影。
- [catalog-generator.bat](bat/catalog-generator.bat) — 五模块目录生成器维护者入口，只转发 Node CLI，不包含凭据或业务逻辑。
- [concept-generator.bat](bat/concept-generator.bat) — AI 概念库生成器维护者入口（concept-cards-pending → glossary.json），只转发 Node CLI，不包含凭据或业务逻辑。
- [build-dist.bat](bat/build-dist.bat) — 重建静态 dist。
