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
- [official-product-url-registry.json](data/manual/archive/official-product-url-registry.json) — 具体 AI 产品官方来源登记表；通过 `vendor_key` 引用厂商登记，含产品别名、词边界前缀、可选的编程工具 `update_sources` 专用更新网页契约和 lifecycle/核验日期；`official_urls` 仍供 catalog batch 使用。
- [llm-series-policy.json](data/manual/archive/llm-series-policy.json) — 厂商 LLM 二级系列分类政策（阶段 1 政策契约，唯一规则源）；声明 16 厂商的家族/用途/版本轴/目标二级系列与 evidence 状态，供阶段 2 迁移与阶段 4 AI 分类读取；未知厂商/非法规则一律 fail-closed。

## data/manual/tools/ — 工具链路人工工作数据
- [tool-update-review.json](data/manual/tools/tool-update-review.json) — 工具专用更新人工审核队列；只保存 pending/candidate 或 blocked 条目、官方 URL、日期、证据摘录、内容 hash 和五字段 AI 建议，不直接写五模块 catalog。

## data/comparison/ — 模型对比数据层（独立于 catalog，四隔离）
- [refresh-config.json](data/comparison/refresh-config.json) — 抓取编排配置（每源 interval_hours/full_every/count/last_run，管线专用）。
- [view-config.json](data/comparison/view-config.json) — 前端展示配置（默认维度/雷达上限/模型上限，维护者可改，管线不覆盖）。
- [models-alias.json](data/comparison/models-alias.json) — 主键对齐人工登记表（canonical → 各源原始名别名）及 catalog 标题/tool_key → canonical 的 `catalog_aliases` 人工桥接；管线与前端读取。
- [model-exclusions.json](data/comparison/model-exclusions.json) — integrated 重建的整系列排除登记表；按 vendor + token-boundary identity prefix 或 exact identity 过滤，保留 raw 快照不删除。
- [model-series.json](data/comparison/model-series.json) — 模型系列人工登记与成员展示规则；只组织现有 canonical，不改变跨源实体或评测分数。
- [integrated/index.json](data/comparison/integrated/index.json) — 前端唯一入口层（小）：模型列表 + composite_score + degrees + sources + `file` 指针。
- [integrated/data.json](data/comparison/integrated/data.json) — 前端懒加载完整层：dimensions/lmarena_scores/livebench_scores/composite/pricing/value/release_date/release_date_provenance。
## data/shared/ — 跨模块共享数据段（comparison ↔ catalog 双向数据耦合，每文件单一写者，经 src/shared 校验接口访问）
- [retention.json](data/shared/retention.json) — 14 个月滚动删除日期 cutoff 状态（months/retention_year_month/last_advanced_at）；comparison 经 `advanceRetentionToNow` 写、catalog prune 经 `readRetentionState` 只读。
- [model-release-dates.json](data/shared/model-release-dates.json) — 模型 release_date 查找索引（model_key + catalog_aliases）；comparison 重建经 `writeReleaseIndex` 写、catalog 生成器经 `readReleaseIndex` 机械查找只读。
- [catalog-release-dates.json](data/shared/catalog-release-dates.json) — catalog api_model/product_variant release_date 投影（detail_id/detail_kind/vendor_key/title/tool_key/release_date）；catalog 落盘后经 `writeCatalogReleaseDates` 发布、comparison 反查经 `readCatalogReleaseDates` 只读。
## 根领域文档
- [CONTEXT.md](CONTEXT.md) — catalog 领域词汇表；定义 CatalogProfile、ResearchScope、OfficialSource、FieldCoverage、DerivedField、LayerPatch、CatalogDraft、Readiness、UpdateCandidate、ToolUpdateReviewQueue 与 Apply。

## 公开项目文档
- [ABOUT.md](ABOUT.md) — 知览/KnowView 的公开定位、编辑部原则、MVP 能力边界与非个性化推荐声明。
- [SUPPORT.md](SUPPORT.md) — 普通用户反馈、GitHub 公开协作、处理时效与安全入口分流说明。
- [SECURITY.md](SECURITY.md) — 安全/隐私问题私密报告、敏感信息边界与处理政策。
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — 公开讨论和贡献的行为准则。
- [LICENSE](LICENSE) — 软件 MIT 许可证。
- [docs/manual/editorial-and-data-policy.md](docs/manual/editorial-and-data-policy.md) — AI 内容编辑、来源核验、可上传内容和禁止内容的数据政策。

## src/ — Node 侧公共入口
- [catalog-interface.js](src/catalog-interface.js) — Node 侧五模块目录唯一 Interface；三级批量替换委托共同事务。导出: `catalog, DATA_FILES, resetCatalogForTests`

## src/shared/ — 跨模块基础能力
- [beijing-time.js](src/shared/beijing-time.js) — 固定 UTC+8 北京时间日期键、自然日键与当天零点 ISO 工具，避免本地 Windows 与 CI 时区差异。导出: `BEIJING_OFFSET_MS, beijingDateKey, beijingDayKey, beijingMidnightIso`
- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录、catalog 文件与生成器事务路径常量，以及统一 AI 配置文件路径（全仓唯一数据登记点，含五模块 catalog、厂商/产品官方 URL 登记表、草案、锁、staging、backup、journal、日期审计清单、编程工具更新审核清单与概念链路 previews/vibeHubCache；data/manual 下分 archive 喂 AI 搜索历史 / tools 工具链路 / concepts 概念链路，待补卡路径已收拢为 CATALOG_GENERATOR_FILES.pendingTools / CONCEPT_FILES.pendingConcepts）。导出: `DIRS, CATALOG_FILES, CATALOG_GENERATOR_FILES, CONCEPT_FILES, AI_CONFIG_FILES, NEWS_FILES, ACQUISITION_FILES, RSS_FEED_PATH`
- [providers/](src/shared/providers/) — 外部 AI 提供商独立目录，各厂商独立拥有自身元数据、端点与默认模型（开闭原则），由 `index.js` 统一汇聚导出。
  - [protocols.js](src/shared/providers/protocols.js) — 传输协议常量定义（RESPONSES / MESSAGES / CHAT）。导出: `AI_PROTOCOLS`
  - [zhipu.js](src/shared/providers/zhipu.js) — 智谱 ZhipuAI 提供方独立配置（Anthropic Messages 兼容端点，glm-5.3-flash）。
  - [deepseek.js](src/shared/providers/deepseek.js) — DeepSeek 提供方独立配置（Responses / Chat 双端点，deepseek-v4-flash）。
  - [local.js](src/shared/providers/local.js) — 本地 Bonsai 提供方独立配置（llama-server 8080，bonsai）。
  - [openai.js](src/shared/providers/openai.js) — OpenAI 提供方独立配置。
  - [anthropic.js](src/shared/providers/anthropic.js) — Anthropic 原生提供方独立配置。
  - [index.js](src/shared/providers/index.js) — 统一汇总注册与提供方解析出口。导出: `AI_PROTOCOLS, AI_PROVIDERS, DEFAULT_PROVIDER_NAME, getProvider, resolveProvider, apiKeyForProvider`
- [ai-config.js](src/shared/ai-config.js) — 按业务大模块读取、合并和校验 provider/model/protocol 与 Tavily retrieval 配置（默认值跟随 registry 开关）。导出: `DEFAULT_MODULE_CONFIGS, readAiConfig, loadAiModuleConfig, validateModuleConfig`
- [deepseek-client.js](src/shared/deepseek-client.js) — provider-aware Responses/Chat transport、认证/HTTP/超时错误归一化；保留 DeepSeek 兼容包装；endpoint 校验放行本地 localhost HTTP（本地 Bonsai 接入点）。导出: `requestResponses, requestDeepSeek, requestChatCompletions, textFromResponse`
- [llm-gateway.js](src/shared/llm-gateway.js) — 统一 AI 调用网关：实现 requestStructuredJson 与 requestLlmText，统一多协议（RESPONSES / MESSAGES / CHAT / local）路由分发、负载格式自适应折叠与错误码映射。导出: `requestStructuredJson, requestLlmText, resolveTransportRoute, extractJsonValues, diagnosticsOf, toChatCompletionsPayload, toMessagesPayload, toExternalChatPayload`
- [llm-endpoints.js](src/shared/llm-endpoints.js) — 本地 Bonsai 模型 OpenAI 兼容端点与模型名常量（news 侧 5 个 + catalog 侧 3 个本地化任务统一引用）。导出: `LOCAL_API_BASE, LOCAL_MODEL`
- [local-model.js](src/shared/local-model.js) — 本地 Bonsai 自动启动：调用本地 LLM 前确保服务在线——探测离线自动 spawn 启动脚本并轮询就绪（幂等 TTL 缓存、超时后 TTL 内不重复拉起）；注入自定义 fetchImpl（测试 mock）一律放行不探测不启动。导出: `LOCAL_MODEL_SCRIPT, buildProbePayload, probeLocal, startLocalServer, ensureLocalModel, resetLocalModelState, autostartEnabled`
- [tavily-client.js](src/shared/tavily-client.js) — Tavily Search/Extract 原生 fetch transport；keyless/keyed 按端点混用认证（search/extract 默认 keyless 免费、缺 key 可用，任意 keyless 429 都自动切 keyed 并进入冷却，冷却后恢复 keyless；cap code/detail 用于诊断，本地节流/冷却可注入）、Key/HTTP/超时错误归一化和 URL canonicalization。导出: `SEARCH_ENDPOINT, EXTRACT_ENDPOINT, canonicalizeUrl, resolveAccessMode, isKeylessCapResult, searchTavily, extractTavily, probeTavily`
- [retention.js](src/shared/retention.js) — 共享段 retention 校验接口（纯逻辑 + 文件 IO 分离）：cutoff = 当前年月 − 14 个月，`advanceRetentionCutoff` 幂等跨自然月推进、漏跑自愈 snap；`readRetentionState` 读端唯一入口（校验后冻结）、`advanceRetentionToNow` 写端唯一入口（推进 + 校验 + 原子写，失败降级沿用旧 cutoff）；`writeRetention` 形状校验 fail-closed 防误篡改。comparison 写、catalog 只读。导出: `DEFAULT_MONTHS, currentCutoffYearMonth, cutoffDateOf, advanceRetentionCutoff, readRetentionFromPayload, validateRetentionPayload, readRetentionState, advanceRetentionToNow, readRetention, writeRetention, ensureSharedDir`
- [release-index.js](src/shared/release-index.js) — 共享段 `model-release-dates.json` 校验接口（comparison 写 / catalog 只读）：`readReleaseIndex` 校验后冻结读取（缺失/损坏回退空）、`writeReleaseIndex` 逐条形状校验 fail-closed 原子写。导出: `isIsoDate, validateReleaseIndexEntries, readReleaseIndex, writeReleaseIndex`
- [catalog-release-dates.js](src/shared/catalog-release-dates.js) — 共享段 `catalog-release-dates.json` 校验接口（catalog 写 / comparison 只读）：`readCatalogReleaseDates` 校验后冻结读取、`writeCatalogReleaseDates` 逐条形状校验 fail-closed 原子写。导出: `isIsoDate, validateCatalogReleaseDatesEntries, readCatalogReleaseDates, writeCatalogReleaseDates`

