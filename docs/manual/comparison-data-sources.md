# 对比页数据源选型与获取方式（核实记录）

> 核实时间：2026-08-18（第一轮）+ 2026-08-18（第二轮复核实）
> 目的：为「AI 模型对比页面」确定可用数据源及其获取方式。本文记录**只读核实结论**，含可用/不可用判定、逐字段验证与工程坑。
> 核实手段：WebSearch / Tavily（extract）+ GitHub MCP + curl 实测（OpenRouter、arena.ai、hf-mirror、datasets-server、llm-stats 等端点）。

## 一、结论速览（定稿）

- **已定保留（4 源，官方/当前可用）**：Artificial Analysis（**仅内部参考**）、LMArena（官方数据集）、OpenRouter、LiveBench
- **已搁置**：**SWE-bench-Live**（官方实时，但**提交驱动、数据少且旧**——2026-07 以来仅 10 条提交，多数模型评测日期早）→ **暂不展示，以后再说**
- **可选待定**：Open LLM Leaderboard（llm-stats.com）—— 实时 358 模型（343 有分），benchmark/index 分**需抓站**（解析 Next.js RSC payload）；另有**官方 API**（models/list 目录 + metrics 实时吞吐）可作基础信息源（见第六节）
- **已弃用**：**DeepSWE**（无干净数据源）、**HF 原站 open-llm-leaderboard**（实测停更，v2 遗留）、**swe-bench/experiments 旧仓库**（新评测已停，见下）
- 获取通路：AA 页面抓取 / LMArena HF 数据集 / OpenRouter API / LiveBench 脚本（4 条官方）+ 可选 llm-stats 抓站

## 二、平台逐一核实

### 1. Artificial Analysis — ✅ 官方 Data API v2

- 主端点：`GET https://artificialanalysis.ai/api/v2/language/models` — Intelligence Index + API 定价 + 延迟/吞吐 + 模型元数据
- 分层许可（2026-08-18 实测官方文档措辞）：
  - **Free**：`Internal use only; no redistribution`（内部使用，禁止再分发）—— **不限于商业**
  - **Pro**：`Restricted external use`（受限外部使用）
  - **Commercial**：`Redistribution with attribution`（可再分发，需署名）
- **✅ 已定（2026-08-18）**：AA 仅作**内部参考**，对比页**不公开显示 AA 具体数值** → 免费层合规，无需 Pro/Commercial
- **内部参考用途（已定，2026-08-18）**：AA 数据**物理隔离**存 `data/comparison/aa-internal.json`，不进 `integrated.json`/前端（防公开再分发）；三用途——① 交叉校验（Intelligence Index 对照 4 源综合分排序、异常去 `raw/` 快速核对）② 速度/延迟内部备用（全量速度数据，其余源缺失）③ 维护者决策佐证（默认推荐/权重调整）；默认不显示，内测显示需显式 `internal` 开关且生产构建不打包
- **⚠️ API 实测（2026-08-18，临时 key）**：
  - 认证：`X-API-Key: <key>` 头（Bearer 头不识别）
  - **`/api/v2/language/models` 与 model detail 均需 Pro 订阅**（免费 key 报错 `requires a Pro subscription`）→ **免费 key 访问不了语言模型数据**
  - 替代路径（内部参考可用）：公开站 `artificialanalysis.ai/models` 表格为**客户端渲染**，原始 HTML 无数据，需浏览器渲染抓取（Tavily extract 已验证可拿；当前 **159 模型 / 84 开源**）
  - Intelligence Index 现为 **0-100 量纲**（实测 Claude Opus 5 (max)=63、GPT-5.6 Sol=61、Kimi K3 (max)=60 开源最高）；另有输出速度（top Celeris-1=1495 t/s）、延迟/TTFT、上下文、blended/input/output 定价等维度
- 免费层另受限：每日 100 请求、无 benchmark 分项、无 per-provider 数据
- 文档：<https://artificialanalysis.ai/data-api/>

### 2. LMArena agent 榜（arena.ai/leaderboard/agent）— ✅ 官方 HF 数据集

- **官方发布 `lmarena-ai/leaderboard-dataset` 数据集（HF）**，与站点数据逐字段一致
- 结构：每分类 `latest` + `full` 两份 parquet；`agent` 配置 = overall（站点「Net Improvement」列），另 5 个子配置 = 其余维度
  - `agent_praise_complaint` / `agent_steerability` / `agent_bash_recovery_steps` / `agent_tool_hallucination` / `agent_task_outcome_explicit`（Confirmed Success）
  - 字段：`model_name / organization / license / score / score_ci_lower / score_ci_upper / observation_count / session_count / rank / category / leaderboard_publish_date`
- **逐字段核对通过**（Claude Opus 5 (High) 全维度，误差仅四舍五入）：

| 维度 | 站点 | 官方数据集 | 一致 |
|---|---|---|---|
| Net Improvement (overall) | 12.19%±1.45% | 12.19% [10.74,13.64] | ✅ |
| Confirmed Success | 15.35%±3.03% | 15.35% [12.31,18.38] | ✅ |
| Praise vs Complaint | 19.26%±5.29% | 19.26% [13.97,24.55] | ✅ |
| Steerability | 11.34%±2.79% | 11.34% [8.55,14.13] | ✅ |
| Bash Recovery | 13.89%±0.79% | 13.89% [13.09,14.68] | ✅ |
| Tool Hallucination | 1.13%±0.19% | 1.13% [0.94,1.32] | ✅ |
| Sessions | 19,739 | 19,739 | ✅ |

