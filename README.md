# 知览 | KnowView

> AI 世界太快，我们替你看明白。

知览（KnowView）是一个开源、免费的 AI 信息编辑部，面向中文用户整理 AI 热点、工具、模型、概念与场景资料，提供浏览、解释和比较入口。项目不接受厂商赞助、付费排名或影响事实呈现的商业置换。

## 快速开始

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000/dist/
```

项目使用原生 HTML/CSS/JS、Node.js 20 和静态 JSON，无 npm 依赖或运行时后端。页面通过 `fetch` 读取数据，因此应使用 HTTP 服务访问。改动 `src/` 或 `data/` 后需运行构建脚本，再刷新页面：

```bash
node scripts/build-dist.js
```

## 验证

```bash
node scripts/validate.js
node --test tests/
```

> 全量测试明确限定在 `tests/` 目录运行，避免 `node --test` 无路径时递归扫描仓库根部的本地符号链接（如 `.obsidian`）。

真实页面验收需要 Edge/CDP 配置，运行：

```bash
node scripts/browser-acceptance.js
```

## 产品边界

- 看热点：浏览经过整理的 AI 公开信息；
- 找工具：按类型和场景查阅工具、模型与套餐资料；
- 比模型：查看公开评测数据和比较口径；
- 懂概念：阅读 AI 术语解释；
- 看场景和编辑精选：从维护者整理的资料入口开始探索。

“编辑精选”和“场景资料”不是基于个人画像的自动推荐。知览不承诺个性化匹配、“最适合你”的自动结论、实时 AI 问答或任何收录对象的永久可用性。当前 AI 搜索入口仍包含静态演示，不代表已经接入实时 AI 搜索。

## 数据与内容

价格、访问条件、版本和日期会随地区、套餐、版本和时间变化。官方宣传、独立评测、公开数据和维护者整理会分别处理；比较分数不能单独代表所有真实场景下的绝对排名。详情见[编辑与数据政策](docs/manual/editorial-and-data-policy.md)。

## 部署与自动更新

- `main` 分支推送后由 GitHub Actions 构建并部署静态站；
- 热点采集由配置开关和 GitHub Actions 变量共同控制，默认关闭时不会请求外部 API；
- 热点、模型对比和工具更新管线各自失败隔离，并保留可审计的运行记录；
- 项目使用的环境变量只应存在于仓库根目录本地 `.env` 或 GitHub Actions Secrets/Variables，不能提交到仓库。

详细的维护者操作以当前仓库中的工作流和脚本为准。不要把 API Key、Cookie、密码、令牌或私有配置写入 Issue、Pull Request、数据文件或文档。

## 参与方式

- [贡献与内容上传规则](CONTRIBUTING.md)：数据、热点、代码和文档提交要求；
- [反馈与支持](SUPPORT.md)：普通用户反馈、Bug、收录线索和处理预期；
- [安全政策](SECURITY.md)：安全和隐私问题的私密报告方式；
- [行为准则](CODE_OF_CONDUCT.md)：参与项目讨论时的基本规则；
- [MIT 许可证](LICENSE)：代码和相关软件文件的许可条款。

知览处于 MVP 测试和公开筹备阶段。发现数据错误或页面问题时，请优先使用[反馈与支持](SUPPORT.md)，不要在公开内容中提交任何敏感信息。