## src/catalog/ — 目录数据接口与生成器
- [catalog-snapshot-store.js](src/catalog/catalog-snapshot-store.js) — 五模块 catalog 快照读取、形状校验与 revision 计算，以及按 area 解析正式文件路径。导出: `FILE_BY_AREA, loadCatalogSnapshot, catalogFileByArea, catalogFiles, generatorPaths`
- [catalog-contract.js](src/catalog/catalog-contract.js) — 五模块字段、枚举、引用和快照形状契约；日期字段为 `release_date` 与 `last_updated_date`。导出: `AREAS, ALLOWED_FIELDS, DETAIL_KINDS, TOOL_CARD_KINDS, THEMES, DATE_FIELDS`
- [catalog-snapshot-validator.js](src/catalog/catalog-snapshot-validator.js) — FutureSnapshot 兼容性结构/引用纯校验；严格新记录完整性由 catalog-record-completeness 单独门禁。导出: `validateCatalogSnapshot`
- [catalog-record-completeness.js](src/catalog/catalog-record-completeness.js) — schema v3 正式记录字段齐全和非缺省门禁，拒绝 null、空字符串、空数组、unknown/未知；日期字段由 Profile 门禁按类型要求。导出: `NOT_APPLICABLE_STATUS, FORBIDDEN_PLACEHOLDERS, isExplicitValue, validatePlannedRecords`
- [catalog-profile-contract.js](src/catalog/catalog-profile-contract.js) — 按 `detail_kind + modality` 选择 CatalogProfile；工具研究 `last_updated_date`，API 模型/产品变体研究 `release_date`，套餐不研究公开日期；计算适用谓词、ResearchScope、稳定目标 ID 与逐层 create/replace/noop LayerPlan。导出: `PROFILE_DEFINITIONS, VENDOR_PREDICATES, GROUP_PREDICATES, DATE_PREDICATES, inferModality, planCatalogResearch`
- [catalog-research.js](src/catalog/catalog-research.js) — Tavily 来源发现与正文获取编排（discover+acquire）、官方域名信任、URL canonicalization、字段级增量 resume（按缺失字段收敛到对应层 scope）和硬 CostLedger 深 Module；保留预算/Adapter 失败时的来源进度。导出: `DEFAULT_LIMITS, createCostLedger, canonicalizeUrl, officialRootsOf, isTrustedOfficialUrl, sourceIdOf, sourcesForScope, scopeKindsOfFields, researchCatalog`
- [catalog-synthesis.js](src/catalog/catalog-synthesis.js) — 按层从官方来源正文合成完整记录和来源 provenance（source_ids）；按 `detail_kind` 选择 `last_updated_date` 或 `release_date`，字段级 FieldCoverage 覆盖门禁，api_model 缺 access/price 关键字段建议 product_variant，字段值缺省/占位 fail-closed；对 `link_only` 父层只克隆当前记录并确定性追加子级引用，不重写父级字段。导出: `DETAIL_MISMATCH_FIELDS, REQUIRED_LAYER_FIELDS, dateFieldFor, expectedLayerFields, isNonDefaultFieldValue, fieldCoverageOf, missingCoverageFailure, validateSynthesisOutput, validateLayerPatches, synthesizeCatalog`
- [catalog-draft-envelope.js](src/catalog/catalog-draft-envelope.js) — schema v3 CatalogDraft Envelope 构建与 Apply 前重算门禁；只消费 ResearchPlan、official_sources、字段级 coverage 和 LayerPatches，ready 时用 fieldCoverageOf 重算防伪造。导出: `buildCatalogDraftEnvelope, validateCatalogDraftEnvelope`
- [catalog-revision.js](src/catalog/catalog-revision.js) — 五模块稳定序列化、revision 和 preview hash。导出: `stableStringify, revisionOf, previewHashOf`
- [catalog-draft-store.js](src/catalog/catalog-draft-store.js) — schema v3 临时 Draft 创建、读取、更新、列举和删除；持久化 ResearchPlan、OfficialSources、字段级 Coverage、LayerPatches、Readiness 与成本账本。导出: `createDraft, readDraft, updateDraft, deleteDraft, listDrafts`
- [catalog-record-builders.js](src/catalog/catalog-record-builders.js) — 确定性五类记录 Builder 和业务键规范化；严格生成路径由上游契约保证非缺省输入。导出: `buildVendorCard, buildLevel1, buildLevel2, buildDetail, buildToolCard, deriveKeys`
- [catalog-change-planner.js](src/catalog/catalog-change-planner.js) — LayerPatches 到 FutureSnapshot 的确定性规划；逐层 create/replace/noop，普通 create 不静默覆盖。导出: `planCatalogPatches`
- [catalog-date-repair.js](src/catalog/catalog-date-repair.js) — 已有三级详情的日期字段级修补规划与 Apply 门禁；保留 fill_missing，新增仅限 tool `last_updated_date` 的 advance_update 与同一 base revision 批量 preview/atomic Apply，校验官方正文/发布时间（evidenceSupportsDate 与 planner 的 explicitDates 一致，支持缩写/点分隔/月份标题推断）、官方根域、approved review candidate、preview hash 和 revision，并确保非日期字段不漂移。导出: `TARGET_FIELD_BY_KIND, DATE_REPAIR_MODES, dateFieldForDetail, officialDateOf, evidenceSupportsDate, nonDateDetailFingerprint, planDateRepair, planDateRepairBatch, approvedRepairsFromReviewQueue, applyDateRepair, applyDateRepairBatch`
- [catalog-transaction-store.js](src/catalog/catalog-transaction-store.js) — catalog 共同锁、五文件 staging、staged dist、journal、回滚和恢复；schema v3 通过 LayerPatches 复用事务；支持带 expected revision 和精确 area/id 列表的关系安全删除；dist 目录交换在 Windows 被占用（IDE/杀软持有目录句柄）时 rename 会 EPERM，自动回退删除重建（build-dist 同法，backup_dist 兜底）。导出: `commitSnapshotChange, commitCatalogChange, replaceToolLevel3, removeCatalogRecords, planRecordRemoval, recoverCatalogTransaction`
- [catalog-assistant.js](src/catalog/catalog-assistant.js) — schema v3 生成器深 Module；统一离线 plan、按缺失字段研究/resume、单段合成、Review、Apply、取消和恢复 Interface；resume 的明确成本确认获得一组增量硬预算。导出: `planCatalogDraft, prepareCatalogDraft, resumeCatalogDraft, reviewCatalogDraft, applyCatalogDraft, discardCatalogDraft, recoverCatalogTransactions, researchLimits, resumeResearchLimits, estimateResearchCost, probeCatalogCapabilities`
- [catalog-workbench.js](src/catalog/catalog-workbench.js) — 维护者知识闭环 Catalog 协调器；只消费 approved pending 工具卡，执行 plan/prepare/单 Draft review/resume/discard/显式 Apply，绝不接入自动 Apply 的 catalog batch。导出: `createCatalogWorkbench, planHashOf, projectDraft`
- [catalog/ai/deepseek-catalog-ai.js](src/catalog/ai/deepseek-catalog-ai.js) — DeepSeek 结构化 Catalog Adapter；单段式调用结构化深 Module，基于官方来源正文直接合成各层字段与来源 provenance；定向 repair 按 profile 选择 `last_updated_date` 或 `release_date`，仅在 seed 指定日期且 `seed_official_hint` 正文包含同一日期时确定性修复并绑定该来源。导出: `synthesizeLayerFields`
- [catalog/ai/catalog-adapters.js](src/catalog/ai/catalog-adapters.js) — Tavily/DeepSeek catalog 研究与合成适配器的默认组合及注入工厂。导出: `createCatalogResearchAdapters, createCatalogSynthesisAdapter`
- [catalog/ai/catalog-synthesis-prompt.js](src/catalog/ai/catalog-synthesis-prompt.js) — 目录合成 prompt 纯函数构建；按层分组官方来源正文（截断/限量）与字段清单，保留 seed 官方来源角色与定向 repair context，按 `detail_kind` 要求工具 `last_updated_date` 或模型/变体 `release_date`，生成 instructions 与 input；硬性要求 rate_cards[].conditions 非空字符串、one_m_context 必须输出（原生 1M 或 not_applicable），否则相应字段/整层列入 missing。导出: `DEFAULT_MAX_SOURCES_PER_LAYER, DEFAULT_MAX_SOURCE_CHARS, sourcesForLayer, buildSynthesisInput, buildSynthesisInstructions`
- [catalog/ai/tool-update-review-ai.js](src/catalog/ai/tool-update-review-ai.js) — 工具专用更新 AI 语义建议 Adapter；本地 Bonsai 默认、DeepSeek 需显式成本确认，输入只含已采集证据/登记元数据，严格输出五字段，不写事实或 catalog。导出: `validateToolUpdateReviewValue, buildToolUpdateReviewInput, buildToolUpdateReviewInstructions, suggestToolUpdateReview`
- [catalog/tool-update-review-contract.js](src/catalog/tool-update-review-contract.js) — 工具更新审核中性契约；统一五字段 decision 校验、decision source 与来源审核模式枚举。导出: `REVIEW_VERDICTS, REVIEW_SURFACES, REVIEW_FIELDS, DECISION_SOURCES, REVIEW_MODES, validateToolUpdateReviewValue, normalizeToolUpdateReviewValue`
- [catalog/tool-update-evidence.js](src/catalog/tool-update-evidence.js) — 工具更新证据日期纯函数；统一官方发布时间、正文日期解析和 `date_mode: latest` 选择，不依赖 AI。导出: `isIsoDate, isoDateFromValue, officialDateOf, explicitDates, dateForEvidence`
- [tool-update-review-planner.js](src/catalog/tool-update-review-planner.js) — 工具更新确定性 planner；校验 registry 来源、tool detail、产品表面、官方日期、置信度和向前更新门禁，输出 candidate/blocked/no-op，不 Apply。日期解析支持月份缩写/序数/点分隔与 `date_mode: latest`（多日期 changelog 页取最新）；无当前 `last_updated_date` 的 detail 允许首次填充候选（Apply 阶段走 fill_missing）。导出: `findToolDetail, sourceForEvidence, planToolUpdateCandidate, planToolUpdateCandidates`
- [tool-update-review-store.js](src/catalog/tool-update-review-store.js) — 工具更新人工审核队列读写、候选替代生命周期与当前/历史视图；提供 revision 化白名单 projection、最新登记来源筛选、历史审计、仅修改 `review_status` 的 fail-closed 工作台 mutation，以及带 expected count/revision 断言的旧 `pending/blocked` 精确删除。导出: `readReviewQueue, writeReviewQueue, mergeReviewQueue, reviewQueueViews, readReviewQueueProjection, setReviewStatusReviewQueue, removePendingBlockedReviewItems`
- [tool-update-collector.js](src/catalog/tool-update-collector.js) — 编程工具专用更新网页确定性采集层；从受校验的 `update_sources` 读取 GitHub Releases/文件或官方 HTML/Tavily Extract，校验 HTML 重定向仍在原官方域，统一产出可审计 UpdateEvidence，不调用 AI、不写 catalog。tavily_extract 优先直接抓官方 HTML（解决 Tavily 对 JS 渲染/缓存页丢失 changelog 日期），HTML 空壳/无日期回退 Tavily Extract；GitHub Release 正文为空但有官方 `published_at` 时仍以版本名/发布元数据生成 ready 证据。导出: `collectGithubRelease, collectGithubFile, collectTavilySource, collectUpdateEvidence, collectProductUpdateEvidence, htmlToText, fetchHtmlText`
- [catalog/ai/concept-synthesis-prompt.js](src/catalog/ai/concept-synthesis-prompt.js) — 概念合成 input/instructions 纯函数构建；把待补术语与摘要/vibe-hub 证据组装为受约束的中文 JSON 任务。导出: `DEFAULT_CONCEPT_CATEGORIES, buildConceptSynthesisInput, buildConceptSynthesisInstructions`
- [catalog/ai/concept-synthesis-ai.js](src/catalog/ai/concept-synthesis-ai.js) — 概念合成 Adapter（本地 Bonsai）；单段式调用结构化深 Module，ledger 必传 fail-closed，合成次数预占，返回 7 字段 glossary 条目（term 以待补卡为准防改词）。导出: `validateConceptValue, normalizeConceptEntry, synthesizeConceptFields`
- [catalog-batch.js](src/catalog/catalog-batch.js) — **批量生成编排层（②→③ 链路）**：待补卡 → 三层查重（正式目录/进行中 draft/同批）→ 厂商/官方源解析（人工登记表 | Tavily）→ 成本估算/全局确认 → 逐 seed prepare→review→自动 apply → 批量报告；单 seed 失败跳过保留 draft 可 resume；**阶段 4：api_model 批量前置经 resolveBatchPlacements 解析二级归属**（人工 placement 优先并校验、确定性 existing/create、migration_required/fail_closed 阻断）；**阶段 5：无 confirmCost 且非 dry-run 时零付费返回三本账成本估算**（vendor_resolution / placement / research，registry 命中零成本），dry-run 也写确定性 placement_decision 进 preview、from-preview/resume 短路复用不重复调 AI，顺序投影维护同厂商候选最新成员数（第 4 个触发拆分）；`readPendingCards` 输入门禁校验容器/卡类型与 `detail_kind_hint` 类型，登记表命中但 seed 转换抛错（vague/非法 hint）收进 unresolved 不中断整批。导出: `readPendingCards, dedupeBatchCandidates, resolveBatchCandidates, runCatalogBatch, runBatchFromCards, resolveBatchPlacements`
- [catalog-series-policy.js](src/catalog/catalog-series-policy.js) — LLM 二级系列分类政策深模块（**纯确定性、零网络零 AI**）：读取/严格校验政策、vendor 别名规范化、按家族 pattern/modality 判定用途（general_llm/专用/uncovered）、匹配家族、返回厂商允许目标二级系列、校验人工 placement 引用（kind/存在性/vendor 归属）、**planSeriesPlacement 确定性 placement 规划**（品牌提示识别已知 LLM、判定 existing/create/migration_required/not_applicable/needs_ai，容量第 4 个触发拆分阻断）；被识别为 general_llm 但厂商无对应家族规则或用途无法确认时 fail-closed，绝不回退到以具体模型名建组。导出: `readSeriesPolicy, validateSeriesPolicy, loadSeriesPolicy, normalizeVendorKey, policyForVendor, matchFamily, usageKindOf, allowedTargetSeries, validatePlacementRef, planSeriesPlacement, memberCountOfSeries, groupKeyOfSeriesId, brandHintsOfFamily, detailKeyOf, detailRefIdOf`
- [catalog-series-placement-ai.js](src/catalog/ai/catalog-series-placement-ai.js) — 二级系列 AI 语义分类 Adapter（阶段 4）：AI 只输出 usage_kind/modality/vendor/family/major_line/release_cohort/confidence/rationale 建议，不决定归属；`suggestSeriesPlacement` 走 requestStructuredJson + 硬 ledger（缺账本 fail-closed）；`resolveSeriesPlacement` 编排——人工 placement 最高优先（经引用校验）→ 确定性 planner → needs_ai 时才允许 AI（hint 重跑确定性 planner，冲突/低置信 fail-closed）→ `applyPlacementToSeed` 写入 seed（existing→existing_level2_ref，create→group_key+new_group_title）。导出: `buildSeriesPlacementInput, buildSeriesPlacementInstructions, validateSeriesPlacementValue, suggestSeriesPlacement, resolveSeriesPlacement, seriesSummaryOf, applyPlacementToSeed`
- [catalog-series-migration.js](src/catalog/catalog-series-migration.js) — LLM 二级系列迁移规划器（**纯确定性、零网络零 AI**）：读取政策 + 五模块快照，生成完整 FutureSnapshot 的精确变更——通用家族重组（merge/split/rename）、专用/套餐/工具家族改名对齐与零漂移、重写 L1.level2_refs、搬迁 L2.detail_refs；三级详情与工具卡完全不动；无既有成员的目标不创建空系列；既有浮空详情写入 warnings 而非孤儿。导出: `planSeriesMigration`
- [official-url-registry.js](src/catalog/official-url-registry.js) — 批量生成前置：厂商/产品人工官方 URL 登记的统一 Module；双表 loader 与 schema/引用/URL/lifecycle 校验，产品表可选 `update_sources` 严格契约（含可选 `date_mode: latest` 多日期页取最新规则）与只读读取，`lookupOfficialUrl` 按 detailKind 在产品表和厂商表之间选择匹配且不混入更新源。导出: `normalizeKey, loadUrlRegistry, listUrlRegistry, loadProductUrlRegistry, listProductUrlRegistry, updateSourcesForProduct, validateUpdateSource, validateUpdateSources, validateProductUrlRegistry, lookupOfficialUrl, addUrlRegistryEntry, removeUrlRegistryEntry`
- [concept-batch.js](src/catalog/concept-batch.js) — **概念批量生成编排层（concept-cards-pending → 预览 → 人工 apply → glossary.json）**：查重（同批 + 正式 glossary）→ 回读 approved 摘要作主证据 + vibe-hub 自动补充 → 成本估算/确认 → 逐概念 DeepSeek 合成写预览文件 → 显式 `concept apply` 原子写 glossary；schema v2 预览绑定 glossary/pending revision 与 hash，工作台 Apply 做 CAS、hash、terms 全量校验。导出: `readPendingConcepts, dedupeConceptCandidates, collectConceptEvidence, planConceptCost, revisionOfGlossary, conceptPreviewHashOf, validateConceptPreview, runConceptBatch, readConceptPreviews, applyConceptPreviews`
- [catalog-integrated-lookup.js](src/catalog/catalog-integrated-lookup.js) — 卡片生成器从共享 release_date 索引机械查找（comparison → catalog 方向，只读 `data/shared/model-release-dates.json`，`loadSharedReleaseIndex` 委托 `src/shared/release-index` 校验接口）：按 tool_key/标题/slug/identity 对齐，供 api_model/product_variant 卡缺失 release_date 时补填。导出: `slugifyModelName, loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed`
- [catalog-shared-publish.js](src/catalog/catalog-shared-publish.js) — catalog → comparison 方向共享投影发布：`buildCatalogReleaseDates` 从五模块快照确定性投影 api_model/product_variant 的 release_date（join tool-card 取 tool_key）；`publishCatalogReleaseDates`/`publishCatalogReleaseDatesAfterCommit` 经 `src/shared/catalog-release-dates` 校验接口写共享段（派生产物失败降级、不进事务回滚链）。导出: `buildCatalogReleaseDates, publishCatalogReleaseDates, publishCatalogReleaseDatesAfterCommit`
- [catalog-retention-prune.js](src/catalog/catalog-retention-prune.js) — catalog 五模块 14 个月滚动级联删除：按 detail_kind 取时间字段（tool→last_updated_date、api_model/product_variant→release_date）筛过期详情，级联删 tool-card/vendor-level2/1/vendor-card（失去全部引用的父级）；subscription_plan 与无日期保守保留；featured 悬空只报不改；复用 planRecordRemoval + commitSnapshotChange 事务。cutoff 只读共享段。导出: `DATE_FIELD_BY_KIND, currentCutoffDate, collectPruneTargets, featuredDangling, planRetentionPrune, applyRetentionPrune`
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
- [revision-date.js](src/comparison/revision-date.js) — revision 日期规范化（代码规则）：解析 MMDD/YYYYMMDD/YYMM/MM-YYYY 等混用格式为 (year,month,day)，本年不显示年份（MM-DD/MM）、往年保留（YYYY-MM-DD/YYYY-MM）；无年份时按系统年份推断，日期在未来回退到上年；同一日期不同写法规范化后同键自动合并。导出: `parseRevisionDate, normalizeRevision`
- [model-series.js](src/comparison/model-series.js) — 模型系列分组深 Module：读取人工系列登记，按 series/member/configuration 三层生成稳定系列投影；revision 聚合为成员变体，canonical 不被系列合并。导出: `readSeriesConfig, seriesInfoFor, memberInfoFor, attachSeriesMetadata, validateSeriesProjection`
- [model-exclusions.js](src/comparison/model-exclusions.js) — integrated 重建排除规则深 Module：读取/严格校验 `vendor + identity_prefix` 或 `identity_prefixes` token-boundary / exact identity 规则，过滤 source records 并返回命中诊断；只影响 integrated，不删除 raw。导出: `validateExclusionConfig, readExclusionConfig, exclusionForModel, filterExcludedRecords`
- [empty-model-filter.js](src/comparison/empty-model-filter.js) — 无数据模型自动过滤（代码规则）：按 identity 分组，同一 identity 全部 revision 无有效评测维度且无综合分时整组从 integrated 移除（任一 revision 有数据则整组保留，不误杀主变体）；随抓取数据动态生效，模型日后有数据自动回归。导出: `hasComparisonData, filterEmptyModels`
- [release-date.js](src/comparison/release-date.js) — 模型 release_date 多源解析 + 14 个月 cutoff 过滤：优先级 llm-stats `release_date` → catalog 反查（tool-preview-level3 + models-alias catalog_aliases 对齐）→ openrouter `created`（Unix 秒兜底）→ null 保守保留；`filterByReleaseCutoff` 在 Elo 前排除早于 cutoff 的模型；生成共享索引 `data/shared/model-release-dates.json`。导出: `isIsoDate, buildReleaseLookup, resolveReleaseDate, filterByReleaseCutoff, buildSharedReleaseIndex`
- [identity-review.js](src/comparison/identity-review.js) — 名称歧义离线审计 Module：只收集确定性解析未分类 token，协调本地 Bonsai 建议与按阈值升级的 DeepSeek 复核；所有结果强制人工确认，不写正式 alias/数据。导出: `collectReviewCandidates, shouldEscalate, reviewCandidates`
- [identity-review-ai.js](src/comparison/identity-review-ai.js) — 名称歧义 AI 建议 Adapter：复用结构化 JSON transport，本地 Bonsai 默认、DeepSeek 可显式升级；统一 prompt/schema，ledger 缺失 fail-closed。导出: `suggestIdentityReview`
- [rebuild-comparison.js](src/comparison/rebuild-comparison.js) — **integrated 重建核心**：只消费统一模型身份解析（厂商限定 `model_key` + 明确 revision 隔离）→ 合并 4 源记录 → 先按 model-exclusions 过滤整系列 → 重新计算 Elo bounds/维度/综合分/性价比 → 系列投影；profile 分数进入 `lmarena_profiles`，不生成选择器行，同厂商同展示名最终强制追加身份消歧，写 index/data.json；排除只影响 integrated，raw 保留。导出: `rebuildIntegrated, collectSourceRecords, slugify, openrouterCanonical, llmStatsCanonical, lmarenaParse, livebenchParse, buildAliasMap, cleanModelDisplay, themeOfDimensions`
- [run-comparison.js](src/comparison/run-comparison.js) — 抓取编排（cron 每日）：每源独立计数全量 + 失败隔离 WARN + 全绿才重建。导出: `runComparison, fetchSource, isFresh, readConfig`

