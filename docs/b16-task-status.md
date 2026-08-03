# B16 任务完成情况与后续清单

> **状态：2026-08-03 · 对比代码库与两份决策文档后的核对结论。**
>
> 依据：[b16-ui-reconstruction-plan.md](./b16-ui-reconstruction-plan.md)（决策 46–103）、[b16-content-type-fix-plan.md](./b16-content-type-fix-plan.md）、[decisions.md](./decisions.md)（ADR-007/008/009）、当前工作区代码与数据、`node scripts/validate.js` 校验输出。

---

## 1. 本次 B16 任务实际完成了什么

**一句话：B16 UI 系统重构三阶段（P0 / P1-A / P1-B）已前端落地并通过校验；热点内容类型修复已按「路径 B」落地（字段拆分完成、类型暂置 `unclassified` 诚实占位）；路径 A（AI 分类 + 人工审核确认）尚未启动。**

### 1.1 UI 系统重构三阶段（决策 101–103）— 已完成，待验收

| 阶段 | 落地内容 | 证据 |
|---|---|---|
| P0 全站基础 | 暖白编辑部视觉令牌、CSS 原语、分组导航（决策 83/84）、三档响应式骨架、统一状态/加载/无障碍规则 | [style.css](src/web/css/style.css)、[index.html](src/web/index.html)（`nav` 重组、「关于」移出主导航） |
| P1-A 搜索主线 | 单列居中首页、静态搜索 2–3 阶段过渡、结果页只读查询条 + 修改/复制、桌面左摘要右来源、引用双向定位、匹配资料分组 | [app.js](src/web/js/app.js)（`SEARCH_DEMOS`、`submitSearchHome`、`openSearchMatch`） |
| P1-B 热点体验 | 内容类型一级筛选、最近/热度排序、卡片 + 模糊预览 + 详情对话框三段式、来源内联展开、稳定 ID 关联资料 | [app.js](src/web/js/app.js)（`renderTrendingCard`、`openHotspotDetail`、`getHotspotRelatedResources`） |

文档状态已同步：b16-ui-reconstruction-plan.md 头部与决策 103 标注「P0/P1-A/P1-B 已实现，待验收审查」，规划期停止条件已解除。

### 1.2 热点内容类型修复（content_type ↔ source_type 拆分）— 路径 B 已完成

修复方案 `b16-content-type-fix-plan.md` 所述冲突（前端把「X 帖子 / YouTube 视频」当内容类型展示）已按推荐路径 B 全链路落地，**注意：该文档自身状态尚未更新，仍写「规划中」**：

| 环节 | 改动 | 文件 |
|---|---|---|
| 采集写入 | `content_type` → `source_type`（含 B 站 inferBilibiliType / repost 判断、评分系数、溯源关系） | [build-news.js](src/news/pipeline/build-news.js)、[news-bilibili.js](src/news/collectors/news-bilibili.js) |
| 手工条目 | `ALLOWED_TYPES` → `ALLOWED_SOURCE_TYPES`；`normalizeManualItem` 输出 `source_type` + `content_type`/`content_type_status` 默认 `unclassified` | [news-manual.js](src/content/news-manual.js) |
| CLI | content 命令 `content_type`→`source_type`；review 命令双字段展示 | [news-cli.js](src/news/cli/news-cli.js) |
| 候选层 | `schema_version` 2→3；公开投影携带 `source_type`/`content_type`/`content_type_status` | [news-candidates.js](src/news/core/news-candidates.js) |
| 校验 | `SOURCE_TYPES`（媒体类型）与 `CONTENT_TYPES`（内容类型六类 + `unclassified`）拆分；必填改 `source_type`，`content_type` 可选校验 | [validate.js](src/maintenance/validate.js) |
| 数据迁移 | 新增 `migrateContentTypeProjection()` + `--migrate-content-type` 幂等子命令 | [build-news.js](src/news/pipeline/build-news.js) |
| 前端 | `contentTypeLabels` 改为内容类型映射（含 `unclassified: '类型待确认'`）；新增 `SOURCE_TYPE_LABELS` 进来源核验层；类型筛选过滤 `unclassified`、全部未分类时隐藏筛选区 | [app.js](src/web/js/app.js) |

**数据现状（已迁移，校验通过）**：`data/news/output/hotspots.json` 为 `schema_version: 3`，100 条 `content_type` 全部 `unclassified`、`content_type_status` 全部 `unclassified`、`source_type` 保留媒体类型（x_post 47 / youtube_video 53，无缺失）。

### 1.3 本工作区未提交的 UI 增量

- 复制查询 / 复制摘要（决策 10.2/100，`navigator.clipboard` + 降级，`aria-live` 反馈）：[app.js](src/web/js/app.js) `copyTextWithFeedback`
- 搜索匹配热点项「查看资料」直接打开对应热点详情对话框（决策 9.1/81）：[app.js](src/web/js/app.js) `openSearchMatch`
- 文案统一（「开始整理」→「搜索」、「正在整理你的问题」等）；[style.css](src/web/css/style.css) 清理约 200 行过时/平台筛选样式。
- ADR-007 概念联动适配层方案状态已正式确认（决策 9.8.2）：[decisions.md](docs/decisions.md)

### 1.4 验证结果

`node scripts/validate.js` **全部通过**（tools 45 / glossary 43 / scenes 12 / hotspots 100 条 · 60 主题 / 开发原则合规等）。前端降级路径正确：全 `unclassified` 时类型筛选区隐藏、卡片标签显示「类型待确认」、来源层显示「来源类型」（youtube_video → YouTube 视频 等）。

---

## 2. 文档与实现的状态偏差（需立即修正）

| 位置 | 现状 | 应更新为 |
|---|---|---|
| [b16-content-type-fix-plan.md](./b16-content-type-fix-plan.md) 头部 | 「状态：规划中，待开发者审查。本文只做方案，不改代码。」 | 「路径 B（字段拆分）已按 §5/§6 落地，`--migrate-content-type` 已迁移数据；路径 A（AI 分类 + 审核确认）待审核后台落地。」并在 §4 标注所选路径 |
| [decisions.md](docs/decisions.md) | 无 content_type 拆分相关 ADR | 可新增 ADR-010 记录字段拆分决策落地（`source_type` 媒体类型 + `content_type` 内容类型 + `unclassified` 占位），防止上下文丢失 |

---

## 3. 后续需要干什么

### 立即（0–1 天，文档与验收）

1. **同步 b16-content-type-fix-plan.md 状态**（见 §2），消除「文档说规划中、代码已实现」的偏差。
2. **本地 HTTP 服务人工验收**（`python -m http.server 8000`），按决策 102 六类标准过一遍：主流程可走通 / 全站视图覆盖 / 状态覆盖 / 响应式覆盖 / 无障碍基线 / 能力边界诚实。重点确认热点视图在「全部 `unclassified`」下的展示符合决策 80（类型筛选区隐藏、卡片显示「类型待确认」、无平台级筛选泄漏）。
3. **决定未提交改动的提交方式**（当前 diff 包含路径 B 实现 + UI 增量 + 文档状态更新，是否拆分提交由开发者定）。

### 近期（数据/能力补齐，前端已就绪）

4. **路径 A：真实内容类型填充**（`content_type` 当前全 `unclassified`，热点类型筛选区因此隐藏）。需要：新增分类模块（`src/news/classify/content-classifier.js`）+ 模型渠道 + 审核确认流程，输出 `ai_suggested` → `reviewed`。**成本提醒：每轮 ≤100 次分类调用，需先确认 API 渠道与额度**（对应 [memory：高消耗评估须先确认成本]）。
5. **tools.json 工具发布时间字段**（ADR-009 后续）：45 个工具目前无 `published_at`/`release_date` 等字段，卡片一律显示「发布时间待补充」。
6. **`related_resources` 填充**（ADR-008 后续）：热点详情「关联资料」区当前固定显示「暂不可用」，由采集/构建脚本为审核通过候选补充稳定 ID。

### 开发计划项（B16-R*）

7. **B16-R2**：确认字幕 enrichment 默认关闭（`transcript_enabled: false`）是否为期望状态。
8. **B16-R3**：清理平台筛选过时注释（[app.js](src/web/js/app.js) 21/2546/3508、[style.css](src/web/css/style.css) 1693）。
9. **B16-R4**：候选层 `hotspot-candidates.json` 当前为空；首次真实采集后复核候选层 / 审核 PR / publish 重建流程一致性。

### v1.0 延后（不在本轮范围）

真实 AI 搜索 / 会话 / 收藏 / 独立详情页 / 模式切换 / 审核管理后台可视化。

---

## 4. 一句话结论

> **B16 UI 三阶段与内容类型字段拆分（路径 B）均已完成并通过校验，当前处于「验收审查 + 文档同步」状态；内容类型真实值、工具发布时间、热点关联资料三块数据待补齐，路径 A 分类需等审核后台与模型渠道到位后再启动。**
