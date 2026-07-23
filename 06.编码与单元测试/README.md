# 编码与单元测试

## ⑥ 编码和单元测试 —— 写出程序

> **环归属**：环 B（MVP 交付）— 当前主力，每轮冲刺产出可用增量。

本目录存放 InfoCatcher 的源代码与单元测试工件。

## 当前产物

| 路径 | 说明 |
|------|------|
| `mvp/` | MVP v0.2 静态站骨架（HTML/CSS/JS + JSON） |
| `mvp/index.html` | 6 视图入口（工具库/场景导航/对比/AI热点/概念词典/关于） |
| `mvp/css/style.css` | 样式（CSS 变量 + 响应式 + 热点/概念词典卡片） |
| `mvp/js/app.js` | 搜索/筛选/对比/场景/热点/概念词典前端逻辑 |
| `mvp/data/tools.json` | 43 个 AI 工具数据 |
| `mvp/data/glossary.json` | 43 条 AI 概念术语 |
| `mvp/data/news-sources.json` | 96 个初始热点来源（YouTube 45 / B站 20 / X 31） |
| `mvp/data/news-config.json` | 热点评分、五层时间窗口、成本和异常配置 |
| `mvp/data/news-registry.json` | 持久视频发现/处理状态与批量防重索引 |
| `mvp/data/news-quota.json` | YouTube quota units 与 B站 RSSHub 请求账本 |
| `mvp/data/pending-authorizations.json` | 超出默认回溯边界的待授权任务 |
| `mvp/data/hotspots.json` | 构建时生成的内容、主题、溯源、评分和覆盖状态 |
| `mvp/scripts/build-news.js` | 三平台构建时采集、标准化、主题/溯源和评分编排 |
| `mvp/scripts/news-registry.js` | 视频 Registry、状态机和 Map 防重 |
| `mvp/scripts/news-quota.js` | 平台独立额度预留、消费和审计 |
| `mvp/scripts/news-scheduler.js` | 五层 UTC 边界与时间层优先推进 |
| `mvp/scripts/news-youtube.js` | uploads playlist 分页与批量详情适配器 |
| `mvp/scripts/news-bilibili.js` | RSSHub 可见历史归层与能力降级 |
| `mvp/scripts/news-cli.js` | 来源、授权、额度和构建锁管理入口 |
| `mvp/scripts/news-tests.test.js` | 既有采集、规则、动态、降级与异常测试 |
| `mvp/scripts/news-foundation.test.js` | Registry、额度、调度、平台回溯和 CLI 测试 |
| `mvp/scripts/validate.js` | 部署前数据与引用完整性校验（CI 自动触发） |
| `mvp/README.md` | MVP 使用说明（面向用户） |
| `mvp模块.md` | MVP 架构文档（模块划分 + 扩展点说明） |
| `mvp架构图.drawio` | MVP 架构关系图 |

## 部署

- ✅ MVP 已部署至 GitHub Pages：<https://wozore.github.io/InfoCatcher/>
- 独立仓库：[github.com/wozore/InfoCatcher](https://github.com/wozore/InfoCatcher)（公开）
- 工程仓库 `InfoCatcher-Engineering` 仅追踪 `mvp/.git/` 之外的文件，两个仓库独立管理
- CI/CD：push main → validate（数据校验）→ deploy（GitHub Pages），全部通过绿勾

## 待办（来自开发计划环 B 冲刺）

- [X] B01 内容扩充：25 → 43 个工具（补国产工具：文心一言/讯飞星火/腾讯混元/天工/百川/海螺 + 国际工具：Grok/Poe/DALL·E 3/Leonardo/HeyGen/NotebookLM/Bolt.new/v0/Udio/Ideogram/Replit/Julius）
- [X] B02 数据校对：全部 43 个工具的免费层/价格信息已更新至 2026-07-21
- [X] B03 对比模式维度扩充：新增"不适合/限制"对比维度
- [X] B04 GitHub Pages 部署：CI/CD 已配置，站点已上线 → <https://wozore.github.io/InfoCatcher/>
- [X] B05 申请 YouTube/X API Key + B站/知乎数据方案调研：三平台实施方案 + 知乎暂缓评估文档完成（见 `02.可行性研究/06-09`）
- [X] B08 AI 概念词典开发：43 条术语/6 分类/可搜索展开
- [ ] B14 AI 热点聚合：规则评分、静态视图、持久 Registry、五层调度、平台额度、受控历史适配器、授权/来源 CLI 和 37 项测试已实现；待真实 Actions 小规模采集、历史游标连续运行及线上确认

## B14 验证命令

```bash
cd mvp
node scripts/sync-news-sources.js
node scripts/validate.js
node --test scripts/news-tests.test.js scripts/news-foundation.test.js
node scripts/build-news.js --fixture
```

真实采集由 `.github/workflows/collect-news.yml` 每日一次执行。GitHub Secrets 注入 `YOUTUBE_API_KEY` / `X_API_KEY`，浏览器不接触凭据。X 当前按每日最多 15 个来源轮转以控制约 300 条/日；B站动态与视频、专栏同为热点内容来源，动态失败会显式降级。

> 静态站阶段继续使用浏览器冒烟测试；B14 的确定性数据规则使用 Node 内置单元测试，不引入 npm 依赖。