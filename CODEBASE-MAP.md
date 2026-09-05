# CODEBASE-MAP — 代码索引

维护约定：改动/新增/删除代码文件后，必须同步更新本文件。条目 = `文件名 — 职责。导出: 关键导出`。

## data/catalog/ — 五模块目录数据
- [vendor-cards.json](data/catalog/vendor-cards.json) — 厂商列表卡片数据；只含卡片展示、访问/价格判断、搜索字段和一级预览稳定引用，不保存场景推荐字段，二级快捷入口与三级数量由目录数据动态派生。
- [tool-cards.json](data/catalog/tool-cards.json) — 工具列表卡片数据；包含具体工具和 API 模型工具，不包含订阅套餐；通过 `detail_ref` 指向三级详情，卡片不重复保存三级来源与价格详情。
- [vendor-preview-level1.json](data/catalog/vendor-preview-level1.json) — 厂商一级预览数据；标题、描述、状态、特点和二级稳定引用由一级模块拥有。
- [vendor-preview-level2.json](data/catalog/vendor-preview-level2.json) — 厂商二级分组预览数据；通过 `detail_refs` 指向三级详情，不重复保存来源或三级子卡片投影。
- [tool-preview-level3.json](data/catalog/tool-preview-level3.json) — 厂商三级预览/工具详情唯一数据源；由 `detail_kind` 区分工具、API 模型和订阅套餐，层级由二级 `detail_refs` 表达，价格/访问/场景与来源信息由详情拥有。
- [scenes.json](data/catalog/scenes.json) — 场景演示数据（AI 搜索示例 + 场景模式共用）；`name`/`search_terms` 为关键词索引词表，`description` 为场景导语，`example` 为搜索首页「你可以试试」的自然语言示例问句（点击整句填入输入框，按关键词索引命中对应场景）。

## data/manual/registries/ — 生成器登记表与政策数据
- [official-url-registry.json](data/manual/registries/official-url-registry.json) — 厂商/模型人工官方 URL 登记表。
- [official-product-url-registry.json](data/manual/registries/official-product-url-registry.json) — 具体 AI 产品官方来源登记表与更新源契约。
- [llm-series-policy.json](data/manual/registries/llm-series-policy.json) — 厂商 LLM 二级系列分类政策唯一规则源。
- [vibe-hub-cache.json](data/manual/registries/vibe-hub-cache.json) — VibeHub 概念页本地缓存。

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
- [interface.js](src/catalog/interface.js) — Node 侧五模块目录唯一 Interface；三级批量替换委托共同事务。导出: `catalog, DATA_FILES, resetCatalogForTests`

## src/shared/ — 跨模块基础能力
- [beijing-time.js](src/shared/beijing-time.js) — 固定 UTC+8 北京时间日期键、自然日键与当天零点 ISO 工具，避免本地 Windows 与 CI 时区差异。导出: `BEIJING_OFFSET_MS, beijingDateKey, beijingDayKey, beijingMidnightIso`
- [env.js](src/shared/env.js) — dotenv 子集解析 + 项目根目录。导出: `loadDotEnv, PROJECT_DIR`
- [paths.js](src/shared/paths.js) — 目录、catalog 文件、登记表与生成器事务路径常量，以及统一 AI 配置文件路径（全仓唯一数据登记点；`data/manual/registries/` 为官方登记表与政策，`data/manual/tools/` 为工具链路工作目录，`data/manual/concepts/` 为概念链路工作目录）。导出: `DIRS, CATALOG_FILES, CATALOG_GENERATOR_FILES, CONCEPT_FILES, AI_CONFIG_FILES, NEWS_FILES, COMPARISON_FILES, SHARED_FILES, REGISTRIES_FILES, DATA_FILES, RSS_FEED_PATH`
- [providers/](src/shared/providers/) — 外部 AI 提供商独立目录，各厂商独立拥有自身元数据、端点与默认模型（开闭原则），由 `index.js` 统一汇聚导出。
  - [protocols.js](src/shared/providers/protocols.js) — 传输协议常量定义（RESPONSES / MESSAGES / CHAT）。导出: `AI_PROTOCOLS`
  - [zhipu.js](src/shared/providers/zhipu.js) — 智谱 ZhipuAI 提供方独立配置（Anthropic Messages 兼容端点，glm-5.3-flash）。
  - [deepseek.js](src/shared/providers/deepseek.js) — DeepSeek 提供方独立配置（Responses / Chat 双端点，deepseek-v4-flash）。
  - [local.js](src/shared/providers/local.js) — 本地 Bonsai 提供方独立配置（llama-server 8080，bonsai）。
  - [openai.js](src/shared/providers/openai.js) — OpenAI 提供方独立配置。
  - [anthropic.js](src/shared/providers/anthropic.js) — Anthropic 原生提供方独立配置。
  - [index.js](src/shared/providers/index.js) — 统一汇总注册与提供方解析出口。导出: `AI_PROTOCOLS, AI_PROVIDERS, DEFAULT_PROVIDER_NAME, getProvider, resolveProvider, apiKeyForProvider`
