# InfoCatcher — AI工具场景化对比平台

发现、对比、选择最适合你的 AI 工具。公开评测方法论，完全开源免费。

**即刻访问**：[wozore.github.io/InfoCatcher](https://wozore.github.io/InfoCatcher)（部署后生效）

## 六大功能

### 工具库
浏览 **43 个 AI 工具**的完整信息——涵盖大语言模型、AI 编程、图像生成、视频制作、音频音乐、办公效率等分类。

- **搜索**：输入关键词（工具名、功能、甚至中文别名如"写代码"）即可搜索
- **筛选**：按分类、访问方式（国内/受限）、价格（免费/付费）三维叠加筛选
- **详情**：点击工具卡片查看完整评分、价格层级、优势/不足、最适合场景

### 场景导航
不知道该用哪个工具？选择你的使用场景，InfoCatcher 为你匹配合适的工具。

覆盖 12 个场景：写论文、编程开发、设计配图、视频制作、办公写作、数据分析等。

### 对比模式
选中 2-5 个工具，从 **10 个维度**横向对比：
综合评分、中文支持、易用性、性价比、免费层、付费层级、优势、不足、最适合、不适合/限制。

### AI 概念词典
43 条 AI 术语，6 大分类（模型架构、训练与微调、推理与部署、多模态、Agent、评估与基准）。每条术语说明其对 AI 工具选择的实际意义。

### AI 热点
每日构建时自动聚合 YouTube 和 X 的 AI 内容；B站视频、动态和专栏仍可进入热点，但当前通过人工精选录入。B站人工条目与其他平台进入同一评分、主题、溯源和前端投影管线。

历史发现采用五层 UTC 时间窗口；YouTube 使用 uploads playlist 受额度控制地回溯，B站当前不做自动历史回溯。浏览器只读取静态 JSON，不接触 API Key。

### 关于
了解 InfoCatcher 的评测方法论、数据来源和开源理念。

## 本地运行

```bash
# 克隆仓库
git clone https://github.com/wozore/InfoCatcher.git
cd InfoCatcher

# 启动本地服务器（任选其一）
python -m http.server 8000
# 或
npx serve .

# 浏览器打开 http://localhost:8000
```

## 数据校验

部署前自动校验数据完整性（GitHub Actions CI 自动触发），也可手动运行：

```bash
node scripts/validate.js
node --test scripts/news-tests.test.js scripts/news-foundation.test.js
node scripts/build-news.js --fixture
```

热点来源和授权管理使用零依赖 CLI：

```bash
node scripts/news-cli.js source add --platform youtube --external-id UC... --name "Example" --url https://www.youtube.com/@example --language en --tag 深度解读
node scripts/news-cli.js source import --file sources.json --dry-run
node scripts/news-cli.js authorization list
node scripts/news-cli.js lock status
```

真实采集所需 `YOUTUBE_API_KEY` 和 `X_API_KEY` 只能配置为 GitHub Repository Secrets，不得写入命令、JSON 或前端代码。

手动诊断 B站 RSSHub 时，在 GitHub Actions 的 `Collect AI News` → `Run workflow` 中将 `platform_scope` 选择为 `bilibili-only`。该模式不会请求 YouTube 或 X，也不会推进 X 轮转游标；检测到 RSSHub Provider 的 Cloudflare 挑战后只记录一次真实探测并立即熔断，不再遍历全部来源。定时任务和默认手动运行使用 `all`，其中B站自动网络采集已暂停，改为人工精选收录；已有 YouTube/X 与B站热点投影会按保留规则继续展示。

B站人工内容只写入独立的 `data/news-manual-items.json`，不会直接覆盖 `hotspots.json`。命令不访问B站网络，也不接受 Cookie、Token 或 API Key：

```bash
# 先预览，不写文件
node scripts/news-cli.js content add --source-id bilibili-123 --type bilibili_dynamic_text --url https://www.bilibili.com/opus/123456 --title "Claude AI 实测" --summary "实际使用 Claude 完成工作流" --published-at 2026-07-25T08:00:00Z --dry-run

# 确认后去掉 --dry-run 写入人工暂存
node scripts/news-cli.js content add --source-id bilibili-123 --type bilibili_video --url https://www.bilibili.com/video/BV1example --title "AI 模型发布" --summary "内容摘要" --published-at 2026-07-25T08:00:00Z

# 查看暂存内容，或原子批量导入
node scripts/news-cli.js content list
node scripts/news-cli.js content import --file manual-items.json --dry-run
```

允许的类型为 `bilibili_video`、`bilibili_dynamic_text`、`bilibili_dynamic_repost`、`bilibili_article`；`source-id` 必须对应已有B站来源。正常热点构建会复用 Registry 防重、AI过滤、评分、主题和溯源管线消费这些条目。

## 贡献

发现信息有误或有新工具推荐？

- **纠错**：[提交 Issue](https://github.com/wozore/InfoCatcher/issues/new?template=data-correction.yml)
- **推荐工具**：[提交 Issue](https://github.com/wozore/InfoCatcher/issues/new?template=new-tool.yml)
- **直接 PR**：修改 `data/tools.json` 或 `data/glossary.json` 后提交 Pull Request

## 技术栈

纯静态站（HTML + CSS + JS），无需构建工具、无需后端服务、无需数据库。部署于 GitHub Pages。

## 开源协议

MIT License