- **当前 49 个模型**（官方数据集实测），前沿精选为主，非全量；站点直连 403（Cloudflare），数据集经 hf-mirror 可达；如需核对站点实时值，Tavily/browser 抓取可拿全表（本轮核对即用此法）
- **同一官方数据集覆盖 arena 全部榜单**（22 个 config，2026-08-18 复核数据集仓库文件清单）：
  - **11 个主榜**：`agent`、`text`、`vision`、`webdev`、`document`、`search`、`text_to_image`、`image_edit`、`image_to_video`、`text_to_video`、`video_edit`（无独立 `code` 榜，Code Arena 已演进为 Fullstack Code Arena 并入 `webdev`）
  - **agent 子维度 5 个**：`agent_praise_complaint` / `agent_steerability` / `agent_bash_recovery_steps` / `agent_tool_hallucination` / `agent_task_outcome_explicit`
  - **style control 子集 4 个**：`text_style_control` / `vision_style_control` / `document_style_control` / `search_style_control`（剥离长度/markdown 的纯内容偏好分）
  - **factuality 子集 2 个**：`text_factuality` / `search_factuality`（事实准确度调整分）
  - 每个 config 均含 `latest` + `full` 两份 parquet → 一个数据集即覆盖全部榜单与历史
- 更新节奏：与站点同步（2026-08-15 提交 / 08-13 数据）
- 旧路废弃：HF Space 每日 CSV 停更于 2025-08；`lmarena2api` 是对话代理非数据；第三方快照 oolong-tea 不再需要（可作历史参考）

### 3. SWE-bench-Live — ⏸️ 已搁置（暂不展示，2026-08-18 决定）

> **决定**：暂不展示。原因：提交驱动、**数据少且旧**（2026-07 以来仅 10 条提交，多数模型评测日期早）。以下核实信息保留，供以后启用时参考。

- **给人看的榜**：`https://swe-bench-live.github.io/`（官方 SWE-bench-Live 组织 GitHub Pages，实测 200；**`swebench.com/live` 实测 404**，主站 /live 链接已失效）
- **数据仓库**：`github.com/SWE-bench-Live/swe-bench-live.github.io` → `reports-0605.jsonl`（**149 条提交，数据到 2026-08-17**，仓库持续更新）
- 字段：`name`（模型+agent 组合，如 "AMI Agent + Claude-4.6-Opus"）/ `set` / `total` / `resolved`（→ resolved%）/ `date` / `url`
- **10 个 set（多语言）**：`lite`（Python 300 例）+ `java`/`go`/`tsjs`/`rust`/`csharp`/`ccpp`/`windows` + `verified`/`full`；各 set 独立算 resolved%（实测 **lite 12~63%**、**java 16.1~67.0%**、total 39~300）
- ⚠️ **旧 `swe-bench/experiments` 已过时**（2026-08-18 实测）：最新模型 run 停在 **2025-12-15**，仓库仍在维护但只改元数据/修 leaderboard，**不再收新评测** → 对比页不要用旧仓库
- **本机评测工具集**：`github.com/SWE-bench-Live/launch`（RepoLaunch，`pip install .`）——`datasets/` JSONL 定义实例（repo/instance_id/language/setup_commands/test_commands/base_image/base_commit）→ `scripts/download_repos.py` 下载 → `git_launch.batch_run.run_launch` 建沙箱 → `run_eval` 本机跑 resolved；CLI `python -m git_launch.launch`；另有经典 `swebench` pip 包（swe-bench/SWE-bench）跑 verified/lite/full 标准分片
- **更新节奏实测（2026-08-18）**：提交驱动（厂商 PR 提交 `preds.json`+`results.json`），**突刺式更新**——2026-01 一次 70 条、2026-06 一次 43 条，**2026-07 以来仅 10 条**（基本是 AMI Agent / Slingshot）→ 多数模型评测日期较早，非自动刷新，时效需接受
- 网页有 Compare results

### 4. OpenRouter — ✅ 官方 API（已实测）

- `GET https://openrouter.ai/api/v1/models` **免 key**，2026-08-18 实测 **414 个模型**
- ⭐ **一次调用拿全 414 个模型的定价**：414/414 含 `pricing.prompt/completion`（389 个 >0、25 个免费），另有 `input_cache_read`、`context_length`、`architecture`（modalities）、`knowledge_cutoff`
- **定价性质（实测）**：OpenRouter **挂牌参考价**（USD/token），按 `vendor:model` 粒度，基于厂商官方定价经统一路由口径；**不是**各第三方 provider 实时价（`top_provider` 是默认厂商）
- **无 effort 分档（实测）**：414 个模型仅 1 个带 `:thinking` 后缀；Claude Opus 5 只有 base / `:fast` / `:batch` 三种价，**没有 high/xhigh/max 独立条目**（effort 走请求参数 `reasoning`，同 ID 一个价）
- `knowledge_cutoff` 实测大量为 **null**（如 claude-opus-5），覆盖率低 → 仅可选元数据
- 文档 URL 已改版（原 `docs/api-reference/list-models` 404）；sofindai 是第三方聚合，直接用官方 API

