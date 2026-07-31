# InfoCatcher 架构

> 当前实现事实、模块边界和数据流。设计理由见 [架构决策](decisions.md)，运维命令见 [运维操作](operations.md)，采集策略见 [采集边界](acquisition.md)，未来演进见 [开发计划](../开发计划.md)。

## 定位与技术栈

InfoCatcher 是部署在 GitHub Pages 的开源 AI 工具信息聚合平台。浏览器使用原生 HTML/CSS/JS，构建脚本使用 Node.js 20；项目无 npm 依赖，以 Git 管理静态 JSON，构建产物为 `dist/`。

当前为环 B（MVP 交付），提供工具库、场景导航、对比模式、AI 热点、编辑精选、AI 概念和关于七个视图。

## 系统拓扑

```text
工具/情报/场景/概念 JSON ───────────────┐
YouTube、X、B站人工内容 → 热点构建 ─────┤→ 浏览器静态站 → GitHub Pages
厂商定价页 → 工具情报采集 ──────────────┘
```

三个 GitHub Actions 工作流分别采集热点、刷新工具情报和构建部署；触发时间与写入范围见 [运维操作](operations.md)。

## 目录与模块边界

| 目录 | 契约 |
|---|---|
| `src/web/` | 页面、样式、数据加载、筛选、比较和七视图渲染 |
| `src/news/` | 热点存储、Registry、额度、调度、授权、采集和 CLI 实现 |
| `src/content/` | B站人工内容标准化、RSS 和 OG 生成 |
| `src/acquisition/` | 工具情报解析、合并、冲突检测和校验 |
| `src/maintenance/` | 数据校验与来源同步 |
| `src/shared/paths.js` | Node 数据路径的唯一登记点 |
| `scripts/` | CI 使用的稳定薄入口，不放业务逻辑 |
| `tests/` | 自动化测试和 fixtures |
| `data/catalog/` | 工具、情报、术语、场景和编辑精选主数据 |
| `data/news/` | 热点配置、来源、人工暂存、内部状态和公开投影 |
| `data/acquisition/` | 工具情报来源配置 |
| `public/` | RSS、sitemap、robots、OG 等部署根资源 |
| `docs/` | 当前文档和历史归档，不放运行时数据或代码 |
| `resources/` | 人工参考材料，不直接发布 |

数据结构变化时须同步 `src/maintenance/validate.js` 和相关测试。每份数据只保留一个权威路径，不在 `data/` 根目录新增 JSON，也不在代码中绕过 `src/shared/paths.js` 硬编码路径。

## 浏览器运行时

浏览器只读取 `data/catalog/` 主数据和 `data/news/output/hotspots.json`，不读取 `data/news/runtime/` 内部状态。`loadData()` 加载数据，`switchView()` 切换视图，各渲染函数生成页面；工具情报加载失败时保留基础工具卡片并显示降级说明。

工具情报采用三级卡片层级：

- **厂商入口卡**：总览入口，不可比较；
- **分类卡**：展示分类和子节点，同类叶节点不少于 2 时可整体比较；
- **叶节点**：展示具体模型/套餐、价格、上下文和来源，可参与比较。

## 数据所有权

| 类别 | 主要文件 | 读写方 |
|---|---|---|
| 内容主数据 | `tools.json`、`glossary.json`、`scenes.json`、`featured.json` | 人工维护；浏览器读取 |
| 工具情报 | `tool-intelligence.json` | 采集器/人工维护；浏览器读取 |
| 热点规则与来源 | `news-config.json`、`news-sources.json` | CLI/同步脚本维护；构建读取 |
| 热点投影 | `hotspots.json` | 构建原子写入；浏览器读取 |
| 内部状态 | `news-state.json`、`news-registry.json` | 热点构建读写 |
| 运维状态 | `news-quota.json`、`pending-authorizations.json`、构建锁与审计 | 构建/CLI 读写 |
| 采集配置 | `intel-sources.json` | 人工维护；工具情报采集器读取 |

API Key 仅通过 GitHub Repository Secrets 注入，不进入代码、JSON 或浏览器。

## 四条数据流

### 工具目录

```text
data/catalog/{tools,tool-intelligence,glossary,scenes,featured}.json
  → fetch() → app.js → 七个浏览器视图
```

人工维护主数据；工具情报可由 `src/acquisition/` 增量更新。`scripts/validate.js` 负责静态校验。

### AI 热点

```text
YouTube / X ──────────────┐
B站人工精选 → 标准化 ─────┤→ build-news.js
                          ├→ Registry / 状态 / 额度 / 授权
                          └→ hotspots.json
```

构建过程获取锁后读取配置和旧状态，先将观察写入 Registry，再做标准化、去重、过滤、评分、溯源和主题聚合；状态原子写入，最后替换前端投影并释放锁。失败不得以空结果覆盖上一版有效 `hotspots.json`。

核心模块：

- `news-registry.js`：以 `platform:native_id` 持久去重；
- `news-scheduler.js`：管理 UTC 半开时间层；
- `news-quota.js`：按平台独立记账；
- `news-authorization.js`：管理超范围回溯授权；
- `news-storage.js`：原子写和 `.news-build.lock`；
- `news-cli.js`：来源、人工内容、授权、额度和锁管理。

平台来源、时间窗口和降级边界以 [采集文档](acquisition.md) 和 [质量标准](content-quality.md) 为准。

### 工具情报

```text
厂商 llms.txt / 定价页 → fetch-tool-intel.js
  → Markdown 解析 → HTML 解析 → 失败时保留旧数据
  → tool-intelligence.json
```

价格变化超过阈值时进入冲突流程而非自动覆盖；详见 [采集文档](acquisition.md#工具情报采集)。

### RSS / SEO

```text
hotspots.json → generate-rss.js → public/feed.xml
src/web/ → generate-og-image.js → OG 图
```

## 当前边界

已实现静态七视图、构建时热点和工具情报采集、规则评分、证据与溯源、持久 Registry、平台额度、授权任务、管理 CLI、单元测试和部署前校验。

当前 MVP 不包含：

- 浏览器运行时直接调用平台 API；
- 数据库、Serverless API、用户账户或实时推送；
- AI 自动事实裁决、商单定性或作者动机判断；
- B站内部 API、逆向 SDK或绕过风控；
- 无限历史回溯或无人审核的工具情报生成。

## 扩展不变量

1. 新浏览器数据源在 `loadData()` 中加载并提供失败空状态；新增视图须完整接入切换、渲染、事件和样式。
2. 新采集平台使用独立适配器；所有检测内容先进入 Registry。
3. 新网络操作先定义额度单位、成本、重试计费和暂停恢复方式。
4. 推广、异常和来源关系必须保留证据与置信度；未知值不得填零。
5. 采集失败保留旧投影；构建锁只能先检查再通过 CLI 带理由解锁。
6. 新工具情报来源优先通过配置扩展，特殊格式才新增专用解析器。
