# B16 热点内容类型修复方案（content_type ↔ source_type 拆分 + 内容分类）

> **状态：路径 B（字段拆分 + 数据迁移）已实现并落地（2026-08-03）；路径 A（真实 AI 分类 + 人工审核确认）待审核后台与模型渠道落地。**
>
> 配套文档：[b16-ui-reconstruction-plan.md](./b16-ui-reconstruction-plan.md)（决策 46–103）、[decisions.md](./decisions.md)（ADR-008/009）、[b16-task-status.md](./b16-task-status.md)。
>
> 目标决策：决策 65（热点展示维度是内容类型，不是来源媒体类型）、决策 66（AI 初步建议类型，管理者审核确认）、决策 74/79（平台不作为列表级筛选，内容类型为主筛选）、决策 80（空状态四类区分）。

---

## 1. 问题与诊断（已确认）

**冲突**：B16 热点视图的一级筛选与卡片标签读 `content_type`，但当前公开数据中 `content_type` 的实际取值是**来源媒体类型**（`x_post` / `youtube_video` / `bilibili_*`），前端把"X 帖子 / YouTube 视频"当作"内容类型"展示——这等价于把平台作为列表级筛选，违背决策 65/74/79 的核心意图。

**根因（已逐环节核实）**：

| 环节 | 位置 | 现状 |
|---|---|---|
| 采集写入 | [build-news.js:204](../src/news/pipeline/build-news.js) | `normalizeRssItem`：`content_type = contentType`（来源媒体类型） |
| 采集写入 | [build-news.js:238](../src/news/pipeline/build-news.js) | `normalizeTweet`：`content_type: 'x_post'` |
| 采集写入 | [build-news.js:941](../src/news/pipeline/build-news.js) | `normalizeHistoricalYouTube`：`content_type: 'youtube_video'` |
| 采集写入 | [build-news.js:969](../src/news/pipeline/build-news.js) | `normalizeHistoricalBilibili`：透传 `content_type` |
| 采集写入 | [news-bilibili.js:48](../src/news/collectors/news-bilibili.js) | `content_type: contentType` |
| 手工条目 | [news-manual.js:3](../src/content/news-manual.js) | `ALLOWED_TYPES` = 媒体类型枚举 |
| 枚举校验 | [validate.js:330](../src/maintenance/validate.js) | `CONTENT_TYPES` = 媒体类型枚举 |
| CLI | [news-cli.js:315/424](../src/news/cli/news-cli.js) | 透传/展示 `content_type` |
| 候选层 | [news-candidates.js](../src/news/core/news-candidates.js) | 透传 `content_type`（不改写） |
| 公开门禁 | [news-public-gate.js](../src/news/core/news-public-gate.js) | 不涉及 `content_type` |
| RSS | [generate-rss.js](../src/content/generate-rss.js) | 不消费 `content_type`（无影响） |
| 前端 | [app.js:2612/2679/2706/2827/2884](../src/web/js/app.js) | `contentTypeLabels` 映射媒体类型；筛选/卡片/详情读 `content_type` |

**关键事实**：全 `src/` 无 LLM 模型调用（仅 YouTube/X 平台 API key）。"内容类型"（AI 工具/产品/概念/技术动态/行业事件）在数据中**根本不存在**——它正是决策 66"AI 初步建议 + 管理者审核确认"的职责，即 B16 明确推迟的审核后台部分。

**结论**：前端代码正确（按决策 79 忠实渲染公开字段、不自行推断）。冲突在数据侧，必须从流水线修，不能前端硬编码。

---

## 2. 目标与非目标

**目标**
- 热点视图一级筛选与卡片标签展示的是**内容类型**（决策 65 六类），不再是来源媒体类型。
- 来源媒体类型（平台）只出现在来源核验层（决策 74/75），不作为列表级筛选。
- 与决策 66/79 兼容：`content_type` 由"AI 建议 + 人工确认"得出，前端不推断。
- 修复对现有 100 条公开数据、RSS、工具/场景/概念视图零破坏。

**非目标（本方案不承诺）**
- 不新增前端标签推断或硬编码分类规则到浏览器（决策 79）。
- 不重建完整审核后台 UI（决策 46–73 仍按既定节奏推进）。
- 不改动工具、场景、对比、概念等其他视图。