- [ai-config.js](src/catalog/ai-config.js) — catalog 域 AI 配置：按模块读取、合并和校验 provider/model/protocol 与 Tavily retrieval 配置（默认值跟随 registry 开关）。导出: `DEFAULT_MODULE_CONFIGS, readAiConfig, loadAiModuleConfig, validateModuleConfig`
- [ai-transport.js](src/shared/ai-transport.js) — provider-aware Responses/Chat transport、认证/HTTP/超时错误归一化；endpoint 校验放行本地 localhost HTTP（本地 Bonsai 接入点）。导出: `DEFAULT_BASE_URL, DEFAULT_RESPONSES_ENDPOINT, classifyHttpError, redact, requestResponses, requestChatCompletions, requestMessages, textFromResponse`
- [llm-gateway.js](src/shared/llm-gateway.js) — 统一 AI 调用网关：实现 requestStructuredJson 与 requestLlmText，统一多协议（RESPONSES / MESSAGES / CHAT / local）路由分发、负载格式自适应折叠与错误码映射。导出: `requestStructuredJson, requestLlmText, resolveTransportRoute, extractJsonValues, diagnosticsOf, toChatCompletionsPayload, toMessagesPayload, toExternalChatPayload`
- [llm-protocol-payload.js](src/shared/llm-protocol-payload.js) — 协议负载构造与自适应格式转换。导出: `toChatCompletionsPayload, toMessagesPayload, toExternalChatPayload`
- [llm-endpoints.js](src/shared/llm-endpoints.js) — 本地 Bonsai 模型 OpenAI 兼容端点与模型名常量（news 侧 5 个 + catalog 侧 3 个本地化任务统一引用）。导出: `LOCAL_API_BASE, LOCAL_MODEL`
- [local-model.js](src/shared/local-model.js) — 本地 Bonsai 自动启动：调用本地 LLM 前确保服务在线——探测离线自动 spawn 启动脚本并轮询就绪（幂等 TTL 缓存、超时后 TTL 内不重复拉起）；注入自定义 fetchImpl（测试 mock）一律放行不探测不启动。导出: `LOCAL_MODEL_SCRIPT, buildProbePayload, probeLocal, startLocalServer, ensureLocalModel, resetLocalModelState, autostartEnabled`
- [tavily-client.js](src/shared/tavily-client.js) — Tavily Search/Extract 原生 fetch transport；keyless/keyed 按端点混用认证（search/extract 默认 keyless 免费、缺 key 可用，任意 keyless 429 都自动切 keyed 并进入冷却，冷却后恢复 keyless；cap code/detail 用于诊断，本地节流/冷却可注入）、Key/HTTP/超时错误归一化和 URL canonicalization。导出: `SEARCH_ENDPOINT, EXTRACT_ENDPOINT, canonicalizeUrl, resolveAccessMode, isKeylessCapResult, searchTavily, extractTavily, probeTavily`
- [retention.js](src/shared/retention.js) — 共享段 retention 校验接口（纯逻辑 + 文件 IO 分离）：cutoff = 当前年月 − 14 个月，`advanceRetentionCutoff` 幂等跨自然月推进、漏跑自愈 snap；`readRetentionState` 读端唯一入口（校验后冻结）、`advanceRetentionToNow` 写端唯一入口（推进 + 校验 + 原子写，失败降级沿用旧 cutoff）；`writeRetention` 形状校验 fail-closed 防误篡改。comparison 写、catalog 只读。导出: `DEFAULT_MONTHS, currentCutoffYearMonth, cutoffDateOf, advanceRetentionCutoff, readRetentionFromPayload, validateRetentionPayload, readRetentionState, advanceRetentionToNow, readRetention, writeRetention, ensureSharedDir`
- [release-index.js](src/shared/release-index.js) — 共享段 `model-release-dates.json` 校验接口（comparison 写 / catalog 只读）：`readReleaseIndex` 校验后冻结读取（缺失/损坏回退空）、`writeReleaseIndex` 逐条形状校验 fail-closed 原子写。导出: `isIsoDate, validateReleaseIndexEntries, readReleaseIndex, writeReleaseIndex`
- [catalog-release-dates.js](src/shared/catalog-release-dates.js) — 共享段 `catalog-release-dates.json` 校验接口（catalog 写 / comparison 只读）：`readCatalogReleaseDates` 校验后冻结读取、`writeCatalogReleaseDates` 逐条形状校验 fail-closed 原子写。导出: `isIsoDate, validateCatalogReleaseDatesEntries, readCatalogReleaseDates, writeCatalogReleaseDates`

