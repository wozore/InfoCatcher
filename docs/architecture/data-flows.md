# 数据流

> **归属**：docs/architecture/ — 架构事实层
>
> **前序**：[overview.md](overview.md) → [module-map.md](module-map.md)

InfoCatcher 有三条独立的数据管线，均在 GitHub Actions 中运行，输出静态 JSON 供浏览器消费。

## 1. 工具目录流

```
data/catalog/tools.json ─────────────┐
data/catalog/tool-intelligence.json ─┤
data/catalog/glossary.json ──────────┤── src/web/js/app.js ─→ 浏览器六视图
data/catalog/scenes.json ────────────┤
data/catalog/featured.json ──────────┘
```

- **写入方**：人工维护 + `src/acquisition/` 自动采集（工具情报）
- **读取方**：`src/web/js/app.js` 通过 `fetch('data/catalog/...')` 加载，在浏览器内存中筛选和渲染
- **校验**：`scripts/validate.js` 检查 JSON 结构、引用完整性和数据合理性

## 2. AI 热点流

```
YouTube Data API / X API ──→ src/news/collectors/ ──→ src/news/pipeline/build-news.js
B站人工精选暂存 ──→ src/content/news-manual.js ──────┘
                              │
                              ├── data/news/runtime/news-registry.json  (持久去重)
                              ├── data/news/runtime/news-state.json     (时间层游标)
                              ├── data/news/runtime/news-quota.json     (API 额度)
                              ├── data/news/runtime/pending-authorizations.json
                              └── data/news/output/hotspots.json        (浏览器投影)
```

- **写入方**：`scripts/build-news.js` (GitHub Actions 每日触发)
- **读取方**：`src/web/js/app.js` 通过 `fetch('data/news/output/hotspots.json')` 加载
- **配置**：`data/news/config/news-config.json` (评分权重/时间层/安全上限)、`data/news/sources/news-sources.json` (96 个来源)
- **管理**：`scripts/news-cli.js` 提供来源导入、授权决策、锁管理

## 3. 工具情报流

```
厂商 llms.txt / 定价页 ──→ src/acquisition/fetch-tool-intel.js
                              │
                              ├── 三级降级：llms.txt → HTML 表格 → 人工录入
                              ├── 冲突检测：价格变化 >20% 标记冲突
                              └── data/catalog/tool-intelligence.json
```

- **写入方**：`src/acquisition/fetch-tool-intel.js` (GitHub Actions 每周触发)
- **校验**：`src/acquisition/validate-intel.js`
- **配置**：`data/acquisition/intel-sources.json`

## 4. RSS / SEO 流

```
data/news/output/hotspots.json ──→ src/content/generate-rss.js ──→ public/feed.xml
src/web/index.html ──→ src/content/generate-og-image.js ──→ public/og-image.png
```

- **写入方**：`scripts/generate-og-image.js`，RSS 随热点构建自动生成
- **发布**：`public/` 下文件由部署工作流复制到 `_site/` 根