## src/maintainer-web/ — 本机维护者前端（原生 HTML/CSS/JS；固定 `/api/workbench/v1/`，不参与公开静态站构建）
- [index.html](src/maintainer-web/index.html) — 编辑部审核工作台页面骨架；待办概览、新闻首审、关键词提纯生成/采纳、Top 待选池生成/选择/公开投影、新闻摘要→工具/概念 pending 审核与 Catalog/Concept 成本确认闭环、工具更新审核/preview/确认 Apply、概念预览。
- [css/workbench.css](src/maintainer-web/css/workbench.css) — 编辑部工作台响应式视觉样式与状态/队列/预览/工具确认/知识闭环组件样式。
- [js/workbench.js](src/maintainer-web/js/workbench.js) — 固定工作台 API 客户端与交互；fragment token、revision 绑定写请求、新闻/关键词/Top 后续操作、知识提取、pending 审核、Catalog Draft/Concept preview Apply、工具 preview 与确认 Apply、工具更新当前待办与历史折叠、blocked 门禁、加载/错误/409 状态和 DOM 安全渲染。

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

- [js/date-display.mjs](src/web/js/date-display.mjs) — 前端日期事实展示与三级对象类型纯函数；typed 日期按 detail_kind 显示，套餐不显示。导出: `getToolDateDisplay, getToolDetailKindLabel, isDateValue`
- [js/data.js](src/web/js/data.js) — 五模块目录领域查询、独立数据加载、过滤、平台元数据与通用工具；通过 date-display.mjs 统一日期事实展示，不再构造旧 `tools.json` / `tool-intelligence.json` 兼容投影。导出: 五模块查询函数、各数据状态与 setter、escapeHtml/timeAgo/formatPrice 等
- [js/search.js](src/web/js/search.js) — AI 搜索视图（四层关键词索引答案引擎）：首页/处理/结果三态；首页为左中右布局（左侧「怎么用」三步引导栏 + 中间主区），「你可以试试」示例按钮用场景自然语言问句渲染（scene.example）；统一提取器 extractKeywords 从混杂查询提取关键词（≥2 字符、长词优先），三层词表依次命中——场景层（复用 scenes.json 场景搜索词，与场景模式共用映射）→ 内容层（工具卡 title/vendor_label/search_terms + 品牌短形式派生，如 gpt→GPT-5.5）→ 热点概念层（glossary 词 + 热点标题英文 token），命中后主区渲染含知识块（热点在上、概念在下）；一句话答案（内嵌 [n] 引用→工具 mini 卡）+ 左栏本页概念索引 + 右栏最新热点；「了解更多」跳工具库按 query 过滤 + 强制 tool toggle；概念词全站联动。导出: `searchState, submitSearchHome, renderSearchView, openSearchToolDetail, openSearchMoreTools...`
- [js/tools.js](src/web/js/tools.js) — 工具库视图（厂商/工具 Toggle）由独立 `VendorDirectoryView` / `ToolDirectoryView` 控制器分别管理；工具卡片四类主题、分组和快速索引 + 滤选 + 单级详情弹窗；厂商一级/二级与工具/模型/套餐三级详情统一按稳定 ref 打开，仅 X 关闭。导出: `openDetail, closeModal, showModal, getToolsViewMode, toggleToolsViewMode, setToolsViewMode, clearToolFilters, renderTools...`
- [js/compare.js](src/web/js/compare.js) — 对比视图双 tab（模型对比 ↔ 工具对比）+ 工具对比（catalog）引擎；api_model 卡 +对比 经标题→canonical 桥接路由到模型 tab、tool/套餐路由到工具 tab；isCompareSelected 模型感知。导出: `compareList, getCompareTab, setCompareTab, renderCompareView, compareKey, isCompareSelected, toggleCompareRef, compareGroupLeaves, updateCompareCount, renderCompare, removeCompare, quickCompare...`
- [js/compare-models.js](src/web/js/compare-models.js) — **模型对比引擎（读 integrated/ + view-config + models-alias）**：左侧选择器按厂商→模型系列→模型三级树形展示，支持两级展开、搜索祖先路径与 `display/vendor/family/identity` 筛选；模型卡 `tool_key` 先经人工 `catalog_aliases` 桥接再回退 v2 identity/raw alias 到 canonical；前端只消费管线已消歧的记录，绝不按名称合并。其余：变体圆圈、综合分/性价比图表与表格能力同现有契约。导出: `renderModelCompare, bindModelCompareEvents, bridgeToCanonical, canonicalForTool, modelCompareIsSelected, modelCap, routeApiModelToCompare`
- [js/featured.js](src/web/js/featured.js) — 编辑精选视图（编辑精选通过工具 `tool_key` + 三级 `detail_ref` 导航，热门模型按正式工具卡 `detail_kind/theme` 分类；访问/资料状态使用中性未知语义，价格兼容通用计价单位）。导出: `renderFeatured, renderFeaturedTabs...`
- [js/glossary.js](src/web/js/glossary.js) — AI 概念视图。导出: `activeGlossaryId, openGlossaryConcept, renderGlossary...`
- [js/trending.js](src/web/js/trending.js) — AI 热点视图（文案走 t()、内容走 getLocalizedField；相关工具资源解析为正式工具卡和三级详情引用）。导出: `renderTrending, openHotspotDetail, reloadHotspots...`
- [js/scenes.js](src/web/js/scenes.js) — 场景模式视图；任务引用正式工具 `tool_key`，具体模型建议通过完整三级 `detail_ref` 打开，复用工具卡价格/访问多状态标签避免 unknown 误报。导出: `activeSceneId, renderScenes, renderSceneDetail...`