## src/catalog/ — 目录数据接口与生成器
- [interface.js](src/catalog/interface.js) — Catalog 统一只读 Interface 与三级替换入口。
- [catalog-integrated-lookup.js](src/catalog/catalog-integrated-lookup.js) — Catalog 与 comparison 共享数据的查询适配。
- [ai-config.js](src/catalog/ai-config.js) — Catalog 模块 AI provider、模型与检索配置。
- [catalog-shared-publish.js](src/catalog/catalog-shared-publish.js) — Catalog 发布后共享日期投影。
- [catalog-workbench.js](src/catalog/catalog-workbench.js) — 维护者知识闭环 Catalog 协调器。
- [catalog-workbench-view.js](src/catalog/catalog-workbench-view.js) — Catalog 工作台视图 DTO 与诊断格式化。
- [catalog-generator-commands.js](src/catalog/catalog-generator-commands.js) — 目录生成器各子命令纯逻辑编排。
- [catalog-retention-prune.js](src/catalog/catalog-retention-prune.js) — Catalog 五模块滚动保留与级联删除协调。
- [core/index.js](src/catalog/core/index.js) — Catalog 核心子域真实聚合门面。
- [core/catalog-contract.js](src/catalog/core/catalog-contract.js) — 五模块字段、枚举、引用与快照契约。
- [core/catalog-snapshot-store.js](src/catalog/core/catalog-snapshot-store.js) — Catalog 快照读取、形状校验与文件路径解析。
- [core/catalog-snapshot-validator.js](src/catalog/core/catalog-snapshot-validator.js) — Catalog 快照结构与引用校验。
- [core/catalog-revision.js](src/catalog/core/catalog-revision.js) — 稳定序列化、revision 与 preview hash。
- [core/catalog-profile-contract.js](src/catalog/core/catalog-profile-contract.js) — detail_kind 与 modality 对应的 CatalogProfile 契约。
- [core/catalog-record-completeness.js](src/catalog/core/catalog-record-completeness.js) — 正式记录完整性与非缺省值门禁。
- [core/catalog-record-builders.js](src/catalog/core/catalog-record-builders.js) — 五类 Catalog 记录 Builder 与业务键规范化。
- [core/catalog-change-planner.js](src/catalog/core/catalog-change-planner.js) — LayerPatches 到 FutureSnapshot 的确定性规划。
- [core/catalog-research.js](src/catalog/core/catalog-research.js) — Catalog 官方来源发现、获取与成本账本编排。
- [core/catalog-synthesis.js](src/catalog/core/catalog-synthesis.js) — Catalog 分层记录合成与 provenance 门禁。
- [core/catalog-synthesis-prompt.js](src/catalog/core/catalog-synthesis-prompt.js) — Catalog 分层合成 prompt 构建。
- [core/deepseek-catalog-ai.js](src/catalog/core/deepseek-catalog-ai.js) — Catalog 结构化合成 AI 适配器。
- [draft/index.js](src/catalog/draft/index.js) — Draft 子域真实聚合门面。
- [draft/catalog-assistant.js](src/catalog/draft/catalog-assistant.js) — Draft plan、prepare、review、resume 与 apply 编排。
- [draft/catalog-batch.js](src/catalog/draft/catalog-batch.js) — 批量 Draft 解析、预览与应用编排。
- [draft/catalog-draft-envelope.js](src/catalog/draft/catalog-draft-envelope.js) — Draft Envelope 与 Apply 前 readiness 门禁。
- [draft/catalog-draft-store.js](src/catalog/draft/catalog-draft-store.js) — Draft 创建、读取、更新、列举与删除。
- [draft/draft-options.js](src/catalog/draft/draft-options.js) — Draft 配置、Seed 校验与研究成本预算。
- [intake/index.js](src/catalog/intake/index.js) — Intake 子域真实聚合门面。
- [intake/catalog-adapters.js](src/catalog/intake/catalog-adapters.js) — Catalog 研究与合成默认适配器。
- [intake/catalog-batch.js](src/catalog/intake/catalog-batch.js) — 待补卡批量导入与 Draft 生命周期。
- [intake/resolution.js](src/catalog/intake/resolution.js) — 待补卡解析、登记表查重与 placement 编排。
- [series/index.js](src/catalog/series/index.js) — Series 子域真实聚合门面。
- [series/catalog-series-policy.js](src/catalog/series/catalog-series-policy.js) — LLM 系列政策读取、校验与确定性 placement。
- [series/catalog-series-migration.js](src/catalog/series/catalog-series-migration.js) — 系列容量拆分迁移编排。
- [series/catalog-series-placement-ai.js](src/catalog/series/catalog-series-placement-ai.js) — 系列 placement AI 建议适配器。
- [tool-update/index.js](src/catalog/tool-update/index.js) — Tool Update 子域真实聚合门面。
- [tool-update/tool-update-collector.js](src/catalog/tool-update/tool-update-collector.js) — 官方工具更新证据收集。
- [tool-update/html-collector.js](src/catalog/tool-update/html-collector.js) — 官方更新页 HTML 抓取与文本清洗。
- [tool-update/tool-update-evidence.js](src/catalog/tool-update/tool-update-evidence.js) — 更新证据结构化与校验。
- [tool-update/tool-update-review-ai.js](src/catalog/tool-update/tool-update-review-ai.js) — 工具更新审核 AI 建议适配器。
- [tool-update/tool-update-review-contract.js](src/catalog/tool-update/tool-update-review-contract.js) — 工具更新审核中性契约。
- [tool-update/tool-update-review-planner.js](src/catalog/tool-update/tool-update-review-planner.js) — 工具更新审核确定性规划。
- [tool-update/tool-update-review-store.js](src/catalog/tool-update/tool-update-review-store.js) — 工具更新审核人工结论与队列合并。
- [tool-update/review-model.js](src/catalog/tool-update/review-model.js) — 审核队列安全投影与排序纯函数。
- [tool-update/review-queue-store.js](src/catalog/tool-update/review-queue-store.js) — 审核队列持久化契约。
- [tool-update/review-commands.js](src/catalog/tool-update/review-commands.js) — 工具更新审核 CLI 子命令实现。
- [tool-update/review-localize.js](src/catalog/tool-update/review-localize.js) — 工具更新审核候选本地化与中文摘要生成。
- [tool-update/review-scan.js](src/catalog/tool-update/review-scan.js) — 工具更新审核全源扫描与候选组装。
- [tool-update/catalog-date-repair.js](src/catalog/tool-update/catalog-date-repair.js) — 工具详情日期修补规划与 Apply 门禁。
- [url-registry/index.js](src/catalog/url-registry/index.js) — URL Registry 子域真实聚合门面。
- [url-registry/official-url-registry.js](src/catalog/url-registry/official-url-registry.js) — 厂商与模型官方 URL 登记及查询。
- [url-registry/product-registry.js](src/catalog/url-registry/product-registry.js) — 产品官方 URL 与更新源登记。
- [concept/index.js](src/catalog/concept/index.js) — Concept 子域真实聚合门面。
- [concept/concept-batch.js](src/catalog/concept/concept-batch.js) — 概念待补卡批量计划、合成与应用。
- [concept/concept-synthesis-ai.js](src/catalog/concept/concept-synthesis-ai.js) — 概念结构化合成 AI 适配器。
- [concept/concept-synthesis-prompt.js](src/catalog/concept/concept-synthesis-prompt.js) — 概念合成 prompt 构建。
- [concept/evidence.js](src/catalog/concept/evidence.js) — 概念来源证据抽取与归一化。
- [concept/preview-store.js](src/catalog/concept/preview-store.js) — 概念预览读写与校验。
- [concept/vibe-hub-evidence.js](src/catalog/concept/vibe-hub-evidence.js) — VibeHub 概念页证据提取与缓存。
- [transaction/index.js](src/catalog/transaction/index.js) — Catalog 事务真实聚合门面。
- [transaction/engine.js](src/catalog/transaction/engine.js) — 快照 staging、journal、锁、CAS、提交、回滚与恢复。
- [transaction/directory-swap.js](src/catalog/transaction/directory-swap.js) — 目录备份、交换与 Windows EPERM 回退。
- [transaction/removal-planner.js](src/catalog/transaction/removal-planner.js) — 精确删除目标与引用清理规划。

