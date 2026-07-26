# 编码与单元测试

## ⑥ 编码和单元测试 —— 写出程序

> **环归属**：环 B（MVP 交付）— 当前主力，每轮冲刺产出可用增量。

本目录存放 InfoCatcher 的源代码与单元测试工件。

## 当前产物

| 路径 | 说明 |
|------|------|
| `mvp/` | MVP v0.4 静态站 + GitHub Actions 构建时热点管线（HTML/CSS/JS + Node.js + JSON） |
| `mvp/index.html` | 6 视图入口（工具库/场景导航/对比/AI热点/概念词典/关于） |
| `mvp/css/style.css` | 样式（CSS 变量 + 响应式 + 热点/概念词典卡片） |
| `mvp/js/app.js` | 搜索/筛选/对比/场景/热点/概念词典前端逻辑 |
| `mvp/data/tools.json` | 43 个 AI 工具数据 |
| `mvp/data/glossary.json` | 43 条 AI 概念术语 |
| `mvp/data/news-sources.json` | 96 个初始热点来源（YouTube 45 / B站 20 / X 31） |
| `mvp/data/news-config.json` | 热点评分、五层时间窗口、成本和异常配置 |
| `mvp/data/news-state.json` | 构建批次、来源覆盖、时间层状态和恢复游标 |
| `mvp/data/news-registry.json` | 持久视频发现/处理状态与批量防重索引 |
| `mvp/data/news-quota.json` | YouTube quota units 账本；B站请求仅在显式诊断时记录 |
| `mvp/data/pending-authorizations.json` | 超出默认回溯边界的待授权任务 |
| `mvp/data/news-manual-items.json` | B站人工精选暂存（不自动访问B站） |
| `mvp/scripts/news-manual.js` | B站人工内容链接、类型、日期和来源校验 |
| `mvp/scripts/build-news.js` | YouTube/X 构建时采集、B站人工暂存消费、标准化、主题/溯源和评分编排 |
| `mvp/scripts/news-storage.js` | JSON 原子写、构建锁和强制解锁审计 |
| `mvp/scripts/news-registry.js` | 视频 Registry、状态机和 Map 防重 |
| `mvp/scripts/news-quota.js` | 平台独立额度预留、消费和审计 |
| `mvp/scripts/news-scheduler.js` | 五层 UTC 边界与时间层优先推进 |
| `mvp/scripts/news-youtube.js` | uploads playlist 分页与批量详情适配器 |
| `mvp/scripts/news-bilibili.js` | B站历史适配器（当前默认暂停） |
| `mvp/scripts/news-authorization.js` | 待授权回溯任务和决策边界 |
| `mvp/scripts/news-cli.js` | 来源、B站人工内容、授权、额度和构建锁管理入口 |
| `mvp/scripts/news-tests.test.js` | 既有采集、规则、动态、降级与异常测试 |
| `mvp/scripts/news-foundation.test.js` | Registry、额度、调度、平台回溯和 CLI 测试 |
| `mvp/scripts/validate.js` | 部署前数据与引用完整性校验（CI 自动触发） |
| `mvp/README.md` | MVP 使用说明（面向用户） |
| `mvp模块.md` | MVP 架构文档（模块划分 + 扩展点说明） |
| `mvp架构图.drawio` | MVP 架构关系图 |

## 部署

- 既有 GitHub Pages 静态站已经部署：<https://wozore.github.io/InfoCatcher/>；B14 真实热点采集和线上热点内容仍待单独验证
- 独立仓库：[github.com/wozore/InfoCatcher](https://github.com/wozore/InfoCatcher)（公开）
- 工程仓库 `InfoCatcher-Engineering` 与 `mvp/` 独立仓库分别维护生命周期文档和站点代码
- 既有 Pages workflow 已建立；B14 的 `collect-news.yml` 需通过真实 Secrets 手动触发后补充 Run 证据

## 待办（来自开发计划环 B 冲刺）

- [X] B01 内容扩充：25 → 43 个工具（补国产工具：文心一言/讯飞星火/腾讯混元/天工/百川/海螺 + 国际工具：Grok/Poe/DALL·E 3/Leonardo/HeyGen/NotebookLM/Bolt.new/v0/Udio/Ideogram/Replit/Julius）
- [X] B02 数据校对：全部 43 个工具的免费层/价格信息已更新至 2026-07-21
- [X] B03 对比模式维度扩充：新增"不适合/限制"对比维度
- [X] B04 GitHub Pages 部署：CI/CD 已配置，站点已上线 → <https://wozore.github.io/InfoCatcher/>
- [X] B05 申请 YouTube/X API Key + B站/知乎数据方案调研：三平台实施方案 + 知乎暂缓评估文档完成（见 `02.可行性研究/06-09`）
- [X] B08 AI 概念词典开发：43 条术语/6 分类/可搜索展开
- [x] B14 AI 热点聚合：YouTube/X自动采集、B站人工精选、规则评分、静态视图、持久 Registry、五层调度、额度和CLI已实现；43项本地测试通过；待提交后进行一次默认 `all` Actions 和线上页面复验。

## B14 验证命令

```bash
cd mvp
node scripts/sync-news-sources.js
node scripts/validate.js
node --test scripts/news-tests.test.js scripts/news-foundation.test.js
node scripts/build-news.js --fixture
```

真实采集由 `.github/workflows/collect-news.yml` 每日一次执行。GitHub Secrets 注入 `YOUTUBE_API_KEY` / `X_API_KEY`，浏览器不接触凭据。X 当前按每日最多 15 个来源轮转以控制约 300 条/日；B站默认不访问网络，人工精选条目与其他内容统一处理；`bilibili-only` 仅用于一次Provider诊断和快速熔断。

> 静态站阶段继续使用浏览器冒烟测试；B14 的确定性数据规则使用 Node 内置单元测试，不引入 npm 依赖。