## src/news/ — 新闻采集管线（CommonJS）
### core/ — 数据层（无网络副作用）
- [news-storage.js](src/news/core/news-storage.js) — JSON 读写 + 原子写 + 并发锁。导出: `readJson, writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock`
- [news-public-gate.js](src/news/core/news-public-gate.js) — 公开展示过滤。导出: `filterPublicItems, filterProjectionByWindow, isWithinPublicWindow, hasCompletePublicFields`

### min/ — 热点管线 v2 数据层（单状态轴审核/候选/投影 + 长期质量历史库）
- [history-store.js](src/news/min/history-store.js) — 来源长期质量历史库（source-history.json 持久化 + 三率加权长期质量分，纯本地无 API）。导出: `readHistoryStore, writeHistoryStore, appendSamples, evaluateLongTermQuality, computeThreeRateScore, sourceKeyOf, perSampleRates`
- [min-history.js](src/news/min/min-history.js) — 热点候选轻量历史（维护者手动归档；最近 30 批，每条仅保存 id/title，批次时间为北京时间 `YYYY-MM-DD-HH:MM:SS`）。导出: `readMinHistory, writeMinHistory, appendMinHistory, compactCandidates, formatBatchAt, archiveMinStore`
- [review-v2.js](src/news/min/review-v2.js) — 热点管线 v2 审核层（L0 规则硬审：字段/AI 关键词/广告 + YouTube 简介明确 AI 生成披露硬排除 → L1 AI 审：高置信 approve/discard 自动分流，争议项 pending → L2 AI 建议+人工；单状态轴 pending/approved/discarded，不依赖旧双轴；复用 content-reviewer.reviewCandidate）。导出: `l0HardFilter, l1AiReview, l2AiAdvice, applyL1Verdicts, AI_DISCLOSURE_PATTERNS, DEFAULT_COMMENTS_TOP_N, DEFAULT_AUTO_APPROVE_CONFIDENCE, DEFAULT_AUTO_DISCARD_CONFIDENCE`
- [min-store.js](src/news/min/min-store.js) — v2 单状态轴候选层读写与候选合并；维护者工作台 mutation 使用稳定 revision、pending→approved/discarded、仅 approved 的 Top 选择门禁，以及字幕写入（transcript/transcript_file）与字幕总结写回（summary/key_points）mutation；重新采集缺字段时保留既有字幕、总结、本地化等加工结果。导出: `readMinStore, writeMinStore, commitMinStoreMutation, reviewPendingCandidates, setApprovedTopSelectedMin, setCandidateTranscriptMin, setCandidateTranscriptSummaryMin`
- [keyword-actions.js](src/news/min/keyword-actions.js) — 关键词候选清单的子集采纳与丢弃、配置 revision 与原子提交；只更新 `keywords.ai_keywords` / `keywords.excluded_keywords`（丢弃词进黑名单防止再建议），供 CLI 与本机工作台共同调用。
- [daily-projection.js](src/news/min/daily-projection.js) — v2 每日 top N 公开投影（approved 按北京时间自然日分组取前 N：含 YouTube 取 8 / 纯 X 取 5，纯逻辑不调 enrich/filter 两步）。导出: `buildDailyProjection`
- [keyword-refine.js](src/news/min/keyword-refine.js) — 人工首次审核后关键词提纯（**分批覆盖全部 approved**，每批截断标题/描述/评论适配本地模型上下文，跨批合并频次、排除已采纳与已丢弃词；清单记录 source_count/input_count/source_basis，dateKey 北京时间，文件名固定 keyword-refine.json；维护者填 adopted_keywords；不直接改配置）。导出: `refineKeywords, collectApprovedOriginals, chunkItems, mergeKeywordBatches, buildRuleCandidates, MAX_KEYWORD_REFINEMENT_INPUT`
- [transcript-workflow.js](src/news/min/transcript-workflow.js) — 字幕文件落库与外部 AI 总结（维护者工作台）：校验文件名防路径穿越、字幕文本截断存储到 `data/manual/transcripts/<candidate_id>/<file>`（可提交、不发布），并写候选层 transcript；显式成本确认后用外部 DeepSeek 重新总结写回 summary/key_points。导出: `safeTranscriptFile, saveTranscriptFile, uploadTranscript, summarizeTranscripts, MAX_TRANSCRIPT_STORED_CHARS, MAX_SUMMARIZE_PER_RUN`
- [pipeline-min.js](src/news/min/pipeline-min.js) — **热点管线 v2 总指挥（runMin 编排）**：严格读取 `collection.enabled` 统一总开关（关闭时全链零网络/零写入）→ 采集（默认 YouTube+X 并行，`options.platforms` 支持分时单平台；X credits/请求账本透传至 coverage 与 last-run）→ 去重 → L0 硬过滤 → 分类 → 评分（历史库）→ L1/L2 审核 → 候选落地 → 总结/本地化 → 自动生成待审清单（review-list，`options.autoReviewList=false` 可关）→ 每日公开投影写 hotspots.json → 写采集运行记录 last-run.json（ai-top 判定 hasYouTube 用）。X 采集窗口缺省「北京时间今天 0 点 → now」；每步失败降级记 coverage 不抛错。导出: `runMin, loadV2Config, isCollectionEnabled, normalizeNow, resolveXWindow`
- [review-list.js](src/news/min/review-list.js) — 人工审核清单：自动生成待审清单 review.json（文件名固定去掉日期后缀，date 为北京时间；带 id、只含 pending、评分倒序；已存在时追加新 pending、保留人工结论、--force 强制重建）+ 应用人工结论批量写回候选层（apply；pending 跳过、无 id 旧格式拒绝）。维护者入口：bat/after-first-review.bat、bat/archive-min.bat（归档时重置当日人工清单）。导出: `scoreOf, suggestReview, buildReviewList, mergeReviewCandidates, loadReviewList, applyReviewList`
- [local-enrichment.js](src/news/min/local-enrichment.js) — 本地 Bonsai 批量增量加工与双通道自愈修复（L1 审核 + L2 建议 + 摘要 + 翻译）：分批处理 + 每批并发安全落盘断点恢复（与工作台人工 mutation 并发时只合并缺失字段、人工结论优先），已处理条目自动跳过（幂等），discarded 不消费摘要/翻译算力；仅缺 L2 建议的条目只补建议不重跑 L1 不改状态；force 失败回滚既有摘要/翻译；支持本地+外部 DeepSeek 双通道自愈修复残缺数据（默认目标上限 100、--no-external 可关）；CLI 入口 `min-review enrich`、`min-review repair`。导出: `DEFAULT_REPAIR_LIMIT, nonNegativeInteger, needsL1Review, needsL2Advice, needsReviewWork, needsSummary, needsLocalize, needsRepair, countEnrichmentWork, countRepairWork, enrichMinCandidates, repairIncompleteCandidates`

