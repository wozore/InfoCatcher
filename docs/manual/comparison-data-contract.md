# 对比页数据契约（integrated 层）

> 版本：2026-08-22 v2.1。配合 `comparison-data-sources.md`（设计决策）阅读。本文定义 `data/comparison/` 的**数据文件契约**与**前端渲染规则映射**，是数据管线与前端共同的唯一事实源。设计决策如有冲突，以本文为准并回写设计文档。

## 1. 文件布局

```
data/comparison/
├── refresh-config.json          # 抓取编排配置（频率/fullEvery/config 清单/count 状态）——管线专用
├── view-config.json             # 前端展示配置（维护者可改，管线不覆盖）
├── models-alias.json            # 主键对齐人工登记表（管线读取）
├── model-exclusions.json        # integrated 整系列排除规则（raw 不删除）
├── model-series.json            # 系列/成员人工登记与展示顺序（管线读取）
├── aa-internal.json             # AA 内部参考（二期，本期不建）
├── raw/                         # 4 源快照（管线写，前端不读）
│   ├── openrouter.json
│   ├── lmarena.json
│   ├── livebench.json
│   └── llm-stats.json
└── integrated/                  # 前端唯一入口层（管线重建，前端只读）
    ├── index.json               # 小：系列投影 + 模型列表 + 指针 + 综合分（选择器用）
    └── data.json                # 大：完整分数/定价/上下文/综合分（懒加载）
```

**关键约定**：
- 源 key 统一：`openrouter` / `lmarena` / `livebench` / `llm_stats`（JSON 内不用连字符，避免前端方括号访问）。
- `integrated/` 由 `rebuild-comparison.js` 全量重建；`view-config.json` / `models-alias.json` / `model-series.json` / `refresh-config.json` 为维护者手工维护，**管线不得覆盖**。
- 前端相对路径 fetch：`data/comparison/view-config.json`、`data/comparison/integrated/index.json`、`data/comparison/integrated/data.json`。

**排除规则**：`model-exclusions.json` 只参与 integrated 重建，不删除或改写 `raw/` 快照。每条规则必须包含 `vendor`、排除理由，并且三选一配置 `identity_prefix`、`identity_prefixes` 或 `identities`：前两者采用 token boundary（identity 等于前缀，或以 `${prefix}-` 开头），`identity_prefixes` 为数组时可把多个命名前缀归入同一规则；`identities` 精确匹配 identity。规则在源记录收集后、Elo bounds、维度归一化、综合分、性价比和 series projection 之前执行，因此被排除记录不会影响剩余模型的归一化或产生空系列；重建诊断会返回完整命中列表，校验器拒绝 integrated 中残留的命中记录。

重建顺序固定为：

```text
collectSourceRecords → exclusions filter → Elo bounds → buildModelRecord
→ value → series projection → integrated index/data
```



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
- `value`：`ln(加权综合分 ÷ ((input+output)/2 每 M 价))` → 再按全表 min-max 归一化 0-100（价格/性能比跨数量级，先 ln 压缩再 min-max，避免超低价开源模型主导线性尺度、旗舰模型全贴 0；单调保序）。
- 所有维度**存原始值 raw + 归一化值 value**；前端只用 `value`。

## 3. integrated/index.json 契约

```json
{
  "schema_version": 2,
  "generated_at": "2026-08-19T00:00:00Z",
  "model_count": 460,
  "series_count": 120,
  "series": [
    {
      "series_key": "openai--gpt-5.6",
      "display": "GPT-5.6",
      "vendor": "openai",
      "member_count": 4,
      "model_count": 4,
      "members": [
        {
          "member_key": "openai--gpt-5.6-sol",
          "display": "基础版",
          "default_canonical": "openai--gpt-5.6-sol",
          "variant_count": 1,
          "variants": [{ "canonical": "openai--gpt-5.6-sol", "revision": null }]
        }
      ]
    }
  ],
  "sources": {
    "openrouter": { "fetched_at": "2026-08-19T00:00:00Z", "count": 414 },
    "lmarena":   { "fetched_at": "2026-08-19T00:00:00Z", "count": 320 },
    "livebench": { "fetched_at": "2026-08-19T00:00:00Z", "count": 58 },
    "llm_stats": { "fetched_at": "2026-08-19T00:00:00Z", "count": 358 }
  },
  "models": [
    {
      "canonical": "openai--gpt-5.6-sol",
      "identity": "gpt-5.6-sol",
      "family": "gpt-5.6",
      "revisions": [],
      "release_date": "2026-07-09",
      "release_date_provenance": "llm_stats",
      "evaluation_profiles": ["codex-harness"],
      "offerings": { "openrouter": [{ "kind": "batch", "raw_name": "openai/gpt-5.6-sol:batch" }] },
      "display": "GPT-5.6 Sol",
      "vendor": "openai",
      "theme": "general",
      "series_key": "openai--gpt-5.6",
      "series_display": "GPT-5.6",
      "member_key": "openai--gpt-5.6-sol",
      "member_display": "基础版",
      "member_order": 0,
      "member_variant_count": 1,
      "has_composite": true,
      "composite_score": 73.7,
      "degrees": { "lmarena": ["high", "xhigh"], "livebench": ["high"] },
      "sources": ["openrouter", "lmarena", "livebench", "llm_stats"],
      "file": "data.json"
    }
  ]
}
```

