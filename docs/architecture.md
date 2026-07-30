# InfoCatcher 架构

> 当前实现事实、模块边界和数据流。不包含历史演进或未来规划——前者见 `docs/archive/architecture-evolution.md`，后者见 `开发计划.md`。

## 项目定位

InfoCatcher 是开源免费的 AI 工具信息聚合平台，部署在 GitHub Pages 上。帮助用户发现、比较和选择 AI 工具，降低搜索成本与决策错误率。

## 技术栈

| 层 | 技术 |
|---|---|
| 浏览器 UI | 原生 HTML + CSS + JS，零框架零依赖 |
| 构建管线 | Node.js 20，零 npm 依赖，GitHub Actions 驱动 |
| 数据存储 | 静态 JSON 文件，Git 版本控制 |
| 部署 | GitHub Pages，纯静态站点，构建产物为 `dist/` |

## 项目结构

| 层 | 目录 | 职责 |
|---|---|---|
| 源码 | `src/` | 唯一业务实现入口：`web/`（浏览器UI）、`news/`（热点采集）、`content/`（RSS/OG）、`acquisition/`（工具情报）、`maintenance/`（校验同步）、`shared/`（路径契约） |
| 命令入口 | `scripts/` | 稳定兼容入口，薄封装，不放业务逻辑 |
| 测试 | `tests/` | 自动化测试及 fixtures |
| 数据 | `data/` | `catalog/`（浏览器主数据）、`news/`（配置/来源/人工暂存/运行状态/输出）、`acquisition/`（采集配置） |
| 静态 | `public/` | 部署根资源 |
| 架构文档 | `docs/` | 当前架构、需求、质量、决策、运维和采集事实 |
| AI 入口 | `.claude/` | 技能、入口与约束 |

## 当前状态

环 B（MVP 交付），多轮冲刺迭代中。七个浏览器视图：工具库、场景导航、对比模式、AI 热点、编辑精选、AI 概念词典、关于。

当前数据规模：45 个工具、11 个情报集合、43 条术语、12 个场景、15 个编辑精选、96 个热点来源、100 条热点、79 个主题。

## 部署架构

```
GitHub Actions (collect-news.yml) → 采集/构建 → 提交 data/news/output/hotspots.json
GitHub Actions (deploy.yml) → src/web/ + public/ + data/ → dist/ → GitHub Pages
GitHub Actions (refresh-tool-intel.yml) → 采集工具情报 → 提交 data/catalog/tool-intelligence.json
```

---

## 模块概览

### 七个用户视图

| 视图 | 能力 | 数据来源 |
|---|---|---|
| 工具库 | 45 个工具、搜索、分类/访问/价格筛选、详情弹窗；集合卡片展示已核实的模型、变体和套餐 | `data/catalog/tools.json` + `tool-intelligence.json` |
| 场景导航 | 12 个可搜索场景、子任务展开与工具映射 | `data/catalog/scenes.json` + 工具数据 |
| 对比模式 | 选择 2–5 个工具进行 10 维度比较 | 前端 `compareList` |
| AI 热点 | YouTube、X、Bilibili 内容，按平台筛选、按评分/时间排序，展示覆盖与降级状态 | `data/news/output/hotspots.json` |
| 编辑精选 | 编辑推荐的特色工具 | `data/catalog/featured.json` |
| AI 概念 | 43 条术语、分类筛选、搜索和展开 | `data/catalog/glossary.json` |
| 关于 | 项目定位、方法论与开源说明 | 静态 HTML |

### 当前边界

已实现：

- 浏览器端七视图和静态 JSON 渲染
- GitHub Actions 每 3 天自动采集 YouTube/X；B站默认采用人工精选
- B站视频、动态、专栏均可作为热点内容
- 规则评分、商业证据、异常提示、转载溯源和主题聚合
- 五层 UTC 历史窗口、持久 Registry、平台额度账本、授权任务和管理 CLI
- 工具情报三级自动采集引擎（llms.txt → HTML 表格 → 人工录入），含价格冲突检测、校验门禁和每周 CI
- Node 20 零第三方依赖的单元测试与部署前校验

不属于当前 MVP：

- 浏览器运行时直接调用平台 API
- 数据库、Serverless API、用户账户和实时推送
- AI 自动事实裁决、自动定性商单或作者动机
- B站内部 API、逆向 SDK 或绕过平台风控
- 无限历史回溯
- 全自动化生成和审核新工具情报（采集失败时仍需人工核验）

