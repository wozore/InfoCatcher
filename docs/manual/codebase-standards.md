# 知览 (KnowView) 代码编写与架构规范

> **定位**：知览（KnowView）代码库核心工程规范，永久纳入版本控制（`docs/manual/`）。
> **生效方式**：通过 [.claude/CLAUDE.md](../../.claude/CLAUDE.md) 自动进入提示词上下文，通过 [scripts/check-standards.js](../../scripts/check-standards.js) 在本地与 CI 阶段执行强约束。

---

## 1. 通用工程红线

1. **单一职责**：一个文件只负责一类事。严禁“路由+业务”、“传输+Prompt”、“编排+具体实现”混杂。
2. **覆盖式修正**：修正 = **抹除旧实现重写 + 迁移全部调用方 + 删除旧路径与旧契约**。严禁兼容别名、严禁 `module.exports = require(...)` 垫片、严禁 `@deprecated`、严禁双轨。
3. **依赖注入（DI）**：可变副作用（fetch、fs、时钟、路径、AI Provider）一律参数/构造注入，默认值集中一处。单测一律用替身离线运行，严禁触网、严禁读真实 Key。
4. **Fail-closed**：严禁静默吞错。业务降级必须显式写入 coverage / warnings / diagnostics 并偏向保守。AI 只提建议，有效性由代码确定性门禁裁决。
5. **体量硬限**：
   - 源码文件：单文件 ≤ 400 行、导出 ≤ 15 个、单函数 ≤ 60 行；超限必拆。
   - CLI 脚本（`scripts/*.js`）：单文件 ≤ 250 行，只做参数解析与调用下沉。
6. **索引与路径收口**：
   - 新增/重命名/删除 `src/` 代码文件，必须同步 [CODEBASE-MAP.md](../../CODEBASE-MAP.md)。
   - 所有运行时与业务数据文件路径必须收口于 `src/shared/paths.js`。
7. **零 npm 外部依赖**：保持原生 Node.js / ES 模块开发，无编译打包层；浏览器端原生 ES Module 直跑。

---

## 2. 依赖分层与域内组装

### 2.1 宏观依赖单向流

依赖严格自上而下流动，**严禁同层互引与反向依赖**：

```
[浏览器前端]  src/web/ 、 src/maintainer-web/ (原生 ES 模块，严禁 import Node 模块)
      │  HTTP / JSON API
      ▼
[服务端边界]  src/maintenance/ (HTTP Server、安全鉴权、路由分发)
      │
      ▼
[装配服务层]  src/maintenance/workbench/*-domain.js (Service 组合根，构造注入)
      │
      ▼
[业务域层]    catalog/ 、 news/ 、 comparison/ 、 content/ 、 pending/ 、 build/
      │  (业务域之间严禁互相 require！跨域需求上移 shared 或由上层服务注入)
      ▼
[基础共享层]  src/shared/ (paths, json-store, ai-transport, llm-gateway, beijing-time, env)
```

* **禁止 src → scripts**：`src/` 严禁反向 require 外部命令行脚本。
* **前后端物理隔离**：浏览器侧与 Node 侧严禁交叉引用。

### 2.2 域内组织与门面（Facade）

1. **子域目录化**：域内同前缀/同业务功能文件 ≥ 4 个时，升为子域目录（如 `src/catalog/series/`），目录深度 ≤ 3 层。
2. **Facade 门面收口**：子域对外仅暴露 `index.js`。**外部严禁深路径跨子域引用内部私有文件**（如 `require('./series/policy')` 违规，必须经 `require('./series')`）。子域内自由引用。
3. **内聚与耦合**：
   - **共同闭包**：总是一起变更的代码放在一起；
   - **变更原因 ≤ 2**：服务于 ≥ 3 个不相关变更原因的文件必须拆分；
   - **就近原则**：单一模块私用函数就地安放，严禁建立无业务语义的 `utils/`、`common/` 垃圾场；
   - **单向数据流**：采集 → 候选/草稿 → 人工审核 → 正式数据 → 公开投影，下游严禁反向引用上游；
   - **状态归属唯一**：可变内存状态由单一模块持有，通过函数读写，严禁多处拷贝。