- `canonical`：v2 的选择器主键 = `<vendor>--<identity>`；若原始记录有明确发布日期，则为 `<vendor>--<identity>@<revision>`。`vendor` 不再只是展示字段，而是身份的一部分。
- `identity`：不含厂商和修订版的模型身份；必须保留产品等级、参数/MoE 规格、Base/Instruct/Thinking、模态和专用产品线。`family` 只用于搜索/归类，不能用于合并。
- `revisions`：该记录实际合并的明确修订版数组；带不同明确日期的记录绝不混算综合分。
- `evaluation_profiles`：已识别的评测运行环境，例如 `codex-harness`。它们不属于模型 identity，也不属于 `degrees`，因此不能生成选择器行或推理挡位圆圈。
- `offerings`：按源收拢的供应服务变体（`batch` / `free` / `fast` / `latest`）；它们不是选择器中的独立模型。
- `display`：面向选择器的唯一名称。只剥离发布日期、供应方式与已经解析为评测挡位的 token；参数规模、MoE、Base/Instruct/Thinking、模态等身份字段不得删除。相同厂商下规范化后的 display 必须唯一。
- `composite_score`：可空（无综合分显示 null）——放这里让**选择器无需拉 data.json 即可按综合分排序**。
- `degrees`：该模型各源可选程度变体（供变体圆圈）；无变体则源缺失或空数组。它与 `offerings`、模型身份规格严格分离。
- `file`：完整数据所在文件，当前全部 `data.json`（分块时改此指针）。
- `sources`：有数据的源列表（前端标「仅 X 源」）。
- `series`：轻量系列投影；只保存系列、成员与 canonical 变体引用，不复制完整分数。`series_key` 是选择器分组键，`member_key` 是系列内具体产品键；`series.members[].theme` 是成员类型（值与 model 层 `theme` 一致，用于类别筛选）。
- `series_key` / `series_display`：人工登记优先的系列归属与展示名；自动回退只用于组织未登记模型，不能用于 canonical 合并。
- `member_key` / `member_display`：系列内具体产品/模型的稳定键与短名；同一 `member_key` 的多个明确 revision 收拢到 `series.members[].variants`，选择器默认只显示一个成员行。
- `degree`、`evaluation_profile`、`offering` 与 revision：配置层信息，不生成系列成员；degree 仍由模型完整数据中的 `degrees` 提供，revision 通过成员变体选择。
- `theme`：模型类型分类，值域 `general` / `image` / `video` / `vision`。由管线按评测维度自动判定——有视频生成维度（`text_to_video` / `image_to_video` / `video_edit`）→ `video`；有图像生成维度（`text_to_image` / `image_edit`）→ `image`；仅有 `vision` 榜分且无 `text` / `reasoning` / `coding` / `multimodal` 维度 → `vision`；否则 `general`。判定后按所属 member 主变体统一（同一 `member_key` 的 revision 变体同类型，防数据不全误判）。前端类别筛选按此值与 `series.members[].theme` 消费；validate 校验 model 与 member 的 theme 值域、以及 `series.members[].theme` 与主变体模型 theme 的一致性。

## 3.1 model-series.json（系列人工登记）

```json
{
  "schema_version": 1,
  "series": [
    {
      "series_key": "openai--gpt-5.6",
      "display": "GPT-5.6",
      "vendor": "openai",
      "match": { "vendor": "openai", "identity_prefix": "gpt-5.5" },
      "member_rules": [
        { "identity": "gpt-5.5", "display": "基础版", "order": 0 },
        { "identity_prefix": "gpt-5.5-pro", "display": "Pro", "order": 20 }
      ]
    }
  ]
}
```

