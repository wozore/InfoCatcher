# InfoCatcher — AI 编码入口

> 本文件是 AI 编码工具理解项目的入口文档。记录架构决策、编码约定、目录结构和扩展点。

## 技术栈

- **前端**：纯原生 HTML + CSS + JS，零依赖、零构建工具
- **构建时脚本**：Node.js 20，零 npm 依赖
- **部署**：GitHub Pages + GitHub Actions
- **数据**：JSON 文件系统，分模块管理

## 目录结构（关键路径）

```
mvp/
├── index.html                  # 七视图 SPA 入口
├── feed.xml                    # AI 热点 RSS 订阅源（每日构建输出）
├── css/style.css               # 全局样式（CSS 变量体系，~826行）
├── js/app.js                   # 前端全部逻辑（~1660行）
├── data/
│   ├── catalog/                # 工具/术语/场景主数据（浏览器读）
│   │   ├── tools.json          # 45 个工具
│   │   ├── tool-intelligence.json  # 模型/套餐/价格核验数据
│   │   ├── glossary.json       # 43 条概念
│   │   ├── scenes.json         # 12 个场景
│   │   └── featured.json       # 15 条编辑精选（5分类x3）
│   ├── news/                   # 热点采集系统数据
│   │   ├── config/             # 评分/时间层配置
│   │   ├── sources/            # 96 个热点来源
│   │   ├── manual/             # B站人工精选暂存
│   │   ├── runtime/            # 状态/Registry/额度/授权
│   │   └── output/             # 前端投影 hotspots.json
│   └── acquisition/            # 工具情报采集来源配置
│       └── intel-sources.json  # 7 厂商 15 条来源
├── scripts/
│   ├── shared/paths.js         # 所有路径常量（新增路径先在此登记）
│   ├── pipeline/build-news.js  # 热点构建总编排（含 RSS 生成）
│   ├── core/                   # 存储/Registry/额度/调度/授权
│   ├── collectors/             # YouTube/B站采集适配器
│   ├── content/                # B站人工内容标准化 + RSS / OG 图生成器
│   │   ├── news-manual.js
│   │   ├── generate-rss.js
│   │   └── generate-og-image.js
│   ├── cli/                    # 管理 CLI
│   ├── maintenance/            # 数据校验 + 来源同步
│   ├── acquisition/            # 工具情报采集引擎 + 冲突检测
│   │   ├── fetch-tool-intel.js # 三级降级采集引擎
│   │   └── validate-intel.js   # 情报数据校验门禁
│   └── tests/                  # 43 项测试 + fixtures
└── .github/workflows/
    ├── collect-news.yml        # 每日热点采集
    ├── deploy.yml              # GitHub Pages 部署
    └── refresh-tool-intel.yml  # 每周工具情报自动更新
```

## 两条独立数据管线

### 热点管线（News Pipeline）
```
外部平台 → GitHub Actions/Node.js → Registry/评分/去重 → hotspots.json → 浏览器
```
- 每日 UTC 2:00 触发
- YouTube RSS + Data API、X TwitterAPI.io、B站人工精选
- 五层 UTC 时间窗、持久 Registry、平台额度账本

### 工具情报管线（Tool Intel Pipeline）
```
intel-sources.json → fetch-tool-intel.js → tool-intelligence.json → 浏览器
```
- 每周日 UTC 6:37 触发
- L1：llms.txt → pricing.md → Markdown 表格解析
- L2：HTML 表格 CSS 选择器提取
- L3：标记获取失败、保留旧数据
- 价格变化 >20% 自动冲突标记

## 编码约定

1. **前端零依赖**：不引入任何 npm 包或 CDN 库
2. **所有 HTML 插入前必须 `escapeHtml()` 转义**
3. **所有外部 URL 通过 `safeExternalUrl()` 校验**
4. **API Key 只能由 GitHub Secrets 注入**，不写入代码或 JSON
5. **JSON 原子写入**：tmp → fsync → 同盘 rename
6. **`data/` 根目录不放 JSON**，必须归属子模块
7. **`scripts/` 根目录只放兼容入口**，业务实现放子模块
8. **新增数据路径先登记到 `scripts/shared/paths.js`**
9. **每份数据只有一个权威路径**，不创建副本或符号链接

## 开发原则（强制约束）

以下原则在 `scripts/maintenance/validate.js` 中有自动门禁，违反即 CI 报错。AI 编写任何代码时 MUST 遵守：

1. **AI-Ready 结构**：`data/` 根目录 MUST NOT 含 .json 文件（必须归属子目录）；`scripts/` 根目录 MUST 仅放兼容入口，业务逻辑放子模块
2. **扩展点显式化**：新增视图/筛选/数据源 MUST 在对应位置标注 `EXTENSION POINT:`；MUST NOT 删除已有标记
3. **CLAUDE.md 同步**：新增/删除子目录或变更工具总数 MUST 同步更新本文件目录树和数字
4. **零外部依赖**：MUST NOT 引入 npm 包或创建 package.json；MUST NOT 使用非 Node.js 内置模块的 `require()`
5. **先结构后逻辑**：新增数据路径 MUST 先在 `scripts/shared/paths.js` 登记再引用

违反上述任一原则的代码不得提交。

## 扩展点

| 位置 | 如何扩展 |
|:------|:---------|
| 新增浏览器视图 | `index.html` + `app.js` `switchView()` + render 函数 + CSS |
| 新增热点采集平台 | `collectors/` 新增适配器 → `build-news.js` 注册 |
| 新增工具情报来源 | 仅更新 `intel-sources.json`（标准格式无需改引擎） |
| 新增数据校验项 | `maintenance/validate.js` 添加检查函数 |
| 新增 CLI 命令 | `cli/news-cli.js` 添加子命令 |
| 新增路径常量 | `shared/paths.js` 添加 → 所有脚本自动感知 |

## 工作流强制规则

以下规则 MUST 在每次会话中执行，不可跳过：

1. **任务完成后必须询问更新日志与计划**：任何代码变更、数据变更或验证任务完成后，MUST 主动询问用户"是否需要更新开发日志（开发日志.md）和开发计划（开发计划.md）？"，等待用户明确答复后再执行或跳过。不得自行决定跳过。
   - 开发日志：追加已完成变更的实际内容和验证证据，不写未发生的事实
   - 开发计划：更新任务状态、进度表和剩余项，不重复记录已完成详情

## 三环开发模型

- **环 A（前期确认）**：①问题定义 + ②可行性研究 ✅
- **环 B（MVP 交付）**：③需求 → ④设计 → ⑥编码 → ⑧维护 🔄 冲刺中
- **环 C（架构演进）**：④正式架构 → ⑤详细设计 → ⑦综合测试 ⏳ 待启动
