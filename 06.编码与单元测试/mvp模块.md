# InfoCatcher MVP 模块文档

> **版本**：v0.4（S2 / B14）
>
> **最后更新**：2026-07-26
>
> **当前说明**：本文件描述当前实现。B站仍是支持的热点内容类型，但默认 `all` 构建采用人工精选，不访问B站网络；RSSHub仅保留为显式 `bilibili-only` 诊断入口。
>
> **环归属**：环 B · ④够用设计 / ⑥编码与单元测试
>
> **对应目录**：`06.编码与单元测试/mvp/`
>
> **前序需求**：[软件需求规格说明书.md](../03.需求分析/软件需求规格说明书.md) FR-NEWS、[AI热点质量评估标准.md](../03.需求分析/AI热点质量评估标准.md)
>
> **架构图**：[mvp架构图.drawio](mvp架构图.drawio)

---

## 1. 当前 MVP 概览

InfoCatcher MVP 仍是部署到 GitHub Pages 的**纯静态浏览器应用**。B14 没有引入运行时后端，而是在 GitHub Actions 中执行 Node.js 采集与处理脚本，再把结果写成浏览器可读取的静态 JSON。

```text
浏览器运行时：HTML + CSS + JS → 读取静态 JSON → 内存筛选与渲染
构建时管线：外部平台 → GitHub Actions / Node.js → 校验与原子写 → 静态 JSON
```

### 1.1 六个用户视图

| 视图 | 主要能力 | 数据来源 |
|---|---|---|
| 工具库 | 43 个 AI 工具、搜索、分类/访问/价格筛选、详情弹窗 | `data/tools.json` |
| 场景导航 | 12 个场景入口并跳转至工具筛选 | 前端场景配置 + 工具数据 |
| 对比模式 | 选择 2–5 个工具进行 10 维度比较 | 前端 `compareList` |
| AI 热点 | YouTube、X、Bilibili 内容，按平台筛选、按评分/时间排序，展示覆盖与降级状态 | `data/hotspots.json` |
| AI 概念 | 43 条术语、分类筛选、搜索和展开 | `data/glossary.json` |
| 关于 | 项目定位、方法论与开源说明 | 静态 HTML |

### 1.2 当前边界

**已实现：**

- 浏览器端六视图和静态 JSON 渲染；
- GitHub Actions 每日构建时自动采集 YouTube/X；B站默认采用人工精选，人工条目与其他平台进入同一处理管线；
- B站视频、动态、专栏均可作为热点内容；
- B站默认网络采集暂停；显式 `bilibili-only` 诊断支持 Provider 单次探测和 Cloudflare 快速熔断；
- 规则评分、商业证据、异常提示、转载溯源和主题聚合；
- 五层 UTC 历史窗口、持久 Registry、平台额度账本、授权任务和管理 CLI；
- Node 20 零第三方依赖的单元测试与部署前校验。

**仍不属于当前 MVP：**

- 浏览器运行时直接调用平台 API；
- 数据库、Serverless API、用户账户和实时推送；
- AI 自动事实裁决、自动定性商单或作者动机；
- B站内部 API、逆向 SDK或绕过平台风控；
- 无限历史回溯。

---

## 2. 总体模块关系

```text
热点信息源清单.md
        │ sync-news-sources.js
        ▼
news-sources.json ─────────────┐
news-config.json ──────────────┤
news-manual-items.json ────────┤  ← B站人工精选暂存
GitHub Secrets ────────────────┤
YouTube / X ───────────────────┤
RSSHub（仅显式诊断）───────────┤
                              ▼
                         build-news.js
     ┌──────────────┬──────────┼───────────┬────────────────┐
     ▼              ▼          ▼           ▼                ▼
 Registry       Scheduler    Quota      Authorization    评分/溯源/主题
     │              │          │           │                │
     └──────────────┴──────────┴───────────┴────────────────┘
                              ▼
       news-registry / news-state / news-quota /
       pending-authorizations / hotspots.json
                              │
                              ▼
                  app.js → AI 热点静态视图
```

构建写入顺序为状态文件在前、`hotspots.json` 在后，避免前端投影领先于持久状态。所有目标 JSON 使用唯一临时文件、`fsync` 和同盘 `rename` 原子替换。