人工登记只影响系列容器和展示顺序，不改变 `canonical`、源级分数或综合分。匹配重叠时以登记数组中更具体的规则优先；无法安全判断的模型回退为独立的 `<vendor>--<family>` 系列。

`match` 支持单个 `identity_prefix`，或使用 `identity_prefixes` 数组把同一型号的多个命名变体（如 `hy3` / `hunyuan-hy3`）合并进同一系列——数组内任一前缀命中即归属，排序时取数组内最长前缀参与优先级比较（最长前缀优先，避免 `hy3` 误吞其它家族）。例如：
```json
{ "match": { "vendor": "tencent", "identity_prefixes": ["hunyuan-hy3", "hy3"] } }
```


```json
{
  "schema_version": 2,
  "generated_at": "2026-08-19T00:00:00Z",
  "models": [
    {
      "canonical": "openai--gpt-5.6-sol",
      "identity": "gpt-5.6-sol",
      "family": "gpt-5.6",
      "revisions": [],
      "release_date": "2026-07-09",
      "release_date_provenance": "llm_stats",
      "evaluation_profiles": ["codex-harness"],
      "offerings": { "openrouter": [{ "kind": "batch", "raw_name": "openai/gpt-5.6-sol:batch" }] },
      "display": "GPT-5.6 Sol",
      "vendor": "openai",
      "theme": "general",
      "license": "Proprietary",
      "open_source": false,
      "is_moe": false,
      "context_length": 400000,
      "modalities": ["text", "image"],
      "single_source": false,
      "degrees": { "lmarena": ["high", "xhigh"], "livebench": ["high"] },
      "default_degree": { "lmarena": "high", "livebench": "high" },
      "composite": {
        "score": 73.7,
        "weights": { "lmarena": 0.45, "livebench": 0.30, "llm_stats": 0.25 },
        "method": "proportional_redistribute",
        "available": { "lmarena": 77.8, "livebench": 80.2, "llm_stats": 86.6 },
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
      "value": { "score": 82.0, "raw": 1.52, "note": "ln(综合分/平均每M价)" }
    }
  ]
}
```

**规则**：
- `dimensions`：**只放该模型有值的维度**；缺该维度的键 = 数据不足（前端显示「数据不足」，不画 0 柱）。`value` 0-100、`raw` 原始值、`source` 来源源 key、`note` 用的具体 benchmark/口径（如 "GPQA"/"aime_2025"/"挂牌参考价"）。
- `composite`：rebuild 预计算；`weights` = **实际应用权重**（缺源按比例重分配后），`method` ∈ `proportional_redistribute` | `missing`（无任何源 → composite 整体缺）。`score` 0-100。`available` = **源级可用归一化分**（`lmarena`=agent 比例分、`livebench`=LB 七组均值、`llm_stats`=index_general；仅含实际可用源）——供前端切挡位时重算综合分（llm_stats 恒定，lmarena/livebench 随挡位变）。
- `lmarena_scores` / `livebench_scores`：**按程度变体的源级原始数据**，供变体圆圈切换时更新对应源显示。`lmarena_scores` 只存默认评测环境可用的分数；评测环境专用结果进入 `lmarena_profiles`，以 `config → evaluation_profile → degree → {score,rank}` 保留，既不覆盖默认分数也不制造模型行。merged 维度与 composite 用 `default_degree` 预计算；v1 切换变体只更新**源级可见分数 + 文字说明**，不重算 merged/composite。
- `single_source`：仅一源有数据（如图像/视频模型只有 lmarena）→ 前端标「仅 X 源」、综合分 N/A。
- `pricing`：`openrouter` 为 USD/token（挂牌参考价，`is_listed_price: true`）；`llm_stats` 为每百万 USD。表格行展示具体值。
- `source_names`：各源实际参与当前记录的原始名称，供审计；`offerings` 记录被收拢的服务变体，二者均不由前端拿来做实体合并。
- 前端**不显示 `raw`**（仅留档/校验），不显示 `value` 以外任何中间态。

## 5. view-config.json（前端展示配置，维护者改）

```json
{
  "schema_version": 1,
  "default_dimensions": ["composite", "value"],
  "radar_dimension_cap": 12,
  "model_cap": 5
}
```

- `default_dimensions` 为前端**默认勾选**的维度（当前仅综合栏：综合分 + 性价比），其余维度浏览态可手动勾选，维护者可调整。选择模型后勾选面板**只公开所选模型共有且不缺省（有值）的维度**，未公开维度强制不勾选、不可勾选；取消选择回到浏览态恢复全部维度。图块渲染是实时的：无选择时显示各维度 Top N 排行，选择模型后仅显示「所有已选模型都有数据」的维度。

