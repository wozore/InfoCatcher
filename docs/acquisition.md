# 工具情报与热点采集

> 工具情报自动采集和热点人工处理边界。当前架构和运维命令见 [docs/architecture.md](architecture.md) 和 [docs/operations.md](operations.md)。

## 工具情报采集

与热点采集管线并列的第二条数据管线。从厂商官方来源自动获取 API 模型定价、套餐信息，与现有 `tool-intelligence.json` 做增量合并。

### 三级降级链

```
L1: llms.txt → pricing.md → Markdown 表格解析
     ↓ 失败
L2: HTML 页面 → CSS 选择器 → HTML 表格提取
     ↓ 失败
L3: 记录日志 → 跳过合并 → 保留旧数据（由维护者后续人工处理）
```

当前实现：提取不到数据时仅记录日志、跳过合并并保留旧数据。不存在自动 `acquisition_failed` 状态写入或维护者通知机制。

### 冲突检测

价格变化 >20% 标记为冲突而非自动覆盖，需人工确认。

### 文件

| 文件 | 用途 |
|---|---|
| `src/acquisition/fetch-tool-intel.js` | 核心采集引擎（Markdown/HTML 解析、冲突检测、合并） |
| `src/acquisition/validate-intel.js` | CI 门禁校验（来源配置完整性 + 数据合理性） |
| `data/acquisition/intel-sources.json` | 工具情报来源配置（URL、方法、周期、解析器） |

### 添加新厂商

编辑 `data/acquisition/intel-sources.json`：

```json
{
  "tool_id": "新工具",
  "intel_sources": [{
    "id": "vendor-pricing",
    "url": "https://vendor.com/pricing",
    "method": "html_table",
    "publisher": "厂商名",
    "interval_days": 7
  }]
}
```

多数厂商只需配置即可，无需修改采集引擎代码。特殊格式（如 DeepSeek 的竖向对比表）需要在 `fetch-tool-intel.js` 中实现专用解析器。

### CLI 命令

```bash
node src/acquisition/fetch-tool-intel.js --tool deepseek --dry-run   # 单工具试运行
node src/acquisition/fetch-tool-intel.js                              # 采集全部来源
node src/acquisition/validate-intel.js                                # 校验输出
```

注意 `--tool` 参数格式：`--tool deepseek`（空格分隔），不是 `--tool=deepseek`。

### CI 关联

`.github/workflows/refresh-tool-intel.yml` 每周日 UTC 6:37 执行：

1. `validate-intel.js` 校验来源配置
2. `fetch-tool-intel.js` 采集（注意：workflow 中引用路径需确认为 `src/acquisition/fetch-tool-intel.js`）
3. `validate-intel.js` 校验输出
4. 提交变更的 `tool-intelligence.json`

## 热点采集平台边界

### YouTube

- 自动采集，通过 Data API v3 获取 uploads playlist
- 按五层时间窗口分页回溯
- 额度独立记账（quota units）
- 当前为每 3 天 UTC 02:00 触发

### X

- 自动采集，通过 TwitterAPI.io
- 按来源轮转控制成本
- 采集逻辑内嵌于 `build-news.js`

### Bilibili

- 默认采用人工精选（`data/news/manual/news-manual-items.json`）
- 人工条目经标准化后进入统一处理管线
- 视频、动态、专栏均可作为热点内容
- 默认不发起网络请求
- 显式 `bilibili-only` 诊断可探测 RSSHub，遇到 Cloudflare 快速熔断
- 不使用 B站内部 API、逆向 SDK 或绕过平台风控

### 知乎

- 当前暂缓，未采集

## 热点来源管理

人工权威来源清单：[resources/source-lists/热点信息源清单.md](../resources/source-lists/热点信息源清单.md)（96 个来源）。

同步命令生成 `data/news/sources/news-sources.json`，供 `build-news.js` 使用。部分条目缺少主类型/标签/备注的需补齐，缺失分类会导致来源被自动禁用。
