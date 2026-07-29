# InfoCatcher

AI 工具信息聚合平台 —— 一个开源免费的中文 AI 工具信息聚合与场景化对比项目，帮助用户降低 AI 工具选择的搜索成本与决策错误率。

> **当前阶段**：环 B（MVP 交付）—— 多轮冲刺迭代中。
>
> 前序工作：①问题定义 ✅ ②可行性研究 ✅（Conditional Go）

## 目录结构

|    阶段     | 目录 | 核心问题 | 主要工件 |
| :-------: | --- | --- | --- |
|  ① 问题定义 | [docs/lifecycle/01-problem-definition/](docs/lifecycle/01-problem-definition/) | 要解决的问题是什么？ | `AI信息获取软件开发.md`、`调查结果总结.md`（N=112） |
|  ② 可行性研究 | [docs/lifecycle/02-feasibility/](docs/lifecycle/02-feasibility/) | 有行得通的解决办法吗？ | `可行性研究报告.md`、`poc/` |
|  ③ 需求分析 | [docs/lifecycle/03-requirements/](docs/lifecycle/03-requirements/) | 目标系统必须做什么？ | `软件需求规格说明书.md` |
|  ④ 总体设计 | [docs/lifecycle/04-architecture/](docs/lifecycle/04-architecture/) | 概括地说，怎样实现？ | `总体设计说明书.md` |
|  ⑤ 详细设计 | [docs/lifecycle/05-detailed-design/](docs/lifecycle/05-detailed-design/) | 具体怎样实现？ | `详细设计说明书.md` |
| ⑥ 编码和单元测试 | [src/](src/) | 写出程序 | `src/`、`scripts/`、`tests/` |
|  ⑦ 综合测试 | [docs/lifecycle/07-integration-testing/](docs/lifecycle/07-integration-testing/) | 集成 + 验收测试 | README |
|  ⑧ 软件维护 | [docs/lifecycle/08-maintenance/](docs/lifecycle/08-maintenance/) | 改正 + 适应 + 完善 + 预防 | `CONTRIBUTING.md`、根 `.github/ISSUE_TEMPLATE/` |

### 四层项目结构

| 层 | 目录 | 只放什么 |
|---|---|---|
| 源码 | `src/` | 唯一业务实现入口 |
| 命令 | `scripts/` | 可执行入口，薄封装 |
| 测试 | `tests/` | 自动化测试及 fixtures |
| 数据 | `data/` | 数据和配置，禁止与代码混放 |
| 静态 | `public/` | 部署根资源 |
| 架构 | `docs/architecture/` | 当前架构事实 |
| 过程 | `docs/lifecycle/` | 八阶段过程资料 |
| AI | `.claude/` | 技能、入口与约束 |

## 开发路径（三环模型）

```
                    ┌───────────────────┐
                    │   环 A：前期确认   │
                    │ ①问题定义 ②可行性  │
                    │     ✅ 已完成     │
                    └────────┬──────────┘
                             │ Conditional Go
                             ▼
        ┌───────────────────────────────────────────┐
        │            环 B：MVP 交付（当前）          │
        │                                           │
        │  每轮冲刺 1-2 周，混合推进 ③④⑥⑧：           │
        │  ┌─ 需求细化(③) · 够用设计(④) ─┐           │
        │  │  编码+测试(⑥) · 反馈维护(⑧)   │         │
        │  └──────── 产出可用增量 ────────┘          │
        │         ↓ 用户反馈驱动下一轮                │
        └────────────────────┬──────────────────────┘
                             │ MVP 稳定
                             ▼
        ┌───────────────────────────────────────────┐
        │         环 C：架构演进 + 正式验收           │
        │ ④正式架构设计 → ⑤详细设计 → ⑦综合测试       │
        │ ⑧持续维护运营                              │
        │         🎯 目标：v1.0 发布                │
        └───────────────────────────────────────────┘
```

## 进度与计划

- [开发日志.md](开发日志.md) —— **已完成工作记录**（面向过去，跨阶段持续追加）
- [开发计划.md](开发计划.md) —— **三环任务清单**（面向未来，冲刺导向）

## 部署

- GitHub Pages：<https://wozore.github.io/InfoCatcher/>
- 静态站由 `.github/workflows/deploy.yml` 自动构建并部署到 GitHub Pages
- 热点采集由 `.github/workflows/collect-news.yml` 每日执行
- 工具情报由 `.github/workflows/refresh-tool-intel.yml` 每周自动更新

## 本地运行与内容维护

静态站无需构建工具或后端服务；可在仓库根目录选择以下任一方式启动本地服务器：

```bash
python -m http.server 8000
# 或
npx serve .
```

浏览器打开 `http://localhost:8000`。热点来源管理与人工 Bilibili 条目录入使用 `scripts/news-cli.js`；当前边界、命令和数据流见 [MVP 模块文档](docs/architecture/module-map.md)。真实采集所需 `YOUTUBE_API_KEY` 和 `X_API_KEY` 只能配置为 GitHub Repository Secrets，不得写入命令、JSON 或前端代码。

## 验证命令

```bash
node scripts/validate.js
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js
node scripts/build-news.js --fixture
```

## 维护机制

采用三层更新流水线：**用户提交 → AI 初审（v1.0+）→ 人工审核 → 入库**。详见 [CONTRIBUTING.md](docs/lifecycle/08-maintenance/CONTRIBUTING.md)。