### collectors/ — 各平台采集（会发网络请求）
- [collector-youtube-v2.js](src/news/collectors/collector-youtube-v2.js) — 热点管线 v2 的 YouTube 采集器（search.list 关键词发现，不依赖旧 quota/registry/scheduler）。导出: `collectYouTubeV2, buildItem, parseDuration, loadV2Config`
- [collector-x-v2.js](src/news/collectors/collector-x-v2.js) — 热点管线 v2 的 X(TwitterAPI.io) 采集器（博主时间窗 last_tweets + 关键词 advanced_search + 长文 article 补读；请求级 credits 预占/结算与重试预算；零/非法预算 fail closed、供应商单价/单页下界保护、超量响应完整结算并止损；独立 credits 计数，不依赖旧 quota/registry/scheduler）。导出: `collectXV2, normalizeXV2Tweet, extractArticleText, hasArticleSignal, resolveConfig, loadV2Config`

### classify/ — AI 内容分类/总结/审核建议/本地化
- [content-classifier.js](src/news/classify/content-classifier.js) — L0 规则 + L1 AI 分类编排（L0 不按娱乐/二创关键词硬排除；普通关键词仅用于分类，AIGC 披露硬排除由 review-v2 负责）。导出: `classifyRuleBased, classifyCandidate, classifyCandidates, confirmContentType`
- [content-summarizer.js](src/news/classify/content-summarizer.js) — 候选内容总结（标题+描述+字幕 → summary/key_points；空白 summary 视为缺失可重试）。导出: `summarizeCandidate, summarizeCandidates, enrichCandidateSummaries`
- [content-reviewer.js](src/news/classify/content-reviewer.js) — AI 审核建议（标题+描述+字幕+总结 → ai_review verdict/reasons/confidence；runPool 为分类/审核并发池，供 pipeline-min 复用）。导出: `reviewCandidate, reviewCandidates, runPool`
- [content-localizer.js](src/news/classify/content-localizer.js) — 候选内容本地化（标题+描述 → localizations[locale]，按原文实际字段判定完整性，原文保留顶层）。导出: `collectLocalizeSource, hasLocalizedContent, localizeCandidate, localizeCandidates, enrichCandidateLocalizations`
- [llm-provider.js](src/news/classify/llm-provider.js) — 内容加工模型提供方封装（分类/总结/审核/本地化/选 top/关键词提纯；关键词提纯失败由调用层显式阻断）；分类留外部 provider 开关（默认 zhipu/glm-4-flash，可切回 deepseek；max_tokens 8 成本可忽略，本地分类有 ai_product 偏好偏差），其余 5 个任务走本地 Bonsai（LOCAL_API_BASE + chat_template_kwargs 关思维链），请求前经 ensureLocalModel 自动启动本地服务（离线自动拉起、失败报错），同时提供外部 provider 总结、审核与本地化直通接口（summarizeWithExternalDeepSeek/reviewWithExternalDeepSeek/localizeWithExternalDeepSeek，经 externalTargetOf/requestExternalChat 按 provider 分流端点与密钥）供修复与工作台复用。导出: `classifyWithDeepSeek, summarizeWithDeepSeek, summarizeWithExternalDeepSeek, reviewWithDeepSeek, reviewWithExternalDeepSeek, localizeWithDeepSeek, localizeWithExternalDeepSeek, selectTopWithDeepSeek, refineKeywordsWithDeepSeek, buildKeywordRefinePayload, API_BASE, LOCAL_API_BASE, LOCAL_MODEL`

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — 网络请求 + URL/标识规范化。导出: `normalizeUrl, hash, numberOrNull, requestText, extractTweetArray`
- [scoring-v2.js](src/news/pipeline/scoring-v2.js) — 热点管线 v2 评分层（6 权重加权，长期质量来自 history-store，互动用真实三率）。导出: `assessItemV2, scoreTimelinessV2, detectLightExperienceV2, scoreSourceReliability, scoreTypePreference`
- [projection.js](src/news/pipeline/projection.js) — 公开热点投影补充（hot_score/evidence_excerpt/related_resources + 内容去重）。导出: `enrichHotspotProjection, buildRelatedTitleLexicon, dedupeItems, buildToolUrlIndex`

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口**（仅保留 v2 命令组）。导出: `parseArgs, main, minReviewCommand`
- [cmd-content.js](src/news/cli/cmd-content.js) — `classify/localize preview` 子命令（纯函数预览；批量分类/本地化已由 v2 管线内建）。导出: `classifyCommand, localizeCommand`
- [cmd-min.js](src/news/cli/cmd-min.js) — **v2 `min-review` 命令组**（操作 min-candidates.json；`enrich` 本地批量初审分流/摘要/本地化，支持分批与断点续跑，默认自动衔接双通道自愈修复；`repair` 双通道自愈修复残缺数据；`feedback` 默认接入 LLM 实体提取，feedback.llm_extract=false 关 / LLM 失败降级正则；`refine` 分批覆盖全部 approved 调本地模型生成关键词清单，`refine-apply` 校验 adopted_keywords 后原子幂等追加配置；`ai-top` 经 `topCandidatesForAi` 控制模型输入规模（`collection.ai_top_input_max` 可调）、优先以 last-run 判定 YouTube、缺失时回退 approved 平台字段，产物带 id 与输入范围统计；`top-apply` 应用 top_selected=true；`apply` 写回首审结论；`archive` 由维护者确认后把当前候选压缩为轻量历史、清空候选层，并重置 data/manual 当日人工清单）。维护者入口：维护者工作台、bat/after-first-review.bat、bat/archive-min.bat。导出: `minReviewCommand, resolveAiTopConfig, topCandidatesForAi, MAX_AI_TOP_INPUT, applyRefineKeywords, applyTopSelectedList, removeManualLists, MANUAL_LIST_FILES`