---

## 文件树与职责

```
src/
├── web/
│   ├── index.html                     # 七视图页面结构
│   ├── css/style.css                  # 通用和响应式样式
│   └── js/app.js                      # 数据加载、筛选、比较和七视图渲染
├── shared/paths.js                    # 所有 Node 数据路径契约
├── news/
│   ├── core/                          # 存储、Registry、额度、调度、授权
│   ├── collectors/                    # YouTube/B站适配器
│   ├── pipeline/                      # 热点构建总编排（含 X 采集逻辑）
│   └── cli/                           # 管理 CLI 实现
├── content/                           # B站人工内容标准化、RSS、OG图生成
├── maintenance/                       # 校验与来源同步实现
└── acquisition/                       # 工具情报采集引擎、校验与冲突检测
data/
├── catalog/                           # 前端主数据
│   ├── tools.json                     # 45 个工具及集合/具体卡片分类
│   ├── tool-intelligence.json         # 模型、变体、套餐、价格与来源核验
│   ├── glossary.json                  # 43 条概念
│   ├── scenes.json                    # 12 个场景及任务-工具映射
│   └── featured.json                  # 15 个编辑精选
├── news/
│   ├── config/news-config.json        # 评分、时间层、额度和停止条件
│   ├── sources/news-sources.json      # 96 个标准化热点来源
│   ├── manual/news-manual-items.json  # B站人工精选暂存
│   ├── runtime/                       # 状态、Registry、额度、授权、锁与审计
│   └── output/hotspots.json           # 前端热点投影
└── acquisition/
    └── intel-sources.json             # 工具情报来源配置
scripts/                               # 稳定兼容入口
tests/                                 # 测试与 fixtures
.github/workflows/
    ├── collect-news.yml               # 每 3 天/手动采集并提交生成数据
    ├── deploy.yml                     # 校验、测试并部署 GitHub Pages
    └── refresh-tool-intel.yml         # 每周自动采集工具情报
```

---

## 浏览器运行时模块

### 页面结构：`index.html`

| 区域 | 职责 | 关键标识 |
|---|---|---|
| 导航 | 七个视图切换 | `.nav-btn[data-view]` |
| 工具库 | 搜索、筛选、卡片 | `#view-tools`, `#toolGrid` |
| 场景导航 | 场景搜索、任务展开 | `#view-scenes` |
| 对比模式 | 选择区和对比表 | `#view-compare` |
| AI 热点 | 状态、平台筛选、排序、Feed | `#view-trending` |
| 编辑精选 | 编辑推荐工具 | `#view-featured` |
| AI 概念 | 搜索、分类、术语列表 | `#view-glossary` |
| 关于 | 静态方法论 | `#view-about` |
| 详情弹窗 | 工具详情 | `#modalOverlay` |

### 应用逻辑：`app.js`

浏览器只读取 `data/catalog/` 主数据与前端投影 `data/news/output/hotspots.json`，不读取 `data/news/runtime/` 中的内部状态。

主要模块：数据加载（`loadData()`）→ 视图切换（`switchView()`）→ 各视图渲染函数。工具情报加载失败时保留旧工具卡片并降级说明。

### 卡片层级

工具信息采用"入口卡 → 分类卡 → 叶节点数据面板"的统一层级：

- **厂商入口卡**：标题使用"厂商（产品入口）"；不可比较
- **分类卡**：展示分类名称、官方链接、说明和子节点；同类叶节点 ≥2 时显示"全部模型/套餐对比"
- **叶节点数据面板**：展示标题、链接、说明、返回与对比；API 模型展示缓存命中/未命中/输出价格、上下文和来源

### 模块化存储约定

- `data/` 根目录不得新增 JSON
- `scripts/` 根目录只允许稳定兼容入口
- 新脚本实现归入 `src/` 对应子模块
- 新 Node 数据路径必须先登记到 `src/shared/paths.js`
- 每份数据只保留一个权威路径
- 数据结构改变时必须同步 `src/maintenance/validate.js` 与相关测试

---

## 热点构建时模块

### 总编排：`build-news.js`

1. 读取配置、来源、旧热点、人工精选暂存和持久状态
2. 获取构建锁并建立本轮额度账本
3. 采集最新 Feed：YouTube RSS/Data API、TwitterAPI.io；B站默认读取人工精选暂存
4. 对所有观察先写 Registry，非 AI 内容标记为 `filtered_non_ai`
5. 执行当前时间层的 YouTube 受控历史 step；B站默认不做自动历史回溯
6. 标准化、去重、AI 过滤、评分、异常检测、溯源和主题聚合
7. 更新 Registry、调度状态、额度和待授权任务
8. 原子写入状态文件，最后替换 `hotspots.json`
9. 释放构建锁