### 5. LiveBench — ✅ 官方脚本（可选保留）

- **特点：月度刷新 + 防污染**（2026 起转型；题库定期更新防止刷分）；客观自动判题（非用户盲评）
- 2026-04 新增 agent 工具测评
- **effort 变体（实测）**：模型名含程度独立条目——`o3-mini-high/low/medium`、`o1-high`、`claude-3-7-thinking-64k` 等 → 程度选择器可用
- 数据：`download_leaderboard.py` / `download_questions.py` → `all_groups.csv` / `all_tasks.csv`；题目存 HF `livebench/`
- 与 AA/LMArena 有维度重叠 → 按需保留

### 6. Open LLM Leaderboard（llm-stats.com）— ⚠️ 数据活，抓站为主，另有官方 API

> 注：用户澄清真正指的是 `https://llm-stats.com/leaderboards/open-llm-leaderboard`（独立聚合站），**不是** HF 原站。

- **数据实时更新**（2026-08-18 实测）：**358 个模型（343 有 LLM Stats Score）**，含 **150 个 proprietary + ~208 个非 proprietary**（**⚠️ 网站 JSON-LD 自称「open-weight」排行榜，但实测确含闭源专有模型**；开源权重约 180+，此前记「204 开源」为旧/子集口径）；列含 LLM Stats Score（`index_general`）、上下文、输入/输出价格、吞吐、延迟、参数量、license、发布日期、厂商；模型到 2026-06（MiniMax M3 等）
- **字段级结构（RSC payload 实测）**：每条记录含 —— 身份（`model_id/name/organization/organization_country/license/release_date`）、规格（`params/training_tokens/context/multimodal/is_moe/knowledge_cutoff`）、性能（`input_price/output_price/throughput/latency`）、**23 个 benchmark 分**（**已定 6 个**：`aime_2025/hle/gpqa/swe_bench_verified/swe_bench_pro/mmmu_pro`，其余如 `coding_arena/osworld/mmmu/simpleqa` 等存在但不展示，多为部分模型非空；覆盖率见下条）、**12 个 index 分**（`index_general≈LLM Stats Score`、reasoning/math/code/search/communication/vision/tool_calling/long_context/finance/legal/healthcare）
- **benchmark 字段覆盖率核实（2026-08-18 重扫 RSC）**：已定 benchmark 字段覆盖率 = `gpqa` **239**/358、`aime_2025` **115**/358、`swe_bench_verified` **111**/358、`swe_bench_pro` **50**/358、`hle` **99**/358、`mmmu_pro` **68**/358（`coding_arena` **152**/358 已定去掉）—— **数据层均存在**；⚠️ 但**网站 UI 只展示其中部分**（JSON-LD `variableMeasured` 仅报 **GPQA Diamond、Coding Arena Score** 两个 benchmark + 吞吐/延迟/定价/上下文；SWE-bench Verified / MMMU-Pro 不出现在主展示，各模型详情页展示需逐个核实）→ 对比页以 RSC 数据字段为准
- 自带「LLM Stats Score」独立方法论（站点自有）
- **官方 API（2026-08-18 发现，JSON-LD `distribution` 自曝，实测均 200）**：
  - `GET https://api.zeroeval.com/leaderboard/models/list` — **358 模型目录**（`model_id/name/organization_id/release_date/inputPrice/outputPrice/context_window`；**无 benchmark/index 分**）→ 可作模型主键 + 价格/上下文权威源，替代抓站解析
  - `GET https://api.zeroeval.com/v1/models/metrics` — **92 模型实时吞吐/延迟/TTFT**（`avg_throughput` 1.9~812.7 t/s，45 模型有吞吐）→ 吞吐/延迟若未来启用可走此 API
  - **benchmark/index 分无 API** → 仍须抓站解析 RSC payload
- **抓站合规（2026-08-18 实测）**：robots.txt 为 `User-Agent: *` + `Allow: /`，`/leaderboards/` 未禁 → 允许抓取 ✅；Cloudflare 前置但普通 curl 直接 200 全量返回（无 challenge/403），内容 `x-nextjs-cache: STALE` + `s-maxage=3600` 小时级缓存 → 抓取频率压到每日数次即可，避免触发 CF 限流
- **HF 原站 `open-llm-leaderboard` 已停更**（实测：批量数据全 2025，space 是旧 v2 前端）→ 不要用 HF 原站

### 7. DeepSWE — ❌ 弃用

- 结果只在网站（113 任务 / 24 模型），无公开 API/结果仓库；新基准、权威性弱；与 SWE-bench 同维度 → 已移除

## 三、推荐组合（定稿）

| 目标 | 组合 |
|---|---|
| **定稿 4 源** | Artificial Analysis（内部参考）+ LMArena（官方数据集）+ OpenRouter + LiveBench |
| +开源模型覆盖（可选） | 上面 + Open LLM Leaderboard（llm-stats，需抓站） |
| 已搁置 | SWE-bench-Live（数据少且旧，以后再说） |
| 已弃用 | ~~DeepSWE~~、~~HF 原站 Open LLM Leaderboard~~、~~swe-bench/experiments 旧仓库~~ |