---

## 3. 文件树与职责

```text
mvp/
├── index.html                         # 六视图页面结构
├── css/style.css                      # 通用、热点和响应式样式
├── js/app.js                          # 数据加载、筛选、比较和六视图渲染
├── data/
│   ├── tools.json                     # 43 个工具
│   ├── glossary.json                  # 43 条概念
│   ├── hotspots.json                  # 前端热点投影
│   ├── news-config.json               # 评分、时间层、额度和停止条件
│   ├── news-sources.json              # 96 个标准化热点来源
│   ├── news-manual-items.json          # B站人工精选暂存
│   ├── news-state.json                # 构建、来源和历史游标状态
│   ├── news-registry.json             # 检测视频的持久发现/处理记录
│   ├── news-quota.json                # YouTube/B站额度账本
│   └── pending-authorizations.json    # 超出默认范围的待授权任务
├── scripts/
│   ├── build-news.js                  # 热点构建总编排入口
│   ├── sync-news-sources.js           # Markdown 来源清单转 JSON
│   ├── news-storage.js                # JSON 原子写和构建锁
│   ├── news-registry.js               # 视频索引、状态与批量防重
│   ├── news-quota.js                  # 平台独立额度预留/消费/审计
│   ├── news-scheduler.js              # 五层 UTC 调度与推进判定
│   ├── news-youtube.js                # uploads playlist 历史适配器
│   ├── news-bilibili.js               # B站历史适配器（当前默认暂停）
│   ├── news-manual.js                 # B站人工条目校验与标准化
│   ├── news-authorization.js          # 待授权任务与决策规则
│   ├── news-cli.js                    # 来源、人工内容、授权、额度和锁管理入口
│   ├── validate.js                    # 数据、引用与 HTML 契约校验
│   ├── news-tests.test.js             # 内容规则与采集行为测试（23项）
│   ├── news-foundation.test.js        # 状态、额度、调度和 CLI 测试（20项）
│   └── news-fixtures/                 # 三平台确定性测试样本
└── .github/workflows/
    ├── collect-news.yml               # 定时/手动采集并提交生成数据
    └── deploy.yml                     # 校验、测试并部署 GitHub Pages
```

---

## 4. 浏览器运行时模块

### 4.1 页面结构：`index.html`

| 区域 | 职责 | 关键标识 |
|---|---|---|
| 导航 | 六个视图切换 | `.nav-btn[data-view]` |
| 工具库 | 搜索、筛选、卡片 | `#view-tools`, `#toolGrid` |
| 场景导航 | 场景卡片 | `#view-scenes`, `#sceneGrid` |
| 对比模式 | 选择区和对比表 | `#view-compare` |
| AI 热点 | 状态、平台筛选、排序、Feed | `#view-trending`, `#trendingGrid` |
| AI 概念 | 搜索、分类、术语列表 | `#view-glossary` |
| 关于 | 静态方法论 | `#view-about` |
| 详情弹窗 | 工具详情 | `#modalOverlay` |

### 4.2 应用逻辑：`app.js`

| 模块 | 关键函数 | 作用 |
|---|---|---|
| 全局状态 | `tools`, `glossary`, `hotspots`, `compareList` | 保存静态数据和交互状态 |
| 数据加载 | `loadData()` | 并行职责式加载三个前端 JSON，失败时降级为空状态 |
| 视图切换 | `switchView()` | CSS class 切换并调用对应 render 函数 |
| 工具发现 | `getFilteredTools()`, `renderTools()` | 文本与三维筛选叠加 |
| 详情与对比 | `openDetail()`, `toggleCompare()`, `renderCompare()` | 工具决策交互 |
| 概念词典 | `getFilteredGlossary()`, `renderGlossary()` | 搜索、分类和展开 |
| AI 热点 | `getFilteredTrending()`, `renderTrendingStatus()`, `renderTrending()` | 平台过滤、排序、评分/主题/溯源展示 |
| 安全输出 | `escapeHtml()`, `safeExternalUrl()` | 转义外部文本，仅允许 HTTP(S) 链接 |
| 场景导航 | `renderScenes()`, `searchByScene()` | 场景到工具查询的跳转 |

