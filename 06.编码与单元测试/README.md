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
| `mvp/data/glossary.json` | 40 条 AI 概念术语 |

## 部署前必做

- ⚠️ `mvp/` 中索引/贡献反馈链接含 `YOUR_USERNAME` 占位符，部署前需替换为实际 GitHub 用户名。
- 建议先以本地静态服务器测试（`python -m http.server`）再部署 GitHub Pages。
- GitHub Pages 需在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。

## 待办（来自开发计划环 B 冲刺）

- [X] B01 内容扩充：25 → 43 个工具（补国产工具：文心一言/讯飞星火/腾讯混元/天工/百川/海螺 + 国际工具：Grok/Poe/DALL·E 3/Leonardo/HeyGen/NotebookLM/Bolt.new/v0/Udio/Ideogram/Replit/Julius）
- [X] B02 数据校对：全部 43 个工具的免费层/价格信息已更新至 2026-07-21
- [X] B03 对比模式维度扩充：新增"不适合/限制"对比维度
- [ ] B04 GitHub Pages 部署：CI/CD 已配置（`.github/workflows/deploy.yml`），待 push 后触发
- [ ] B05 申请 YouTube/X API Key（为后续 B14 AI 热点聚合做准备）
- [ ] B08 AI 概念词典开发：40 条术语/6 分类/可搜索展开

> 单元测试策略待进入方案 3（含 Serverless 函数）后补；静态站阶段以浏览器端手测 + 内部自测为主。