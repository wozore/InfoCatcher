# 运行时契约

> **归属**：docs/architecture/ — 架构事实层
>
> **前序**：[overview.md](overview.md) → [module-map.md](module-map.md) → [data-flows.md](data-flows.md)

本文件定义目录、文件、环境变量和 CI 的硬性契约。所有 Node.js 脚本和 GitHub Actions 必须遵守。

## 1. 目录契约

| 目录 | 契约 |
|------|------|
| `src/` | 唯一业务实现入口。禁止放 JSON 数据文件、禁止 `package.json` |
| `scripts/` | 可执行入口。只做薄封装 `require('../src/xxx/')`，不包含业务逻辑 |
| `tests/` | 自动化测试。`tests/news/` 放测试文件，`tests/fixtures/` 放样本数据 |
| `data/` | 数据和配置。子目录：`catalog/`、`news/config/`、`news/sources/`、`news/manual/`、`news/runtime/`、`news/output/`、`acquisition/` |
| `public/` | 静态部署资源。`feed.xml`、`sitemap.xml`、`robots.txt`、`og-image.*` |
| `docs/architecture/` | 架构事实。禁止放运行时数据或可执行代码 |
| `docs/lifecycle/` | 过程资料。禁止放运行时数据或可执行代码 |
| `resources/` | 人工维护的参考材料，不被应用直接发布 |

## 2. JSON 数据契约

### 内容主数据

| 文件 | 写入方 | 读取方 | 说明 |
|------|--------|--------|------|
| `data/catalog/tools.json` | 人工 | 浏览器 | 工具基本信息、评分、分类 |
| `data/catalog/tool-intelligence.json` | 采集引擎 + 人工 | 浏览器 | 模型/变体/套餐/价格/来源核验 |
| `data/catalog/glossary.json` | 人工 | 浏览器 | AI 术语词典 |
| `data/catalog/scenes.json` | 人工 | 浏览器 | 场景及任务-工具映射 |
| `data/catalog/featured.json` | 人工 | 浏览器 | 精选推荐 |

### 热点管线

| 文件 | 写入方 | 读取方 | 说明 |
|------|--------|--------|------|
| `data/news/config/news-config.json` | 人工 | 构建 | 评分权重、时间层、额度上限 |
| `data/news/sources/news-sources.json` | CLI/同步脚本 | 构建 | 96 个登记来源 |
| `data/news/manual/news-manual-items.json` | 人工/CLI | 构建 | B站人工精选暂存 |
| `data/news/runtime/news-state.json` | 构建 | 构建 | 时间层游标和来源进度 |
| `data/news/runtime/news-registry.json` | 构建 | 构建 | 持久去重记录 |
| `data/news/runtime/news-quota.json` | 构建/CLI | 构建 | 平台 API 额度账本 |
| `data/news/runtime/pending-authorizations.json` | 构建 | CLI | 待决策授权任务 |
| `data/news/output/hotspots.json` | 构建 | 浏览器 | 前端热点投影 |

### 采集配置

| 文件 | 写入方 | 读取方 | 说明 |
|------|--------|--------|------|
| `data/acquisition/intel-sources.json` | 人工 | 采集引擎 | 工具情报来源 URL 和方法 |

## 3. 环境变量

| 变量 | 使用方 | 说明 |
|------|--------|------|
| `YOUTUBE_API_KEY` | `src/news/collectors/news-youtube.js` | YouTube Data API v3 |
| `X_API_KEY` | `src/news/collectors/` (X 适配器) | TwitterAPI.io |
| `NEWS_PLATFORM_SCOPE` | `scripts/build-news.js` | 采集范围：`all` 或 `bilibili-only` |

所有密钥通过 GitHub Repository Secrets 注入，不出现在代码、JSON 或浏览器中。

## 4. CI 契约

| 工作流 | 触发 | 写入 |
|--------|------|------|
| `collect-news.yml` | 每日 UTC 2:00 / 手动 | `data/news/output/`、`data/news/runtime/`、`public/feed.xml` |
| `deploy.yml` | push main / 手动 | 只读，构建 `_site/` 后部署 |
| `refresh-tool-intel.yml` | 每周日 UTC 6:37 / 手动 | `data/catalog/tool-intelligence.json` |

## 5. 路径契约

所有 Node.js 数据路径必须通过 `src/shared/paths.js` 获取，禁止硬编码。该文件导出：

- `DIRS` — 目录常量（project、src、scripts、tests、data、public、resources、catalog、news、newsConfig、newsSources、newsManual、newsRuntime、newsOutput、acquisition、fixtures）
- `CATALOG_FILES` — 工具目录 JSON 文件路径
- `NEWS_FILES` — 热点管线 JSON 文件路径
- `ACQUISITION_FILES` — 采集配置 JSON 文件路径
- `SOURCE_LIST_PATH` — 热点信息源清单路径
- `RSS_FEED_PATH` — RSS 输出路径
