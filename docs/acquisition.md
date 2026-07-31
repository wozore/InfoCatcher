# 工具情报与热点采集

> 采集来源、降级和平台边界。系统拓扑见 [架构文档](architecture.md)，命令与 CI 见 [运维操作](operations.md)。

## 工具情报采集

采集器从厂商官方来源读取模型定价和套餐信息，与 `data/catalog/tool-intelligence.json` 增量合并。

```text
L1：llms.txt / pricing.md → Markdown 表格解析
  ↓ 失败
L2：HTML 页面 → CSS 选择器 / 表格提取
  ↓ 失败
L3：记录日志 → 跳过合并 → 保留旧数据，等待人工处理
```

当前不会自动写入 `acquisition_failed` 或通知维护者。价格变化超过 20% 时标记冲突，须人工确认，不自动覆盖。

关键文件：

| 文件 | 用途 |
|---|---|
| `src/acquisition/fetch-tool-intel.js` | 解析、冲突检测和增量合并 |
| `src/acquisition/validate-intel.js` | 校验来源配置和数据合理性 |
| `data/acquisition/intel-sources.json` | 来源 URL、方法、发布方、周期和解析器配置 |

新增厂商时配置 `tool_id` 及 `intel_sources` 中的 `id`、`url`、`method`、`publisher`、`interval_days`。多数厂商无需修改采集引擎；特殊格式才添加专用解析器。运行命令与参数格式见 [运维操作](operations.md#工具情报)。

## 热点平台边界

| 平台 | 当前方式 | 关键边界 |
|---|---|---|
| YouTube | Data API v3 自动采集 uploads playlist，并受控回溯 | 按 quota units 独立记账 |
| X | TwitterAPI.io 自动采集 | 按来源轮转控制成本；逻辑暂内嵌于 `build-news.js` |
| Bilibili | `data/news/manual/news-manual-items.json` 人工精选 | 视频、动态、专栏均可入库；默认不发网络请求 |
| 知乎 | 暂缓 | 当前不采集 |

显式 `bilibili-only` 诊断可探测 RSSHub，但遇到 Cloudflare 后快速熔断。禁止使用 B站内部 API、逆向 SDK 或绕过平台风控。

## 来源管理

人工权威清单为 [热点信息源清单](../resources/source-lists/热点信息源清单.md)。同步命令生成 `data/news/sources/news-sources.json` 供热点构建使用；缺少主类型、标签或备注的条目需复核，缺失分类会使来源自动禁用。