## 四、HF 访问方案（已确定：镜像优先）

- Node 抓取层访问 HF 一律走 `https://hf-mirror.com`，不做端口探活/自动降级
- hf-mirror 提供目标数据（`lmarena-ai/leaderboard-dataset` 200；与官方内容实测一致）
- 网络层失败 → 报清晰错误；保留 `HF_ENDPOINT` 开关可切官路 + undici `ProxyAgent('http://127.0.0.1:7897')`（Node 24 需 `NODE_USE_ENV_PROXY=1`）
- 本机网络坑（已诊断）：Clash Verge fake-ip 模式 + curl/node 不读系统代理；Clash 关着时别留代理环境变量

## 五、待办清单

> 当前阶段边界：全部设计定稿（2026-08-18）+ **实现决策定稿（2026-08-19，13 条见下）**；**进入实现**——首批前端先行（mock integrated 数据），数据管线并行随后；**数据契约（index.json/data.json）先定死防返工**。

- [x] **对比规则 / 排版设计**（已定，2026-08-18；排版终稿 2026-08-18）：**对比页代码重整**（旧 compare.js 为 demo，重置问题少；复用横向柱状图组件）——
  - **双标签**：**模型对比 / 工具对比**两个 tab 各自独立（模型对比读 integrated/；**工具对比 tab 逻辑也重做**、复用前端柱状图组件）；用户看效果后定去留
  - **可视化组**（模型对比）：柱状图（默认）与雷达图（PK），**同一组、由 toggle 切换**——柱状图 = **每个勾选维度一个图块、每块内每模型一行 = icon + 横向柱 + 数值**（复用现有横向柱状图样式）；**综合分为第一个维度块（默认勾选）**；雷达图 = 仅 2 模型、**经典单一 N 边形图**（N = 勾选维度数）、**模型1 标签居左 / 模型2 居右**，且**雷达图开启时放开页面限宽**（同搜索页条件放开，其余页均限宽）
  - **变体切换**：点击模型 icon → icon 周围**顺时针 360° 平分圆圈**，每圈 = 一个可选变体（high/xhigh/max 等，有多少显示多少）；点圈切换为该变体数据并给**文字说明**
  - **来源归属**：每个可视化块下方统一**右对齐「来源」footer 条**（用户参考图 来源.png），不按模型逐行、不放整页角落
  - **表格视图**：**独立视图，不参与 toggle**——不可量化属性（是否免费、是否需翻墙、是否开源、license、厂商等）+ 上下文 + **模型定价（具体值进表格行）**；**前端不显示原始值**（存原始值、展示归一化后），**取消详情卡片弹窗**
  - **用户交互**：可量化维度**可任意勾选**（柱状图全可选；**定价仅柱状图可选、雷达图不可选**）；**默认勾选 = 综合分 + 推理 + 编码 + Math（进可配置文件，维护者可改，2026-08-19）**；每个模型的**程度变体是模型对比时的可选项**（不是数据维度；放射圆圈切换）；**雷达图维度上限 12 条**（超出提示取消勾选，2026-08-19）；模型数上限 2–5（沿 demo，可调）
  - **综合分加权（普通用户，已定）**：
    - 开源模型且 llm-stats 有值：`0.45×LMArena + 0.30×LiveBench + 0.25×LLM Stats Score`
    - 否则：`0.65×LMArena + 0.35×LiveBench`
  - 原则：**对比在精不在多**。⚠️ **雷达图各维度必须归一化到统一刻度**（存原始值、展示层归一化）：
    - LMArena `score`：-0.3 → 0.2 映射到 0 → 100（`(x+0.3)/0.5×100`）
    - LiveBench 综合/类别：0-100 原值
    - LLM Stats Score `index_general`：**-20 → 60 映射到 0 → 100**（`(x+20)/80×100`）
    - 吞吐/延迟等速度指标：映射到 0-100
    - 参数量：可量化（所选模型支持时；0.8B~2.8T 跨度大，宜对数刻度）
    - 性价比：可量化（公式待定）
  - **模型命名统一**：展示名统一为 **`Model (Degree)`** 格式（如 `Claude Opus 5 (High)`）；**日期去掉、默认最新版本**——多版本取最新（如 `o3-mini-2025-01-31-high` → 显示 `o3-mini`），旧版本一般已不可用
  - **存储**：5 平台对比数据**分别存储**（各自原始 JSON），由整合代码对齐模型主键 + 归一化 → 生成前端对比数据
  - **性价比公式（已定，2026-08-18）**：`性价比 = 加权综合分（0-100）÷ 定价（$/M，取 input/output 平均）`，再归一化到 0-100
  - **吞吐/延迟（已定，2026-08-18）**：数据量少（llm-stats 仅 ~13% 模型有值）、跨源口径不可比 → **暂不加入前端显示**；AA 输出速度仅作内部参考备用
  - **细分维度子项（已定，2026-08-18）**：LiveBench 与 llm-stats index **跨源合并收敛为 7 项**（表 A②）：推理 reasoning / 编码 coding（A+B 同名合并）+ 沟通/语言 communication（idx communication + LB language 合并）+ 执行成功率 instruction_following + 自主编程 agentic_coding + 工具调用 tool_calling + 长上下文 long_context；**数学 math 并入 benchmark 组 Math**（aime_2025 优先 + LB/idx math 兜底）、**vision 并入 benchmark 组 Multimodal 作兜底**；llm-stats **专业人员补充 3 项**（金融/法律/医疗）不参与普通默认对比；index_search 搜索归属待定
  - **benchmark 精简与合并（已定，2026-08-18）**：llm-stats benchmark 收敛为 **4 个能力维度**（英文名 + 落库键）：**Knowledge 知识问答 `expert_knowledge`** = GPQA+HLE（GPQA 优先、HLE 兜底：239 vs 99 覆盖）｜**Math 数学推理 `math_reasoning`** = **aime_2025 优先 + LB math + idx math 兜底**｜**Multimodal 图文多模态 `multimodal`** = **mmmu_pro 优先 + idx vision 兜底**｜**SWE 工程能力 `swe_capability`** = SWE-bench Verified+Pro（Pro 优先、Verified 兜底：Pro 未泄漏/未饱和/2026 官方口径，Verified 覆盖广 111 补缺但已泄漏+OpenAI 2026-02 弃用须标注）；统一归一化后取非空、顶尖差异进详情卡片；**coding_arena 去掉**（与 LMArena 编码榜重复）