## src/comparison/ — 模型对比数据管线（CommonJS；子域化组织，抓取 4 公开源 → 重建 integrated）
- [index.js](src/comparison/index.js) — comparison 域顶层聚合统一门面。
- [compare-schema.js](src/comparison/core/compare-schema.js) — 共享契约：源 key、维度键枚举、各源 raw 快照 schema 白名单、口径归一化。
- [compare-store.js](src/comparison/core/compare-store.js) — raw 快照读写（原子写临时文件 + rename）。
- [rebuild-canonical.js](src/comparison/core/rebuild-canonical.js) — 多源模型名称、别名与规格确定性规范化。
- [rebuild-collector.js](src/comparison/core/rebuild-collector.js) — 4 源快照收集聚拢与有效记录过滤。
- [rebuild-dimensions.js](src/comparison/core/rebuild-dimensions.js) — 维度归一化与模型记录装配。
- [rebuild-comparison.js](src/comparison/core/rebuild-comparison.js) — integrated 重建主编排器。
- [run-comparison.js](src/comparison/core/run-comparison.js) — 抓取编排（cron 每日）：每源独立计数全量 + 失败隔离 WARN + 全绿才重建。
- [core/index.js](src/comparison/core/index.js) — core 子域门面。
- [compare-http.js](src/comparison/fetch/compare-http.js) — 抓取共享 HTTP 层：合理 UA + 有限重试 + 429 指数退避 + 超时。
- [fetch-openrouter.js](src/comparison/fetch/fetch-openrouter.js) — OpenRouter 官方免 key models API 抓取。
- [fetch-lmarena.js](src/comparison/fetch/fetch-lmarena.js) — LMArena 官方数据集抓取。
- [fetch-livebench.js](src/comparison/fetch/fetch-livebench.js) — LiveBench 官方 CSV 抓取与聚合。
- [fetch-llm-stats.js](src/comparison/fetch/fetch-llm-stats.js) — llm-stats RSC flight payload 确定性解析。
- [fetch/index.js](src/comparison/fetch/index.js) — fetch 子域门面。
- [model-identity.js](src/comparison/identity/model-identity.js) — 模型身份解析深 Module。
- [identity-review.js](src/comparison/identity/identity-review.js) — 名称歧义离线审计 Module。
- [identity-review-ai.js](src/comparison/identity/identity-review-ai.js) — 名称歧义 AI 建议 Adapter。
- [model-exclusions.js](src/comparison/identity/model-exclusions.js) — integrated 重建排除规则深 Module。
- [empty-model-filter.js](src/comparison/identity/empty-model-filter.js) — 无数据模型自动过滤。
- [identity/index.js](src/comparison/identity/index.js) — identity 子域门面。
- [model-series.js](src/comparison/series/model-series.js) — 模型系列分组深 Module。
- [release-date.js](src/comparison/series/release-date.js) — 模型 release_date 多源解析 + 14 个月 cutoff 过滤。
- [revision-date.js](src/comparison/series/revision-date.js) — revision 日期规范化。
- [series/index.js](src/comparison/series/index.js) — series 子域门面。

## src/maintainer-web/ — 本机维护者前端（原生 HTML/CSS/JS；固定 `/api/workbench/v1/`，不参与公开静态站构建）
- [index.html](src/maintainer-web/index.html) — 编辑部审核工作台页面骨架；待办概览、新闻首审、关键词提纯生成/采纳、Top 待选池生成/选择/公开投影、新闻摘要→工具/概念 pending 审核与 Catalog/Concept 成本确认闭环、工具更新审核/preview/确认 Apply、概念预览。
- [css/workbench.css](src/maintainer-web/css/workbench.css) — 编辑部工作台响应式视觉样式与状态/队列/预览/工具确认/知识闭环组件样式。
- [js/workbench.js](src/maintainer-web/js/workbench.js) — 固定工作台 API 客户端与交互；fragment token、revision 绑定写请求、新闻/关键词/Top 后续操作、知识提取、pending 审核、Catalog Draft/Concept preview Apply、工具 preview 与确认 Apply、工具更新当前待办与历史折叠、blocked 门禁、加载/错误/409 状态和 DOM 安全渲染。

