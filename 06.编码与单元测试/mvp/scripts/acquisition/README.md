# scripts/acquisition/ — 工具情报采集模块

N01 交付物。与热点采集管线（news）并列的第二条数据管线。

## 模块定位

从厂商官方来源自动获取 API 模型定价、套餐信息，与现有 `tool-intelligence.json` 做增量合并（价格变化 >20% 标记冲突而非自动覆盖）。

## 三级降级链

```
L1: llms.txt → pricing.md → Markdown 表格解析
     ↓ 失败
L2: HTML 页面 → CSS 选择器 → HTML 表格提取
     ↓ 失败
L3: acquisition_failed → 保留旧数据 → 通知维护者
```

## 文件

| 文件 | 用途 |
|:-----|:-----|
| `fetch-tool-intel.js` | 核心采集引擎（Markdown/HTML 解析、冲突检测、合并） |
| `validate-intel.js` | CI 门禁校验（来源配置完整性 + 数据合理性） |

## 添加新厂商

只需编辑 `data/acquisition/intel-sources.json`：

```json
{
  "tool_id": "新工具",
  "intel_sources": [{
    "id": "vendor-pricing",
    "url": "https://vendor.com/pricing",
    "method": "html_table",      // 或 pricing_markdown
    "publisher": "厂商名",
    "interval_days": 7
  }]
}
```

## 添加新解析器

当厂商有特殊格式时（如 DeepSeek 的竖向对比表），在 `fetch-tool-intel.js` 中实现专用解析器，并在 `fetchToolIntel()` 中注册。

## CLI 命令

```bash
node scripts/acquisition/fetch-tool-intel.js --tool=deepseek --dry-run
node scripts/acquisition/validate-intel.js
```

## CI 关联

`.github/workflows/refresh-tool-intel.yml` 每周日 UTC 6:37 执行：
1. `validate-intel.js` 校验配置
2. `fetch-tool-intel.js` 采集数据
3. `validate-intel.js` 校验输出
4. git-auto-commit 提交变更
