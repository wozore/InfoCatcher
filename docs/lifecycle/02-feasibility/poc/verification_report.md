# W1 技术验证报告

**项目**: InfoCatcher  
**日期**: 2026-07-18  
**验证项**: C1 (信息采集 PoC) + C3 (ToS 审查)

---

## 一、Bilibili API 验证

| 端点 | 状态 | 说明 |
|------|:---:|------|
| 主搜索 API (`/x/web-interface/wbi/search/all/v2`) | ✅ | HTTP 200, 12 条结果, 无需 wbi 签名即可返回数据 |
| 视频详情 API (`/x/web-interface/view`) | ✅ | HTTP 200, 返回完整元数据 |
| 热门推荐 API (`/x/web-interface/index/top/feed/rcmd`) | ✅ | HTTP 200, 20 条推荐 |
| 搜索建议 API (`/s.search.bilibili.com/main/suggest`) | ⚠️ | 间歇超时, 不稳定 |
| 分区列表 API (`/x/web-interface/dynamic/region`) | ⚠️ | HTTP 200 但 data 为 null, API 结构可能已变更 |

**关键发现**: Bilibili API **需要完整的浏览器请求头**（Accept、Accept-Language、Accept-Encoding、Referer、Origin）才能正常工作。缺少这些头部会触发 412 Precondition Failed。

**可用性**: ✅ 3/5 端点稳定可用。核心功能（搜索 + 视频详情 + 热门列表）正常工作。

---

## 二、网页抓取验证

| 目标网站 | HTTP | 大小 | 可抓取 | 说明 |
|----------|:---:|------|:---:|------|
| deepseek.com | 200 | 142 KB | ✅ | 静态 HTML, title/description 可提取 |
| tongyi.aliyun.com | 200 | 130 KB | ✅ | 静态 HTML, 元数据可提取 |
| aistudio.google.com | 200 | 25 KB | ✅ | 静态 HTML, 可正常获取 |
| openai.com | 403 | — | ❌ | Cloudflare/WAF 保护 |
| claude.ai | 403 | — | ❌ | Cloudflare/WAF 保护 |

**关键发现**: 
- **国内 AI 工具官网**（DeepSeek、通义）和 **Google 服务**（AI Studio）可正常抓取
- **海外 AI 工具官网**（OpenAI、Anthropic）由 Cloudflare 保护，返回 403
- 对于受保护网站，**手动整理 + 注明来源**是可行的替代方案
- 国内可抓取 + 国外手动整理的混合策略可覆盖所有目标工具

**可用性**: ✅ 3/5 可直接抓取。剩余 2 个可通过手动方式覆盖。

---

## 三、ToS 审查

| 数据源 | 风险 | 关键限制 |
|--------|:---:|----------|
| **Bilibili API** | 低 | 公开 API, 非商业个人使用风险低 |
| **YouTube Data API** | 低 | 免费 10,000 单位/天, 仅元数据 |
| **X (Twitter) API** | 中 | 免费层 1,500 条/月, 读取约 100 次/月 |
| **DeepSeek 官网** | 低 | 公开信息可合理引用 |
| **通义千问 官网** | 低-中 | 阿里云通用条款, 公开信息引用风险低 |
| **OpenAI 官网** | 中 | 禁止自动化抓取, 但人工收集+注明来源可行 |
| **Anthropic 官网** | 中 | 同 OpenAI, 人工整理风险低 |
| **Google AI Studio** | 低 | 公开信息引用宽松 |

**结论**: ✅ 0 个高风险源, 3 个中风险源。所有中风险源均可通过"手动整理 + 注明来源"降低至低风险。无明确法律禁止项。

---

## 四、综合判定

### C1: 信息采集 PoC

| 数据源类别 | 验证方式 | 状态 |
|------------|----------|:---:|
| Bilibili API (视频/AI热点) | 实测 — 3/5 端点可用 | ✅ |
| YouTube Data API | 文档验证 — 免费配额确认 | ✅ |
| X API | 文档验证 — 免费层确认 (限制较多) | ⚠️ |
| 网页抓取 (国内/Google) | 实测 — 3/5 网站可抓取 | ✅ |
| 网页抓取 (海外受保护) | 手动整理替代方案 | ✅ |
| **综合** | **≥ 4/5 数据源类别有可行路径** | **✅ C1 通过** |