- [x] **数据落库形态（已定，2026-08-18）**：**独立数据层 `data/comparison/`，不入 catalog**（生命周期/语义/校验/许可四隔离）——`refresh-config.json`（抓取编排配置，含拉取 config 清单）+ `models-alias.json`（主键对齐人工登记表）+ `aa-internal.json`（AA 内部参考，不公开）+ `raw/`（4 源原样快照，留作快速校对与重跑合并不重抓：lmarena 由 parquet 只读解析转 JSON / livebench / llm-stats / openrouter）+ `integrated/`（**前端唯一入口层，拆两文件**：`index.json` 小——模型列表 + `file` 指针，秒开；`data.json` 大——完整分数/定价/上下文/综合分，用户勾选模型后懒加载；将来 data 超 ~1.5MB 可按类别拆块、仅改指针前端契约不变）；4 源按表 A 规矩合并、主键对齐、存原始值；刷新链路独立于 catalog（fetch → 校验 → 写 raw → 重建 integrated）
- [x] **抓取链路编排（已定，2026-08-18）**：**每源独立脚本**（`fetch-openrouter` / `fetch-lmarena` / `fetch-livebench` / `fetch-llm-stats` / `fetch-aa`）+ `run-comparison.js` 定时调度（cron 每日）+ 配置 `data/comparison/refresh-config.json`（可手动改）——频率：OpenRouter/llm-stats/LMArena 每 2 天、AA 每周、LiveBench 每月；**每源独立计数全量**：到间隔即抓、count+1，count 达 fullEvery（2 天源 n=10、周源 n=5、月源 n=2）该次升级为全量（从源强制完整重抓一遍）后归 0，手动单跑不计 count；**失败隔离**：每源失败 WARN 具体任务、不阻塞其余源；**全绿才重建**：全部源成功且 fresh 才由 `rebuild-comparison.js` 重建 integrated.json，任一源未就绪则停住不重建并列出待修源，维护者修复后自动继续后续链路
- [x] **模型主键对齐策略（已定，2026-08-18）**：以 line 145 已定统一格式 `Model (Degree)` 为锚——**canonical id = 统一格式里 Model 部分 slug 化**（`claude-opus-5` / `o3-mini` / `gpt-5.6-sol`），**Degree 是主键下的变体属性**不占独立主键（呼应「程度变体是模型对比时可选项」）；各源 raw 名按同一套规则归到统一格式天然对齐（LMArena `Claude Opus 5 (High)`→claude-opus-5+High / OpenRouter `claude-opus-5`→claude-opus-5 / LiveBench `o3-mini-high`→o3-mini+high / llm-stats `model_id` 即 slug）；**归一化规则**：剥离程度/日期后缀 → 大小写与分隔符统一 → 多版本取最新（已定）→ 命中即对齐；失败/歧义进**人工登记表 `models-alias.json` 兜底**（同 official-url-registry 先例，只覆盖进入对比的模型子集）；**未对齐/单源独有模型独立展示**（仅该源数据），不进综合分加权；对齐后 integrated 记录形如 `{ canonical, display, degrees: {源→[变体]}, sources }`
- [x] **落库前核实三方数据许可（已核实，2026-08-18）**：LMArena 数据集 `lmarena-ai/leaderboard-dataset` = **cc-by-4.0**（hf-mirror API 实测；可存储再分发，**须署名**）；LiveBench 仓库 = **Apache-2.0（FastChat 部分）+ MIT（LiveCodeBench 部分）复合 LICENSE**（GitHub 标 NOASSERTION 因复合；宽松，署名即可）；OpenRouter = ⚠️ **可行 + 缓解**：ToS 禁「自动化爬取网站/服务信息」与「转售 API 访问/开发竞争服务」，但走官方免 key models API（文档化限速、第三方生态惯例用法）、不转售不竞争且外链引流 → **缓解（落库时落地）**：仅官方 API 不抓网页、频率受限速、前端署名 + 外链 openrouter.ai、定价标注「OpenRouter 挂牌参考价」非实时价
- [x] **parquet 下载只读解析 + schema 白名单校验（方案已定，2026-08-18；2026-08-19 改主用 C）**：LMArena 数据链路——**主用 C：datasets-server rows API 直取 JSON**（零依赖；HF 服务端把 parquet 转 JSON，本地仅 JSON.parse + 白名单校验；项目零依赖是刻意的、CI 无 npm install，故弃 hyparquet）→ **后备 A：hyparquet 纯 JS 只读解析**（C 通路不可用时启用）；两者均满足**绝不执行网络内容**；**schema 白名单校验 fail-closed**（按 config 校验列名集合 + 类型 + 行数；多余列/缺列/类型不符/超限 → 整文件拒绝，保留旧 raw 快照，WARN 具体原因）→ 转 JSON 写 `raw/lmarena.json`
- [x] **抓站 prompt 只取结构化字段（方案已定，2026-08-18）**：llm-stats 提取**主路径确定性、无 LLM**（RSC flight payload 解析 + 字段白名单校验 fail-closed）；**LLM 仅作兜底**——RSC 结构改版解析失败时启用，走**本地 Bonsai**（任务简单不需长上下文）经 requestStructuredJson（ledger 必传 fail-closed），且**只喂结构化 key:value 候选、绝不拼整页 prose**（防 R2 注入）；**字段白名单**：身份 model_id/name/organization/license/release_date + 规格 params/context/multimodal/is_moe + 性能 input_price/output_price/throughput/latency + 6 benchmark（aime_2025/hle/gpqa/swe_bench_verified/swe_bench_pro/mmmu_pro）+ 12 index（index_general/reasoning/math/code/search/communication/vision/tool_calling/long_context/finance/legal/healthcare）；**training_tokens/knowledge_cutoff 丢掉**（训练规模无用户意义；知识截止日期无展示位且覆盖率低，以后要「知识新鲜度」维度再加）；**三道闸**：结构化候选（去 prose）→ 字段白名单（去未知键）→ 值域校验（aime∈[0,1]、覆盖率非负、model_id 符合 slug）
- [ ] **SWE-bench 重新评估**（已搁置：提交驱动、数据少且旧；以后再说，工具集 `SWE-bench-Live/launch` 已核实保留）
- [x] **AA 许可落地**（已定）：AA 仅内部参考，对比页不公开显示 AA 数值 → 免费层合规
- [x] **实现决策（已定，2026-08-19）**：① parquet **主用 C**（datasets-server rows API 零依赖）、**A（hyparquet）后备**；② 调度走 **GitHub Actions cron 每日 + workflow_dispatch**，auto-commit `data/comparison/`；③ **AA 首批跳过**（二期，失败不阻塞 integrated）；④ 综合分 **rebuild 预计算**进 data.json（带 weights）；⑤ 工具对比 tab **逻辑重做**（复用柱状图组件）；⑥ 路由按类型：catalog api_model → 模型 tab（**标题→canonical 桥接**）、tool/套餐 → 工具 tab；⑦ 综合分**缺源时权重按比例重分配**（有分就能比，无分显示数据不足）；⑧ 默认勾选 = **综合分+推理+编码+Math**，进可配置文件；⑨ 来源 footer 每块带**平台名+许可证名+链接**；⑩ comparison 校验**接入 validate.js**（网络抽检延后）；⑪ 对比页文案走 **i18n**（t()+zh.js，en 二期）；⑫ **雷达图维度上限 12 条**；⑬ 首批**前端先行（mock integrated 数据）**、数据管线并行随后；index.json/data.json 契约先定死防返工