---

## 3. 数据契约变更

**核心：把"媒体类型"与"内容类型"拆成两个字段。**

| 字段 | 语义 | 枚举（建议，待开发者确认命名） | 用途 |
|---|---|---|---|
| `source_type`（新） | 采集时的来源媒体类型 | `youtube_video` / `x_post` / `bilibili_video` / `bilibili_dynamic_video` / `bilibili_dynamic_repost` / `bilibili_dynamic_text` / `bilibili_article` / `unknown` | 仅来源溯源元信息 → 详情/来源展开层 |
| `content_type`（改语义） | 内容类型（决策 65） | `ai_tool`（AI 工具）/ `ai_product`（AI 产品）/ `ai_concept`（AI 概念）/ `ai_technology`（AI 技术动态）/ `ai_industry`（AI 行业事件）/ `other`（其他） | 一级筛选 + 卡片标签 |

配套建议新增字段（可选，用于诚实标注分类状态，决策 66/80）：
- `content_type_status`：`ai_suggested`（AI 建议待确认）｜ `reviewed`（人工已确认）｜ `unclassified`（未分类）。
- `content_type_reason`（可选）：分类依据（AI 判断理由或规则命中项），供审核回溯。

> 命名说明：决策 65 只说"不提前确定热点类型枚举的最终命名"，此处给的是英文 slug + 前端中文标签的组合，与现有 `x_post` 风格一致，也便于校验与国际化。最终命名待开发者拍板。

---

## 4. 内容类型来源（三条路径，需选定）

### 路径 A —— 真实 AI 分类 + 人工确认（决策 66 正规路径）
- 新增模块（如 `src/news/classify/content-classifier.js`）接入模型调用，为每条候选输出 `content_type` + `content_type_reason`，写入 `content_type_status: 'ai_suggested'`。
- 管理者在审核流程中确认/修改类型后置 `reviewed`（复用候选层 `review_status` 流转）。
- **成本**：每轮抓取约 `≤ max_output_items(100)` 次分类调用；每次输入为标题+描述（当前 ≤600 字符），输出一个枚举。具体额度取决于所选模型与单价，需在实施前用项目现有 API 渠道确认。
- **依赖**：模型接入（本项目当前无 LLM 依赖，需新增）；审核确认流程（即被推迟的审核后台，至少先做 CLI 级类型确认）。

### 路径 B —— 仅字段拆分，内容类型暂不填充（免费、诚实、最小）
- 只做第 3、5、6、7、8 节的字段拆分与迁移；`content_type` 统一置 `unclassified`（`content_type_status: 'unclassified'`）。
- 前端：无 `content_type` 值 → 类型筛选区不显示/显示"建设中"空状态（决策 80），媒体类型移到来源层。
- **代价**：当前 100 条将不再有类型筛选，热点视图展示为"审核建设中"；等 AI+审核上线后再填充。
- **优点**：零成本、零 LLM 依赖、最诚实；从根上消除"平台伪装成内容类型"的冲突。

### 路径 C —— 免费规则初分类（不推荐）
- 关键词/实体规则打初始 `content_type`，标注 `ai_suggested` 待审核。
- **风险**："AI 工具 vs AI 产品 vs AI 行业事件"语义边界模糊，规则分类准确率低，易产生误导性标签，违背"不伪造结论"原则（决策 89/54）。**建议不采用。**

**推荐**：短期选 **B**（本轮即可消除冲突且诚实），中长期随审核后台落地路径 **A**（真实分类+确认）。路径 C 不建议。

**已选路径（2026-08-03）**：按推荐实施 **路径 B**。字段拆分（采集层 `source_type`、手工条目与 CLI、候选层透传、校验枚举、前端映射）与数据迁移（`--migrate-content-type`，`hotspots.json` → `schema_version: 3`）均已完成；`content_type` 统一置 `unclassified`（`content_type_status: unclassified`）。路径 A 待审核后台与模型渠道到位后启动（见开发计划 B16-R5）。

---

## 5. 改动面清单（逐文件）

> 以下为路径 A/B 共有的改动；路径 A 额外含分类模块与审核确认。

