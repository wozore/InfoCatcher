# Catalog Domain Context

## CatalogProfile

目录资料类型模板，由内容种类与模态共同确定。它规定哪些字段必须存在、哪些字段不适用，以及哪些目录层可能被创建或替换。

## ResearchScope

一次研究实际覆盖的目录层、主体和事实谓词集合。研究范围不等于整个厂商目录；已有且合格的层可以不在本次范围内。

## OfficialSource

可由官方根域、官方链接关系或维护者确认来源证明归属的产品页、开发文档、定价页、公告或更新日志。模型自行声称某来源是官方，不足以建立 OfficialSource。OfficialSource 保留清洗后的正文（`content`），直接作为字段合成的证据。

## FieldCoverage

CatalogProfile 所需的每层展示字段与已取得官方来源的覆盖关系：任一适用字段无值、值仍是占位（null/空串/unknown/待核验）或未引用官方来源时，该字段即 missing。缺少适用的必需字段时，目录草案不能发布。

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
