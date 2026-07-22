# 编码与单元测试

## ⑥ 编码和单元测试 —— 写出程序

> **环归属**：环 B（MVP 交付）— 当前主力，每轮冲刺产出可用增量。

本目录存放 InfoCatcher 的源代码与单元测试工件。

## 当前产物

| 路径 | 说明 |
|------|------|
| `mvp/` | MVP v0.2 静态站骨架（HTML/CSS/JS + JSON） |
| `mvp/index.html` | 5 视图入口（工具库/场景导航/对比/概念词典/关于） |
| `mvp/css/style.css` | 样式（CSS 变量 + 响应式 + 概念词典卡片） |
| `mvp/js/app.js` | 搜索/筛选/对比/模态/场景导航/概念词典 |
| `mvp/data/tools.json` | 43 个 AI 工具数据 |
| `mvp/data/glossary.json` | 43 条 AI 概念术语 |
| `mvp/scripts/validate.js` | 部署前数据校验（CI 自动触发） |
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
- [X] B05 申请 YouTube/X API Key + B站/知乎数据方案调研：YouTube 官方 + Supadata Free + TwitterAPI.io 三平台 API Key 已申请；四平台数据获取方案文档已完成（见 `02.可行性研究/06-09`）
- [X] B08 AI 概念词典开发：43 条术语/6 分类/可搜索展开
- [ ] B14 AI 热点聚合：四平台数据方案已就位，待开发

> 单元测试策略待进入方案 3（含 Serverless 函数）后补；静态站阶段以浏览器端手测 + 内部自测为主。