## 六、风险与说明

1. **LMArena agent 榜仅 49 个精选模型**，非全量；数据不含价格 → 定价从 OpenRouter / AA 补
2. **AA 免费层禁止公开展示**（见上文许可措辞）——开源身份不豁免
3. **llm-stats.com 是第三方独立站**：方法论自有、无 API、HTML 结构可能改版；作参考维度可，作权威主榜谨慎
4. **LiveBench 与 AA/LMArena 有维度重叠**，取舍需接受
5. LMArena 数据集与站点已用 1 个锚点模型全维度核对，其余模型同构未逐项核对（置信度高）

## 七、安全评估（2026-08-18 静态评估）

> 评估对象：上文定稿的数据获取方案（当前仅调研与文档，无抓取代码）。结论：**无高危**，核心风险集中在镜像供应链完整性、抓站内容注入、许可合规三处。

**中危**
- **R1 hf-mirror 供应链完整性**：LMArena 数据经第三方镜像拉取，理论上可被篡改。缓解：只读解析（parquet 反序列化，绝不执行网络内容）、下载后 fail-closed 结构/schema 白名单校验、定期与官方源抽查比对（并入维护 validate）
- **R2 抓站正文 prompt injection**（llm-stats / arena.ai）：第三方页面文本若拼进 LLM prompt 可预埋注入。缓解（项目已有模式）：只取结构化字段进 prompt、禁编造、枚举校验、ledger 必传