## src/web/ — 前端静态站（原生 ES module，无打包器；build-dist.js 原样复制到 dist/）
- [index.html](src/web/index.html) — 页面骨架与八视图 HTML 结构；AI 搜索首页为左中右布局（左侧「怎么用」三步引导栏 + 中间原样搜索主区 + 右侧留白），结果页三栏答案引擎。
- [css/style.css](src/web/css/style.css) — 全站样式；工具视图分类索引含极简编辑部科技风格、左侧独立定位、移动端横向布局与具体工具卡片主题/微纹理；厂商卡片与具体工具卡片的悬停样式作用域隔离；工具卡片适合/不适合提示使用颜色竖线；搜索主区热点概念层知识块（热点在上、概念在下）；搜索首页左中右引导栏布局（<main> 限宽按 :has 条件放开，窄视口收起为单列）
- [i18n/zh.js](src/web/i18n/zh.js) — 语言字典（试点：trending 视图 + 共享工具；未来加 en.js 等）。导出: `messages`
- [icons/](src/web/icons/) — 手工维护的品牌图标资产与 `manifest.json` 映射；build-dist 原样复制到 dist/icons，二级系列 icon 不直接渲染，仅供其三级详情继承。
- [js/main.js](src/web/js/main.js) — 前端入口：路由装配与事件绑定。导出: `currentView, switchView`
- [js/state.js](src/web/js/state.js) — 前端横切状态中心与跨视图数据持有者。导出: `state`

### src/web/js/data/ — 数据访问层
- [data/catalog-interface.js](src/web/js/data/catalog-interface.js) — 浏览器侧五模块目录 Interface。导出: `catalog`
- [data/data-catalog.js](src/web/js/data/data-catalog.js) — 前端目录 Interface 统一读取适配层。
- [data/data-comparison.js](src/web/js/data/data-comparison.js) — 前端模型对比数据加载与索引桥接。
- [data/data-filters.js](src/web/js/data/data-filters.js) — 前端工具、场景与概念内存过滤管线。
- [data/data-loader.js](src/web/js/data/data-loader.js) — 前端静态数据异步加载与骨架屏控制器。

### src/web/js/ui/ — 共享 UI 组件与工具
- [ui/brand-icons.js](src/web/js/ui/brand-icons.js) — 手工品牌图标清单加载与统一渲染。
- [ui/date-display.mjs](src/web/js/ui/date-display.mjs) — 前端日期事实展示与三级对象类型纯函数。
- [ui/i18n.js](src/web/js/ui/i18n.js) — 前端 i18n 框架核心（UI 文案 t() + 内容数据 getLocalizedField）。
- [ui/modal.js](src/web/js/ui/modal.js) — 全站统一模态框与无障碍焦点管理。
- [ui/ui-helpers.js](src/web/js/ui/ui-helpers.js) — 前端安全外链与文本转义通用辅助函数。
- [ui/ui-icons.js](src/web/js/ui/ui-icons.js) — 前端通用内联 SVG 图标定义。

### src/web/js/views/ — 视图模块
- [views/compare.js](src/web/js/views/compare.js) — 对比视图双 tab（模型对比 ↔ 工具对比）+ 工具对比引擎。
- [views/compare-chips.js](src/web/js/views/compare-chips.js) — 对比视图已选模型标签与变体选择组件。
- [views/compare-dimensions.js](src/web/js/views/compare-dimensions.js) — 对比视图评测维度与图表重算渲染。
- [views/compare-models.js](src/web/js/views/compare-models.js) — 模型对比引擎（读 integrated/ + view-config + models-alias）。
- [views/compare-selector.js](src/web/js/views/compare-selector.js) — 对比视图左侧模型树与筛选选择器。
- [views/compare-table.js](src/web/js/views/compare-table.js) — 对比视图规格与参数对比表格组装器。
- [views/featured.js](src/web/js/views/featured.js) — 编辑精选视图。
- [views/glossary.js](src/web/js/views/glossary.js) — AI 概念视图。
- [views/scenes.js](src/web/js/views/scenes.js) — 场景模式视图。
- [views/search.js](src/web/js/views/search.js) — AI 搜索视图主流程与答案引擎。
- [views/search-index.js](src/web/js/views/search-index.js) — 搜索三层关键词与概念词边界探测索引。
- [views/search-render.js](src/web/js/views/search-render.js) — 搜索结果下拉面板与高亮卡片渲染。
- [views/tool-cards.js](src/web/js/views/tool-cards.js) — 工具卡片渲染器。
- [views/tool-preview-level3.js](src/web/js/views/tool-preview-level3.js) — 厂商三级预览与工具详情模块。
- [views/tools.js](src/web/js/views/tools.js) — 工具库视图控制器。
- [views/trending.js](src/web/js/views/trending.js) — AI 热点视图。
- [views/vendor-cards.js](src/web/js/views/vendor-cards.js) — 厂商卡片渲染器。
- [views/vendor-preview-level1.js](src/web/js/views/vendor-preview-level1.js) — 厂商一级预览模块。
- [views/vendor-preview-level2.js](src/web/js/views/vendor-preview-level2.js) — 厂商二级预览模块。

