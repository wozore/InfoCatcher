# 对比页数据契约（integrated 层）

> 版本：2026-08-19 v1 草案。配合 `comparison-data-sources.md`（设计决策）阅读。本文定义 `data/comparison/` 的**数据文件契约**与**前端渲染规则映射**，是数据管线与前端共同的唯一事实源。设计决策如有冲突，以本文为准并回写设计文档。

## 1. 文件布局

```
data/comparison/
├── refresh-config.json          # 抓取编排配置（频率/fullEvery/config 清单/count 状态）——管线专用
├── view-config.json             # 前端展示配置（维护者可改，管线不覆盖）
├── models-alias.json            # 主键对齐人工登记表（管线读取）
├── aa-internal.json             # AA 内部参考（二期，本期不建）
├── raw/                         # 4 源快照（管线写，前端不读）
│   ├── openrouter.json
│   ├── lmarena.json
│   ├── livebench.json
│   └── llm-stats.json
└── integrated/                  # 前端唯一入口层（管线重建，前端只读）
    ├── index.json               # 小：模型列表 + 指针 + 综合分（选择器用）
    └── data.json                # 大：完整分数/定价/上下文/综合分（懒加载）
```

**关键约定**：
- 源 key 统一：`openrouter` / `lmarena` / `livebench` / `llm_stats`（JSON 内不用连字符，避免前端方括号访问）。
- `integrated/` 由 `rebuild-comparison.js` 全量重建；`view-config.json` / `models-alias.json` / `refresh-config.json` 为维护者手工维护，**管线不得覆盖**。
- 前端相对路径 fetch：`data/comparison/view-config.json`、`data/comparison/integrated/index.json`、`data/comparison/integrated/data.json`。

## 2. 维度键枚举（dimension keys，唯一）

| 键 | 中文标签（i18n key 见 §9） | 来源 | 归一化 |
|---|---|---|---|
| `composite` | 综合分 | 加权（rebuild 预计算） | 0-100 原值 |
| `expert_knowledge` | 知识问答 | llm-stats（gpqa 优先 hle 兜底） | accuracy×100 |
| `math_reasoning` | 数学推理 | aime_2025 优先 + LB math + idx math 兜底 | 见下 |
| `multimodal` | 图文多模态 | mmmu_pro 优先 + idx vision 兜底 | 见下 |
| `swe_capability` | 工程能力 | swe-bench-pro 优先 + verified 兜底 | 见下 |
| `reasoning` | 推理 | LB reasoning + idx reasoning | 见下 |
| `coding` | 编码 | LB coding + idx code | 见下 |
| `communication` | 沟通/语言 | idx communication + LB language | 见下 |
| `instruction_following` | 执行成功率 | LB | 0-100 原值 |
| `agentic_coding` | 自主编程 | LB | 0-100 原值 |
| `tool_calling` | 工具调用 | idx | 见下 |
| `long_context` | 长上下文 | idx | 见下 |
| `finance` / `legal` / `healthcare` | 金融/法律/医疗 | idx（专业人员可选） | 见下 |
| `text` / `vision` / `webdev` / `search` | LMArena 各榜分 | lmarena | 各榜 per-config 归一化 |
| `text_to_image` / `image_edit` | 图像生成/编辑 | lmarena | 同上 |
| `image_to_video` / `text_to_video` / `video_edit` | 视频生成/编辑 | lmarena | 同上 |
| `agent_praise_complaint` / `agent_steerability` / `agent_bash_recovery_steps` / `agent_tool_hallucination` / `agent_task_outcome_explicit` | agent 能力 5 子维度 | lmarena | 同上 |
| `value` | 性价比 | composite ÷ 平均定价 | 见下 |

