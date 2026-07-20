# 编码与单元测试

## ⑥ 编码和单元测试 —— 写出程序

> **环归属**：环 B（MVP 交付）— 当前主力，每轮冲刺产出可用增量。

本目录存放 InfoCatcher 的源代码与单元测试工件。

## 当前产物

| 路径 | 说明 |
|------|------|
| `mvp/` | MVP v0.1 静态站骨架（HTML/CSS/JS + JSON） |
| `mvp/index.html` | 4 视图入口 |
| `mvp/css/style.css` | 样式（CSS 变量 + 响应式） |
| `mvp/js/app.js` | 搜索/筛选/对比/模态/场景导航 |
| `mvp/data/tools.json` | 25 个 AI 工具数据 |

## 部署前必做

- ⚠️ `mvp/` 中索引/贡献反馈链接含 `YOUR_USERNAME` 占位符，部署前需替换为实际 GitHub 用户名。
- 建议先以本地静态服务器测试（`python -m http.server`）再部署 GitHub Pages。

## 待办（来自开发计划环 B 冲刺）

- [ ] B01 内容扩充：25 → 40 个工具（补国产工具）
- [ ] B02 数据校对：价格/免费额度等高频变化信息
- [ ] B03 对比模式维度扩充
- [ ] B04 GitHub Pages 部署
- [ ] B05 申请 YouTube/X API Key
- [ ] B08 AI 概念词典开发

> 单元测试策略待进入方案 3（含 Serverless 函数）后补；静态站阶段以浏览器端手测 + 内部自测为主。