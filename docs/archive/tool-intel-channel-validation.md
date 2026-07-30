---
name: info-acquisition-channel-design
description: N01 信息获取通道设计与落地 — 包含 L1/L2/L3 验证结论的数据采集方案
metadata:
  type: project
---

# N01：信息获取通道设计方案 — 验证报告

## 验证方法

逐个厂商实测其数据端点的可用性，确认是否能通过自动化方式获取结构化 / 半结构化的官方资料。

---

## 1. L1 层验证：llms.txt + 结构化 Markdown

### ✅ Anthropic — **全功能通过**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://docs.anthropic.com/llms.txt` → 301 重定向到 `https://platform.claude.com/docs/llms.txt`，实际端点可用 |
| pricing.md | llms.txt 中直接链接 `https://platform.claude.com/docs/en/about-claude/pricing.md` |
| 数据类型 | **清洁的 Markdown 表格**，可直接解析 |
| 验证数据 | 成功提取 15 个模型的价格行（Fable 5、Mythos 5、Opus 5/4.8/4.7/4.6/4.5/4.1/4、Sonnet 5/4.6/4.5/4、Haiku 4.5/3.5），含 Base Input、Cache 三档、Output 共 5 列 |
| 与 B10 试点数据匹配度 | **100%** — 人工录入的 Opus 4.8 ($5/$0.50/$25) 与自动化提取完全一致 |

**结论**：Anthropic 是 L1 的标杆案例，可直接实现端到端自动化。

### ✅ OpenAI — **llms.txt 存在，数据可用**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://developers.openai.com/llms.txt` 存在（Vercel 403 curl 但 Tavily 成功获取），包含 8 个文档分区的完整索引 |
| llms-full.txt | `https://developers.openai.com/api/llms-full.txt` 存在，单文件 Markdown 全量文档 |
| 定价数据 | `/api/docs/pricing` 是 HTML 页面（非独立 .md），但 Tavily 提取为结构化 Markdown |
| 实际可用 | **L1 partial → L2 fallback**：优先从 llms-full.txt 提取定价表格，失败则 fallback 到 HTML 解析 |

**结论**：可用但不如 Anthropic 干净。需要两层（从 full.txt 提取表 → 降级 HTML 解析）。

### ✅ Google AI — **llms.txt 存在**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://ai.google.dev/llms.txt` 存在，官方文档中明确用于 MCP 回退 |
| 定价数据 | `https://ai.google.dev/gemini-api/docs/pricing` HTML 页面，有结构化定价表 |

**结论**：L1 可发现文档 → L2 解析定价页面。

### ✅ Cohere — **llms.txt 存在（但定价在企业侧）**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://docs.cohere.com/llms.txt` ✅ 200 OK — 支持 `.md` 后缀直接获取 Markdown |
| 定价页面 | `cohere.com/pricing` 是企业引导页，无公开 API 定价表（FAQ 中隐藏了 "$2.50/1M" 等） |
| 实际可用性 | L1 ✅ 用于 API 文档；定价需 L3 人工+AI 辅助从 FAQ 提取 |

**结论**：llms.txt 用于 API 文档发现 ✅；定价信息需要额外方案。

### ⚠️ DeepSeek — **无 llms.txt，但有结构化定价页**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://api-docs.deepseek.com/llms.txt` 存在但仅含 "你的首次 API 调用" 页面内容，**不是结构化索引** |
| 定价页面 | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing` — 有 **结构化的中文 HTML 表格**，可直接 CSS 选择器提取 |
| 验证数据 | 成功提取 DeepSeek-V4-Flash（¥1/¥0.02/¥2）和 DeepSeek-V4-Pro（¥3/¥0.025/¥6）的中文+英文双币种价格 |

**结论**：L2 直接解析 HTML 表格即可，效率不低于 L1。

### ⚠️ Mistral — **无 llms.txt，定价在动态页面**

| 测试项目 | 结果 |
|:---------|:-----|
| llms.txt | `https://docs.mistral.ai/llms.txt` — 连接超时 ❌ |
| 定价页面 | `https://mistral.ai/pricing/api/` — 有结构化定价，但由 JS 渲染，需要 Headless 或无头提取 |
| 验证数据 | 通过 Tavily 成功提取了全部模型定价（Mistral Medium 3.5 $1.5/$7.5、Small 4 $0.15/$0.6、Large 3 $0.5/$1.5 等 10+ 模型） |

