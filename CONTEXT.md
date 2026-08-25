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