**合规（实现前必须确认，由 Claude 在落库时处理）**
- **R3 数据再分发许可**：AA 已定内部参考 ✅；LMArena 数据集 **cc-by-4.0（须署名）** / LiveBench 仓库 **Apache-2.0+MIT（署名即可）** / OpenRouter **⚠️ 可行+缓解**（仅官方 API、限速、署名外链、挂牌价标注）→ **已核实（2026-08-18）**

**低危 / 工程注意**
- **R4 凭据**：OpenRouter models list 免 key；未来任何 key 走 `.env` + `check-secrets.js`，不硬编码、不进前端
- **R5 前端 XSS**：模型名/分数等外部字段渲染 DOM 走 `escapeHtml`
- **R6 代理**：fallback 仅指向本机 `127.0.0.1:7897`；代理 URL 不塞凭据、代理 env 不进 CI
- **R7 稳定性**：抓站限速 + 合理 UA + 有限重试

## 八、数据维度与范围（2026-08-18 实测）

> 目的：为对比规则/排版设计提供「比什么、范围多大」。AA 用临时 key 实测（API 需 Pro → 内部参考走公开页抓取）；llm-stats 为第 6 源（可选待定，已实测）。

### 表 A：可量化维度（柱状图 / 雷达图数据，用户可任选勾选；AA 只做内部参考）

**① 综合分数（归一化到 0-100，多源并列参考）**

| 平台 | 维度 | 字段 | 原始范围（实测） | 归一化 |
|---|---|---|---|---|
| LMArena | 综合分数 | `score`（agent 榜） | -0.189 ~ +0.122 | `(x+0.3)/0.5×100` |
| LiveBench | 综合分 | 榜单聚合 | 0-100 | 原值 |
| llm-stats | LLM Stats Score | `index_general` | -12.9 ~ +57.4 | `(x+20)/80×100`（-20 映射 0、60 映射 100） |
| AA（仅内部） | Intelligence Index | 页面抓取 | 0-100（top 63） | 原值（不公开显示） |

> **加权综合分**（普通用户，已定）：开源模型且 llm-stats 有值 → `0.45×LMArena + 0.30×LiveBench + 0.25×LLM Stats Score`；否则 → `0.65×LMArena + 0.35×LiveBench`。作为「综合分数」主维度展示。

**② 细分可量化维度（用户任选勾选）**

| 平台 | 维度 | 字段/枚举 | 范围（实测） | 归一化 |
|---|---|---|---|---|
| LiveBench + llm-stats | **跨源合并细分维度（7 项，已定）** | 推理 `reasoning`（LB reasoning + idx reasoning）/ 编码 `coding`（LB coding + idx code）/ 沟通语言 `communication`（idx communication + LB language）/ 执行成功率 `instruction_following`（LB）/ 自主编程 `agentic_coding`（LB）/ 工具调用 `tool_calling`（idx）/ 长上下文 `long_context`（idx） | LB 0-100；idx 各约 -15.7~+56.9（可负） | 各映射 0-100 |
| llm-stats | index 专业人员补充（已定 3 项） | finance 金融 / legal 法律 / healthcare 医疗（**不参与普通用户默认对比，专业人员可选补充**） | 同上 | 各映射 0-100 |
| LMArena | 各榜分 | **已定拉取 15 config（2026-08-18）**：text / vision / webdev / search / text_to_image / image_edit / text_to_video / image_to_video / video_edit + **agent 5 子维度**（agent_praise_complaint 夸奖vs抱怨 / agent_steerability 可指挥性 / agent_bash_recovery_steps 终端恢复 / agent_tool_hallucination 工具幻觉 / agent_task_outcome_explicit 任务完成；评估 agent 能力维度，进 raw 留档，展示与否排版规则再定）；agent 供综合分 overall；document 不拉——无对应卡片 | 各量纲 | 各映射 |
| llm-stats | **4 个 benchmark 维度（精简已定）** | Knowledge `expert_knowledge`（gpqa+hle，GPQA 优先 HLE 兜底）/ Math `math_reasoning`（**aime_2025 优先 + LB math + idx math 兜底**）/ Multimodal `multimodal`（**mmmu_pro 优先 + idx vision 兜底**）/ SWE `swe_capability`（swe_bench_verified+swe-bench-pro，Pro 优先 Verified 兜底）；归一化后取非空、顶尖差异进详情卡片；**coding_arena 去掉**（与 LMArena 编码榜重复） | 覆盖 14~67% | 各映射 |
| OpenRouter | 定价（**仅柱状图可选**） | `pricing.prompt / completion / input_cache_read` | USD/token（25 免费 $0） | 越低越好 |
| llm-stats | 定价（**仅柱状图可选**） | `input_price / output_price` | $0.05~12.5 / $0.18~75 每 M | 越低越好 |
| 多源 | 速度（**暂不展示**） | 吞吐 / 延迟 | 各异（Celeris-1 1495 t/s 等） | 已定不展示（数据量少、口径不可比） |
| llm-stats | 参数量（所选模型支持时） | `params` | 0.8B ~ 2.8T | 对数刻度 |
| — | 性价比（已定） | 综合分 ÷ 定价 | — | 加权综合分 ÷ input/output 平均价，归一化 0-100 |