### transcripts/ — 收尾环节：字幕人工获取通知（独立于主链，只写清单文件）
- [transcript-notify.js](src/news/transcripts/transcript-notify.js) — 每日"待人工获取字幕"清单（min 候选层挑评分最高 notify_count 个 YouTube，写 transcript-requests.json 交人工，文件名固定去掉日期后缀、dateKey 北京时间；不碰主链/不调采集总结）。导出: `notifyTranscripts, parseNotifyCount, scoreOf`

### feedback/ — 收尾环节：工具库/概念库反哺（独立于主链，只写待补卡文件）
- [pending-review-store.js](src/news/feedback/pending-review-store.js) — 工具/概念待补卡 schema v2 唯一写者；稳定 SHA-256 base64url candidate key、revision/CAS、pending/approved/discarded 结论保留与白名单投影。导出: `candidateKeyOf, revisionOfPending, readPending, writePending, mergePending, reviewPending, pendingByKey, projectPending, fileFor`
- [tool-feedback.js](src/news/feedback/tool-feedback.js) — 从 approved summary 提取带类型实体（默认正则 / options.llmExtract 注入 LLM），按类型路由（tool/model→待补工具卡并带 detail_kind_hint、concept→待补概念卡、vague→排除），isVagueName 兜底拦截产品/平台/模型家族笼统名绝不进待补工具卡；与五模块工具卡/glossary.json 比对，缺失通过 pending-review-store 合并写待补卡，不直接改知识库。导出: `feedbackFromSummaries, extractEntities, extractEntitiesDefault, normalizeEntities, isVagueName, toolExists, conceptExists`
- [llm-entity-extract.js](src/news/feedback/llm-entity-extract.js) — 摘要 AI 实体提取（本地 Bonsai 替代默认正则）：找 AI 概念/工具/模型并输出带类型 JSON 数组 `{name,type}`（type∈tool/model/concept/vague，笼统名标 vague；完整名、排除泛称/人名/机构、检查遗漏、无则输出 []）；复用 requestStructuredJson + ledger fail-closed，缺 ledger 内部自建；调用失败抛错由 cmd-min 降级正则。导出: `ENTITY_TYPES, buildEntityExtractInstructions, validateExtractOutput, toEntityList, toNameList, extractEntitiesWithLlm`
- [catalog-draft-adapter.js](src/news/feedback/catalog-draft-adapter.js) — 将热点待补工具候选转换为 Seed（接受解析结果 vendor_name/official_url/official_urls[]，多官方 URL 全部进 discovery_sources 作 official_hint；透传候选显式 modality；保留候选显式指定的 existing level1/level2 稳定引用以加入已有分组；detail_kind 由候选 detail_kind_hint 严格映射——只接受 catalog 已知类型 tool/api_model/subscription_plan/product_variant，未知 hint 抛 PENDING_DETAIL_KIND_INVALID（不再静默降为 tool），缺省当 tool；isVagueName 拒绝笼统名 PENDING_CANDIDATE_VAGUE；不设 new_group_title 时分组名由 deriveKeys 回退 seed.name），不直接写正式目录。导出: `pendingCandidateToSeed`

## docs/manual/ — 用户说明
- [catalog-generator.md](docs/manual/catalog-generator.md) — schema v3 五模块目录生成器手册；CatalogProfile/OfficialSource/FieldCoverage/LayerPatch、plan/new/resume/review/apply、硬成本账本和恢复安全规则；含 LLM 二级系列自动归属（政策 + AI hint + migration_required）、二级系列迁移 CLI、批量成本门禁（三本账/零确认零付费/from-preview 复用）。
- [comparison-data-sources.md](docs/manual/comparison-data-sources.md) — 对比页数据源选型核实记录；AA/SWE-bench/LiveBench/HF Leaderboard/OpenRouter 可用通路、LMArena 仅第三方快照、DeepSWE 抓站、HF 网络镜像坑与推荐组合。
- [comparison-data-contract.md](docs/manual/comparison-data-contract.md) — 对比页数据契约（integrated 层）：文件布局、维度键枚举与归一化口径、index.json/data.json/view-config/models-alias 契约、raw 快照形状、前端渲染规则映射、i18n 键、管线实现红线。
- [icons.md](docs/manual/icons.md) — 品牌图标资产维护说明：官方 logo 获取、Simple Icons 备选、manifest 键规则和三级模型按系列继承/单模型覆盖。
- [dev-log.md](docs/manual/dev-log.md) — 开发日志（开发过程记录，公开可见，供回顾开发背景；开发计划不入库仅本地）。

## src/content/ — 内容生成
- [generate-rss.js](src/content/generate-rss.js) — RSS 生成。导出: `getFeedItems, generateRss`
- [generate-og-image.js](src/content/generate-og-image.js) — OG 图生成；默认输出经 `DIRS.public` 写 `public/og-image.png`。导出: `generateOgImage`

## src/acquisition/ — 工具情报采集
- [fetch-intel-http.js](src/acquisition/fetch-intel-http.js) — HTTP 抓取层。导出: `requestText, fetchToolIntel`
- [normalize-intel.js](src/acquisition/normalize-intel.js) — 价格/表格解析与合并。导出: `extractDeepSeekPricing, assignPrices, mergeIntelData...`
- [fetch-tool-intel.js](src/acquisition/fetch-tool-intel.js) — 工具情报采集 CLI 入口（`require.main === module` 自运行，无库导出）；编排 fetch-intel-http 与 normalize-intel 完成"抓取 → 规范化 → 写 data/acquisition 产物"流程，手动运行（docs/operations.md 记载）
- [validate-intel.js](src/acquisition/validate-intel.js) — 情报数据校验。导出: `validate, validateSourceConfig, validateIntelData`

## src/maintenance/ — 维护校验与本机工作台
- [maintainer-workbench-server.js](src/maintenance/maintainer-workbench-server.js) — 仅监听 `127.0.0.1` 的 Node 原生维护者工作台 server；静态资源白名单、fragment token/Bearer、同源 POST、32KiB JSON 上限和固定 API 路由，包含新闻后续流程、pending 审核、Catalog Draft/Concept batch 闭环与工具 preview/确认 Apply 的受控入口。导出: `createMaintainerWorkbenchServer`
- [maintainer-workbench-service.js](src/maintenance/maintainer-workbench-service.js) — 维护者工作台领域编排与受控 DTO；复用新闻关键词/Top/知识提取、pending 审核、Catalog Assistant 单 Draft 与 Concept batch preview/CAS，保留既有 revision、hash、成本和事务门禁。导出: `createMaintainerWorkbenchService`
- [validate.js](src/maintenance/validate.js) — **校验聚合入口（require 即运行 + process.exit 0/1）**。scripts/validate.js 直接引用，CI 三处工作流依赖
- [catalog-date-audit.js](src/maintenance/catalog-date-audit.js) — 纯本地只读五模块 catalog 日期语义审计；按 detail_kind、来源 title/url 和人工 repair 证据分类为 verified_release/verified_update/ambiguous/invalid_source，生成迁移清单但不修改正式 catalog。导出: `TARGET_FIELD_BY_KIND, auditCatalogDates, createCatalogDateAudit, loadRepairEvidence, repairFieldFromNote, runCatalogDateAudit, writeAuditReport`
- [validate-catalog.js](src/maintenance/validate-catalog.js) — catalog 数据校验。导出: `validateCatalog, validateHtml`
- [validate-news.js](src/maintenance/validate-news.js) — news 数据校验（news-config-v2 采集安全配置 + last-run X credits/request 账本 + hotspots + v2 候选层 min-candidates）。导出: `validateNews, validateMinNews, validateNewsConfig, validateLastRun`
- [validate-comparison.js](src/maintenance/validate-comparison.js) — 模型对比数据校验（先校验 model-exclusions 规则与 integrated 无命中残留，再校验 index/data 交叉一致性、canonical/同厂商 display 唯一、series/member 引用完整性、identity/evaluation_profiles 契约、degree 不得伪装评测环境、composite 与 raw 自洽、维度 0-100、view-config/models-alias 契约形状；raw 快照存在则 schema 校验、缺失优雅跳过）。导出: `validateComparison, validateIndex, validateData`

