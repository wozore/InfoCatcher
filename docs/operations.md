# 运维操作

> 环境变量、验证、CLI、CI、部署和恢复操作。平台来源策略见 [采集文档](acquisition.md)。

## 凭据与环境变量

| 变量 | 使用方 | 说明 |
|---|---|---|
| `YOUTUBE_API_KEY` | `src/news/collectors/news-youtube.js` | YouTube Data API v3 |
| `X_API_KEY` | `src/news/pipeline/build-news.js` | TwitterAPI.io |
| `NEWS_PLATFORM_SCOPE` | `scripts/build-news.js` | `all`（默认）或 `bilibili-only`（诊断） |

密钥仅通过 GitHub Repository Secrets 注入，不进入代码、JSON、浏览器或 CLI 参数。

## 验证与本地运行

```bash
node scripts/validate.js
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js
node scripts/build-news.js --fixture
node src/acquisition/validate-intel.js
```

Fixture 构建不请求 API，也不写持久状态。启动静态站：

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

## CLI 速查

### 热点和人工内容

```bash
node scripts/news-cli.js source add ...
node scripts/news-cli.js source import --file sources.json --dry-run
node scripts/news-cli.js content add ...
node scripts/news-cli.js content import --file ...
node scripts/news-cli.js content list
node scripts/news-cli.js authorization list
node scripts/news-cli.js lock status
node scripts/news-cli.js lock force-unlock --reason "..."
```

批量来源先使用 `--dry-run`。不得直接编辑或删除 `.news-build.lock`；仅在确认原任务已终止后，才能通过 CLI 带理由强制解锁，操作会写入审计。

### 工具情报

```bash
node src/acquisition/fetch-tool-intel.js --tool deepseek --dry-run
node src/acquisition/fetch-tool-intel.js
node src/acquisition/validate-intel.js
```

`--tool` 使用空格分隔（`--tool deepseek`），不支持 `--tool=deepseek`。

## CI、构建与部署

| 工作流 | 触发 | 写入/产物 |
|---|---|---|
| `collect-news.yml` | 每 3 天 UTC 02:00 / 手动；同类任务受 concurrency 限制 | `data/news/output/`、`data/news/runtime/`、`public/feed.xml` |
| `refresh-tool-intel.yml` | 每周日 UTC 06:37 / 手动，可指定工具 | `data/catalog/tool-intelligence.json` |
| `deploy.yml` | push `main` / 手动 | 构建并部署 `dist/` |

`deploy.yml` 运行 `node scripts/build-dist.js`，将 `src/web`、`public` 和浏览器所需 `data` 复制到 `dist/`，再上传 Pages artifact。

## 失败与禁止操作

- 工具情报解析失败时记录日志、跳过合并并保留旧数据，当前不会写入 `acquisition_failed` 或自动通知维护者。
- 热点构建失败不得以空结果覆盖上一版有效投影。
- B站默认读取人工精选；`bilibili-only` 仅用于诊断，遇到 Cloudflare 后快速熔断。
- 禁止使用 B站内部 API、逆向 SDK 或绕过平台风控。
- 当前无运行时数据库/Serverless 采集、实时推送或 AI 自动事实裁决。

## 数据维护

```text
用户提交（GitHub Issue）→ 人工审核 → 合并或驳回并说明理由
```

纠错和新工具推荐通过 `.github/ISSUE_TEMPLATE/data-correction.yml` 与 `new-tool.yml` 接收。当前没有 AI 初审或自动合并工作流。详细提交规则见 [贡献指南](../CONTRIBUTING.md)，未来完善项见 [开发计划](../开发计划.md)。

## 已知验证缺口

- 工具情报采集缺少独立自动化测试；现有 43 项单元测试均属于热点管线。
- 没有浏览器自动化、Pages 线上冒烟、可访问性或性能自动验证。
- 真实平台连续采集、跨日 Actions 和 Registry 恢复尚未验证。
