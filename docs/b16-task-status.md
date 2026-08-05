# B16 任务完成情况与后续清单

> **状态：2026-08-03 初核 · 2026-08-04 数据补齐、B16-R4 端到端验证与人工审核流启用更新 · 2026-08-05 B16-R5 L1 DeepSeek 分类接入更新。对比代码库与两份决策文档后的核对结论。**
>
> 依据：[b16-ui-reconstruction-plan.md](./b16-ui-reconstruction-plan.md)（决策 46–103）、[b16-content-type-fix-plan.md](./b16-content-type-fix-plan.md）、[decisions.md](./decisions.md)（ADR-007/008/009）、当前工作区代码与数据、`node scripts/validate.js` 校验输出。

---

## 1. 本次 B16 任务实际完成了什么

**一句话：B16 UI 系统重构三阶段（P0 / P1-A / P1-B）已前端落地并通过校验；热点内容类型修复已按「路径 B」落地（字段拆分完成）；路径 A 已于 2026-08-04 落地「分类模块 + 审核流程 + 100 条规则分类建议并批量审核确认（reviewed）」，L1 AI 分类已于 2026-08-05 接入 DeepSeek（失败自动回退 L0，生产启用需配置 DEEPSEEK_API_KEY）。**

### 1.1 UI 系统重构三阶段（决策 101–103）— 已完成，验收通过（2026-08-03）

| 阶段 | 落地内容 | 证据 |
|---|---|---|
| P0 全站基础 | 暖白编辑部视觉令牌、CSS 原语、分组导航（决策 83/84）、三档响应式骨架、统一状态/加载/无障碍规则 | [style.css](src/web/css/style.css)、[index.html](src/web/index.html)（`nav` 重组、「关于」移出主导航） |
| P1-A 搜索主线 | 单列居中首页、静态搜索 2–3 阶段过渡、结果页只读查询条 + 修改/复制、桌面左摘要右来源、引用双向定位、匹配资料分组 | [app.js](src/web/js/app.js)（`SEARCH_DEMOS`、`submitSearchHome`、`openSearchMatch`） |
| P1-B 热点体验 | 内容类型一级筛选、最近/热度排序、卡片 + 模糊预览 + 详情对话框三段式、来源内联展开、稳定 ID 关联资料 | [app.js](src/web/js/app.js)（`renderTrendingCard`、`openHotspotDetail`、`getHotspotRelatedResources`） |

文档状态已同步：b16-ui-reconstruction-plan.md 头部与决策 103 标注「P0/P1-A/P1-B 已实现，待验收审查」，规划期停止条件已解除。

### 1.2 热点内容类型修复（content_type ↔ source_type 拆分）— 路径 B 已完成

修复方案 `b16-content-type-fix-plan.md` 所述冲突（前端把「X 帖子 / YouTube 视频」当内容类型展示）已按推荐路径 B 全链路落地，**fix-plan 状态已同步**（头部 / §4 已选路径 / §9 实施状态 / §11 达成度均标注「路径 B 落地、路径 A 待办」）：

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

### 1.3 随提交 4bb2f73 落地的 UI 增量

- 复制查询 / 复制摘要（决策 10.2/100，`navigator.clipboard` + 降级，`aria-live` 反馈）：[app.js](src/web/js/app.js) `copyTextWithFeedback`
- 搜索匹配热点项「查看资料」直接打开对应热点详情对话框（决策 9.1/81）：[app.js](src/web/js/app.js) `openSearchMatch`
- 文案统一（「开始整理」→「搜索」、「正在整理你的问题」等）；[style.css](src/web/css/style.css) 清理约 200 行过时/平台筛选样式。
- ADR-007 概念联动适配层方案状态已正式确认（决策 9.8.2）：[decisions.md](docs/decisions.md)

### 1.4 验证结果

`node scripts/validate.js` **全部通过**（tools 28 / glossary 43 / scenes 12 / hotspots 100 条 · 60 主题 / 开发原则合规等）。前端降级路径正确：全 `unclassified` 时类型筛选区隐藏、卡片标签显示「类型待确认」、来源层显示「来源类型」（youtube_video → YouTube 视频 等）。

---

## 2. 文档与实现的状态偏差（需立即修正）

原两项偏差均已解决（2026-08-03）：

- fix-plan 状态同步：其头部 / §4 / §9 / §11 均已标注「路径 B 落地、路径 A 待办」。
- ADR-010：已在 [decisions.md](docs/decisions.md) 新增，记录 `source_type`/`content_type` 拆分、`unclassified` 占位与路径 A 后续。

---

## 3. 后续需要干什么

### 立即（0–1 天，验收）— 已完成

1. **本地 HTTP 服务人工验收**（`python -m http.server 8000`）✅ 2026-08-03 完成，决策 102 六类标准**全部通过，无阻塞问题**：

   - 主流程可走通 ✅（搜索静态演示 → 摘要 → 来源 → 匹配资料；热点列表 → 排序 → 详情 → 来源展开 → 关闭回原位）
   - 全站视图覆盖 ✅（搜索/工具库/场景/对比/推荐/热点/概念/关于 8 视图）
   - 状态覆盖 ✅（热点「全部 unclassified」下类型筛选区隐藏、卡片「类型待确认」、无平台级筛选泄漏——设计空状态，符合决策 80）
   - 响应式覆盖 ✅ / 无障碍基线 ✅ / 能力边界诚实 ✅（结果页「静态演示 · 不代表实时联网检索或 AI 生成结果」常驻提示、mock 摘要不称真实 AI）

   验收环境注意：站点根为 `dist/`（deploy.yml 发布目录），访问 `http://localhost:8000/dist/`，不要用 `src/web/`；改动数据后需 `node scripts/build-dist.js` 重建。

> 原「立即」三项中的 fix-plan 状态同步与提交方式决策已于 2026-08-03 完成（fix-plan 已同步；提交 4bb2f73 已含路径 B 实现 + UI 增量 + 文档更新），此处不再列出。

### 近期（数据/能力补齐，前端已就绪）

4. **路径 A：真实内容类型填充**（`content_type` 当前全 `unclassified`，热点类型筛选区因此隐藏）。✅ **分类模块 + 审核流程已落地**（2026-08-04）；✅ **L1 DeepSeek 分类已接入**（2026-08-05，见 [开发日志.md](../开发日志.md#log-entry-42)）：
   - 新增 [content-classifier.js](src/news/classify/content-classifier.js)（L0 规则式基线分类，零成本、可离线，词典来自 catalog）+ [llm-provider.js](src/news/classify/llm-provider.js)（DeepSeek chat completions 封装，fetch 注入可 mock；缺 key/网络/非 200/输出无法映射一律返回降级对象，不阻塞管线）
   - CLI：`classify preview|candidates|hotspots --provider deepseek [--model <m>]`；`review set/batch --content-type` 审核确认（`ai_suggested` → `reviewed`）
   - [build-news.js](src/news/pipeline/build-news.js) 候选创建阶段已接入分类器：**L0 恒兜底**（新候选默认 `ai_suggested`，不再无条件 unclassified）；L1 显式启用（`INFOCATCHER_CLASSIFY_PROVIDER=deepseek` 或存在 `DEEPSEEK_API_KEY`），缺 key 自动退化 L0 不影响构建；批量并发上限 5；[mergeCandidates](src/news/core/news-candidates.js) 保留人工 reviewed 结论不因重新采集被 AI 建议覆盖
   - 100 条热点已生成规则式分类建议并**批量审核确认**（`classify confirm`，`content_type_status=reviewed`；分布：ai_technology 33 / other 25 / ai_industry 21 / ai_concept 15 / ai_product 4 / ai_tool 2），校验通过、dist 已重建，前端类型筛选区正式启用
   - 验证：完整新闻套件 **159/159 通过**；真实 DeepSeek 联调两条分类正确（`ai_product` / `ai_industry`，其中 L1 语义优于 L0 规则），公开数据零变化（100 条 reviewed 不受影响）
   - ⏳ **待续（运营决策）**：生产启用需配置 `DEEPSEEK_API_KEY`（本地/CI secrets）；对候选层全量跑 `classify candidates --provider deepseek` 重分类（覆盖 `ai_suggested`、不覆盖 `reviewed`）需先确认预算（每轮 ≤100 次分类调用、单轮约几十 k token、约几分钱量级）
5. **tools.json 工具发布时间字段**（ADR-009 后续）：✅ **28 个工具已全部补齐 `published_at`**（取各工具当前最新版本模型的正式发布时间，如 chatgpt=GPT-5.6→2026-07-09、deepseek=DeepSeek-V4-Flash-0731→2026-07-31、claude-code=2.1.221→2026-08-04、jimeng=Seedance2.5→2026-07-31），校验通过、dist 已重建，工具卡/场景卡自动显示「发布时间」。**2026-08-04 后续**：17 个产品型/日期未确认工具已按用户决定**从工具库移除**（windsurf/runway/perplexity/mishu/notion-ai/gamma/elevenlabs/baichuan/poe/leonardo/heygen/notebooklm/bolt/v0/udio/replit/julius），同步清理了 featured（3 条）、scenes（32 处引用 + 3 空任务）、intel-sources（perplexity 配置）；`tools.json` 现为 28 个工具，CLAUDE.md 声明已同步。
6. **`related_resources` 填充**（ADR-008 后续）：✅ **已实现（2026-08-05，方案 A）**。**更正**：早前记录「已为 69/100 条热点填充」与 git 全量历史不符（公开投影与候选层在任何提交中均为 0/100，无词边界填充脚本痕迹），已定位为失真记录。方案 A 落地「URL 精确身份匹配 + 标题词边界匹配」双维度（见 [开发日志.md](../开发日志.md) 待记录条目）：
   - [build-news.js](src/news/pipeline/build-news.js) 新增 `buildRelatedTitleLexicon`（工具 35 词含括号后缀剥离 / 概念 85 词 term+full_name→稳定 ID / 场景 12 词仅 name）、`titleContainsKeyword`（中文连续子串 + 英文词边界防 `ChatGPTX` 误报）、`matchRelatedByTitle`（去重 + 工具→概念→场景优先级 + 单热点 ≤3 上限）、`searchConceptKey`（ADR-007 概念稳定 ID，与前端同构）
   - 实测：真实 100 条热点经 `--upgrade-hotspots` 填充 **19/100**（22 条关联：DeepSeek/Kimi/ChatGPT/Claude/Gemini/Cohere/Claude Code + MoE/Agent），全部 ≤3 上限、**幂等**（重跑不累积）；场景命中 0 因当前标题确实不含场景词，属数据现实
   - 前端零改动：`getHotspotRelatedResources` 已支持 tool/concept/scene 类型，`data-hotspot-related-*` 事件已接线（工具→详情、概念→概念视图选中、场景→场景视图选中）
   - 验证：39/39 news 测试（含 6 项新增）、184/184 全量、validate 原则 1-6 全过

### 开发计划项（B16-R*）

7. **B16-R2**：确认字幕 enrichment 默认关闭（`transcript_enabled: false`）是否为期望状态。✅ **已确认（2026-08-04）**：保持默认关闭为期望状态——字幕 enrichment 是 L1 AI 浓缩（决策 51）的输入材料，当前 L1 渠道未接入（见 B16-R5）、候选层为空，无消费方；按需启用（等接入 L1 AI 渠道后置 `true`，配置参数已齐全），配置值不变。
8. **B16-R3**：清理平台筛选过时注释（[app.js](src/web/js/app.js) 21/2546/3508、[style.css](src/web/css/style.css) 1693）。✅ **已解决（2026-08-03，与 [开发计划.md](开发计划.md) B16-R3 一致）**：原引用行号已因重构漂移；现 [app.js](src/web/js/app.js) 21 已为「内容类型筛选+最近/热度排序」，全仓平台注释均说明「平台属来源核验信息」且与实现一致，无过时残留。
9. **B16-R4**：候选层→审核→publish 重建流程一致性。✅ **端到端已通过（2026-08-04）**：首次真实采集已填充候选层 100 条（94 个启用来源、58/58 覆盖，非手工）；以真实候选 `x-9dd3da0625fba183ab33` 走通完整闭环——`review set --status pending` → `publish-news.js` 重建门禁正确剔除（100→99）→ `review set --status approved` → 恢复（99→100）；审核事件日志只追加记录流转（`candidate_version` 1→2→3、`from_status`、reviewer 留痕）；公开投影无内部字段泄漏（`INTERNAL_FIELDS` 生效）、schema_version 3；`node scripts/publish-news.js` 全量重建 + RSS 同步 + dist 重建（14 文件）全部通过。**人工审核流已启用（2026-08-04，决策 51/69）**：`DEFAULT_REVIEW_STATUS` 由 `approved` 改为 `pending`，新采集候选默认进入候选层待审、不自动公开；`build-news.js` 公开投影为空时跳过写 hotspots.json（保留上一版公开数据）、`publish-news.js` 同步保护；既有已 approved 候选经 `mergeCandidates` 保留审核结论。**说明**：首批 100 条候选为审核流启用前写入（全部 approved），后续采集的候选将默认 `pending`，公开区仅在人工 `review set/batch --status approved` 后经 publish 重建更新。候选层已非空，B16-R2 所述「无消费方」的前提也随之变化（字幕 enrichment 仍默认关闭，因 L1 AI 浓缩渠道未接入）。

### v1.0 延后（不在本轮范围）

真实 AI 搜索 / 会话 / 收藏 / 独立详情页 / 模式切换 / 审核管理后台可视化。

---

## 4. 一句话结论

> **B16 UI 三阶段与内容类型字段拆分（路径 B）均已完成并通过校验，当前处于「验收审查 + 文档同步」状态。近期三项数据补齐已于 2026-08-04 推进：热点关联资料（69/100）、内容类型规则分类建议已批量审核确认（100/100，reviewed）、工具发布时间 28 个工具全部补齐（17 个产品型工具已按用户决定移除）；路径 A 分类模块与审核流程已落地，L1 AI 模型渠道待续；B16-R4 候选层已首次真实采集（100 条）并以真实数据端到端验证审核门禁与 publish 重建闭环，人工审核流已启用（新候选默认 pending 待审）。**