### C3: ToS 审查

| 检查项 | 状态 |
|--------|:---:|
| 8 个主要数据源 ToS 已审查 | ✅ |
| 0 个高风险源 | ✅ |
| 无"明确禁止"条款 | ✅ |
| 中风险源均有降级方案 (手动整理 + 注明来源) | ✅ |
| **综合** | **✅ C3 通过** |

---

## 五、对策略的影响

1. **Bilibili**: 可作为 AI 视频内容的主要数据源。需维护浏览器级请求头。搜索 + 热门 + 详情三个接口组合使用已足够。

2. **网页抓取**: 国内工具（DeepSeek、通义、Kimi、文心一言等）可直接抓取。海外工具（OpenAI、Claude、Gemini 网页版）更适合手动整理，或者只使用其官方公开 API 文档。

3. **X/YouTube API**: 需要申请 API Key（W1 即可完成），免费配额对 MVP 阶段的低频采集（每天几次）完全够用。

4. **采集策略确认**: "API 优先 + 手动补充 + 注明来源"的策略可行，与可行性报告第 9.3 节的建议一致。

---

## 六、Cloudflare 方案专项评估（历史 PoC，当前不采用）

> 本节最初针对 OpenAI/Claude 网站的Cloudflare 403编写，属于历史可行性材料。它没有验证 `rsshub.app` 或B站路由，也不构成 InfoCatcher 当前的自动采集批准。当前项目不使用 FlareSolverr、cloudscraper、Playwright + Stealth、代理、Cookie复用或验证码处理来绕过第三方访问保护。

### 6.1 方案汇总

| 方案 | 类型 | 费用 | 可靠性 | 复杂度 | 本项目推荐 |
|------|------|:---:|:---:|:---:|:---:|
| **FlareSolverr** | 历史候选；当前不采用 | 需Docker和浏览器，可能处理部分挑战，但不等于适用于RSSHub/B站 |
| **cloudscraper** | 历史候选；当前不采用 | 对现代挑战不稳定，仍属于规避访问保护 |
| **Playwright + Stealth** | 历史候选；当前不采用 | 资源成本高，且涉及自动化反检测 |
| Bright Data Web Unlocker | 付费 API 代理 | $0.75/1K 请求 | ⭐⭐⭐⭐⭐ | 极低 | ❌ 超预算 |
| ScraperAPI | 付费 API | $49/月起 | ⭐⭐⭐ | 极低 | ❌ 超预算 |
| Capsolver | 付费 CAPTCHA 解算 | 按次计费 | ⭐⭐⭐⭐ | 低 | ❌ 超预算 |

### 6.2 详细分析

#### 方案 A：FlareSolverr（历史候选，不实施）

**原理**：在本地运行一个代理服务器 (localhost:8191)，内置真实 Chromium 浏览器 + undetected-chromedriver。你发送 URL 给它 → 它用浏览器打开页面 → 等待 Cloudflare 挑战自动通过 → 返回 HTML 和 cf_clearance cookie。

**安装**（一行命令）：
```bash
docker run -d --name=flaresolverr -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
```

**Python 调用**：
```python
import requests

# 不再直接请求目标网站，而是通过 FlareSolverr 代理
resp = requests.post("http://localhost:8191/v1", json={
    "cmd": "request.get",
    "url": "https://claude.ai",
    "maxTimeout": 60000
})
html = resp.json()["solution"]["response"]
# 同时获得 cf_clearance cookie，后续可复用
cookies = resp.json()["solution"]["cookies"]
```

**优势**：
- 完全免费、开源 (MIT, 14.7K GitHub Stars)
- 活跃维护（最新版 v3.5.0, 2026年5月）
- 一次配置，所有 Cloudflare 网站通用
- 返回的 cookies 可复用于后续请求（避免每次都开浏览器）