**归一化口径**（统一到 0-100）：
- LMArena agent 榜（agent + 5 子维度）比例分：`(x+0.3)/0.5×100`（可负，clamp 0-100）。
- LMArena 其余 9 榜为 Elo rating（实测），与 agent 量纲不同 → **按 config 内 min-max 归一化到 0-100**（单值退化为 100）。
- llm-stats index 任一（含 index_general、reasoning/math/code/…）：`(x+20)/80×100`（-20→0、60→100），clamp 0-100。
- benchmark（aime_2025/hle/gpqa/swe_bench_*/mmmu_pro 均为 0-1 accuracy）：`x×100`。
- `value`：`加权综合分 ÷ ((input+output)/2 每 M 价)` → 再按全表 min-max 归一化 0-100。
- 所有维度**存原始值 raw + 归一化值 value**；前端只用 `value`。

## 3. integrated/index.json 契约

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-19T00:00:00Z",
  "model_count": 460,
  "sources": {
    "openrouter": { "fetched_at": "2026-08-19T00:00:00Z", "count": 414 },
    "lmarena":   { "fetched_at": "2026-08-19T00:00:00Z", "count": 320 },
    "livebench": { "fetched_at": "2026-08-19T00:00:00Z", "count": 58 },
    "llm_stats": { "fetched_at": "2026-08-19T00:00:00Z", "count": 358 }
  },
  "models": [
    {
      "canonical": "gpt-5.6-sol",
      "display": "GPT-5.6 Sol",
      "vendor": "openai",
      "theme": "general",
      "has_composite": true,
      "composite_score": 73.7,
      "degrees": { "lmarena": ["High", "XHigh"], "livebench": ["high"] },
      "sources": ["openrouter", "lmarena", "livebench", "llm_stats"],
      "file": "data.json"
    }
  ]
}
```

- `canonical`：主键 = 统一格式 Model 部分 slug（无 vendor 前缀）；`vendor` 单列。
- `composite_score`：可空（无综合分显示 null）——放这里让**选择器无需拉 data.json 即可按综合分排序**。
- `degrees`：该模型各源可选程度变体（供变体圆圈）；无变体则源缺失或空数组。
- `file`：完整数据所在文件，当前全部 `data.json`（分块时改此指针）。
- `sources`：有数据的源列表（前端标「仅 X 源」）。

## 4. integrated/data.json 契约

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-19T00:00:00Z",
  "models": [
    {
      "canonical": "gpt-5.6-sol",
      "display": "GPT-5.6 Sol",
      "vendor": "openai",
      "theme": "general",
      "license": "Proprietary",
      "open_source": false,
      "is_moe": false,
      "context_length": 400000,
      "modalities": ["text", "image"],
      "single_source": false,
      "degrees": { "lmarena": ["High", "XHigh"], "livebench": ["high"] },
      "default_degree": { "lmarena": "High", "livebench": "high" },
      "composite": {
        "score": 73.7,
        "weights": { "lmarena": 0.45, "livebench": 0.30, "llm_stats": 0.25 },
        "method": "proportional_redistribute",
        "note": null
      },
      "dimensions": {
        "composite":     { "value": 73.7, "source": "composite", "raw": 73.7 },
        "reasoning":     { "value": 82.0, "source": "livebench", "raw": 82.0 },
        "coding":        { "value": 78.0, "source": "livebench", "raw": 78.0 },
        "expert_knowledge": { "value": 85.0, "source": "llm_stats", "raw": 0.85, "note": "GPQA" },
        "math_reasoning": { "value": 90.0, "source": "llm_stats", "raw": 0.90, "note": "aime_2025" },
        "multimodal":    { "value": 76.0, "source": "llm_stats", "raw": 0.76, "note": "mmmu_pro" },
        "swe_capability": { "value": 70.0, "source": "llm_stats", "raw": 0.70, "note": "swe-bench-pro" },
        "text":          { "value": 81.0, "source": "lmarena", "raw": 0.10 },
        "vision":        { "value": 74.0, "source": "lmarena", "raw": 0.07 }
      },
      "lmarena_scores": {
        "agent": {
          "High":  { "score": 0.1219, "rank": 3 },
          "XHigh": { "score": 0.1100, "rank": 5 }
        },
        "text": { "High": { "score": 0.10, "rank": 8 }, "XHigh": { "score": 0.09, "rank": 9 } }
      },
      "livebench_scores": {
        "high": { "reasoning": 82.0, "coding": 78.0, "language": 74.0 },
        "low":  { "reasoning": 70.0, "coding": 66.0, "language": 63.0 }
      },
      "pricing": {
        "openrouter": { "prompt": 5e-6, "completion": 15e-6, "input_cache_read": 1e-6, "currency": "USD", "is_listed_price": true },
        "llm_stats":  { "input_per_m": 3.0, "output_per_m": 12.0 }
      },
      "value": { "score": 82.0, "raw": 1.9e-5, "note": "综合分/平均每M价" }
    }
  ]
}
```

