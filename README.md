# InfoCatcher

开源、免费且不接受厂商赞助的中文 AI 工具信息聚合与场景化对比平台。当前进度见 [开发计划](开发计划.md)。

## 快速开始

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

项目使用原生 HTML/CSS/JS、Node.js 20 和静态 JSON，无 npm 依赖或运行时后端。页面通过 `fetch` 读取数据，因此应使用 HTTP 服务访问。

## 验证

```bash
node scripts/validate.js
node --test tests/news/news-tests.test.js tests/news/news-foundation.test.js
node scripts/build-news.js --fixture
```

## 部署

- GitHub Pages：<https://wozore.github.io/InfoCatcher/>
- `main` 分支推送后自动部署静态站
- 热点每 3 天 UTC 02:00 采集；工具情报每周日 UTC 06:37 更新

具体命令、CI 和故障处理见 [运维操作](docs/operations.md)。

## 文档导航

| 主题 | 文档 |
|---|---|
| 贡献方式与数据规范 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 当前架构、模块和数据流 | [docs/architecture.md](docs/architecture.md) |
| 需求、范围和验收状态 | [docs/requirements.md](docs/requirements.md) |
| 热点内容质量标准 | [docs/content-quality.md](docs/content-quality.md) |
| 架构决策及理由 | [docs/decisions.md](docs/decisions.md) |
| 环境变量、CLI、CI 和部署 | [docs/operations.md](docs/operations.md) |
| 工具情报与热点采集边界 | [docs/acquisition.md](docs/acquisition.md) |
| 已发生的工作 | [开发日志.md](开发日志.md) |
| 未来任务 | [开发计划.md](开发计划.md) |
| 历史研究与阶段材料 | [docs/archive/index.md](docs/archive/index.md) |

项目目录及职责以 [架构文档](docs/architecture.md#目录与模块边界) 为准。