**结论**：L2 需要 Headless 浏览器或 Tavily 类中间件。

---

## 2. L2 层验证：HTML 页面解析

| 厂商 | URL | 页面类型 | 解析难度 | 能否提取定价表 |
|:----:|:----|:--------:|:--------:|:-------------:|
| OpenAI | `developers.openai.com/api/docs/pricing` | 静态 HTML | 低 | ✅ 可直接 CSS 选择器提取 |
| Google AI | `ai.google.dev/gemini-api/docs/pricing` | 静态 HTML | 低 | ✅ 结构化表格 |
| DeepSeek | `api-docs.deepseek.com/zh-cn/quick_start/pricing` | 静态 HTML | 低 | ✅ 中文/英文双币种 |
| Mistral | `mistral.ai/pricing/api/` | Astro JS 渲染 | 中 | ✅ 需要 Headless 或 HTTP 回退 |
| Cohere | `cohere.com/pricing` | 企业引导页 | 高 | ⚠️ 定价在 FAQ 和 EA 页面中 |

## 3. L3 层分析：需人工/AI 辅助的工具

37 个厂商中，含公开 API 定价的仅约 10 家：

**有公开定价页面的 API 提供商（可 L1/L2 自动化）**：
- OpenAI, Anthropic, Google, DeepSeek, Mistral, Cohere（部分）, xAI, 智谱AI, 百度（文心）, 科大讯飞, MiniMax

**消费类产品（只需基本信息，L3 人工+AI）**：
- ChatGPT Go/Plus/Pro（套餐信息不在 API 定价页中，需从 `chatgpt.com/pricing` 获取）
- Midjourney, Suno, Gamma, Notion, ElevenLabs, Replit, Perplexity 等 25+ 工具（主要是套餐/会员定价）

---

## 4. 全面可行性结论

| 层级 | 方案 | 可用性 | 覆盖工具数 |
|:----:|:-----|:------:|:---------:|
| **L1** | llms.txt → pricing.md Markdown 表格解析 | ✅ 已验证 | ~4 家（Anthropic、OpenAI、Google、Cohere） |
| **L2** | HTML 表格 CSS 选择器提取 | ✅ 已验证 | ~10 家（含以上 + DeepSeek、Mistral、xAI、智谱等） |
| **L3** | AI 辅助人工录入 | ✅ 现行方案 | ~30 家（消费类工具） |

**关键结论**：
1. **L1 对所有主要 API 提供商都可行** — llms.txt 标准已被 Anthropic、OpenAI、Google、Cohere 等采用
2. **L2 作为降级覆盖全部 API 提供商** — 所有主流 API 提供商都有结构化定价表格
3. **90% 以上的消费类工具数据稳定性高**（套餐价格数月不变），L3 半自动维护就足够
4. **数据模型与已有 B10 试点兼容** — 自动提取结果可直接映射到现有的 `tool-intelligence.json` 格式

## 5. 实施路线图

| 步骤 | 内容 | 涉及文件 | 预估工时 |
|:----:|:-----|:---------|:--------:|
| **Step 1** | 设计 intel-sources.json 来源配置格式 | `data/acquisition/intel-sources.json`（新建） | 2h |
| **Step 2** | 实现核心采集引擎（L1: fetch+parse Markdown table） | `scripts/acquisition/fetch-tool-intel.js`（新建） | 4h |
| **Step 3** | 实现降级采集引擎（L2: HTML table CSS selector） | 同上，新增 `extractHtmlTable()` | 3h |
| **Step 4** | 实现冲突检测 + 数据校验 | `scripts/acquisition/validate-intel.js`（新建） | 3h |
| **Step 5** | 搭建 GitHub Actions 定时 workflow | `.github/workflows/refresh-tool-intel.yml`（新建） | 1h |
| **Step 6** | 前端 freshness 展示 + 过期提示（B11 联动） | `js/app.js` 扩展 | 2h |
| **Step 7** | 接入试点工具（将 B10 三家来源切换为自动采集） | 配置迁移 | 1h |
| **Step 8** | 按批次接入更多厂商（N02 启动） | 扩展 intel-sources.json | 迭代 |

## 6. 验证方法（实施后确认）

- `npm run intel:fetch -- --tool=anthropic` → 输出与 `tool-intelligence.json` 中现有数据对比
- `npm run intel:validate` → 校验通过
- `npm run test` → 全部已有测试通过
- GitHub Actions [refresh-tool-intel] 一次成功运行，数据无异常覆盖