**规则**：
- `dimensions`：**只放该模型有值的维度**；缺该维度的键 = 数据不足（前端显示「数据不足」，不画 0 柱）。`value` 0-100、`raw` 原始值、`source` 来源源 key、`note` 用的具体 benchmark/口径（如 "GPQA"/"aime_2025"/"挂牌参考价"）。
- `composite`：rebuild 预计算；`weights` = **实际应用权重**（缺源按比例重分配后），`method` ∈ `proportional_redistribute` | `missing`（无任何源 → composite 整体缺）。`score` 0-100。
- `lmarena_scores` / `livebench_scores`：**按程度变体的源级原始数据**，供变体圆圈切换时更新对应源显示。merged 维度与 composite 用 `default_degree` 预计算；v1 切换变体只更新**源级可见分数 + 文字说明**，不重算 merged/composite。
- `single_source`：仅一源有数据（如图像/视频模型只有 lmarena）→ 前端标「仅 X 源」、综合分 N/A。
- `pricing`：`openrouter` 为 USD/token（挂牌参考价，`is_listed_price: true`）；`llm_stats` 为每百万 USD。表格行展示具体值。
- 前端**不显示 `raw`**（仅留档/校验），不显示 `value` 以外任何中间态。

## 5. view-config.json（前端展示配置，维护者改）

```json
{
  "schema_version": 1,
  "default_dimensions": ["composite", "reasoning", "coding", "math_reasoning"],
  "radar_dimension_cap": 12,
  "model_cap": 5
}
```

## 6. models-alias.json（主键对齐人工登记表）

```json
{
  "schema_version": 1,
  "entries": [
    {
      "canonical": "some-base-model",
      "aliases": {
        "openrouter": ["vendor/raw-id-1", "vendor/raw-id-2"],
        "lmarena": ["Raw Brand Name (High)"],
        "livebench": ["raw-lb-name-high"],
        "llm_stats": ["raw_model_id"]
      }
    }
  ]
}
```
自动归一化（去程度/日期后缀、大小写与分隔符统一、vendor 前缀匹配）失败/歧义时，维护者在此登记；合并时命中优先于自动规则。

## 7. raw/ 快照形状（管线写）

- `raw/openrouter.json`：`{ "fetched_at": …, "data": [ …官方 API data 数组原样… ] }`（存全量 414）。
- `raw/lmarena.json`：`{ "fetched_at": …, "configs": { "agent": [行…], "text": [行…], … } }`，行字段 = 数据集原样，经 schema 白名单校验后落盘。config 拉取范围 = 设计文档已定 15 个。**两套行 schema（实测 2026-08-19）**：
  - agent 榜（`agent` + 5 个 agent 子维度）为**比例分**：`model_name/organization/license/score/score_ci_lower/score_ci_upper/observation_count/session_count/rank/category/leaderboard_publish_date`（`score` 为净提升比例，可负；CI 上下界与观测数可空）。
  - 其余 9 榜（`text/vision/webdev/search/text_to_image/image_edit/image_to_video/text_to_video/video_edit`）为 **Elo rating**：`model_name/organization/license/rating/rating_lower/rating_upper/variance/vote_count/rank/category/leaderboard_publish_date`。
  - datasets-server rows API 的 `filter` 参数实测无效 → 抓取按「每 config 限量取前段（overall 类别在数据中排前）+ 客户端收敛 `category='overall'`」实现，取各榜精选 top。
