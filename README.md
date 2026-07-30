# InfoCatcher

AI 工具信息聚合平台 —— 开源、免费、不接受厂商赞助的中文 AI 工具信息聚合与场景化对比项目。

> **当前阶段**：环 B（MVP 交付），多轮冲刺迭代中。前序工作：①问题定义 ✅ ②可行性研究 ✅（Conditional Go）

## 快速开始

```bash
# 本地浏览
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

无需构建工具、npm 依赖或后端服务。直接打开 `src/web/index.html` 也可浏览（但 fetch 需要 HTTP 服务）。

## 验证

```bash
node scripts/validate.js                                          # 数据校验
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js   # 43 项测试
node scripts/build-news.js --fixture                               # 本地样本构建
```

## 部署

- GitHub Pages：<https://wozore.github.io/InfoCatcher/>
- 热点采集：每 3 天 UTC 02:00 自动执行
- 工具情报：每周日 UTC 06:37 自动更新
- 静态站由 push main 自动部署

## 文档导航

| 想了解… | 看这里 |
|---|---|
| 项目概览和快速验证 | 本页 |
| 如何贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 当前实现架构、模块和数据流 | [docs/architecture.md](docs/architecture.md) |
| 功能需求、范围和验收状态 | [docs/requirements.md](docs/requirements.md) |
| 热点内容质量标准 | [docs/content-quality.md](docs/content-quality.md) |
| 架构决策及理由 | [docs/decisions.md](docs/decisions.md) |
| 环境变量、CLI、CI、部署和维护 | [docs/operations.md](docs/operations.md) |
| 工具情报与热点采集边界 | [docs/acquisition.md](docs/acquisition.md) |
| 已发生的工作记录 | [开发日志.md](开发日志.md) |
| 未来任务与计划 | [开发计划.md](开发计划.md) |
| 历史研究、可行性和阶段材料 | [docs/archive/index.md](docs/archive/index.md) |

## 技术栈

原生 HTML + CSS + JS / Node.js 20 / 零 npm 依赖 / 静态 JSON / GitHub Pages

## 项目结构

| 目录 | 职责 |
|---|---|
| `src/` | 唯一业务实现入口 |
| `scripts/` | 可执行入口，薄封装 |
| `tests/` | 自动化测试及 fixtures |
| `data/` | 数据和配置（catalog/news/acquisition） |
| `public/` | 部署根资源 |
| `docs/` | 当前架构、需求、质量、决策、运维和采集文档 |
| `resources/` | 人工维护的参考材料 |