## tests/ — 自动化回归
- [index.js](tests/index.js) — 跨平台全量测试目录入口；递归加载所有 `*.test.js`，使 `node --test tests/` 可用。
- [web-date-display.test.js](tests/web-date-display.test.js) — 前端 typed 日期、无日期/套餐及场景类型标签纯函数回归。
- [catalog-interface.test.js](tests/catalog-interface.test.js) — 五模块目录 Interface、字段所有权、稳定引用、工具卡→三级详情以及场景/精选详情引用回归。
- [catalog-date-audit.test.js](tests/catalog/catalog-date-audit.test.js) — 日期语义审计保守分类、目标字段和输入不变回归。
- [catalog-date-repair.test.js](tests/catalog/catalog-date-repair.test.js) — 日期字段级修补与 `advance_update` 回归：目标类型、官方 metadata/正文/根域门禁、向前日期、批量 preview、approved queue、revision/preview 冲突、字段零漂移和 atomic commit。
- [catalog-generator.test.js](tests/catalog/catalog-generator.test.js) — v3 官方查询、单段 Synthesis Adapter、LayerPatch planner 和 revision 回归。
- [catalog-synthesis-prompt.test.js](tests/catalog/catalog-synthesis-prompt.test.js) — 合成 prompt 按层分组、来源截断限量、跳过无正文来源与指令规则回归。
- [catalog-adapters.test.js](tests/catalog/catalog-adapters.test.js) — Tavily 官方域名发现、清洗正文、能力探针与 DeepSeek 组合 Adapter 回归。
- [catalog-batch.test.js](tests/catalog/catalog-batch.test.js) — 批量生成编排回归：读卡、三层查重、双表登记/解析/detail_kind_hint、`update_sources` 严格契约与 batch 兼容性、dry-run 预览、全局成本门禁、批量循环失败隔离、登记表增删。
- [catalog-workbench.test.js](tests/catalog/catalog-workbench.test.js) — 工作台 Catalog 协调器回归：成本/计划/Apply 门禁、不自动 Apply、discard 绑定当前 catalog revision。
- [catalog-integrated-lookup.test.js](tests/catalog/catalog-integrated-lookup.test.js) — 共享 release_date 索引机械查找回归：tool_key/标题/slug/identity 对齐、deterministic 来源跳过官方来源校验。
- [catalog-retention-prune.test.js](tests/catalog/catalog-retention-prune.test.js) — 14 个月滚动级联删除回归：过期 tool/api_model 判据、级联删 vendor 链、无日期/subscription_plan 保守保留、引用清理、featured 悬空只报不改。
- [catalog-release-dates.test.js](tests/catalog/catalog-release-dates.test.js) — catalog→comparison 共享投影发布回归：只投影 api_model/product_variant、tool_key join、逐条形状校验 fail-closed、读写冻结。
- [tool-update-collector.test.js](tests/catalog/tool-update-collector.test.js) — 专用更新网页 collector 全离线回归：GitHub REST/raw 请求构造、来源仓库/路径校验、release 过滤、限流重试、tag-only discovery、Tavily Extract-only 和统一证据。
- [tool-update-review.test.js](tests/catalog/tool-update-review.test.js) — 工具更新 AI/planner/store 全离线回归：五字段结构化输出、本地/DeepSeek 成本门禁、实体/组件/日期阻断、队列幂等、人工结论保留和 evidence hash 重开。
- [tool-update-review-cli.test.js](tests/catalog/tool-update-review-cli.test.js) — 工具更新 CLI 离线回归：参数解析、Tavily/DeepSeek 门禁、本地模型汉化与失败重试、外部摘要成本门禁、scan 不 Apply、localize 回填/list 只读和 Apply 三重确认门禁。
- [concept-batch.test.js](tests/catalog/concept-batch.test.js) — 概念批量编排回归：读卡、双层查重、approved 摘要证据匹配与 K 上限、vibe-hub 补充/失败静默、成本估算、dry-run 零网络零写入、成本门禁、合成失败隔离、预览文件、apply 必填校验/去重/合并保序/terms 子集。
- [vibe-hub-evidence.test.js](tests/catalog/vibe-hub-evidence.test.js) — vibe-hub 提取回归：term→slug（中文 null）、JSON-LD/正文结构化提取、缓存命中零网络、未命中 GET+写缓存、TTL 过期重抓、404/网络失败 null、串行节流、过期刷新与失败保留。
- [catalog-profile-contract.test.js](tests/catalog/catalog-profile-contract.test.js) — CatalogProfile 适用性、video API 必需谓词、稳定目标与逐层 create/replace/noop 规划回归。
- [catalog-series-policy.test.js](tests/catalog/catalog-series-policy.test.js) — LLM 二级系列政策契约回归：16 厂商矩阵、validator fail-closed、usageKindOf general/专用/uncovered 分类、vendor 别名、人工 placement ref（kind/存在性/vendor 归属）、稳定 ID 与 slugify 点号冲突。
- [catalog-series-migration.test.js](tests/catalog/catalog-series-migration.test.js) — LLM 二级系列迁移规划器回归：同 id 就地改写、全新创建、专用改名、多碎片合并、多余成员搬家、专用零漂移、碎片删除与 id_map、L1 level2_refs 重写、孤儿为空、既有浮空详情入 warnings、非政策厂商零漂移；集成真实快照迁移后校验通过且关键终态符合政策。
- [catalog-series-placement-ai.test.js](tests/catalog/catalog-series-placement-ai.test.js) — 二级系列 AI 分类 Adapter 回归：prompt 白名单无密钥、结构校验、缺 ledger fail-closed、resolveSeriesPlacement 人工优先/非法拒绝、确定性 decision existing/create、专用与无政策厂商 not_applicable、GLM 第 4 个成员 migration_required、needs_ai 未放行/放行+AI hint/冲突/失败各分支、applyPlacementToSeed 写入 seed。
- [catalog-research.test.js](tests/catalog/catalog-research.test.js) — 官方域名过滤、Tavily-only 成本、字段级 missing-only resume 和硬成本账本回归。
- [catalog-synthesis.test.js](tests/catalog/catalog-synthesis.test.js) — 完整层字段合成、来源 provenance、字段级 Profile mismatch、占位/伪造覆盖拒绝和 noop 层回归。
- [catalog-transaction-store.test.js](tests/catalog/catalog-transaction-store.test.js) — 精确 area/id 删除规划、引用清理、缺失目标和不完整删除集回归。
- [catalog-draft-envelope.test.js](tests/catalog/catalog-draft-envelope.test.js) — schema v3 Readiness 字段级重算、Source 校验与旧 Draft Apply 拒绝回归。
- [catalog-pipeline-v3.test.js](tests/catalog/catalog-pipeline-v3.test.js) — Kling video API 完整/缺字段 dossier 全链 mock；五层 replace、非缺省字段、字段级 blocked 改类建议和 Assistant new/resume/review 回归。
- [kling-video-dossier.js](tests/catalog/fixtures/kling-video-dossier.js) — 完全离线的 Kling video API 官方 dossier 与受约束单段合成 Adapter fixture。导出: `OFFICIAL_URL, EXACT_QUOTE, klingVideoSeed, createKlingDossierAdapters`
- [catalog-cli.test.js](tests/catalog/catalog-cli.test.js) — CLI 参数、vendor/product 官方 URL 登记增删、纯本地 freshness audit、热点 Seed、catalog Tavily/DeepSeek 模块配置、Tavily 能力 fail-closed 和共享 DeepSeek transport 回归。
- [tavily-client.test.js](tests/shared/tavily-client.test.js) — Tavily Search/Extract 请求、Key、URL canonicalization、失败响应和正文映射回归。
- [providers.test.js](tests/shared/providers.test.js) — provider 协议、Key 环境变量映射和 Messages API fail-closed 回归。
- [llm-gateway.test.js](tests/shared/llm-gateway.test.js) — 统一 AI 调用网关多协议路由（MESSAGES / RESPONSES / CHAT / local）、文本与结构化 JSON 提取及错误透传回归；含经真实 catalog 合成 Adapter 协作验证 `requestStructuredJson` 成本账本 fail-closed 的集成用例。
- [ai-config.test.js](tests/shared/ai-config.test.js) — 业务模块配置合并、Tavily retrieval 配置和 protocol 校验回归。
- [collector-x-v2.test.js](tests/news/collector-x-v2.test.js) — X 请求级 credits 硬预算回归：窗外/空长文/重试/零预算/低配置/超量响应/直接门禁。
- [news-pipeline-min.test.js](tests/news/news-pipeline-min.test.js) — v2 全链编排、总开关、采集状态汇总、credits→last-run 透传回归。
- [validate-news-config.test.js](tests/maintenance/validate-news-config.test.js) — news-config-v2 安全字段与 last-run X credits/request schema 校验。
- [model-exclusions.test.js](tests/comparison/model-exclusions.test.js) — 排除规则 schema、token-boundary prefix、exact identity、命中诊断和 fail-closed 回归。
- [rebuild-comparison.test.js](tests/comparison/rebuild-comparison.test.js) — 模型对比管线回归：4 源对齐/合并、models-alias 覆盖、维度归一化、综合分缺源重分配、性价比、单源/无综合分模型、整系列排除在 Elo/value/series 前生效且不写 raw、LiveBench CSV 聚合、llm-stats RSC 解析、LMArena 快照 fail-closed。
- [model-series.test.js](tests/comparison/model-series.test.js) — 系列投影回归：系列/成员/修订变体聚合、人工成员展示名与重叠登记优先级。
- [retention.test.js](tests/comparison/retention.test.js) — 14 个月滚动删除回归：纯函数（窗口/推进/幂等/自愈）+ 校验接口（readRetentionState 冻结回退、advanceRetentionToNow 唯一写入口、writeRetention fail-closed）。
- [release-date.test.js](tests/comparison/release-date.test.js) — release_date 多源解析回归：llm-stats 优先、openrouter 兜底、catalog 反查 Path A/B 经共享投影、filterByReleaseCutoff 排除/保守保留。
- [release-index.test.js](tests/comparison/release-index.test.js) — 共享 model-release-dates 索引读写回归：逐条校验 fail-closed 不覆盖、原子写、缺失/损坏回退空、冻结。
- [fixtures/raw/](tests/comparison/fixtures/raw/) — 模型对比管线测试 raw 快照 fixtures（openrouter/lmarena/livebench/llm-stats 各源小样本）。