> ✅ **重叠已定（2026-08-18）**：数学并入 benchmark 组 Math（aime_2025 优先 + LB/idx math 兜底）；SWE 与 编码 **不同高度分开保留**（SWE=端到端软件工程、编码=一般代码生成）；自主编程 agentic_coding 与 SWE 概念相邻，暂按「自主性」vs「真实任务完成」区分保留。

### 表 C：其他数据（表格展示具体值，不归一化）

| 维度 | 内容 | 来源 |
|---|---|---|
| 上下文 | context_length token 数 | OpenRouter `context_length`；llm-stats `context`（**补充 OpenRouter 缺失模型**） |

> 其余维度表格展示待后续定：具体定价（**进详情卡片**）、程度变体（**模型对比时可选项**）；MoE 已定入表 B。吞吐/延迟已定**暂不展示**（数据量少、跨源口径不可比）。

### 表 B：不可量化维度（表格展示）

| 维度 | 取值 | 来源 |
|---|---|---|
| 是否免费 / 免费额度 | 免费 / 付费 / 免费额度 | OpenRouter `pricing.prompt=0` 等 |
| 访问方式（是否需翻墙） | 国内直连 / 需代理 | 人工维护 |
| 是否开源权重 | 开源 / 闭源 | LMArena `license`、OpenRouter `hugging_face_id` |
| license | Proprietary / Apache-2.0 / MIT… | LMArena `license`、OpenRouter |
| 厂商 / 组织 | anthropic / openai / qwen… | 各源 `organization` |
| 模态支持 | text / image / video → text | OpenRouter `architecture` |
| 是否 MoE | 是 / 否 | llm-stats `is_moe`（布尔标签，随参数量） |

### 各源实测备注

- **LMArena**：agent 榜 49 模型；`score` 为净提升比例（负分正常，如 -18.9%），越高越好、**归一化需处理负值**；`score_ci_lower/upper`、`observation_count/session_count` **不进对比维度**（不可见/不作评价），仅数据源核实保留；其余 21 个 config 字段同构、量纲各自不同
- **SWE-bench**：实时数据走 **SWE-bench-Live** `reports-0605.jsonl`（`name/set/total/resolved/date/url`，resolved% 自动算）；旧 `swe-bench/experiments` 的 `results.json` 状态桶结构（no_generation/generated/…/resolved）已过时，仅作历史参考
- **LiveBench**：`livebench/model_judgment`（HF，split=leaderboard）逐题 score 0/1，按 task/category 聚合成分；月度刷新 + 防污染
- **AA**：API `/language/models` **需 Pro 订阅**（免费 key 实测 `requires a Pro subscription`，认证头 `X-API-Key`）；内部参考改走公开页 Tavily 抓取（表格客户端渲染，原始 HTML 无数据）；当前 159 模型 / 84 开源
- **llm-stats**：358 模型（343 有 `index_general`），150 proprietary + ~208 非 proprietary；`index_general` 可负（-12.9 ~ +57.4），归一化需处理负值；数据在 Next.js RSC flight payload 提取，不依赖 DOM 结构

## 来源

- [Artificial Analysis Data API（含分层许可措辞）](https://artificialanalysis.ai/data-api/) — Free=internal only / Pro=restricted external / Commercial=redistribution
- [lmarena-ai/leaderboard-dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) — LMArena 官方数据集（49 模型，六维度，逐字段核对）
- [arena.ai/leaderboard/agent](https://arena.ai/leaderboard/agent) — 站点 agent 榜（核对源）
- [llm-stats.com Open LLM Leaderboard](https://llm-stats.com/leaderboards/open-llm-leaderboard) — 358 模型（343 有分，含 150 proprietary）、实时、无 API、RSC payload 提取
- [oolong-tea/arena-ai-leaderboards](https://github.com/oolong-tea-2026/arena-ai-leaderboards) — 第三方每日快照（不再需要，可作历史参考）
- [SWE-bench](https://www.swebench.com/) + [SWE-bench-Live 榜数据](https://github.com/SWE-bench-Live/swe-bench-live.github.io)（实时 reports-0605.jsonl）+ 旧 [swe-bench/experiments](https://github.com/swe-bench/experiments)（已过时，历史参考）
- [OpenRouter 模型列表 API](https://openrouter.ai/docs/api-reference/list-models) — 414 模型、全量定价、免 key
- [LiveBench 官方仓库](https://github.com/LiveBench/LiveBench) + [月度防污染说明](https://agentmarketcap.ai/blog/2026/04/09/livebench-2026-contamination-proof-benchmark-monthly-updates)
- [hf-mirror.com](https://hf-mirror.com) — HF 镜像（实测可用）
- [DeepSWE](https://deepswe.datacurve.ai/) — 已弃用

## 不确定性说明

- llm-stats.com 的「LLM Stats Score」方法论未深入核对（站点自有），引用其分数前需看其 methodology 页
- LiveBench 2026 变化基于媒体与仓库，未逐月拉 CSV 验证
- Open LLM Leaderboard（llm-stats）数据在 Next.js RSC flight payload，结构可能随改版变动；抓取方案需在实现时验证稳定性
- SWE-bench-Live 数据文件名 `reports-0605.jsonl` 固定（leaderboard.js 硬编码 + 时间戳参数），内容原地更新至 2026-08-17；实现时需确认是否有新快照文件名
