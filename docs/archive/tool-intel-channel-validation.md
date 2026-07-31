---
name: info-acquisition-channel-design
description: N01 信息获取通道设计与落地 — 包含 L1/L2/L3 验证结论的数据采集方案
metadata:
  type: project
---

# N01 信息获取通道验证（历史报告）

> 验证厂商官方资料能否通过 L1 Markdown、L2 HTML 或 L3 人工路径获取。URL、模型、价格和覆盖数量都是当时快照，使用前须重新核验。

## 厂商验证矩阵

| 厂商 | L1 | L2 | 当时结论 |
|---|---|---|---|
| Anthropic | `llms.txt` 重定向后可用，定价为 Markdown 表格 | — | 可直接解析；当时与试点价格一致 |
| OpenAI | `llms.txt` / `llms-full.txt` 可发现文档 | 定价页可解析 | L1 部分可用，失败后降级 L2 |
| Google AI | `llms.txt` 可发现文档 | 定价页有结构化表格 | L1 发现、L2 提取 |
| Cohere | `llms.txt` 可用 | 公开定价分散 | 文档可发现，定价需人工复核 |
| DeepSeek | `llms.txt` 不是有效索引 | 中文定价表可提取 | 直接使用 L2 |
| Mistral | 当时无法使用 `llms.txt` | 动态页面 | 需要额外提取方式或人工处理 |

这说明 `llms.txt` 不是所有厂商的统一定价接口；采集器必须逐来源配置并允许降级。

## 分层结论

```text
L1：llms.txt / pricing.md → Markdown 表格
  ↓ 失败或不完整
L2：官方 HTML → 表格/选择器
  ↓ 失败、动态页面或信息分散
L3：人工核验并录入，保留来源和查询时间
```

- API 提供商通常可通过 L1/L2 获取部分结构化价格；
- 消费类产品的套餐和权益更适合 L3 人工维护；
- 提取结果可映射到 `tool-intelligence.json`，但冲突必须人工确认；
- 当时报告中的“全部主要厂商可覆盖”“90% 数据稳定”等判断证据有限，不应视为保证。

## 实施结果与偏差

历史路线包括来源配置、L1/L2 解析、冲突检测、校验、定时 workflow、时效展示和分批接入。当前实现已迁至：

- `data/acquisition/intel-sources.json`
- `src/acquisition/fetch-tool-intel.js`
- `src/acquisition/validate-intel.js`
- `.github/workflows/refresh-tool-intel.yml`

原报告中的 `scripts/acquisition/` 路径和 `npm run` 命令已过时；现行命令见 [运维文档](../operations.md#工具情报)。

## 验证要求

每个来源接入时应：单工具 `--dry-run`，对比已有情报，运行工具情报校验与项目测试，再验证 workflow 不会异常覆盖旧数据。动态页面、定价条件、币种、缓存价格和地区限制须保留原始证据，不能根据解析结果自行补全。