## src/news/ — 新闻采集管线（CommonJS）
### core/ — 数据层（无网络副作用）
- [json-store.js](src/shared/json-store.js) — JSON 读写 + 原子写 + 并发锁（跨域通用存储层）。导出: `readJson, writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock`
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
- [pipeline-min.js](src/news/min/pipeline-min.js) — 热点管线 v2 总指挥（runMin 编排）：严格读取 collection.enabled 统一总开关（关闭时全链零网络/零写入）→ 采集 → 去重 → L0 硬过滤 → 分类 → 评分 → L1/L2 审核 → 候选落地 → 总结/本地化 → 自动生成待审清单 → 每日公开投影。导出: `runMin, loadV2Config, isCollectionEnabled, normalizeNow, resolveXWindow`
- [pipeline-collect.js](src/news/min/pipeline-collect.js) — 热点管线采集步骤执行与多平台并行调度。
- [pipeline-schedule.js](src/news/min/pipeline-schedule.js) — 热点管线到期判定、时间窗计算与调度状态持久化。
- [min-review-actions.js](src/news/min/min-review-actions.js) — min-candidates 审核状态批量流转与变更提交动作。
- [review-list.js](src/news/min/review-list.js) — 人工审核清单：自动生成待审清单 review.json（文件名固定去掉日期后缀，date 为北京时间；带 id、只含 pending、评分倒序；已存在时追加新 pending、保留人工结论、--force 强制重建）+ 应用人工结论批量写回候选层（apply；pending 跳过、无 id 旧格式拒绝）。维护者入口：bat/after-first-review.bat、bat/archive-min.bat（归档时重置当日人工清单）。导出: `scoreOf, suggestReview, buildReviewList, mergeReviewCandidates, loadReviewList, applyReviewList`
- [local-enrichment.js](src/news/min/local-enrichment.js) — 本地 Bonsai 批量增量加工编排：按批调用 enrichment-core，维护断点恢复与人工/字幕保护；自愈修复流程由 min-repair.js 独立拥有。导出: `enrichMinCandidates`
- [enrichment-core.js](src/news/min/enrichment-core.js) — 候选加工共享机制层：残缺判定、L1/L2 单条审核、并发安全落盘与摘要/本地化加工；供 enrich 与 repair 共用。导出: `nonNegativeInteger, needsL1Review, needsL2Advice, needsReviewWork, needsSummary, needsLocalize, needsRepair, countEnrichmentWork, countRepairWork, enrichCandidate, repairCandidate...`
- [min-repair.js](src/news/min/min-repair.js) — 双通道自愈修复编排：按残缺判定对候选批量补齐审核、摘要与本地化，支持本地+外部通道。导出: `DEFAULT_REPAIR_LIMIT, repairIncompleteCandidates`
- [ai-top.js](src/news/min/ai-top.js) — approved 候选的 AI top 结果确定性收敛：按 AI 选择顺序取值，对无效或漏选项按评分补齐，组装人工审核清单条目。导出: `selectTopCandidates`

### collectors/ — 各平台采集（会发网络请求）
- [collector-youtube-v2.js](src/news/collectors/collector-youtube-v2.js) — 热点管线 v2 的 YouTube 采集器（search.list 关键词发现，不依赖旧 quota/registry/scheduler）。导出: `collectYouTubeV2, buildItem, parseDuration, loadV2Config`
- [collector-youtube-normalize.js](src/news/collectors/collector-youtube-normalize.js) — YouTube 视频元数据与时长解析规范化。
- [collector-x-v2.js](src/news/collectors/collector-x-v2.js) — 热点管线 v2 的 X(TwitterAPI.io) 采集器（博主时间窗 last_tweets + 关键词 advanced_search + 长文 article 补读；请求级 credits 预占/结算与重试预算；零/非法预算 fail closed、供应商单价/单页下界保护、超量响应完整结算并止损；独立 credits 计数，不依赖旧 quota/registry/scheduler）。导出: `collectXV2, normalizeXV2Tweet, extractArticleText, hasArticleSignal, resolveConfig, loadV2Config`
- [collector-x-normalize.js](src/news/collectors/collector-x-normalize.js) — X(Twitter) 原始推文与长文数据规范化。
- [loadCollectorConfig.js](src/news/collectors/loadCollectorConfig.js) — 采集器共享配置读取与校验。

### classify/ — AI 内容分类/总结/审核建议/本地化
- [content-classifier.js](src/news/classify/content-classifier.js) — L0 规则 + L1 AI 分类编排（L0 不按娱乐/二创关键词硬排除；普通关键词仅用于分类，AIGC 披露硬排除由 review-v2 负责）。导出: `classifyRuleBased, classifyCandidate, classifyCandidates, confirmContentType`
- [content-summarizer.js](src/news/classify/content-summarizer.js) — 候选内容总结（标题+描述+字幕 → summary/key_points；空白 summary 视为缺失可重试）。导出: `summarizeCandidate, summarizeCandidates, enrichCandidateSummaries`
- [content-reviewer.js](src/news/classify/content-reviewer.js) — AI 审核建议（标题+描述+字幕+总结 → ai_review verdict/reasons/confidence；runPool 为分类/审核并发池，供 pipeline-min 复用）。导出: `reviewCandidate, reviewCandidates, runPool`
- [content-localizer.js](src/news/classify/content-localizer.js) — 候选内容本地化（标题+描述 → localizations[locale]，按原文实际字段判定完整性，原文保留顶层）。导出: `collectLocalizeSource, hasLocalizedContent, localizeCandidate, localizeCandidates, enrichCandidateLocalizations`
- [llm-provider.js](src/news/classify/llm-provider.js) — 内容加工模型提供方封装。
- [llm-prompts.js](src/news/classify/llm-prompts.js) — 内容分类、审核、总结与本地化 LLM prompt 模板。
- [llm-selection.js](src/news/classify/llm-selection.js) — AI Top 候选选择与关键词提纯 payload 构造。
- [loadContentTaskConfig.js](src/news/classify/loadContentTaskConfig.js) — 内容加工任务独立的 provider、model 与协议配置加载。