- [model-identity.test.js](tests/comparison/model-identity.test.js) — 跨源模型身份解析、厂商/服务方式/评测挡位与歧义门禁回归。
- [identity-review.test.js](tests/comparison/identity-review.test.js) — 模型名称歧义候选收集、升级阈值与人工确认流程回归。
- [revision-date.test.js](tests/comparison/revision-date.test.js) — 混合 revision 日期解析、规范化与未来日期回退回归。
- [empty-model-filter.test.js](tests/comparison/empty-model-filter.test.js) — 无有效评测维度模型按 identity 整组过滤回归。
- [beijing-time.test.js](tests/news/beijing-time.test.js) — 固定 UTC+8 日期键、自然日与午夜边界回归。
- [content-classifier-llm.test.js](tests/news/content-classifier-llm.test.js) — 内容分类 LLM 结果归一化与降级回归。
- [content-classifier-rule.test.js](tests/news/content-classifier-rule.test.js) — 内容分类规则召回、类型判断与边界回归。
- [feedback/llm-entity-extract.test.js](tests/news/feedback/llm-entity-extract.test.js) — 摘要实体提取结构化输出、类型与 fail-closed 回归。
- [feedback/tool-feedback.test.js](tests/news/feedback/tool-feedback.test.js) — 热点摘要实体路由、待补工具/概念卡去重与笼统名拦截回归。
- [feedback/pending-review-store.test.js](tests/news/feedback/pending-review-store.test.js) — 待补卡 store 回归：稳定 candidate key、revision CAS、人工结论保留/业务变化重置、白名单投影。
- [keyword-refine.test.js](tests/news/keyword-refine.test.js) — 关键词候选规则召回、approved 原文收集、有限输入规模、丢弃词排除与来源统计回归。
- [keyword-actions.test.js](tests/news/keyword-actions.test.js) — 关键词采纳/丢弃 mutation 回归：丢弃黑名单幂等去重、revision 门禁、原子写与陈旧冲突拒绝。
- [transcript-workflow.test.js](tests/news/transcript-workflow.test.js) — 字幕文件落库与外部 AI 总结回归：路径穿越/非法文件名拒绝、approved 门禁、成本确认、AI 总结写回、无字幕/缺失候选失败汇总、存储截断。
- [min-history.test.js](tests/news/min-history.test.js) — 热点候选轻量历史归档、压缩与批次日期回归。
- [news-cmd-min.test.js](tests/news/news-cmd-min.test.js) — `min-review` 审核/关键词/top/归档命令纯逻辑回归。
- [news-localizer.test.js](tests/news/news-localizer.test.js) — 候选标题/描述本地化输入、输出与降级回归。
- [news-public-gate.test.js](tests/news/news-public-gate.test.js) — 公开字段完整性、时间窗与投影过滤回归。
- [local-enrichment.test.js](tests/news/local-enrichment.test.js) — 本地 Bonsai 增量加工与双通道自愈修复回归：分批落盘、跳过阶段、人工/字幕保护、失败回退与审核统计边界。
- [news-review-list.test.js](tests/news/news-review-list.test.js) — 人工审核清单生成、合并、保留结论与批量应用回归。
- [news-reviewer.test.js](tests/news/news-reviewer.test.js) — AI 审核建议输入、结构化输出与并发池回归。
- [news-rss.test.js](tests/news/news-rss.test.js) — RSS 项目筛选、字段投影与生成回归。
- [news-summarizer.test.js](tests/news/news-summarizer.test.js) — 候选摘要/key points 输入输出与降级回归。
- [review-v2-disclosure.test.js](tests/news/review-v2-disclosure.test.js) — YouTube AI 生成披露硬排除与 v2 审核分流回归。
- [run-after-first-review.test.js](tests/news/run-after-first-review.test.js) — 首次审核后 refine/ai-top 并行编排与失败隔离回归。
- [local-model.test.js](tests/shared/local-model.test.js) — 本地 Bonsai 探测、自动启动、轮询超时、TTL 缓存与测试注入隔离回归。
- [check-secrets.test.js](tests/maintenance/check-secrets.test.js) — 密钥/高熵扫描与敏感文件门禁回归。
- [check-standards.test.js](tests/maintenance/check-standards.test.js) — 规范检查器 7 类检测正反例、白名单 count 豁免与 whitelist-growth、fail-closed 与浏览器→shared 盲区回归（临时目录 fixture 隔离，不依赖 src 现状）。
- [env.test.js](tests/maintenance/env.test.js) — `.env` 子集解析、覆盖规则与项目根目录回归。
- [validate-comparison.test.js](tests/maintenance/validate-comparison.test.js) — integrated 对比数据、raw 快照与引用契约校验回归。
- [fixtures/x.json](tests/fixtures/x.json) — 新闻管线 X 平台测试夹具。

## scripts/ — 命令入口（薄包装；src/ 为纯逻辑）
- [build-news.js](scripts/build-news.js) — 热点管线 v2 CLI 实际入口；加载 `.env` 后运行 `runMin`，支持默认双平台、`--platforms` 分时采集与 `--fixture` 离线全链。导出: `main, mainMin, buildMinFixtureOptions`
- [catalog-generator.js](scripts/catalog-generator.js) — schema v3 五模块目录生成器 CLI；`plan/prepare` 零网络，`new/resume/probe/batch` 要求显式 `--tavily-access-mode` 并透传到 Tavily，Apply 要求维护者输入完整确认；支持 `remove --targets` 精确 ID 删除（revision/确认值/事务回滚）、`batch`（`--confirm-cost` 全局确认自动 apply / `--dry-run` 预览 / `--from-preview` 复用解析）以及双表 `url-registry vendor/product` 维护和纯本地 product freshness audit。导出: `parseArgs, main, readSeed, tavilyAccessModeFromFlags, generatorOptionsFromFlags`
- [concept-generator.js](scripts/concept-generator.js) — **AI 概念库生成器 CLI（与五模块目录生成器分离）**：`batch --file <待补概念卡> --dry-run/--confirm-cost` 合成预览 → `preview` → `apply [--terms]` 人工写 glossary。导出: `parseArgs, main`
- [catalog-series-migration.js](scripts/catalog-series-migration.js) — LLM 二级系列迁移 CLI：预览（人类可读 / `--json`）加载政策 + 当前快照输出变更；`--apply <targetRevision>` 阶段 3 原子 Apply——按当前快照重算目标 revision 校验防漂移，经 commitSnapshotChange 五文件事务 + dist 重建提交，expectedRevision 绑定防并发冲突。导出: `currentPlan, humanReport, applyMigration, main`
- [tool-update-review.js](scripts/tool-update-review.js) — 编程工具专用更新审核 CLI：`preflight` 只读环境检查，`scan` 采集/AI/planner 后写 review queue 并通过新闻链路本地模型生成中文展示摘要，`localize` 只回填已有队列且失败可重试，日期不晚于当前记录的证据作为 no-op，`list/preview` 只读，`apply` 仅消费 approved 并复用日期批量事务。外部摘要回退受显式成本确认与账本门禁约束。导出: `PRODUCT_KEYS, parseArgs, accessModeOf, runPreflight, runScan, runLocalize, localizeToolCandidate, runList, runPreview, runApply, main`
- [refresh-vibe-hub-cache.js](scripts/refresh-vibe-hub-cache.js) — 定时刷新 vibe-hub 概念缓存（CI 入口，由 refresh-vibe-hub-cache.yml 每 3 天北京 19:00 调用）；只刷 `fetched_at` 距今 > 3 天 TTL 的条目，空缓存/全新鲜零网络，纯 HTTP 不读任何 Key。导出: `main`
- [news-cli.js](scripts/news-cli.js) — CLI 分发入口（透传 src/news/cli/news-cli，含 **`min-review` 命令组**）
- [fetch-comparison.js](scripts/fetch-comparison.js) — 模型对比数据管线 CLI（run 定时抓取+全绿重建 / fetch <source> 手动单跑 / rebuild / review 输出零网络零写入的待人工名称歧义清单 / status）；`.github/workflows/refresh-comparison.yml` 每日 cron 调用。
- [identity-review.bat](bat/identity-review.bat) — 模型身份歧义审计维护入口；双击调用 `fetch-comparison.js review`，只生成待人工确认清单，不调用 AI、不写正式数据。
- [catalog-date-repair.js](scripts/catalog-date-repair.js) — 日期字段级修补 CLI；`plan` 只输出字段/来源/revision/preview hash，`apply` 需回传 revision/hash 并输入精确确认值。导出: `readRepair, publicPreview, main`
- [catalog-date-audit.js](scripts/catalog-date-audit.js) — 纯本地日期语义审计 CLI；默认写入 `data/manual/tools/catalog-date-audit.json`，`--dry-run` 只输出统计，不写文件。导出: `parseArgs, main`
- [validate.js](scripts/validate.js) — 校验聚合入口
- [check-standards.js](scripts/check-standards.js) — 零依赖规范静态检查器（validate.js 前置门禁，全部 CI 工作流生效）：依赖方向/垫片/旧契约叙事/体量导出/环/组装纪律/src 文件 CODEBASE-MAP 登记完整性 7 类检测；存量违规白名单 `scripts/check-standards.whitelist.json`（git 跟踪，条目带机器校验 count，白名单文件内违规增长报 whitelist-growth，铁律只减不增）。导出: `runChecks, main`
- [build-dist.js](scripts/build-dist.js) — src/web + public + data → dist/（维护者入口：bat/build-dist.bat）
- [browser-acceptance.js](scripts/browser-acceptance.js) — 依赖零安装的 Edge/CDP 真实页面验收：读取被忽略的 `config/browser.local.json`，启动 dist 静态站与临时 Edge profile，检查 18 张模型卡搜索/详情、三级模型对比选择器的厂商/系列展开与模型搜索、revision/degree 交互、旧 Spark/xunfei 隐藏和排除模型不可见。
- [publish-news.js](scripts/publish-news.js) — 候选 → 公开投影 + RSS 发布（**默认走 v2：min-candidates approved 按每日 top 重建 hotspots.json**）
- [run-after-first-review.js](scripts/run-after-first-review.js) — 首次审核结论落地后安全并行 `refine` 与 `ai-top`；任一失败仅终止本次记录子进程并整体失败。导出: `runAfterFirstReview`
- [check-secrets.js](scripts/check-secrets.js) — 密钥/高熵扫描（validate.js 反向依赖）
- [generate-og-image.js](scripts/generate-og-image.js) — OG 图生成入口
- [maintainer-workbench.js](scripts/maintainer-workbench.js) — 维护者工作台 server 唯一启动器：loadDotEnv 后起 `src/maintenance/maintainer-workbench-server`（仅监听 127.0.0.1），SIGINT/SIGTERM 优雅停止。导出: `main`

- [after-first-review.bat](bat/after-first-review.bat) — 首次人工审核后：应用 review 清单，再安全并行生成关键词提纯与 AI top 清单。
- [archive-min.bat](bat/archive-min.bat) — 归档当前热点候选并重置当日人工清单的维护者入口。
- [apply-keywords.bat](bat/apply-keywords.bat) — 应用维护者填写的 keyword-refine 清单；仅更新后续采集关键词，不发布或构建。
- [apply-top.bat](bat/apply-top.bat) — 应用 top_selected 并发布公开投影。
- [catalog-generator.bat](bat/catalog-generator.bat) — 五模块目录生成器维护者入口，只转发 Node CLI，不包含凭据或业务逻辑。
- [concept-generator.bat](bat/concept-generator.bat) — AI 概念库生成器维护者入口（concept-cards-pending → glossary.json），只转发 Node CLI，不包含凭据或业务逻辑。
- [tool-update-review.bat](bat/tool-update-review.bat) — 编程工具更新审核中文菜单；只转发 `scripts/tool-update-review.js`，不保存凭据、业务逻辑或默认批准状态。
- [build-dist.bat](bat/build-dist.bat) — 重建静态 dist。
