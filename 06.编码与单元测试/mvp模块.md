# InfoCatcher MVP 模块文档

> **版本**：v0.2
> **最后更新**：2026-07-21
> **对应目录**：`06.编码与单元测试/mvp/`

---

## 1. MVP 概览

InfoCatcher MVP 是一个**纯静态前端应用**（方案1），无需后端服务器，可直接部署到 GitHub Pages。

### 当前能力

| 功能 | 对应视图 | 数据来源 |
|------|---------|---------|
| 工具信息库（43 个 AI 工具） | 工具库 | `data/tools.json` |
| AI 概念词典（40 条术语） | AI 概念 | `data/glossary.json` |
| 多维度搜索筛选（分类/访问/价格 + 中文别名） | 工具库 | 前端过滤 |
| 场景导航（12 个使用场景） | 场景导航 | 硬编码场景列表 + 工具数据匹配 |
| 多工具对比（2-5 个，10 个对比维度） | 对比模式 | 前端状态 `compareList` |
| 工具详情弹窗 | 工具库 | 动态渲染 |
| 关于/方法论 | 关于 | 静态 HTML |

### 方案1 边界

- 可做：静态数据 + 前端交互
- 不做：用户系统、后端 API、运行时插件、个性化推荐、自动化采集

---

## 2. 文件清单与职责

```
mvp/
├── index.html          # 入口 — 页面结构、视图容器、导航栏
├── css/
│   └── style.css       # 样式 — CSS 变量体系、组件样式、响应式
├── js/
│   └── app.js          # 逻辑 — 数据加载、搜索筛选、视图渲染、事件绑定
└── data/
    ├── tools.json      # 数据 — 43 个 AI 工具的结构化信息
    └── glossary.json   # 数据 — 40 条 AI 概念术语
```

### 各文件详细职责

#### `index.html`

| 区域 | 职责 | 关键 ID / 属性 |
|------|------|---------------|
| `<header>` | 导航栏 — 5 个视图按钮 + Logo 返回首页 | `.nav-btn[data-view]`, `#homeBtn` |
| `#view-tools` | 工具库 — 搜索框 + 三维筛选（分类/访问/价格）+ 卡片网格 | `#searchInput`, `.filter-chip[data-category/access/price]`, `#toolGrid` |
| `#view-scenes` | 场景导航 — 12 个场景卡片，点击跳转工具库搜索 | `#sceneGrid` |
| `#view-compare` | 对比模式 — 已选工具 + 快捷方案 + 多维度对比表 | `#compareSelection`, `#compareTable` |
| `#view-glossary` | AI 概念词典 — 搜索 + 分类筛选 + 可展开术语卡片 | `#glossarySearch`, `#glossaryCategories`, `#glossaryList` |
| `#view-about` | 关于 — 项目介绍 + 评测方法论 + 开源说明 | 静态内容 |
| `#modalOverlay` | 工具详情弹窗 — 评分/价格/优劣势/最适合场景 | `#modalContent` |
| `<footer>` | 页脚 — 数据更新日期 + 贡献/纠错链接 | `#dataDate` |

#### `app.js`

| 模块 | 函数 | 职责 |
|------|------|------|
| **全局状态** | 变量声明 (L4-9) | 工具数据、概念数据、对比列表、当前视图、筛选状态 |
| **工具函数** | `stars()`, `scoreClass()`, `hasFree()` | 评分渲染、颜色分级、免费判断 |
| **数据加载** | `loadData()` | 异步加载 tools.json + glossary.json，失败降级为空数组 |
| **视图切换** | `switchView(view)` | 切换 active 视图，触发对应渲染函数 |
| **搜索筛选** | `getFilteredTools()` | 文本搜索(关键词 OR + 中文别名) + 三维筛选叠加 |
| **工具卡片** | `renderTools()` | 过滤 → 渲染卡片网格，含对比按钮状态 |
| **详情弹窗** | `openDetail(id)`, `closeModal()` | 渲染完整工具信息弹窗 |
| **对比模式** | `toggleCompare()`, `renderCompare()`, `removeCompare()`, `quickCompare()` | 对比列表 CRUD + 10 维度对比表 |
| **概念词典** | `getFilteredGlossary()`, `renderGlossary()` | 术语搜索 + 按分类筛选 + 可展开卡片 |
| **场景导航** | `renderScenes()`, `searchByScene()` | 场景卡片渲染 + 点击跳转搜索 |
| **搜索别名** | `searchAliases` 对象 | 中文关键词 → 过滤函数映射，赋能自然语言搜索 |
| **事件绑定** | `DOMContentLoaded` 回调 | 搜索/导航/筛选/快捷键/概念词典事件注册 |

#### `style.css`

| 分区 | 涵盖 |
|------|------|
| `:root` | CSS 自定义属性（颜色/阴影/圆角/过渡） |
| Header | 固定顶栏 + Logo + 导航按钮 + Badge |
| Main / View | 布局容器 + 视图显隐 |
| Hero | 首页标题 + 搜索框 |
| Filters | 筛选 chip 组件 |
| Tool Grid / Card | 工具卡片网格 + 卡片内部（评分/标签/对比按钮） |
| Scene Grid | 场景卡片网格 |
| Compare | 对比选择区 + 对比表格 |
| Modal | 弹窗 + 评分网格 + 详情分段 |
| Glossary | 概念搜索 + 分类筛选 + 可展开卡片 |
| About | 关于页面排版 |
| Footer | 页脚 |
| Empty State | 空结果占位 |
| Responsive | 移动端适配 |

#### `data/tools.json`

