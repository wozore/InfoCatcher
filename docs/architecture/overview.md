# InfoCatcher 项目概述

> **归属**：docs/architecture/ — 架构事实层
>
> **阅读顺序**：本文是 AI 与开发者进入项目的第一份架构文档。读完本文后，按 [module-map.md](module-map.md) → [data-flows.md](data-flows.md) → [runtime-contracts.md](runtime-contracts.md) 继续。

## 项目定位

InfoCatcher 是一个开源免费的 AI 工具信息聚合平台，部署在 GitHub Pages 上。帮助用户发现、比较和选择 AI 工具，降低搜索成本与决策错误率。

## 技术栈

| 层 | 技术 |
|---|---|
| 浏览器 UI | 原生 HTML + CSS + JS，零框架零依赖 |
| 构建管线 | Node.js 20，零 npm 依赖，GitHub Actions 驱动 |
| 数据存储 | 静态 JSON 文件，Git 版本控制 |
| 部署 | GitHub Pages，纯静态站点 |

## 四层项目结构

| 层 | 目录 | 职责 |
|---|---|---|
| 源码 | `src/` | 唯一业务实现入口。`web/`(浏览器UI)、`news/`(热点采集管线)、`content/`(RSS/OG)、`acquisition/`(工具情报)、`maintenance/`(校验同步)、`shared/`(路径契约) |
| 架构事实 | `docs/architecture/` | 模块边界、数据流、路径契约、架构决策 |
| 开发过程 | `docs/lifecycle/` | 八阶段过程资料、调研证据 |
| AI 入口 | `.claude/` | 技能、CLAUDE.md 入口索引 |

## 部署架构

```
GitHub Actions (collect-news.yml) ─→ 采集/构建 ─→ 提交 data/news/output/hotspots.json
GitHub Actions (deploy.yml) ─→ src/web/ + public/ + data/ ─→ _site/ ─→ GitHub Pages
GitHub Actions (refresh-tool-intel.yml) ─→ 采集工具情报 ─→ 提交 data/catalog/tool-intelligence.json
```

## 当前状态

环 B（MVP 交付），多轮冲刺迭代中。六个浏览器视图：工具库、场景导航、对比模式、AI 热点、AI 概念词典、关于。