X 采用来源轮转控制成本；B站默认不做自动历史分页，人工条目直接进入统一处理管线。

### 关键子模块

| 模块 | 职责 |
|---|---|
| `news-registry.js` | 持久去重：主键 `platform:native_id`，区分 discovery/processing 状态 |
| `news-scheduler.js` | 五层 UTC 半开窗口 `[0,1)→[1,7)→[7,30)→[30,90)→[90,270)` 天，当前层终态后推进 |
| `news-youtube.js` | uploads playlist 分页 + `videos.list` 批量补详情 |
| `news-bilibili.js` | 当前默认暂停自动请求，仅保留诊断/历史能力边界 |
| `news-manual.js` | 校验 B站公开链接，生成统一人工条目 |
| `news-quota.js` | YouTube 按 quota units、B站按 HTTP attempts 独立记账 |
| `news-authorization.js` | 五层无新内容后可创建待确认任务 |
| `news-cli.js` | 来源管理、人工内容、授权处理、额度恢复、锁管理 |
| `news-storage.js` | 原子 JSON 写和 `.news-build.lock` |

---

## 数据文件分层

| 类别 | 文件 | 谁读写 | 用途 |
|---|---|---|---|
| 内容主数据 | `tools.json`, `glossary.json` | 人工维护；浏览器读 | 工具库与概念词典 |
| 情报数据 | `tool-intelligence.json` | 自动采集/人工维护；浏览器读 | 模型、变体、套餐、价格 |
| 来源/规则 | `news-sources.json`, `news-config.json` | CLI/同步脚本维护；构建读 | 采集来源、评分和上限 |
| 采集配置 | `intel-sources.json` | 人工维护；采集引擎读 | 工具情报 URL 和方法 |
| 前端投影 | `hotspots.json` | 构建写；浏览器读 | 内容、事件、溯源、评分 |
| 内部状态 | `news-state.json`, `news-registry.json` | 构建读写 | 游标、发现/处理记录 |
| 运维审计 | `news-quota.json`, `pending-authorizations.json` | 构建/CLI 读写 | 成本、暂停、授权 |

API Key 通过 GitHub Repository Secrets 注入（`YOUTUBE_API_KEY`、`X_API_KEY`），不出现在代码、JSON 或浏览器中。

---

## 数据流

InfoCatcher 有四条数据管线，均在 GitHub Actions 中运行，输出静态 JSON 供浏览器消费。

### 1. 工具目录流

```
data/catalog/tools.json ─────────────┐
data/catalog/tool-intelligence.json ─┤
data/catalog/glossary.json ──────────┤── fetch() → app.js → 浏览器七视图
data/catalog/scenes.json ────────────┤
data/catalog/featured.json ──────────┘
```

写入方：人工维护 + `src/acquisition/` 自动采集（工具情报）。校验：`scripts/validate.js`。

### 2. AI 热点流

```
YouTube Data API / X API → src/news/pipeline/build-news.js
B站人工精选暂存 → src/content/ → ──────────────┘
                              │
                              ├── runtime/news-registry.json (持久去重)
                              ├── runtime/news-state.json (时间层游标)
                              ├── runtime/news-quota.json (API 额度)
                              ├── runtime/pending-authorizations.json
                              └── output/hotspots.json (浏览器投影)
```

写入方：`scripts/build-news.js`（GitHub Actions 每 3 天触发）。管理：`scripts/news-cli.js`。

### 3. 工具情报流

```
厂商 llms.txt / 定价页 → src/acquisition/fetch-tool-intel.js
                              │
                              ├── L1: llms.txt → Markdown 表格解析
                              ├── L2: HTML 页面 → CSS 选择器提取
                              ├── L3: 记录日志、跳过合并、保留旧数据
                              └── data/catalog/tool-intelligence.json
```

写入方：`src/acquisition/fetch-tool-intel.js`（GitHub Actions 每周触发）。校验：`src/acquisition/validate-intel.js`。

### 4. RSS / SEO 流

```
hotspots.json → src/content/generate-rss.js → public/feed.xml
src/web/ → src/content/generate-og-image.js → og-image.png
```

---

## 运行时契约

### 目录契约

