# W1 技术验证报告（历史 PoC）

> **日期**：2026-07-18
> **验证项**：C1 信息采集 PoC、C3 ToS 初查。端点状态、配额和法律判断仅代表当日快照，不是当前批准方案或法律意见。

## 实测结果

### Bilibili 内部端点

| 端点 | 当日结果 |
|---|---|
| 搜索 `/x/web-interface/wbi/search/all/v2` | HTTP 200，返回 12 条 |
| 视频详情 `/x/web-interface/view` | HTTP 200，返回元数据 |
| 推荐 `/x/web-interface/index/top/feed/rcmd` | HTTP 200，返回 20 条 |
| 搜索建议 | 间歇超时 |
| 分区列表 | HTTP 200 但 `data=null` |

当时 3/5 端点可用，且缺少浏览器请求头会触发 412。该结果后来被合规与维护边界覆盖：当前项目不使用 B站内部 API、逆向 SDK、Cookie 自动化或风控绕过，B站改为人工精选。

### 官网页面

| 目标 | 当日 HTTP | 结论 |
|---|:---:|---|
| DeepSeek、通义、Google AI Studio | 200 | 可提取公开页面元数据 |
| OpenAI、Claude | 403 | 由 WAF/Cloudflare 阻止自动访问 |

对受保护站点采用人工整理和精确来源链接，不将绕过访问保护作为采集方案。

## ToS 初查

当时审阅了 Bilibili、YouTube、X、DeepSeek、通义、OpenAI、Anthropic 和 Google AI Studio，得出“0 个高风险、3 个中风险，可通过人工整理降级”的初步判断。该结论没有正式法务审查，且后来对 B站内部 API 的风险判断已改变；任何自动采集都须按当前 ToS、接口政策和实现方式重新评估。

## C1 / C3 历史判定

- **C1 通过**：当时至少 4/5 数据源类别存在自动或人工路径。
- **C3 条件性通过**：未发现无法降级的高风险来源，但依赖持续合规复核。
- 形成的有效原则：官方/API 优先，受阻时人工补充，保存来源和查询时间。

## Cloudflare 候选方案（已否决）

早期曾评估 FlareSolverr、cloudscraper、Playwright + Stealth、付费代理和 CAPTCHA 服务。它们的共同问题是规避访问保护、资源/费用高、稳定性随防护变化，且无法证明适用于 RSSHub/B站。

历史命令仅用于审计当时评估对象，不代表可执行建议：

```bash
docker run -d --name=flaresolverr -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
pip install cloudscraper
pip install playwright
playwright install chromium
```

当前禁止将这些方案用于绕过第三方访问保护；失败时应跳过、保留旧数据或人工整理。

## 对当前策略仍有效的影响

1. 平台端点和网页可访问性是时间敏感证据，不能一次验证后永久视为可用。
2. 自动采集应有人工降级路径，失败不得覆盖旧数据。
3. API Key、配额、端点和 ToS 必须在实际接入时复核。
4. B站历史端点测试保留为证据，但不构成当前实施许可。