### 5.1 采集层（媒体类型写入改到 `source_type`）
1. [build-news.js:204](../src/news/pipeline/build-news.js)：`normalizeRssItem` 输出 `source_type`（含 B 站 `inferBilibiliType` 结果）。
2. [build-news.js:238](../src/news/pipeline/build-news.js)：`normalizeTweet` 输出 `source_type: 'x_post'`。
3. [build-news.js:941](../src/news/pipeline/build-news.js)：`normalizeHistoricalYouTube` 输出 `source_type: 'youtube_video'`。
4. [build-news.js:969](../src/news/pipeline/build-news.js)：`normalizeHistoricalBilibili` 透传改为 `source_type`。
5. [build-news.js:502/506/772](../src/news/pipeline/build-news.js)：`item.content_type === 'bilibili_dynamic_repost'` 判断全部改为 `item.source_type`（评分系数、轻用户信号、溯源关系）。
6. [news-bilibili.js:48](../src/news/collectors/news-bilibili.js)：采集器输出 `source_type`。

### 5.2 手工条目与 CLI
7. [news-manual.js](../src/content/news-manual.js)：`ALLOWED_TYPES` 语义改为 `source_type`；`normalizeManualItem` 输出 `source_type`（手工条目可选由维护者直接填 `content_type`，不填则 `unclassified`）。
8. [news-cli.js:315/424](../src/news/cli/news-cli.js)：`flags.type` 与候选展示字段改为 `source_type`（或同时展示两者）。

### 5.3 分类与候选层（路径 A）
9. 新增 `src/news/classify/content-classifier.js`：输入单条候选（title/description/transcript 可用时），输出 `{ content_type, reason, status }`。
10. [build-news.js](../src/news/pipeline/build-news.js)（候选创建处，约 :1262）：对每条 item 调用分类器，写 `content_type` / `content_type_status` / `content_type_reason`。
11. [news-candidates.js](../src/news/core/news-candidates.js)：候选模型透传新字段；`INTERNAL_FIELDS` **不**包含 `content_type`（公开字段），`content_type_reason`/`content_type_status` 是否公开按决策 77 判定（建议 `content_type_reason` 视为内部、不进公开，或进公开但明确标注为"AI 建议"）。

### 5.4 校验
12. [validate.js:330](../src/maintenance/validate.js)：`CONTENT_TYPES` 改为内容类型枚举；新增 `SOURCE_TYPES` 媒体类型枚举；`:502/:506` 校验同步拆分。
13. **迁移窗口**：校验改为"新枚举 + 旧值兼容"（或先跑迁移再收紧），避免迁移前校验失败阻塞构建。

### 5.5 数据迁移
14. 现有 `data/news/output/hotspots.json` 100 条：`content_type`（媒体类型）→ 移到 `source_type`；`content_type` 重新分类（路径 A）或置 `unclassified`（路径 B）。
15. 迁移脚本：可复用/扩展 [build-news.js:708](../src/news/pipeline/build-news.js) 的 `upgradeHotspotsProjection` 思路，加一个幂等的 `--migrate-content-type` 子命令；候选层为空，无历史候选迁移负担。

---

## 6. 前端联动（无论 A/B）

[app.js](../src/web/js/app.js) 全部引用点均为数据驱动，改动集中在映射与标签：

1. [app.js:2612](../src/web/js/app.js)：`contentTypeLabels` 从媒体类型映射改为内容类型映射：
   `{ ai_tool: 'AI 工具', ai_product: 'AI 产品', ai_concept: 'AI 概念', ai_technology: 'AI 技术动态', ai_industry: 'AI 行业事件', other: '其他' }`。
2. [app.js:2679/2706/2709](../src/web/js/app.js)：`getFilteredTrending` / `renderTrendingTypeFilters` 继续读 `content_type`（值变为内容类型，自动生效）；无任何 `content_type` 值时筛选区隐藏（决策 80 空状态分支已存在，见 :2924）。
3. [app.js:2827/2884](../src/web/js/app.js)：`openHotspotDetail` / `renderTrendingCard` 的类型标签读 `content_type`；来源详情/卡片来源展开层（`source_type` + 平台 + 时间 + 依据片段）保持不变或补充 `source_type` 显示。
4. **降级兼容**：前端对未知 `content_type` 值应显示原始值或"类型未知"，不崩、不隐藏内容（现有 `|| item.content_type` 已覆盖）。