- `raw/livebench.json`：`{ "fetched_at": …, "release": …, "groups": [ …all_groups.csv 解析后行… ] }`（行 = `model` + 分组列 reasoning/coding/math/language/instruction_following/data_analysis/agentic_coding）。
- `raw/llm-stats.json`：`{ "fetched_at": …, "models": [ …白名单字段记录… ] }`（白名单见设计文档 line 156：身份 5 + 规格 4 + 性能 4 + 6 benchmark + 12 index；benchmark 字段实为 `aime_2025_score/hle_score/gpqa_score/swe_bench_verified_score/swe_bench_pro_score/mmmu_pro_score`）。

## 8. 前端渲染规则映射

| UI 区块 | 数据源 | 规则 |
|---|---|---|
| 模型选择器（模型 tab 顶部） | `index.json` models | 搜索 `display`+`vendor`；类别筛选 `theme`；默认按 `composite_score` 降序（null 排后）；展示 `display` + 源覆盖标记 |
| 已选 chips | 选择器结果 | 上限 `model_cap`；每 chip 内模型 icon 可点 → **变体圆圈** |
| 变体圆圈 | `data.json` 对应模型 `degrees`/`lmarena_scores`/`livebench_scores` | 点 icon → icon 周围顺时针 360° 平分圆圈（union 各源 degrees，去重）；点圈 → 源级分数更新 + 文字说明（如「已切换至 Claude Opus 5 (High)：LMArena agent 分 0.122→0.110」）；merged/composite 不重算 |
| 综合分块（默认勾选） | `dimensions.composite.value` | 柱状图块：每模型一行 icon+横向柱+数值 |
| 维度块（每勾选一个维度一块） | `dimensions[key].value` | 同综合分块；缺失键 → 显示「数据不足」不画柱 |
| 柱状图 ↔ 雷达图 | 同一组 toggle | 柱状图默认；雷达图仅 2 模型可用（≥3 提示）；N = 勾选维度数 ≤ `radar_dimension_cap`（12）；雷达为经典单 N 边形，模型1 标签左/模型2 右，**开启时放开页面限宽** |
| 表格视图（独立、不参与 toggle） | `data.json` 模型记录 | 行：license / open_source / vendor / modalities / is_moe / context_length / pricing（具体值）|
| 来源 footer | 每可视化块 | 块下右对齐「来源：平台名（许可证）+ 链接」；OpenRouter 参与的块加「挂牌参考价」 |
| 单源/无综合分模型 | 记录 `single_source`/`composite` | 标「仅 X 源」；综合分显示 N/A，不画 0 柱 |
| 路由（catalog 侧） | — | catalog `api_model` 卡 +对比 → 模型 tab（标题→canonical 桥接，models-alias 兜底）；`tool`/`subscription_plan` → 工具 tab |

## 9. i18n 键（进 `src/web/i18n/zh.js`）

`compare.tab.model` / `compare.tab.tool` / `compare.dimension.<key>`（§2 每键一条，如 `compare.dimension.reasoning`）/ `compare.source.footer`（模板：`来源：{name}（{license}）`）/ `compare.listedPrice` / `compare.dataInsufficient` / `compare.onlySource`（`仅 {source} 源`）/ `compare.noComposite` / `compare.variantSwitch`（`已切换至 {model}（{degree}）：{source} 分 {before}→{after}`）/ `compare.radarRequireTwo` / `compare.radarCapExceed`（`已选 N 个维度，雷达图仅显示前 12 个`）/ `compare.addModel` / `compare.removeModel` / `compare.searchModel`。

## 10. 实现红线（管线侧）

1. datasets-server rows API 主用、hyparquet 后备（零依赖，CI 不装 npm）。
2. 综合分 rebuild 预计算：缺源按比例重分配，无源则缺。
3. 调度：GitHub Actions cron 每日 + workflow_dispatch；全绿才重建 integrated；auto-commit `data/comparison/`。
4. AA 二期，本期不做（aa-internal.json 不建）。
5. 校验接入 validate.js：integrated 一致性 / canonical 唯一 / composite 与 raw 可复算 / raw schema。网络抽检延后。
6. 前端零依赖：柱状图 CSS、雷达图手写 SVG；对比页文案走 i18n。