## 6. models-alias.json（主键对齐人工登记表）

```json
{
  "schema_version": 2,
  "vendor_aliases": {
    "mistral": ["mistral", "mistralai"],
    "qwen": ["qwen", "alibaba"]
  },
  "entries": [
    {
      "model_key": "anthropic--claude-opus-4.8",
      "display": "Claude Opus 4.8",
      "aliases": {
        "openrouter": ["anthropic/claude-opus-4.8"],
        "lmarena": ["claude-opus-4-8-high"],
        "livebench": ["claude-opus-4-8-max-effort"],
        "llm_stats": ["claude-opus-4-8"]
      }
    }
  ],
  "never_merge": [["qwen--qwen3-8b", "qwen--qwen3-32b"]]
}
```

自动规则只处理无歧义格式差异：大小写、空格/下划线/连字符、位于版本位置的点号/连字符、已识别的日期和服务方式。它**不得**删除或互并参数规模、MoE 规格、Base/Instruct/Thinking、模态、Codex/Realtime 等身份字段。

自动归一化仍无法可靠判断、或来源名缺少关键规格时，维护者必须在此登记精确 alias；命中人工 alias 优先于自动规则。`never_merge` 用于永久保护容易被误并的型号。一个 `(source, raw alias)` 只能登记到一个 `model_key`。

### 歧义命名 AI 审计

AI 审计不参与 `rebuild`，也不得直接写入 `models-alias.json`。确定性解析 Module 先输出无法分类的 token；离线审计再使用本地 Bonsai API 生成受 JSON schema 约束的建议，只有本地结果低置信、输出不合法、跨源冲突、或建议会触及既有合并/`never_merge` 时才升级到 DeepSeek。所有建议均须人工确认，确认后的规则才可写入人工登记表；因此正式 `integrated` 始终可复现。

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
| 模型选择器（模型 tab 顶部） | `index.json` series + models | 先按 `series` 渲染系列容器，再展开 `members` 选择具体 canonical；搜索同时匹配系列、成员、vendor、canonical/display，命中成员时只突出该成员；类别筛选按成员 theme（chips：通用/图像生成/视频生成/纯视觉理解，默认落在通用），切换类别时已选的其他类别模型自动移出；系列按最高有效 `max_composite_score` 排序，成员按人工 order；前端不得按名称去重或合并实体。revision 只在成员内的 `variants` 下拉选择，degree/profile/offering 不生成成员行。 |
| 已选 chips | 选择器结果 | 上限 `model_cap`；每 chip 内模型 icon 可点 → **变体圆圈** |
| 变体圆圈 | `data.json` 对应模型 `degrees`/`lmarena_scores`/`livebench_scores` | 点 icon → icon 周围顺时针 360° 平分圆圈（**仅列「有 ≥2 个挡位」的源的挡位并集**；单挡位源不是可切换变体不列圈，避免点了只搭别源上次挡位导致得分随历史漂移）；点圈 → **按所选挡位重算并实时反映**：源级维度（lmarena agent 子维比例分 / Elo 榜按全模型 min-max；livebench 组 → reasoning/coding/communication/instruction_following/agentic_coding/math_reasoning）+ composite（`composite.available` 底座，lmarena/livebench 源级分换挡，缺源按比例重分配）+ value（全表 min-max），然后重渲染图表/表格；状态说明如「已切换至 Claude Opus 5 (High)：LMArena agent 分 0.122→0.110」 |
| 综合分块（默认勾选） | `dimensions.composite.value` | 柱状图块：每模型一行 icon+横向柱+数值 |
| 维度块（实时渲染） | `dimensions[key].value` | 默认仅勾选综合分与性价比（`view-config.default_dimensions`）；无选择 → 每维度显示 Top N 排行（浏览态，勾选面板显示全部维度）；选择后 → 勾选面板**只公开所选模型共有且不缺省的维度**（未公开强制不勾选、不可勾选），图块仅当**所有已选模型**都有该维度数据时显示（缺任一即不显示，无「数据不足」行）；`value` 维走 `model.value.score`。柱状图为**竖柱状图**：每模型一簇、簇内各维度柱相连无缝、柱顶标真实数值、右上角图例（颜色=维度，同一维度跨模型同色）；每维度统一满高——该维度在图表内最大值顶到满高，其余按 `value/最大值` 比例量化（柱顶数值仍为真实 value） |
| 柱状图 ↔ 雷达图 | 同一组 toggle | 柱状图默认；雷达图仅 2 模型可用（≥3 提示）；N = 勾选维度数 ≤ `radar_dimension_cap`（12）；雷达为经典单 N 边形，模型1 标签左/模型2 右；**图表模式（柱状图/雷达图）均放开页面限宽**（`main:has(#view-compare.active.cmp-chart-active){max-width:none}`，柱状图 SVG 随容器等比放大，窄屏回退定高 280px；表格视图仍受限宽） |
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
5. 校验接入 validate.js：integrated 一致性 / canonical 唯一 / 同厂商可见 display 唯一 / alias 一对一 / 不同明确修订版不混分 / composite 与 raw 可复算 / raw schema。网络抽检延后。
6. 前端零依赖：柱状图 CSS、雷达图手写 SVG；对比页文案走 i18n。
7. **空壳模型自动过滤（代码规则，非清单）**：合并后无任何有效评测维度且无综合分的模型，当同一 identity 的**所有** revision 均无数据时整组从 integrated 移除；任一 revision 有数据则整组保留（不误杀主变体）。过滤在综合分/性价比计算后、series projection 前执行，随抓取数据动态生效——模型日后获得评测数据会自动回归，无需维护排除登记表。此规则与 `model-exclusions.json`（人工永久排除）职责分离；被过滤模型进 `diagnostics.empty_filtered_models`，raw 快照保留。
8. **revision 日期规范化（代码规则）**：canonical 的 `@revision` 统一解析为 (year,month,day) 后再拼键。本年不显示年份（`MM-DD` / 月级 `MM`），往年保留（`YYYY-MM-DD` / `YYYY-MM`）；无年份的 MMDD/MM-DD 用系统年份推断，推断日期落在未来（数据源给出的是已发布版本）则回退到上一年；4 位纯数字按月份有效性区分 MMDD（前两位 01-12）与 YYMM（前两位 > 12，推断 20xx 世纪）。同一日期不同写法（如 `0731` 与 `20260731`）规范化后同键，自动合并为同一 revision，不混算分数。重建时以 `options.now` 为基准（默认当前时间），保证可测。
9. **14 个月滚动删除（retention，代码规则 + 共享数据段，数据耦合）**：全局删除边界 cutoff = 当前年月 − 14 个月，持久化在 `data/shared/retention.json`（comparison 管线每月初幂等推进写，catalog `prune` 只读）。模型 `release_date`（发布时间，多源解析：llm-stats → catalog 反查 → openrouter created → null）早于 cutoff 月首日 → 重建时在 Elo 计算前排除（`retention_filtered_models` 诊断）；catalog 工具/模型按 `last_updated_date`/`release_date` 早于 cutoff → 级联删除过期卡（复用事务）。无日期实体保守保留（`retention_retained_null_models` 诊断 + validate 警告）。