**劣势**：
- 需要 Docker 环境（Windows 需安装 Docker Desktop）
- 每个并发请求占用 ~500MB 内存（Chromium 实例）
- 请求延迟较高（5-15 秒，浏览器加载时间）
- **无法处理交互式 CAPTCHA**（需要点击"我不是机器人"的验证码）。Cloudflare 从 2025 年起有逐步升级挑战难度的趋势

**本项目适用性**：⭐⭐⭐⭐⭐ — 低频采集场景完美匹配。每天几十次请求时，Docker 资源消耗可忽略。如果触发 CAPTCHA（概率较低），可切换手动方式。

#### 方案 B：cloudscraper（历史候选，不实施）

**原理**：纯 Python 库，模拟浏览器 JS 引擎来通过 Cloudflare 的 JS 挑战。不需要 Docker，不需要真实浏览器。

**安装**：
```bash
pip install cloudscraper
```

**使用**：
```python
import cloudscraper
scraper = cloudscraper.create_scraper()
resp = scraper.get("https://claude.ai")
print(resp.text)
```

**优势**：
- 极简，pip install 即用
- 无需 Docker 或浏览器，资源消耗极低
- 响应快（无浏览器加载时间）

**劣势**：
- 可靠性明显低于 FlareSolverr（6.6K Stars vs 14.7K）
- Cloudflare 更新检测算法后，cloudscraper 通常需要数天到数周才能跟上
- 对较新的 Cloudflare 检测技术（Turnstile、更复杂的 JS 挑战）无力应对

**本项目适用性**：⭐⭐⭐ — 适合作为轻量备选。当目标网站 Cloudflare 配置较为宽松时使用；遇到失败则降级到 FlareSolverr。

#### 方案 C：Playwright + puppeteer-extra-stealth（历史候选，不实施）

**原理**：直接使用无头浏览器 + 反检测插件，最逼真地模拟人类用户。

**安装**：
```bash
pip install playwright
playwright install chromium
```

**使用**（配合反检测）：
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...",
        viewport={"width": 1920, "height": 1080},
    )
    page = context.new_page()
    page.goto("https://claude.ai", wait_until="networkidle")
    html = page.content()
    browser.close()
```

**优势**：
- 可靠性最高 — 真实浏览器指纹
- 不依赖第三方服务
- 可配合 playwright-stealth 插件进一步隐藏自动化特征

**劣势**：
- 资源消耗大（每个实例 ~500MB-1GB 内存）
- 需要额外编写反检测逻辑（User-Agent、viewport、WebGL、时区、语言等）
- 部署复杂度高于 FlareSolverr
- 不适合高并发（本项目不需要高并发）

**本项目适用性**：⭐⭐⭐⭐ — 作为 FlareSolverr 失败时的最终后备方案。当目标网站使用特别激进的 Cloudflare 配置时启用。

### 6.3 历史组合策略（当前不实施）

```
目标网站 → cloudscraper (轻量快速尝试)
              │
              ├─ 成功 → 返回 HTML
              │
              └─ 失败 → FlareSolverr (浏览器级绕过)
                            │
                            ├─ 成功 → 返回 HTML + cookies
                            │
                            └─ 触发 CAPTCHA → Playwright (最终手段)
                                                  │
                                                  └─ 仍失败 → 手动整理
```

**历史评估结论，不代表当前批准方案**：早期报告曾建议对受保护站点使用FlareSolverr；该建议仅针对当时的OpenAI/Claude抓取测试，未验证RSSHub/B站，也不适用于当前InfoCatcher边界。

### 6.4 对验证结论的当前修正

当前项目不把Cloudflare绕过方案接入B站或RSSHub；B站默认改为人工精选，显式诊断只做一次Provider探测并快速熔断。

---

## 七、待办

- [ ] 申请 YouTube Data API Key (console.cloud.google.com)
- [ ] 申请 X API Key (developer.x.com) — 可选, 免费层限制较大，MVP 阶段可暂缓
- [ ] 确认 Bilibili wbi 签名是否需要 (当前测试显示主搜索可无签名工作)
- [ ] MVP 阶段编写数据采集脚本 (W3)
