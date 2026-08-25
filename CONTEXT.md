# Catalog Domain Context

## CatalogProfile

目录资料类型模板，由内容种类与模态共同确定。它规定哪些字段必须存在、哪些字段不适用，以及哪些目录层可能被创建或替换。

## ResearchScope

一次研究实际覆盖的目录层、主体和事实谓词集合。研究范围不等于整个厂商目录；已有且合格的层可以不在本次范围内。

## OfficialSource

可由官方根域、官方链接关系或维护者确认来源证明归属的产品页、开发文档、定价页、公告或更新日志。模型自行声称某来源是官方，不足以建立 OfficialSource。OfficialSource 保留清洗后的正文（`content`），直接作为字段合成的证据。

## UpdateSource

编程工具更新链路专用的人工登记来源。产品表中的 `update_sources` 可选且与 `official_urls` 分离；每条来源声明 `kind`、人类可读 HTTPS `url`、`collector`、`product_surface`，GitHub 来源还必须声明与网页对应的 `repository` 和 `include_prerelease: false`。`official_urls` 仍是 catalog 身份、文档和价格研究入口，`lookupOfficialUrl()` 不读取 `update_sources`。

## UpdateCandidate

由确定性 planner 从 `UpdateEvidence` 和 AI 语义建议共同形成、等待人工决定的工具更新项。只允许指向 `detail_kind=tool` 的 `last_updated_date` 向前候选；来源必须命中产品 `update_sources`，日期必须来自官方 metadata/正文、晚于当前值且不晚于扫描日。AI 低置信度、产品表面/实体不匹配、日期缺失或证据 hash 变化均保持 blocked/pending，不进入 Apply。

## ToolUpdateReviewQueue

独立于五模块 catalog 的人工审核 JSON 清单。条目按 `product_key + source_url + proposed_date + content_hash` 稳定去重，重复扫描保留人工 `approved/rejected`；同一发布的 evidence hash 变化替换为新的 pending 条目。只落盘完整官方 URL、证据摘录、内容 hash、日期和五字段 AI 建议，不落盘整页正文或凭据。

`release_date` 表示实体首次公开或 GA 日期，`last_updated_date` 表示有官方证据的产品级最近更新日期；订阅套餐不保存这两类日期。抓取时间或无关页面更新时间不属于日期事实；证据不足时保持日期缺失并显示待核验。


## DerivedField

由一个或多个 OfficialSource 确定性整理出的展示字段，例如摘要、特点、适用场景和限制。DerivedField 必须保留所依赖的 source IDs，但不要求官方原文使用相同字段名称。

## LayerPatch

针对一个目录层的完整变更，操作只能是 create、replace 或 noop。LayerPatch 拥有目标记录和字段来源，不隐含修改其他目录层。

## CatalogDraft

可供维护者审核的研究与变更包，包含 ResearchScope、OfficialSources、FieldCoverage、LayerPatches、Readiness 和成本账本。

## Readiness

CatalogDraft 是否可进入 Apply 的结论。只有官方来源可信、必需字段覆盖完整、LayerPatches 完整且字段来源可审计时才是 ready。

## Apply

在维护者确认后，把 ready CatalogDraft 的 LayerPatches 通过共同锁、staging、备份、journal 和回滚事务写入正式目录。Apply 不执行研究，也不补造缺失字段。

## SeriesPolicy

LLM 二级系列分类的唯一规则源（`data/manual/archive/llm-series-policy.json`）。声明每厂商的模型家族、用途、版本轴、允许的目标二级系列、容量（同系列最多 3 个，第 4 个才允许拆分）与证据状态。阶段 2 迁移与阶段 4 AI 分类都以此为规则门禁；未知厂商或规则不完整一律 fail-closed，绝不回退到以具体模型名建组。

## ModelFamily

厂商内平行的模型产品线，例如 Google 的 Gemini 与 Gemma、MiniMax 的 M 与 H、Qwen 通用与 Omni/Image。不同家族不互相凑数，须分别归入各自系列。

## UsageKind

候选模型的用途分类：`general_llm / coding / image / video / audio_realtime / translation / omni / media / subscription / tool / unknown`。只有 `general_llm` 进入通用 LLM 系列归类；专用用途走各自路径；无法确认时标记 `uncovered`，调用方不得自动建组。

## ReleaseCohort

同一家族内按发布时间划分的组别：`newest`（当前代）与 `previous`（紧邻上一代）。`previous` 是紧邻发布组，不是无限历史收纳箱；被移出当前二级展示的三级详情必须由迁移预览明确列出。

## PlacementDecision

一次经过验证的二级系列归属结论，来源为 `manual / policy / ai`，含 `usage_kind`、家族、主版本、发布批次、目标二级系列 id/title、置信度、evidence 与 policy 版本。经验证后写入 seed/Draft，使 plan、resume、from-preview 可审计复现且不重复调用 AI。AI 只作语义建议，确定性门禁重算最终归属。

## SeriesMigrationPlan

当某厂商候选触发第 4 个成员或需合并既有系列时，生成的输出结果。普通单 seed LayerPlan 无法表达“搬迁已有成员/删除旧系列”，因此 split 必须是独立的多记录迁移计划（重写一级 `level2_refs`、搬迁二级 `detail_refs`），而不是单个新模型的 placement。三级记录本身无父级字段，成员关系只存在于 `vendor-level2.detail_refs`。

## ManualPlacementOverride

人工在待补卡/Seed 上显式指定的 `existing_level1_ref` / `existing_level2_ref` / `new_group_title`，优先于 AI 与政策自动归类，但必须通过引用 kind、存在性与厂商归属校验，否则拒绝。