| 目录 | 契约 |
|---|---|
| `src/` | 唯一业务实现入口；禁止放 JSON 数据文件 |
| `scripts/` | 可执行入口，薄封装，不包含业务逻辑 |
| `tests/` | `tests/news/` 放测试文件，`tests/fixtures/` 放样本数据 |
| `data/` | 数据和配置；子目录：`catalog/`、`news/`、`acquisition/` |
| `public/` | 静态部署资源：`feed.xml`、`sitemap.xml`、`robots.txt`、`og-image.*` |
| `docs/` | 架构事实和过程资料；禁止放运行时数据或可执行代码 |
| `resources/` | 人工维护的参考材料，不被应用直接发布 |

### 环境变量

| 变量 | 使用方 | 说明 |
|---|---|---|
| `YOUTUBE_API_KEY` | `src/news/collectors/news-youtube.js` | YouTube Data API v3 |
| `X_API_KEY` | `src/news/pipeline/build-news.js`（内嵌 X 逻辑） | TwitterAPI.io |
| `NEWS_PLATFORM_SCOPE` | `scripts/build-news.js` | 采集范围：`all` 或 `bilibili-only` |

所有密钥通过 GitHub Repository Secrets 注入。

### CI 契约

| 工作流 | 触发 | 写入 |
|---|---|---|
| `collect-news.yml` | 每 3 天 UTC 2:00 / 手动 | `data/news/output/`、`data/news/runtime/`、`public/feed.xml` |
| `deploy.yml` | push main / 手动 | 只读，构建 `dist/` 后部署 |
| `refresh-tool-intel.yml` | 每周日 UTC 6:37 / 手动 | `data/catalog/tool-intelligence.json` |

### 路径契约

所有 Node.js 数据路径通过 `src/shared/paths.js` 获取，禁止硬编码。导出：

- `DIRS` — 目录常量
- `CATALOG_FILES` — 工具目录 JSON 路径
- `NEWS_FILES` — 热点管线 JSON 路径
- `ACQUISITION_FILES` — 采集配置 JSON 路径
- `SOURCE_LIST_PATH` — 热点信息源清单路径
- `RSS_FEED_PATH` — RSS 输出路径

---

## 测试与验证

### 内容语义层（23 项）：`news-tests.test.js`

验证三平台输入标准化、评分规则、B站人工条目和 Provider 熔断是否遵守产品约束。

### 持久基础设施层（20 项）：`news-foundation.test.js`

验证原子写、构建锁、Registry 唯一性和状态机、额度预留/消费、五层边界、时间层推进等。

### Fixture 与静态校验

| 命令 | 用途 |
|---|---|
| `node scripts/validate.js` | 校验 tools/glossary/news 配置、Registry、额度、热点引用和 HTML 契约 |
| `node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js` | 运行 43 项单元测试 |
| `node scripts/build-news.js --fixture` | 使用本地样本运行完整内容管线（不请求 API，不写持久数据） |

这些测试证明确定性规则和状态转换在本地成立，不能替代真实平台响应、跨日 Actions 连续运行和浏览器线上冒烟测试。

---

## 常用命令

```bash
node scripts/validate.js
node src/acquisition/validate-intel.js
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js
node scripts/build-news.js --fixture
node src/acquisition/fetch-tool-intel.js --tool deepseek --dry-run
node scripts/news-cli.js authorization list
node scripts/news-cli.js lock status
node scripts/news-cli.js source import --file sources.json --dry-run
```

---

## 扩展约束

1. 新增浏览器视图时同步修改 `index.html`、`switchView()`、渲染函数、事件绑定和样式
2. 新增前端数据源时在 `loadData()` 中加载，并提供失败空状态
3. 新增采集平台时单独建立适配器，不堆入 `build-news.js`
4. 所有检测内容应先进入 Registry，再进入详情、分析和热点投影
5. 新网络操作必须先定义额度单位、操作成本、重试计费和暂停恢复方式
6. B站动态继续作为可独立展示、评分和参与主题的内容
7. 商业推广、异常和来源关系必须保留证据与置信度；未知不是零
8. 采集失败不得用空结果覆盖上一版有效 `hotspots.json`
9. 不直接删除构建锁；先检查状态，必要时通过 CLI 带理由强制解锁
10. 新增工具情报来源时更新 `intel-sources.json` 即可，特殊格式需添加专用解析器
11. 环 B 只维护够用架构；正式数据库 schema、Serverless 接口和综合验收留至环 C
