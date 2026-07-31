# 为 InfoCatcher 贡献

InfoCatcher 是开源、免费且不接受厂商赞助的 AI 工具信息对比平台。提交内容须可核验，并说明修改内容和理由。

## 贡献入口

- **纠错数据**：提交[数据纠错 Issue](https://github.com/wozore/infocatcher/issues/new?template=data-correction.yml)，或修改 `data/catalog/tools.json` / `data/catalog/tool-intelligence.json` 后提交 PR。
- **推荐工具**：提交[新工具推荐 Issue](https://github.com/wozore/infocatcher/issues/new?template=new-tool.yml)，提供名称、分类、场景、价格/免费信息及使用体验。
- **质疑评分**：说明具体工具和维度，并提供对比测试、用例或其他证据。
- **改进代码**：从带 `help wanted` 标签的 [Issues](https://github.com/wozore/infocatcher/issues) 选取任务，Fork 后提交 PR。

## 数据与模块规范

新增或移动文件时按职责归类，不在 `data/` 或 `src/` 根目录平铺业务文件：

- 工具、模型/套餐情报、概念和场景放入 `data/catalog/`；高频变化且需追溯的字段集中在 `tool-intelligence.json`。
- 热点配置、来源、人工暂存、运行状态和公开投影分别放入 `data/news/config/`、`sources/`、`manual/`、`runtime/`、`output/`。
- Node 实现按职责放入 `src/news/`、`src/content/`、`src/acquisition/`、`src/maintenance/` 或 `src/shared/`。
- `scripts/` 只保留 CI 使用的稳定入口；新 Node 数据路径必须在 `src/shared/paths.js` 登记。
- 不用复制文件或符号链接维护两套路径；数据结构变化时同步 `validate.js` 和相关测试。

`tools.json` 中每个工具至少包含名称、厂商、分类、功能描述、价格/权益、免费额度、访问门槛、中文支持、擅长场景和最后更新日期；模型、变体、套餐、API 价格及核验来源放在 `tool-intelligence.json`。

## 模型、套餐与价格情报

- 推荐对象优先落到具体模型、版本、变体或套餐；泛化品牌/入口标为 `collection` 并列出已核实子项。
- 模型、价格、套餐、上下文长度和弃用状态优先引用官方文档、定价页、套餐页或发布公告；搜索摘要不能直接入库。
- 来源保存精确 URL 和实际 UTC `queried_at`；`last_updated` 仅表示 InfoCatcher 编辑日期。
- API 价格分别记录缓存命中输入、缓存未命中输入和输出价格，并注明币种、每百万 tokens 单位、地区及长上下文/服务层级条件。
- 官方未说明的价格、包含模型、缓存命中率或上下文结论使用明确未知状态，不填 `0`、不推算。
- 套餐注明金额、币种、周期、地区/税费条件和官方列出的主要模型；不同地区价格不合并。
- 场景中的集合推荐通过 `recommendations` 显式引用具体 `item_id` 并说明理由。

综合评分使用 1—5 分（极差、较差、一般、良好、优秀），是各维度的整体判断，不是简单平均。

## 热点来源与内容评估

热点判断以 [质量评估标准](docs/content-quality.md) 为准。提交来源、转载关系、商单标识或评分调整时：

- 来源须有可核验主页和平台 ID/Handle；分类支持多标签，更新频率不等于质量。可用 `node scripts/news-cli.js source add` 添加单条来源，或用 `source import --file ... --dry-run` 预检批量来源；不得通过 CLI 参数传入 API Key。
- 原创、转载、引用或同主题关系须附原文链接、平台标识或其他证据；证据不足只能标为候选。
- 商单、软广、赞助或利益关系仅在存在明确声明、平台广告标识、affiliate 链接等证据时标识和降权。
- 官方来源用于核验发布事实；官方宣传主张与独立测试分开处理。正常质疑、纠错和技术争论不得作为低质量依据。
- B站视频、动态和专栏均可入库；动态不可用时记录降级，禁止使用内部 API、逆向 SDK 或绕过风控补数据。
- 历史回溯遵守五层时间边界和平台额度；超出 270 天只能通过授权任务继续，B站授权也不能突破 RSSHub 公开能力边界。
- 不直接编辑或删除 `.news-build.lock`；先运行 `news-cli.js lock status`，确认原任务终止后才能带理由执行 `lock force-unlock`，操作会写入审计。
- 异常判断须保留样本量、方法、阈值和基线；小样本不得自动删除或降权。
- 自动评分调整须记录理由、证据和时间，不静默覆盖结果。

## 审核与行为准则

提交的信息必须有可验证来源；不接受厂商或代理以优化排名、删除负面观点等目的提交，也不接受厂商赞助。参与讨论时保持友善、建设性；评测分歧由维护者复核并公开理由。

```text
提交（PR/Issue）→ 人工审核 → 合并或驳回（在 PR/Issue 中说明理由）
```

当前所有提交由维护者人工审核，通常在 2—3 天内处理。Issue 模板位于 `.github/ISSUE_TEMPLATE/`；AI 初审和自动合并尚未实现。
