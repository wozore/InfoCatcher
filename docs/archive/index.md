# 归档文档索引

本目录保存仍有追溯价值、但不代表当前实现的历史原件。**所有文件均为历史快照，以当前代码和 `docs/` 中的权威文档为准。**

## 研究证据

| 文件 | 内容 | 当前替代 |
|---|---|---|
| `problem-definition-full.md` | 问题定义、8 类用户画像与需求假设（2457 行） | `docs/requirements.md` + `docs/architecture.md` |
| `user-survey-full.md` | N=112 问卷统计与交叉分析（623 行）；存在样本总数与百分比内部矛盾 | 结论已提炼至 `docs/requirements.md` §1 |
| `feasibility-study-full.md` | Conditional Go 决策、方案比较、预算与风险（1216 行） | `docs/decisions.md` + `docs/architecture.md` |

## 可行性专题与 PoC

| 文件 | 内容 | 说明 |
|---|---|---|
| `risk-mitigation.md` | R2 更新时效与 R4 获客留存缓解方案 | 历史路线已过时；当前措施在 `docs/operations.md` |
| `platform-acquisition-study.md` | YouTube/X/B站/知乎平台采集策略与历史方案 | 当前边界在 `docs/acquisition.md` |
| `tool-intel-channel-validation.md` | 工具情报 L1/L2/L3 验证报告 | 当前命令在 `docs/acquisition.md`；其中 `npm run` 命令已过时 |
| `poc-index.md` | PoC 边界说明 | — |
| `poc-competitive-analysis.md` | 2026-07-18 竞品分析快照 | 有时效性，不作为当前产品事实 |
| `poc-verification-report.md` | 采集 PoC/ToS 及历史 Cloudflare 候选方案 | 历史绕过方案已明确不采用 |

## 未来功能草案

| 文件 | 内容 | 当前状态 |
|---|---|---|
| `future-subscriptions.md` | RSS/推送订阅草案 | RSS 已实现；完整登录/推送留至开发计划 |
| `future-featured-tools.md` | 编辑精选推荐草案 | 已被 `data/catalog/featured.json` + 推荐视图完整替代 |
| `future-plugin-system.md` | 静态/运行时插件方案草案 | 环 C 未来需求，目标留开发计划 |

## 生命周期历史文档

| 文件 | 内容 | 说明 |
|---|---|---|
| `architecture-evolution.md` | 方案 1→3 演进骨架（原总体设计） | 包含已废弃的 Lunr.js 引用；当前事实以 `docs/architecture.md` 为准 |
| `detailed-design-placeholder.md` | 21 行待补清单 | 未形成正式交付物 |
| `integration-testing-placeholder.md` | 综合测试阶段入口 | 环 C 尚未启动；当前测试见 `docs/operations.md` |
| `maintenance-overview.md` | 维护阶段三层流水线 | 当前维护流程见 `CONTRIBUTING.md` + `docs/operations.md` |

## 外部参考

| 文件 | 内容 |
|---|---|
| `feasibility-methodology.md` | 通用可行性研究方法论教程，非 InfoCatcher 项目事实 |

## 代理工具约定

| 文件 | 内容 | 说明 |
|---|---|---|
| `agent-domain-conventions.md` | 领域文档消费约定 | 通用约定，非项目事实 |
| `agent-issue-tracker-conventions.md` | Issue/PR 操作约定 | 通用约定，非项目事实 |

## 历史设计图

| 文件 | 内容 |
|---|---|
| `requirements-flow.drawio` | 方案 1 业务流程图（历史稿） |
| `requirements-use-cases.drawio` | 方案 1 用例图（历史稿） |