### pipeline/ — 管线与投影
- [feed-parser.js](src/news/pipeline/feed-parser.js) — 网络请求 + URL/标识规范化。导出: `normalizeUrl, hash, numberOrNull, requestText, extractTweetArray`
- [scoring-v2.js](src/news/pipeline/scoring-v2.js) — 热点管线 v2 评分层（6 权重加权，长期质量来自 history-store，互动用真实三率）。导出: `assessItemV2, scoreTimelinessV2, detectLightExperienceV2, scoreSourceReliability, scoreTypePreference`
- [projection.js](src/news/pipeline/projection.js) — 公开热点投影补充（hot_score/evidence_excerpt/related_resources + 内容去重）。导出: `enrichHotspotProjection, buildRelatedTitleLexicon, dedupeItems, buildToolUrlIndex`

### cli/ — 命令行
- [news-cli.js](src/news/cli/news-cli.js) — **CLI 分发器 + 入口**（仅保留 v2 命令组）。导出: `parseArgs, main, minReviewCommand`
- [cmd-content.js](src/news/cli/cmd-content.js) — `classify/localize preview` 子命令（纯函数预览；批量分类/本地化已由 v2 管线内建）。导出: `classifyCommand, localizeCommand`
- [cmd-min.js](src/news/cli/cmd-min.js) — **v2 `min-review` 命令组**（操作 min-candidates.json；`enrich` 本地批量初审分流/摘要/本地化，支持分批与断点续跑，默认自动衔接双通道自愈修复；`repair` 双通道自愈修复残缺数据；`feedback` 默认接入 LLM 实体提取，feedback.llm_extract=false 关 / LLM 失败降级正则；`refine` 分批覆盖全部 approved 调本地模型生成关键词清单，`refine-apply` 校验 adopted_keywords 后原子幂等追加配置；`ai-top` 经 `topCandidatesForAi` 控制模型输入规模（`collection.ai_top_input_max` 可调）、优先以 last-run 判定 YouTube、缺失时回退 approved 平台字段，产物带 id 与输入范围统计；`top-apply` 应用 top_selected=true；`apply` 写回首审结论；`archive` 由维护者确认后把当前候选压缩为轻量历史、清空候选层，并重置 data/manual 当日人工清单）。维护者入口：维护者工作台、bat/after-first-review.bat、bat/archive-min.bat。导出: `minReviewCommand, resolveAiTopConfig, topCandidatesForAi, MAX_AI_TOP_INPUT, applyRefineKeywords, applyTopSelectedList, removeManualLists, MANUAL_LIST_FILES`
- [min-review-flows.js](src/news/cli/min-review-flows.js) — min-review 命令组执行流编排（enrich、repair、feedback、refine 等）。

### transcripts/ — 收尾环节：字幕人工获取通知（独立于主链，只写清单文件）
- [transcript-notify.js](src/news/transcripts/transcript-notify.js) — 每日"待人工获取字幕"清单（min 候选层挑评分最高 notify_count 个 YouTube，写 transcript-requests.json 交人工，文件名固定去掉日期后缀、dateKey 北京时间；不碰主链/不调采集总结）。导出: `notifyTranscripts, parseNotifyCount, scoreOf`

### feedback/ — 收尾环节：工具库/概念库反哺（独立于主链，只写待补卡文件）
- [tool-feedback.js](src/news/feedback/tool-feedback.js) — 从 approved summary 提取带类型实体并写入待补卡。
- [llm-entity-extract.js](src/news/feedback/llm-entity-extract.js) — 摘要 AI 实体提取与结构化校验。

### pending/ — 待补候选与 Catalog Seed
- [index.js](src/pending/index.js) — Pending 域统一聚合门面。
- [store.js](src/pending/store.js) — Pending 候选存储、revision/CAS 与审核结论。
- [catalog-seed.js](src/pending/catalog-seed.js) — 待补候选到 Catalog Seed 的严格转换。
- [rules.js](src/pending/rules.js) — 待补候选名称与知识库匹配规则。