---

## 7. 校验更新（与 5.4 一致）

- `CONTENT_TYPES` → 内容类型枚举（六类）。
- 新增 `SOURCE_TYPES` → 媒体类型枚举（七类 + `unknown`）。
- 新增字段完整性：公开条目的 `source_type` 必须合法；`content_type` 允许 `unclassified`（路径 B）或必须合法（路径 A 审核后）。

---

## 8. 成本估算（仅路径 A）

- 调用量：每轮抓取一次，`≤ max_output_items`（当前 100）条 × 1 次分类调用/条 ≈ **100 次/轮**。
- 输入 token：标题 + 描述（描述当前截断 ≤600 字符）≈ 每条约 0.2–0.5k token；输出 1 个枚举 ≈ 极小。
- 单轮 ≈ **几十 k token** 量级，具体金额取决于所选模型单价（本项目当前无 LLM 渠道，实施前需确认 API 渠道与额度）。
- 若接入字幕（决策 51/52 开关），视频候选输入含字幕片段，token 会上升，需在分类器入口裁剪。

---

## 9. 实施阶段与顺序

| 阶段 | 内容 | 依赖 | 对应路径 |
|---|---|---|---|
| P0 | 本方案审查定稿（字段命名、枚举、路径） | — | — |
| P1 | 字段拆分：采集层 `source_type`、候选层透传、校验枚举、前端映射、数据迁移 | P0 | A/B 共有 |
| P2 | 内容类型填充：分类模块接入（A）或置 unclassified（B） | P1 | A/B 分支 |
| P3 | 审核确认：管理者确认/修改 `content_type` 置 `reviewed` | P2 | 仅 A |
| P4 | 验收：类型筛选、卡片标签、来源层、空状态、迁移校验 | P2/P3 | A/B |

建议先完成 P1（消除冲突的最小诚实改动，路径 B），P2/P3 随审核后台节奏推进（路径 A）。

**实施状态（2026-08-03）**：P1 与 P2-路径 B 已完成（字段拆分 + 数据迁移 + 前端映射），`node scripts/validate.js` 通过（100 热点 · 60 主题）；P2-路径 A（分类模块接入）与 P3（审核确认）待审核后台落地；P4 验收待本地 HTTP 服务人工复核（见 [b16-task-status.md](./b16-task-status.md)）。

---

## 10. 风险与边界

- **破坏性改动**：`content_type` 语义变化会影响现有数据与校验。必须走"先兼容、后收紧"（5.4/5.5），迁移前不要让校验阻塞构建。
- **前端降级**：迁移中间态（新旧字段并存）时，前端应容忍 `source_type` 存在而 `content_type` 缺失，按决策 80 空状态处理，不崩不伪造。
- **分类准确性（A）**：工具/产品边界模糊，需靠审核确认兜底；`content_type_status` 必须诚实表达"建议/已确认/未分类"。
- **字幕成本（A）**：接入字幕会放大输入 token，分类器需控制输入长度。
- **RSS 无影响**：已确认 generate-rss 不消费 `content_type`。

---

## 11. 验收标准

1. `data/news/output/hotspots.json` 中每条公开项：`source_type` 合法；`content_type` 为内容类型枚举或 `unclassified`。
2. 热点视图一级筛选与卡片标签显示内容类型（AI 工具/产品/概念/技术动态/行业事件/其他），不再出现"X 帖子 / YouTube 视频"作为筛选或标签。
3. 平台/来源媒体类型只出现在详情或卡片来源展开层。
4. `node scripts/validate.js`（或仓库现有校验命令）通过；迁移前构建不因枚举变化阻塞。
5. 移动端、键盘、`prefers-reduced-motion` 无回归；决策 80 四类空状态仍区分。
6. 工具/场景/对比/概念视图无回归。

**当前达成度（2026-08-03）**：第 1 条（`source_type` 合法 + `content_type` 为枚举或 `unclassified`）、第 3 条（平台只在来源核验层）、第 4 条（校验通过）已满足；第 2 条「类型筛选与卡片显示内容类型」当前因全 `unclassified` 处于「审核建设期」展示（类型筛选区隐藏、卡片「类型待确认」），待路径 A 填充后自动满足；第 5、6 条待本地 HTTP 服务人工复验。