浏览器不会读取 `news-registry.json`、`news-quota.json` 等内部状态，只读取前端投影 `hotspots.json`。

---

## 5. 热点构建时模块

### 5.1 总编排：`build-news.js`

主要阶段：

1. 读取配置、来源、旧热点、人工精选暂存和持久状态；
2. 获取构建锁并建立本轮额度账本；
3. 采集最新 Feed：YouTube RSS/Data API、TwitterAPI.io；B站默认读取人工精选暂存，显式诊断才探测RSSHub；
4. 对所有观察先写 Registry，非 AI 内容也标记为 `filtered_non_ai`；
5. 执行当前时间层的 YouTube 受控历史 step；B站默认不做自动历史回溯；
6. 标准化、去重、AI 过滤、评分、异常检测、溯源和主题聚合；
7. 更新 Registry、调度状态、额度和待授权任务；
8. 原子写入状态文件，最后替换 `hotspots.json`；
9. 释放构建锁。

X 继续采用来源轮转控制成本；B站默认不做自动历史分页，人工条目直接进入统一处理管线；显式 `bilibili-only` 诊断遇到 Cloudflare 后快速熔断。

### 5.2 Registry：`news-registry.js`

- 首选唯一键：`platform:native_id`；
- 无原生 ID 时使用按平台隔离的规范化 URL 哈希；
- 启动时构造原生键、URL、来源三类内存索引；
- 区分 discovery 与 processing 状态；
- 已完成且 `analysis_version` 未变化时跳过重复详情和分析；
- 不同平台相同 native ID 不冲突。

### 5.3 时间调度：`news-scheduler.js`

固定 UTC 半开窗口：

```text
[0,1) → [1,7) → [7,30) → [30,90) → [90,270) 天
```

当前层所有适用来源达到终态后才推进；`quota_paused`、`temporarily_failed`、`waiting_authorization` 等状态会阻止自动推进。来源层状态保存页游标、观察数、新增数、重复数、最旧时间和停止原因。

### 5.4 平台适配器

| 模块 | 策略 | 能力边界 |
|---|---|---|
| `news-youtube.js` | 获取 uploads playlist，按 `playlistItems.list` 分页；Registry 防重后用 `videos.list` 批量补详情 | 默认不用高成本 `search.list`；额度不足保存恢复游标 |
| `news-bilibili.js` | 当前默认暂停自动请求；仅保留显式诊断/历史能力边界记录 | 不调用内部 API，不绕过风控 |
| `news-manual.js` | 校验B站公开链接、source_id、内容类型和日期，生成统一人工条目 | 不访问B站网络，不接受Cookie或Token |

### 5.5 额度、授权与管理

- `news-quota.js`：YouTube 按 quota units、B站按 HTTP attempts 独立记账；请求前 reserve，实际发出后 consume；失败和重试仍消耗。
- `news-authorization.js`：五层均无新内容后可创建待确认任务，决策支持 `continue`、`until-first`、`skip`、`stop`。
- `news-cli.js`：提供单条/批量来源管理、B站人工内容 `content add/import/list`、授权处理、额度恢复记录、锁状态和带理由的强制解锁；不接受 API Key 参数。
- `news-storage.js`：原子 JSON 写和 `.news-build.lock`；stale lock 不自动删除。

---

## 6. 数据文件分层

| 类别 | 文件 | 谁读写 | 用途 |
|---|---|---|---|
| 内容主数据 | `tools.json`, `glossary.json` | 人工维护；浏览器读 | 工具库与概念词典 |
| 来源/规则配置 | `news-sources.json`, `news-config.json` | CLI/同步脚本维护；构建读 | 采集来源、评分和安全上限 |
| 前端投影 | `hotspots.json` | 构建写；浏览器读 | 内容、事件、溯源、评分和覆盖状态 |
| 持久内部状态 | `news-state.json`, `news-registry.json` | 构建读写 | 游标恢复、发现/处理记录、防重 |
| 运维审计 | `news-quota.json`, `pending-authorizations.json` | 构建/CLI 读写 | 成本、暂停、授权决策 |