每个工具对象的字段（共 43 条记录）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识（英文小写） |
| `name` | string | 工具中文名 |
| `vendor` | string | 开发商 |
| `category` | string[] | 分类标签数组 |
| `scenes` | string[] | 适用场景标签数组 |
| `url` | string | 官网链接 |
| `icon` | string | Emoji 图标 |
| `free_tier` | string | 免费层说明 |
| `paid_tiers` | {name, price, features}[] | 付费层级 |
| `chinese_support` | number | 中文支持评分 (1-5) |
| `access_level` | string | 国内访问 "开放"/"受限" |
| `rating_overall/chinese/ease/price` | number | 四维评分 (1-5) |
| `strengths/weaknesses` | string | 优势/不足描述 |
| `best_for/not_for` | string[] | 最适合/不适合场景 |
| `last_updated` | string | 信息更新日期 |
| `source` | string | 信息来源 |

#### `data/glossary.json`

每个术语对象的字段（共 40 条记录）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `term` | string | 术语名称（如 RAG、Token） |
| `full_name` | string | 英文全称 |
| `category` | string | 分类（模型架构/训练与微调/推理与部署/多模态/Agent/评估与基准） |
| `summary` | string | 1-3 句简明释义 |
| `related_terms` | string[] | 关联术语 |
| `source` | {name, url} | 释义来源 |
| `relevance` | string | 该概念对 AI 工具选择的实际意义 |

---

## 3. 架构关系图

> 参见同目录下的 `mvp架构图.drawio`

---

## 4. 数据流

```
tools.json ──┐
              ├── loadData() ──→ tools[] ──→ getFilteredTools() ──→ renderTools()
glossary.json─┘                                      │                    │
                                                     │              openDetail(id)
                                              searchAliases      toggleCompare()
                                                     │                    │
                                              searchByScene()    renderCompare()
                                                     │
                                              renderScenes()

glossary.json ──→ loadData() ──→ glossary[] ──→ getFilteredGlossary() ──→ renderGlossary()
```

**核心约束**：
- 所有搜索/筛选均为**前端内存过滤**，不发起网络请求
- 数据文件为**静态 JSON**，修改后重新部署即可更新内容
- 视图切换通过 CSS class `.view.active` 控制显隐，非路由

---

## 5. AI 自定义功能扩展点

以下位置标注了 `EXTENSION POINT` 注释，方便 AI 编码工具识别并插入新功能。

### 5.1 index.html — 视图级扩展

| 位置 | 扩展方式 | 对应用例 |
|------|---------|---------|
| 导航栏 `.nav` | 新增 `<button class="nav-btn" data-view="xxx">` | UC-AI-04 新视图 |
| `<main>` 内 | 新增 `<section id="view-xxx" class="view">` | UC-AI-04 新视图 |
| 筛选区 `.filters` | 新增 `.filter-group` + `.filter-chip[data-xxx]` | UC-AI-03 新筛选维度 |
| `<footer>` | 新增链接 | 通用 |

### 5.2 app.js — 逻辑级扩展

| 位置 | 扩展方式 | 对应用例 |
|------|---------|---------|
| `switchView()` | 新增 `if (view === 'xxx') renderXxx();` 分支 | UC-AI-04 新视图 |
| `getFilteredTools()` | 新增筛选条件分支 | UC-AI-03 新筛选维度 |
| `searchAliases` | 新增键值对 `'关键词': t => 条件` | UC-AI-03 搜索增强 |
| `renderCompare()` 的 `dims[]` | 新增 `{key, label, format}` 条目 | UC-AI-05 新对比维度 |
| `renderScenes()` 的 `scenes[]` | 新增场景对象 `{id, icon, name, desc, q}` | 场景扩展 |
| `loadData()` | 新增 fetch 新 JSON 文件 | UC-AI-02 新数据源 |
| `DOMContentLoaded` 回调 | 新增事件监听注册 | UC-AI-04 新交互 |

### 5.3 style.css — 样式级扩展

| 位置 | 扩展方式 | 对应用例 |
|------|---------|---------|
| `:root` | 直接使用已有 CSS 变量（`--primary`, `--surface` 等） | 所有 |
| 文件末尾 | 新增视图样式块（参考 `.glossary-*` 模式） | UC-AI-04 |

### 5.4 data/ — 数据级扩展

| 位置 | 扩展方式 | 对应用例 |
|------|---------|---------|
| `tools.json` | 新增字段不影响现有渲染（前端按需读取） | UC-AI-02 |
| `glossary.json` | 新增术语条目 | 内容扩充 |
| 新建 `data/*.json` | 新数据文件 + `loadData()` 中 fetch | UC-AI-02 |

---

## 6. 后续修改注意事项

1. **视图切换机制**：`switchView()` 通过硬编码 if 分支匹配视图名。添加新视图时需同时修改 3 处：index.html（导航按钮 + 视图容器）、app.js（`switchView` + `DOMContentLoaded` 事件）、style.css（新视图样式）
2. **搜索筛选叠加**：`getFilteredTools()` 中文本搜索和三维筛选是**叠加**关系（AND），修改时注意顺序不会影响结果
3. **对比按钮状态同步**：`toggleCompare()` 调用后必须同步调用 `updateCompareCount()` + `renderTools()`，否则 UI 不一致
4. **JSON 数据格式**：所有日期使用 ISO 格式 (`YYYY-MM-DD`)；评分使用 1-5 数值；数组字段即使空值也应为 `[]` 而非 `null`
5. **CSS 变量体系**：所有颜色/阴影/圆角统一使用 `:root` 中的 CSS 自定义属性，不硬编码色值，确保深色模式可升级
6. **无构建工具**：MVP 是纯 HTML/CSS/JS，无打包器/转译器。所有代码直接运行于浏览器，需兼容主流浏览器 ES6+
7. **部署路径**：CI 将 `mvp/` 部署为站点根目录（`_site/`），文件内引用路径（`data/`, `css/`, `js/`）均为相对路径
