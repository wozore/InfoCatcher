# 归档文档索引

本目录保存有追溯价值但不代表当前实现的历史材料；文件名为兼容既有链接而保留。当前事实以代码和 `docs/` 下权威文档为准。

## 研究证据

| 文件 | 内容 | 当前替代 |
|---|---|---|
| `problem-definition-full.md` | 问题、画像假设、计划版 41 题问卷与评测方法 | `docs/requirements.md` |
| `user-survey-full.md` | 实际 22 题、N=112 统计、勘误和外推边界 | `docs/requirements.md`；引用数字前先看勘误 |
| `feasibility-study-full.md` | Conditional Go、方案评分、成本、风险和关口 | `docs/decisions.md` + `开发计划.md` |
| `feasibility-methodology.md` | 通用可行性研究流程、公式和检查清单 | 非项目事实 |

## 可行性专题与 PoC

| 文件 | 内容 | 说明 |
|---|---|---|
| `risk-mitigation.md` | R2 时效与 R4 获客/留存缓解逻辑 | 当前措施见 `docs/operations.md` |
| `platform-acquisition-study.md` | 四平台历史采集方案和否决理由 | 当前边界见 `docs/acquisition.md` |
| `tool-intel-channel-validation.md` | 工具情报 L1/L2/L3 验证 | 当前命令见 `docs/operations.md` |
| `poc-index.md` | PoC 边界 | — |
| `poc-competitive-analysis.md` | 2026-07-18 竞品快照 | 使用前重新核验 |
| `poc-verification-report.md` | 采集/ToS PoC 与已否决的 Cloudflare 候选 | 不构成当前采集许可 |

## 功能与生命周期草案

| 文件 | 内容 | 状态 |
|---|---|---|
| `future-subscriptions.md` | RSS 与完整推送的阶段边界 | RSS 已实现；登录推送见 C06 |
| `future-featured-tools.md` | 编辑推荐草案 | 已由 `featured.json` + 编辑精选实现 |
| `future-plugin-system.md` | 静态/运行时插件设计 | 未实现，见 C05 |
| `architecture-evolution.md` | 方案 1 → 3 的历史总体设计 | 当前事实见 `docs/architecture.md` |
| `detailed-design-placeholder.md` | 尚未形成正式详细设计的记录 | 环 C 按需产出 |
| `integration-testing-placeholder.md` | 综合测试阶段入口 | 当前测试与缺口见 `docs/operations.md` |
| `maintenance-overview.md` | 历史维护流水线 | 当前流程见 `CONTRIBUTING.md` + `docs/operations.md` |

## 代理约定与图

- `agent-domain-conventions.md`、`agent-issue-tracker-conventions.md`：归档的通用代理约定，非项目事实。
- `requirements-flow.drawio`、`requirements-use-cases.drawio`：方案 1 历史业务流程和用例图；不代表当前需求或实现。