API Key 不属于任何 JSON 文件，只能由 GitHub Repository Secrets 注入为 `YOUTUBE_API_KEY` 和 `X_API_KEY`。

---

## 7. 测试与验证架构

### 7.1 `news-tests.test.js`：内容语义层（23项）

验证三平台输入能否被正确标准化，以及评分规则、B站人工条目和Provider熔断是否遵守产品约束：B站动态是一等内容、轻度用户体验必须有证据、商单无证据不扣分、低频不损害长期质量、小样本不误伤、MAD 只提示复核、转载/主题关系保留、X 轮转和B站人工/降级状态不误报。

### 7.2 `news-foundation.test.js`：持久基础设施层（20项）

验证原子写、构建锁、Registry 唯一性和状态机、额度预留/消费、五层边界、时间层推进、低频回溯资格、YouTube 分页防重与游标恢复、B站历史能力降级、授权边界和来源 CLI 原子导入。

### 7.3 Fixture 与静态校验

- `node scripts/build-news.js --fixture`：使用本地三平台样本运行完整内容管线，不请求真实 API、不写持久数据；当前预期为5条内容、5个主题。
- `node scripts/validate.js`：校验 tools/glossary/news 配置、Registry、额度、授权、热点引用和 HTML DOM 契约。
- `node --check scripts/*.js`：检查所有 Node.js 脚本语法。

这些测试证明确定性规则和状态转换在本地成立，但不能替代真实平台响应、跨日 Actions 连续运行和浏览器线上冒烟测试。

---

## 8. CI/CD 与运维入口

### 8.1 `collect-news.yml`

每日 UTC 02:00 或手动触发：校验配置 → 注入 Secrets → 构建热点（YouTube/X自动采集 + B站人工暂存；B站默认不请求网络）→ 运行43项测试与校验 → 提交变更的热点/状态数据。工作流使用 concurrency 防止同类 Action 并发。

### 8.2 `deploy.yml`

主分支 push 或手动触发：运行静态校验和43项测试 → 复制站点文件 → 上传 Pages artifact → 部署 GitHub Pages。

### 8.3 常用命令

```bash
node scripts/validate.js
node --test scripts/news-tests.test.js scripts/news-foundation.test.js
node scripts/build-news.js --fixture
node scripts/news-cli.js authorization list
node scripts/news-cli.js lock status
node scripts/news-cli.js source import --file sources.json --dry-run
```

---

## 9. 扩展点与修改约束

1. 新增浏览器视图时同步修改 `index.html`、`switchView()`、渲染函数、事件绑定和样式。
2. 新增前端数据源时在 `loadData()` 中加载，并为失败情况提供空状态。
3. 新增采集平台时单独建立适配器，不把平台细节继续堆入 `build-news.js`。
4. 所有检测内容应先进入 Registry，再进入详情、分析和热点投影。
5. 新网络操作必须先定义额度单位、操作成本、重试计费和暂停恢复方式。
6. B站动态继续作为可独立展示、评分和参与主题的内容，不得降为单纯活跃度信号。
7. 商业推广、异常和来源关系必须保留证据与置信度；未知不能当作零或负面事实。
8. 采集失败不得用空结果覆盖上一版有效 `hotspots.json`。
9. 不直接删除构建锁；先检查状态，必要时通过 CLI 带理由强制解锁并保留审计。
10. 环 B 只维护够用架构；正式数据库 schema、Serverless 接口和综合验收设计留到环 C。

---

## 10. 当前验证状态与下一验收点

| 项目 | 状态 |
|---|---|
| 43项 Node 单元测试 | ✅ 本地通过 |
| Fixture 5条内容 / 5个主题 | ✅ 本地通过 |
| JSON、引用和 HTML 契约 | ✅ 本地通过 |
| JavaScript 语法和 diff whitespace | ✅ 本地通过 |
| 真实 YouTube/X/RSSHub 首次 Actions 采集 | ⏳ 待执行 |
| 跨批次历史游标和 Registry 恢复 | ⏳ 待真实连续运行验证 |
| GitHub Pages AI 热点线上浏览器冒烟 | ⏳ 待生成真实 `hotspots.json` 后验证 |