### 2.3 拆分决策树

* **必须拆（同时满足）**：超过体量红线（>400 行或 >15 导出）**且**内部包含 ≥ 2 个独立职责；变更原因分离；消费群体分离。
* **严禁拆（防过度拆分）**：单一职责的大数据表/常量表/Schema；无第二个消费者的提前拆分（YAGNI）；拆分后增加内部参数暴露（新增参数 ≥ 4 个）。
* **优先级**：按职责层拆（State/Render/Transport/编排）> 按业务对象拆；严禁按行数机械均分。

### 2.4 shared/ 准入门槛

进入 `src/shared/` 必须同时满足：① ≥ 2 个业务域消费；② **零业务语义**（只知传输、存储、时间、配置，不知业务实体）；③ 稳定性高于消费域。有业务语义的跨域共享必须建立独立业务域（如 `src/pending/`）。

### 2.5 模块组装纪律

* **require 零副作用**：模块被引用时仅做声明，执行逻辑必须在 `if (require.main === module)` 保护下。
* **库代码严禁 console**：`src/` 内部只返回数据或抛错；输出仅允许在 `scripts/` 入口与 Server 请求日志中。
* **process.env 收口**：散落读取违规，仅允许收口在 `src/shared/env.js`、`providers` 注册表与 `load*Config.js`。
* **错误码域前缀**：稳定错误码统一大写下划线并带域前缀（如 `CATALOG_...`、`NEWS_...`）。

---

## 3. 代码类型与架构模板（T1–T14）

编写代码前必须明确所属模板，并遵守其契约：

| 模板 | 类型 | 职责 | 允许依赖 | 严禁事项 | 结构顺序 |
|---|---|---|---|---|---|
| **T1** | CLI 入口 | 参数解析与终端调度 | 仅调用对应 src 编排入口与 paths | 禁含业务逻辑，行数 ≤ 250 | `parseArgs` → `main` → 终端输出/退出码 |
| **T2** | 纯领域模块 | 确定性业务规则与算法 | 纯数据结构与工具函数 | 零网络、零 fs、零 AI、零时钟（全注入） | 契约表 → 纯函数工具 → 导出主规则函数 |
| **T3** | Store 持久层 | 单一数据文件的读写与原子落盘 | `shared/paths`、`shared/json-store` | 禁网络、禁 AI、禁调其他 Store，禁业务审批逻辑 | Schema 常量 → read → mutate 纯函数 → write |
| **T4** | Transport 层 | 外部 HTTP/网络协议细节封装 | 底层 fetch、共享错误码 | 禁业务语义，禁拼装 Prompt | 端点常量 → 请求构造器 → fetch 发送 → 错误码归一化 |
| **T5** | AI Adapter | 业务数据与 AI 调用的转换中继 | `llm-gateway`、纯验证工具 | 禁硬编码密钥，AI 仅建议不得裁决业务 | `buildInput` → `suggest*` → `validate*Value` |
| **T6** | 编排层 | 串联步骤的业务流水线 | 调 T2/T3/T4/T5 各模块，require ≤ 10 | 只编排不实现，禁内联复杂校验/Prompt/HTTP | 步骤常量 → 单步具名函数 → 总调度函数 |
| **T7** | Server 路由层 | HTTP 入口、鉴权与路由分发 | 对应 Service 门面与基础安全模块 | 严禁业务逻辑，严禁深引业务域私有模块 | 中间件 → 路由表 (URL→Service 方法) → 分发 |
| **T8** | Service 装配层 | 组装业务域能力为面向接口 DTO | 业务域公开门面，一律构造注入 | 禁方法体内动态 require，禁持有多余全局状态 | `createService({ apis... })` 工厂 → DTO 方法 |
| **T9** | 校验器 | 静态数据完整性与规则检查 | 只读数据，输出错误清单 | 禁就地修改数据，错误消息严禁包含历史叙事 | 纯校验函数 `validateX(data)` → 退出码汇聚 |
| **T10**| 采集器 | 外部源抓取与内部证据归一化 | Transport 通道、配置加载器 | 禁直写正式数据，禁在采集层调重量级商业 AI | 配置解析 → 批量拉取 → 单条归一化 → 证据落盘 |
| **T11**| Web 前端模块 | 页面渲染与用户交互 | 原生 ES 相对路径，禁 Node 模块 | 严禁循环 import，视图严禁直接持有全局状态 | 常量 → state 读取 → render 纯函数 → 事件绑定 |
| **T12**| 维护者前端 | 维护者工作台面板与交互 | 共享 `api.js`、`auth.js`、`state.js` | 单面板单文件，单文件 ≤ 400 行 | API 请求 → DOM 缓存 → 面板渲染与绑定 |
| **T13**| 测试用例 | 自动化契约断言与防回退 | 被测模块、离线 Fixture 替身 | 严禁真实网络请求与真实线上密钥 | 镜像目录结构，断言核心契约行为 |
| **T14**| 数据文件 | 持久化状态与公开投影 | 专属 Store 维护，登记于 paths | 禁多模块无锁并发直写 | 严格对应 Schema 的 JSON 数据文件 |