## docs/manual/ — 用户说明
- [catalog-generator.md](docs/manual/catalog-generator.md) — schema v3 五模块目录生成器手册；CatalogProfile/OfficialSource/FieldCoverage/LayerPatch、plan/new/resume/review/apply、硬成本账本和恢复安全规则；含 LLM 二级系列自动归属（政策 + AI hint + migration_required）、二级系列迁移 CLI、批量成本门禁（三本账/零确认零付费/from-preview 复用）。
- [comparison-data-sources.md](docs/manual/comparison-data-sources.md) — 对比页数据源选型核实记录；AA/SWE-bench/LiveBench/HF Leaderboard/OpenRouter 可用通路、LMArena 仅第三方快照、DeepSWE 抓站、HF 网络镜像坑与推荐组合。
- [comparison-data-contract.md](docs/manual/comparison-data-contract.md) — 对比页数据契约（integrated 层）：文件布局、维度键枚举与归一化口径、index.json/data.json/view-config/models-alias 契约、raw 快照形状、前端渲染规则映射、i18n 键、管线实现红线。
- [icons.md](docs/manual/icons.md) — 品牌图标资产维护说明：官方 logo 获取、Simple Icons 备选、manifest 键规则和三级模型按系列继承/单模型覆盖。
- [dev-log.md](docs/manual/dev-log.md) — 开发日志（开发过程记录，公开可见，供回顾开发背景；开发计划不入库仅本地）。

## src/content/ — 内容生成
- [generate-rss.js](src/content/generate-rss.js) — RSS 生成。导出: `getFeedItems, generateRss`
- [generate-og-image.js](src/content/generate-og-image.js) — OG 图生成；默认输出经 `DIRS.public` 写 `public/og-image.png`。导出: `generateOgImage`


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
- [static-site.test.js](tests/build/static-site.test.js) — 静态站点复制构建与历史产物清理测试。
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
- [ai-config.test.js](tests/catalog/ai-config.test.js) — 业务模块配置合并、Tavily retrieval 配置和 protocol 校验回归。
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

## R4 新增实现文件
- [draft-options.js](src/catalog/draft/draft-options.js) — Catalog Draft 配置、Seed 校验与研究成本预算。
- [static-site.js](src/build/static-site.js) — 静态站点复制构建器。
- [preview-store.js](src/catalog/concept/preview-store.js) — 概念预览读写与校验。
- [resolution.js](src/catalog/intake/resolution.js) — 待补卡批量解析与查重编排。
- [html-collector.js](src/catalog/tool-update/html-collector.js) — 官方更新页 HTML 抓取与文本清洗。
- [review-model.js](src/catalog/tool-update/review-model.js) — 工具更新审核队列的安全投影与排序纯函数。
- [review-queue-store.js](src/catalog/tool-update/review-queue-store.js) — 工具更新审核队列持久化契约。
- [directory-swap.js](src/catalog/transaction/directory-swap.js) — 目录交换、备份与 Windows 回退操作。
- [engine.js](src/catalog/transaction/engine.js) — Catalog 快照事务、journal、回滚与恢复。
- [removal-planner.js](src/catalog/transaction/removal-planner.js) — 精确删除目标与引用清理规划。
- [product-registry.js](src/catalog/url-registry/product-registry.js) — 产品官方 URL 与更新源登记模块。
- [catalog-seed.js](src/pending/catalog-seed.js) — 待补工具候选到 Catalog Seed 的转换。
- [rules.js](src/pending/rules.js) — 待补候选名称与知识库匹配规则。

## R5-R9 新增实现文件
- [rebuild-canonical.js](src/comparison/core/rebuild-canonical.js) — 模型对比名称与别名多源规范化。
- [rebuild-collector.js](src/comparison/core/rebuild-collector.js) — 4 源快照收集聚拢与有效记录过滤。
- [rebuild-dimensions.js](src/comparison/core/rebuild-dimensions.js) — 评测维度归一化与模型指标装配。
- [check-secrets.js](src/maintenance/check-secrets.js) — 核心密钥与高熵模式扫描守卫。
- [news-domain.js](src/maintenance/workbench/news-domain.js) — 维护者工作台新闻首审与处理领域服务。
- [tool-update-domain.js](src/maintenance/workbench/tool-update-domain.js) — 维护者工作台工具更新审核领域服务。
- [catalog-domain.js](src/maintenance/workbench/catalog-domain.js) — 维护者工作台目录草稿与待补卡领域服务。
- [workspace-domain.js](src/maintenance/workbench/workspace-domain.js) — 维护者工作台工作区清理与完成度检查。
- [api.js](src/maintainer-web/js/api.js) — 维护者平台 API 客户端封装与 revision/token 绑定。
- [auth.js](src/maintainer-web/js/auth.js) — 维护者平台 URL 片段 Token 解析工具。
- [state.js](src/maintainer-web/js/state.js) — 维护者平台前端状态管理与 DOM 工具。
- [common.js](src/maintainer-web/js/panels/common.js) — 维护者平台面板队列卡片通用构建器。
- [overview-panel.js](src/maintainer-web/js/panels/overview-panel.js) — 维护者平台概览与清空面板。
- [news-panel.js](src/maintainer-web/js/panels/news-panel.js) — 维护者平台新闻首审流转面板。
- [keywords-panel.js](src/maintainer-web/js/panels/keywords-panel.js) — 维护者平台关键词提纯面板。
- [top-panel.js](src/maintainer-web/js/panels/top-panel.js) — 维护者平台 Top 选择与发布预览面板。
- [knowledge-panel.js](src/maintainer-web/js/panels/knowledge-panel.js) — 维护者平台知识提取与待补卡面板。
- [catalog-panel.js](src/maintainer-web/js/panels/catalog-panel.js) — 维护者平台目录草稿生成与应用面板。
- [concept-panel.js](src/maintainer-web/js/panels/concept-panel.js) — 维护者平台概念合成与应用面板。
- [tool-update-panel.js](src/maintainer-web/js/panels/tool-update-panel.js) — 维护者平台工具更新审核面板。


