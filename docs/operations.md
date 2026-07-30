# 运维操作

> 环境变量、CLI、测试、构建、CI、部署和维护流程。

## 环境变量

| 变量 | 使用方 | 说明 |
|---|---|---|
| `YOUTUBE_API_KEY` | `src/news/collectors/news-youtube.js` | YouTube Data API v3 |
| `X_API_KEY` | `src/news/pipeline/build-news.js` | TwitterAPI.io |
| `NEWS_PLATFORM_SCOPE` | `scripts/build-news.js` | 采集范围：`all`（默认）或 `bilibili-only`（诊断） |

所有密钥通过 GitHub Repository Secrets 注入，不出现在代码、JSON 或浏览器中。

## 验证命令

```bash
node scripts/validate.js                                         # 静态数据校验
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js  # 43 项单元测试
node scripts/build-news.js --fixture                              # 本地样本构建（不请求 API）
node src/acquisition/validate-intel.js                            # 工具情报校验
```

## 本地运行

静态站无需构建工具或后端服务：

```bash
python -m http.server 8000
# 或
npx serve .
```

浏览器打开 `http://localhost:8000`。

## 热点管理 CLI

```bash
node scripts/news-cli.js source add ...                          # 添加单条来源
node scripts/news-cli.js source import --file sources.json --dry-run  # 批量预检
node scripts/news-cli.js authorization list                      # 查看待授权任务
node scripts/news-cli.js lock status                             # 查看构建锁状态
node scripts/news-cli.js lock force-unlock --reason "..."        # 强制解锁（需理由）
```

不接受通过 CLI 参数传入 API Key。

### B站人工内容管理

```bash
node scripts/news-cli.js content add ...                         # 添加单条人工内容
node scripts/news-cli.js content import --file ...               # 批量导入
node scripts/news-cli.js content list                            # 列出人工内容
```

## 工具情报采集

```bash
node src/acquisition/fetch-tool-intel.js --tool deepseek --dry-run  # 单工具试运行
node src/acquisition/fetch-tool-intel.js                            # 采集全部来源
node src/acquisition/validate-intel.js                              # 校验输出
```

注意：`--tool` 参数后跟空格分隔的工具名（`--tool deepseek`），不是 `--tool=deepseek`。

## CI 工作流

| 工作流 | 触发 | 写入 | 并发 |
|---|---|---|---|
| `collect-news.yml` | 每 3 天 UTC 2:00 / 手动 (`workflow_dispatch`) | `data/news/output/`、`data/news/runtime/`、`public/feed.xml` | concurrency 防止同类并行 |
| `deploy.yml` | push main / 手动 | 只读；构建 `dist/` 后部署 GitHub Pages | — |
| `refresh-tool-intel.yml` | 每周日 UTC 6:37 / 手动（可指定单工具） | `data/catalog/tool-intelligence.json` | — |

### 构建产物

`deploy.yml` 运行 `node scripts/build-dist.js`，将 `src/web`、`public` 和浏览器所需 `data` 复制到 `dist/`，上传为 Pages artifact。

## 采集能力与边界

### 当前自动采集

- YouTube：通过 Data API v3 获取 uploads playlist，按时间层分页回溯
- X：通过 TwitterAPI.io 按来源轮转采集

### 当前人工处理

- Bilibili：默认采用人工精选（`data/news/manual/news-manual-items.json`），再进入统一处理管线。显式 `bilibili-only` 诊断可探测 RSSHub，但遇到 Cloudflare 后快速熔断
- 工具情报 L3：采集引擎无法提取数据时记录日志、跳过合并、保留旧数据；由维护者后续处理

### 当前不支持的

- B站内部 API、逆向 SDK 或绕过平台风控
- 运行时数据库、Serverless 采集、实时推送
- AI 自动事实裁决或商单定性
- 浏览器自动化测试、Pages 线上冒烟测试、可访问性/性能自动验证

## 维护流程

### 三层更新流水线

```
用户提交（GitHub Issue 模板）→ 人工审核 → 合并入库
```

当前使用 GitHub Issue 模板（`.github/ISSUE_TEMPLATE/data-correction.yml`、`new-tool.yml`）接收纠错和新工具推荐，由维护者人工审核后合并。Issue 模板中的仓库链接含 `wozore` 占位符，首次部署前需替换为实际用户名。

AI 初审和自动合并为 v1.0+ 计划能力，当前仓库 workflow 中不存在对应实现。

### 四类维护活动

| 类型 | 说明 | 对应工作 |
|---|---|---|
| 改正性 | 修正错误信息 | 数据纠错（CONTRIBUTING + Issue 模板） |
| 适应性 | 适配环境变化 | 网站改版适配、API 变更适配 |
| 完善性 | 新增/增强功能 | 见 `开发计划.md` |
| 预防性 | 防患于未然 | ToS 监控、时效提示 |

## 已知测试缺口

- 43 项单元测试均属于新闻管线；工具情报采集（`fetch-tool-intel.js`）缺少独立自动化测试
- 无浏览器自动化测试、Pages 线上冒烟测试、可访问性或性能自动验证
- 真实平台连续采集、跨日 Actions 运行和 Registry 恢复尚未验证