*注：Windows 批处理文件（`bat/*.bat`）一律使用 **CRLF** 行尾保存，仅做命令转发，不含业务逻辑。*

---

## 4. 注释与契约治理

### 4.1 旧契约定义与三问判定法

**旧契约 = 描述已不存在事物的叙述文字**（形态：① 解释已删除字段/行为的历史注释；② 兼容已消失旧格式的代码分支；③ 与事实不符的失效注释）。
*横幅、组编号、分割线均属自由书写形式，不是旧契约，无需清除。*

**三问判定流程**：
1. **它描述的事物还存在吗？**
   - 存在 → 属于活契约，保留维护；
   - 已不存在 → 进第 2 问。
2. **删掉它，系统行为有任何变化吗？**
   - 有变化 → 属于活门禁，**保留逻辑本体**，将文案改写为当前契约要求；
   - 无变化 → 进第 3 问。
3. **它是在叙述现在还是过去？**
   - 过去事实进 [dev-log.md](dev-log.md)，代码内彻底删除该叙述或死分支。

### 4.2 注释与命名纪律

* **允许的新增注释**：① 文件头一行职责（与 CODEBASE-MAP 同步）；② 代码无法表达的隐性约束（协议限制、安全红线、物理单位、环境避坑）。
* **禁止**：`@deprecated` 标记、在注释中写更新历史、注释掉的废弃代码。
* **命名必须反映当前事实**：通用模块不得带特定厂商名（如多厂商网关禁叫 `deepseek-`）；活跃数据目录严禁命名为 `archive`。

---

## 5. 防回退与机械门禁体系

1. **CI 门禁永久化**：[scripts/check-standards.js](../../scripts/check-standards.js) 前置接入 [scripts/validate.js](../../scripts/validate.js)，覆盖全部 6 个 GitHub Actions 工作流，违规代码无法合入主分支。
2. **白名单只减不增**：[scripts/check-standards.whitelist.json](../../scripts/check-standards.whitelist.json) 带精确 count 校验，违规增加报 `whitelist-growth` 阻断。
3. **静态检测 7 大项**：
   - `dependency-direction`（单向依赖/域间隔离/深路径私引）；
   - `shim`（垫片与纯 re-export 拦截）；
   - `legacy-narrative`（旧契约历史短语拦截）；
   - `size-exports`（代码 ≤400行/≤15导出、脚本 ≤250行）；
   - `cycles`（require/import 依赖拓扑环）；
   - `assembly`（src 内 console、process.exit、散落 process.env）；
   - `codemap`（`src/` 代码文件在 CODEBASE-MAP.md 登记覆盖率 100%）。
4. **修改走正道**：修改或演进规范必须同步修改本文件、[.claude/CLAUDE.md](../../.claude/CLAUDE.md) 与检查器规则，严禁通过增加白名单规避检查。