**共享数据段访问层（红线）**：`data/shared/` 是 comparison 与 catalog 之间**唯一**跨层通道，只存在数据耦合，两侧不互相 import 数据层模块、不读写对方私有文件、不裸 fs 碰共享文件。共享段只经 `src/shared/` 校验接口访问：

| 共享文件 | 写者（唯一） | 读者 |
|---|---|---|
| `data/shared/retention.json` | comparison `advanceRetentionToNow`（幂等推进 + 校验 + 原子写） | catalog prune `readRetentionState`、validate |
| `data/shared/model-release-dates.json` | comparison 重建 `writeReleaseIndex`（逐条校验 fail-closed） | catalog 生成器 `readReleaseIndex` |
| `data/shared/catalog-release-dates.json` | catalog 落盘后 `writeCatalogReleaseDates`（事务提交后发布） | comparison 反查 `readCatalogReleaseDates` |

- **数据耦合 = 封装 + 只公开接口**：写路径形状校验 fail-closed（防误篡改），读路径返回校验后冻结结构；业务模块只依赖接口函数，不感知底层文件。
- **catalog → comparison 反查经共享投影**：comparison 不再直接读 catalog `tool-preview-level3.json`；catalog 每次落盘后把 api_model/product_variant 的 release_date 发布为 `catalog-release-dates.json`（可再生的派生投影，失败降级不进事务回滚链，comparison 读端校验 + 空默认兜底）。
- **手动 `rebuild` 同样应用共享 cutoff**：`fetch-comparison.js rebuild` 读 `readRetentionState().cutoff_date`，与 `run` 一致，避免旧模型回潮。共享段不进前端 dist（`build-dist` 不复制 `data/shared/`）。
