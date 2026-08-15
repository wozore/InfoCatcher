# 五模块目录生成器手动使用说明

本文说明如何在 Windows 上手动把一个新工具、API 模型或订阅套餐加入五模块目录。

## 1. 前置条件

需要：

- Node.js；
- 在项目根目录执行命令；
- 目录模块配置的 DeepSeek provider 对应 API Key 环境变量（默认是 `DEEPSEEK_API_KEY`）；
- 官方资料搜索和正文提取使用 Tavily。Search/Extract 默认走 **keyless**（免费、无需 `TAVILY_API_KEY`）；配置 `TAVILY_API_KEY` 仅用于 keyless 小时额度耗尽时的自动回退，以及 keyed 端点（map/crawl/research）。可选环境变量 `TAVILY_ACCESS_MODE=auto|keyless|keyed` 可一键强制认证模式；
- 目录生成器不再使用 DeepSeek `web_search`。Tavily Search 负责发现官方来源，Tavily Extract 负责返回清洗后的正文，DeepSeek 单段式基于官方来源正文合成五层字段与来源 provenance（不再有 AtomicClaim 中间层）。

API Key 只通过环境变量读取，不要写入 Seed、配置文件、BAT、草案或目录 JSON。

### CMD 临时设置

```bat
set DEEPSEEK_API_KEY=你的DeepSeek_API_Key
set TAVILY_API_KEY=你的Tavily_API_Key
```

### PowerShell 临时设置

```powershell
$env:DEEPSEEK_API_KEY = "你的DeepSeek_API_Key"
$env:TAVILY_API_KEY = "你的Tavily_API_Key"
```

关闭当前终端后，临时设置会失效。不要把真实 Key 粘贴到 Git 或文档中。

## 2. provider、model 与模块配置

目录生成器使用项目根目录的 `config/catalog-generator.local.json` 作为本地配置；该文件只写配置，不写任何 API Key。可复制 `config/catalog-generator.example.json` 后按需修改。配置按业务大模块组织，本轮实际接通的是 `catalog`：

```json
{
  "modules": {
    "catalog": {
      "enabled": true,
      "provider": "deepseek",
      "retrieval_provider": "tavily",
      "model": "deepseek-v4-flash",
      "protocol": "responses",
      "timeout_ms": 180000,
      "max_search_queries": 4,
      "max_pages": 8,
      "max_responses_calls": 12,
      "max_synthesis_calls": 1,
      "max_repair_calls": 1
    },
    "news": {
      "enabled": false,
      "provider": "deepseek",
      "model": "deepseek-chat",
      "protocol": "responses"
    }
  }
}
```

- `provider` 选择字段合成的模型厂商；当前目录生成器默认使用 DeepSeek Responses API。
- `retrieval_provider` 固定为 `tavily`；Tavily Search 发现来源，Tavily Extract 获取清洗后的正文。
- `model` 选择 DeepSeek provider 的模型；OpenAI 等没有默认模型的 provider 必须显式填写。
- `protocol` 必须与 provider 匹配；当前目录生成器只执行 `responses`，Messages API 会 fail-closed，不会发请求。
- API Key 只按职责从环境变量读取：DeepSeek 使用 `DEEPSEEK_API_KEY`，Tavily 使用 `TAVILY_API_KEY`；Key 不进入配置文件。
- `max_search_queries`、`max_pages`、`max_responses_calls`、`max_synthesis_calls` 是执行前就生效的硬上限；搜索请求、正文 URL 和模型请求均在执行前扣减，额度不足时返回 `COST_BUDGET_EXHAUSTED`。
- `resume --confirm-cost` 表示维护者授权一组新的增量硬预算；历史消耗仍保留在 Draft 成本账本中，不会被重置。
- `news` 配置目前只是统一配置预留；新闻现有执行链路仍是旧 Chat Completions，本轮没有迁移到 Tavily。

配置只读取 `modules.catalog`。

### 启动方式

双击后会显示中文指令菜单：

| 指令 | 功能 | 网络/API | 是否修改正式目录 |
|---|---|---|---|
| `plan --seed <file>` | 离线计算 CatalogProfile、ResearchScope、LayerPlan 和硬成本计划 | 否 | 否 |
| `prepare --seed <file>` | `plan` 的兼容别名；只输出离线计划 | 否 | 否 |
| `probe --confirm-cost` | 检查 Tavily 检索和 DeepSeek 合成配置 | 会调用一次 Tavily | 否 |
| `new --seed <file> --confirm-cost` | 按计划联网研究并生成 schema v3 Preview Draft | 会联网并可能产生费用 | 否 |
| `resume <draft-id> --confirm-cost` | 只补 FieldCoverage 中仍缺失字段对应的层来源并重新合成 | 会联网并可能产生费用 | 否 |
| `list` | 列出草案及状态 | 否 | 否 |
| `review <draft-id>` | 重算字段覆盖、LayerPatch、Preview hash 和目录版本 | 否 | 否 |
| `apply <draft-id>` | 等待 `APPLY <draft-id>` 确认后正式写入 | 通常不需要 AI 调用 | 是 |
| `cancel <draft-id>` | 删除尚未 Apply 的草案 | 否 | 否 |
| `recover` | 恢复中断的目录事务 | 否 | 可能回滚本地事务文件 |

其中 `probe`、`new` 和 `resume` 可能产生 API 费用；先用 `plan` 查看本次 ResearchScope 和硬上限。`apply`、`cancel` 和 `recover` 可能修改本地文件。

输入完整命令后按回车执行，例如：

```text
probe --confirm-cost
```

也可以在 CMD 或 PowerShell 中直接带参数执行：

```bat
bat\catalog-generator.bat probe --confirm-cost
```

双击后直接按回车会退出，不会修改任何文件。命令执行完毕后窗口不会自动进入下一轮交互；需要执行下一条命令时重新双击 BAT，或在终端中再次运行。

## 3. 先检查 Tavily 检索和 DeepSeek 提取配置

在项目根目录执行：

```bat
bat\catalog-generator.bat probe --confirm-cost
```

这会执行一次最小 Tavily 动态检查，可能产生 API 调用费用。成功时应看到：

- Tavily 检索 provider；
- DeepSeek 提取 provider 和 model；
- 可审计官方来源数量。

常见失败：

- `TAVILY_SEARCH_AUTH_REQUIRED`：keyed 模式（`TAVILY_ACCESS_MODE=keyed` 或 keyed 端点）下当前终端没有 `TAVILY_API_KEY`；
- `TAVILY_SEARCH_RATE_LIMITED` / `TAVILY_SEARCH_FAILED`：Tavily Search 被限流或返回失败；
- `TAVILY_EXTRACT_FAILED`：官方页面正文提取失败，来源会保留但字段合成证据不足；
- `DEEPSEEK_AUTH_REQUIRED`：当前终端没有 `DEEPSEEK_API_KEY`；
- `DEEPSEEK_RATE_LIMITED` / `DEEPSEEK_TIMEOUT`：DeepSeek 字段合成请求失败；
- `DEEPSEEK_SYNTHESIS_EMPTY`：DeepSeek 没有返回文本；
- `DEEPSEEK_SYNTHESIS_INCOMPLETE`：DeepSeek 响应被截断，Draft 会保存 `response_status`、`incomplete_reason` 和有限输出预览；
- `DEEPSEEK_SYNTHESIS_OUTPUT_INVALID`：DeepSeek 返回的文本不是可解析 JSON；
- `DEEPSEEK_SYNTHESIS_SCHEMA_INVALID`：返回了 JSON，但缺少 `layer_fields` 对象或结构不符合约束；
- DeepSeek 的 JSON 外壳允许有限归一化，但每个字段仍必须引用真实官方来源并通过 FieldCoverage 本地门禁；
- `SYNTHESIS_COVERAGE_INCOMPLETE`：CatalogProfile 的适用字段仍无值、仍是占位或未引用官方来源；Draft 保持 `preview_blocked`；
- `PROFILE_MISMATCH_SUSPECTED`：`api_model` 缺少访问方式、价格徽标或 API 计价等类型成立所必需的字段；继续检索官方 developer/API/pricing/credits 资料，仍找不到时可人工考虑改建为 `product_variant`，生成器不会自动改类；
- `SYNTHESIS_INVALID` / `LAYER_PATCH_INVALID`：派生字段引用不存在的官方来源、记录字段不完整、存在空值，或字段缺少 provenance；
- `COST_BUDGET_EXHAUSTED`：某类硬成本额度已耗尽，本次不会继续发请求；可审核已有来源后执行一次明确授权的 `resume --confirm-cost`；
- `DRAFT_SCHEMA_UNSUPPORTED`：旧 schema Draft 不能进入新的 Review/Apply 路径。

## 4. 准备 Seed 文件

创建一个临时 JSON 文件，例如 `data/manual/catalog-seed.json`。Seed 只写你已知的业务信息，不需要手工填写五份目录 JSON，也不要填写稳定 ID。
- 如果 `name` 无法稳定转成 ASCII 业务键，需要手工填写 `tool_key`；如果 `vendor_name` 无法稳定转成 ASCII 业务键，需要手工填写 `vendor_key`。
- `modality` 与 `detail_kind` 共同决定 CatalogProfile。API 模型必须明确 `text`、`video`、`image` 或 `audio`，不能让视频模型落入文本 token/context 假设。
- `known_fields` 只放维护者已经确定的结构提示；当前稳定支持 `theme` 和 `icon`。摘要、价格、访问方式与场景仍必须从官方来源正文派生，不能用 `known_fields` 绕过证据门禁。
- `repair_layers` 用于声明本次确实需要替换的污染层；未列入且已存在的健康层为 `noop`，不会因新增一个模型而重写厂商资料。

生成器对本次新建或替换的记录执行严格完整性校验：每个适用契约字段都必须是非空、类型正确的明确值，禁止 `null`、空字符串、空数组、`unknown/未知` 等占位值。`one_m_context`、`api_pricing` 或 `plan` 确实不适用时，必须使用：

```json
{
  "status": "not_applicable",
  "reason": "该字段为何不适用于当前记录"
}
```

官方来源正文直接支撑字段合成：DeepSeek 一次调用按层生成全部字段，每个字段引用一个或多个 `source_id` 作为 provenance。摘要、特点、场景和适合/不适合说明属于 `DerivedField`，必须保留来源 IDs。官方资料未覆盖任一适用字段时，FieldCoverage 会保持 missing，Draft 不能 Apply。

### 普通工具

```json
{
  "detail_kind": "tool",
  "name": "Example Writer",
  "vendor_name": "Example Vendor",
  "vendor_key": null,
  "tool_key": null,
  "official_url": "https://example.com",
  "placement": {
    "existing_level1_ref": null,
    "existing_level2_ref": null,
    "new_group_title": "Products"
  },
  "known_fields": {
    "theme": "general"
  },
  "discovery_sources": [
    {
      "url": "https://example.com",
      "kind": "official_hint"
    }
  ]
}
```

### API 模型

只需把类型改为 `api_model`：

```json
{
  "detail_kind": "api_model",
  "modality": "video",
  "name": "Example Video Model",
  "vendor_name": "Example Vendor",
  "vendor_key": "example-vendor",
  "tool_key": "example-video-model",
  "official_url": "https://example.com/models/example-video-model",
  "repair_layers": [],
  "placement": {
    "existing_level1_ref": null,
    "existing_level2_ref": null,
    "new_group_title": "Models"
  },
  "known_fields": {
    "theme": "media"
  },
  "discovery_sources": [
    {
      "url": "https://example.com/developer",
      "kind": "official_hint"
    },
    {
      "url": "https://example.com/pricing",
      "kind": "official_hint"
    }
  ]
}
```

API 模型会生成三级详情和工具卡；厂商卡、一级、二级是否创建或替换由 LayerPlan 决定。`api_model:video` 必须覆盖访问方式、价格徽标、API 计价、时长、分辨率、音频和语言等字段；`one_m_context` 与订阅 `plan` 由 Profile 确定为结构化不适用。

### 订阅套餐

```json
{
  "detail_kind": "subscription_plan",
  "name": "Example Pro",
  "vendor_name": "Example Vendor",
  "official_url": "https://example.com/pricing",
  "placement": {
    "existing_level1_ref": null,
    "existing_level2_ref": null,
    "new_group_title": "Plans"
  },
  "known_fields": {},
  "discovery_sources": []
}
```

订阅套餐只生成三级详情并进入二级 `detail_refs`，不会生成工具卡。

### 加入已有厂商或已有分组

可以在 `placement` 中指定稳定引用，例如：

```json
{
  "existing_level1_ref": {
    "kind": "vendor-level1",
    "id": "vendor-level1:example"
  },
  "existing_level2_ref": {
    "kind": "vendor-level2",
    "id": "vendor-level2:example:models"
  }
}
```

如果只指定已有一级而不指定已有二级，需要提供 `new_group_title`，生成器会新增二级分组并向一级追加引用。

### 显式修复已有层

修复已 Apply 的污染记录时，优先在 Seed 顶层列出需要替换的层：

```json
{
  "repair_layers": [
    "vendor-card",
    "vendor-level1",
    "vendor-level2",
    "tool-level3",
    "tool-card"
  ]
}
```

LayerPlan 对每层独立判定：目标不存在是 `create`；目标存在且列入 `repair_layers` 是 `replace`；目标存在且未列入是 `noop`。兼容旧 `"operation":"replace"`，但它会把五层都视为修复目标，不适合只修模型层。

替换不是静默 upsert：目标必须已存在、稳定业务键必须匹配，否则生成器 fail-closed。Review 会显示每个 LayerPatch 的 `create/replace/noop`；Apply 仍使用 revision、preview hash、共同锁、staging、backup、journal 与回滚事务。普通 create 遇到相同 ID 时仍返回 `ID_CONFLICT`。

## 5. 生成草案 Preview

先执行零网络计划：

```bat
bat\catalog-generator.bat plan --seed data\manual\catalog-seed.json
```

确认输出中的 `profile`、三个 ResearchScope、每层 `create/replace/noop` 和硬成本上限后，再执行：

```bat
bat\catalog-generator.bat new --seed data\manual\catalog-seed.json --confirm-cost
```

`new` 会依次执行：

1. 根据 `detail_kind + modality` 选择 CatalogProfile，并计算需要研究的 vendor/group/detail scope；
2. 使用 Tavily Search 按官方域名和谓词联想搜索 developer/API/OpenAPI/pricing/credits/specifications 等资料；
3. canonicalize URL、过滤非官方域名，再用 Tavily Extract 获取清洗后的 markdown/text 正文；
4. DeepSeek 不使用 web tools，单段式直接基于各层官方来源正文合成全部层字段与来源 provenance；
5. 计算 FieldCoverage；任一适用字段缺值、占位或未引用官方来源时保持 blocked；
6. 验证每个字段引用的 source_id 真实存在，并校验记录完整性；
7. 本地生成每层完整的 `create/replace/noop` LayerPatch，禁止空值、`null`、空数组和 `unknown/未知`；
8. 校验 FutureSnapshot、revision 与 Preview hash；
9. 将 schema v3 Draft 保存到 `data/manual/catalog-drafts/<draft-id>.json`；
10. 输出 Preview，不会写入正式 catalog。

输出中的关键值：

- `draft_id`：后续 resume/review/apply 使用；
- `readiness.status`：必须是 `ready` 才能 Apply；
- `research_plan`：CatalogProfile、ResearchScope、LayerPlan 与适用性；
- `coverage`：每层每个适用字段的 `covered/missing`；
- `source_count` / `missing_field_count`：官方来源数量与缺失字段数；
- `layer_patches`：五层独立的 `create/replace/noop`、完整记录和字段 provenance；
- `record_preview`：本次实际写入的完整记录；
- `cost`：各类硬上限、已花费和剩余额度；
- `base_revision`、`preview_hash` 和 `change_preview`：Apply 前的事务校验信息。

如果关键事实没有官方证据，Draft 会是 `preview_blocked`。不要手工补价格、日期或占位值绕过门禁；可修正官方来源提示后执行：

```bat
bat\catalog-generator.bat resume draft-xxxxxxxxxxxx-xxxxxxxx --confirm-cost
```

`resume` 只重新研究 FieldCoverage 中仍 missing 字段对应的层 scope，并重新合成，保留已有来源和累计成本账本。即使前一次因网络错误或 `COST_BUDGET_EXHAUSTED` 中断，已完成的 OfficialSources 也会写入失败 Draft，后续不会从已覆盖的 scope 重新开始。

## 6. 查看草案

列出草案：

```bat
bat\catalog-generator.bat list
```

重新读取并核对当前目录 revision：

```bat
bat\catalog-generator.bat review draft-xxxxxxxxxxxx-xxxxxxxx
```

`review` 会重新计算必需字段覆盖、记录完整性、字段 provenance、LayerPatch、Preview hash 和当前 revision。目录在生成 Draft 后发生变化时返回 `REVISION_CONFLICT`；schema v2 Draft 返回 `DRAFT_SCHEMA_UNSUPPORTED`。任一 missing 或无效 Patch 都不能 Apply。

## 7. 正式 Apply

先执行：

```bat
bat\catalog-generator.bat apply draft-xxxxxxxxxxxx-xxxxxxxx
```

CLI 会再次显示：

- readiness 和字段覆盖；
- 每层 `create/replace/noop` 及完整记录；
- 每字段 provenance；
- Responses、页面、提取和合成的累计成本；
- 当前 revision；
- preview hash。

确认无误后，在提示符中原样输入：

```text
APPLY draft-xxxxxxxxxxxx-xxxxxxxx
```

只有这一明确确认通过后才会正式写入。Apply 内部会：

1. 获取 catalog 共同锁；
2. 重新检查 revision 和 Preview；
3. 重新生成并校验 FutureSnapshot；
4. 写入五文件 staging；
5. 使用 staged catalog 构建 staged dist；
6. 记录 journal 并备份现有 catalog/dist；
7. 替换五份 catalog 和静态站；
8. 重新校验正式数据；
9. 成功后删除对应草案。

不要使用不存在的 `--yes` 绕过确认，也不要在 Apply 过程中手工编辑五份 catalog 文件。

## 8. 取消、恢复和失败处理

Apply 前取消草案：

```bat
bat\catalog-generator.bat cancel draft-xxxxxxxxxxxx-xxxxxxxx
```

如果终端、Node 进程或 Windows 操作在事务中断开，先执行：

```bat
bat\catalog-generator.bat recover
```

恢复逻辑会根据 journal：

- 清理尚未提交的 staging；
- 回滚已部分替换的 catalog；
- 回滚 dist 替换窗口；
- 对已确认提交但草案未删除的事务执行 cleanup-only。

如果草案删除失败，状态会变为 `cleanup_pending`。不要再次手工 Apply 同一草案；先执行 `recover`，让系统只完成清理。

## 9. Apply 后验证

生成器 Apply 已经会构建 staged dist。还可以运行只读校验：

```bat
node scripts\validate.js
node scripts\check-secrets.js
```

若要在本地重新生成正式 `dist/`，使用：

```bat
bat\build-dist.bat
```

该命令会重建并覆盖项目内 `dist/`，只在确认不需要保留当前 dist 内容时运行。

## 10. 热点候选的边界

热点反哺产生的 pending 工具候选只是发现线索，不能直接进入正式目录。它们应经过：

```text
pending candidate
  → Seed
  → CatalogProfile / ResearchPlan
  → OfficialSources
  → FieldCoverage / LayerPatches
  → Preview
  → 维护者确认
  → Apply
```

热点反哺可通过生成器的 `batch` 命令自动接入这条链（查重 → 厂商/官方源解析 → 逐工具生成 → 自动 Apply，见 §11）。但仍不要直接把 `tool-cards-pending.json` 复制到正式 `tool-cards.json`——必须经过研究合成与 readiness 门禁。

## 11. 批量生成（热点待补卡 → 正式目录）

`min-review feedback` 产出的 `data/manual/tool-cards-pending.json` 由 `batch` 命令一键转成正式目录卡片：

```text
tool-cards-pending.json
  → 查重（正式 tool-card / 进行中 draft / 同批）
  → 厂商/官方源解析（人工登记表命中 | Tavily 搜工具名 → 厂商名 + 官方域名）
  → 成本估算 → --confirm-cost 全局确认一次
  → 逐工具 prepare → review → 自动 apply
  → 批量报告（applied / skipped / failed / unresolved）
```

### 人工官方 URL 登记表

批量生成前把已知工具的官方域名登记到 `data/manual/official-url-registry.json`，命中就无需花 Tavily/DeepSeek 解析（key 可为工具名或厂商名，同一命名空间，可配 aliases）：

```bash
node scripts/catalog-generator.js url-registry list
node scripts/catalog-generator.js url-registry add --name 可灵 --vendor 快手可灵 --url https://klingai.com --alias Kling
node scripts/catalog-generator.js url-registry remove --name 可灵
```

### 先 dry-run 预览

```bash
node scripts/catalog-generator.js batch --file data/manual/tool-cards-pending.json --dry-run
```

写 `data/manual/batch-seeds-preview.json`（已解析 seed + 每工具成本估算），不建草案、零研究零合成。

### 正式批量生成

```bash
node scripts/catalog-generator.js batch --file data/manual/tool-cards-pending.json --confirm-cost
```

- 全局成本确认一次后，每个工具 readiness ready 即自动写入正式五模块目录（跳过人工 `APPLY <id>` 输入）。
- 复用上次 dry-run 的解析结果避免重复花解析费：加 `--from-preview`；缺省每次重新解析。
- 失败隔离：单个工具失败跳过并记录原因，不阻塞后续；失败草案保留供 `resume` 续跑。
- unresolved（解析不出厂商/官方域名）不硬猜，落在报告的 unresolved 列表，人工补登记表或补 seed 后重跑。

### 分组归属

新工具不设 `placement.new_group_title`，分组名默认 = 工具名（deriveKeys 回退 `seed.name`，匹配现有"GPT-5.6"家族组约定）。

## 12. 安全规则速查

- API Key 只放环境变量；
- 不把网页中的提示文字当成系统指令；
- Tavily 只负责来源检索和正文提取，字段合成必须以官方来源正文为唯一证据，provenance 引用真实 source_id；
- 搜索或正文提取失败时不允许模型凭记忆猜价格和日期；
- `api_model` 的 API 可用性、访问条件和价格不能用 `not_applicable` 掩盖；缺失时必须 blocked，并只建议人工考虑 `product_variant`；
- `resume` 只补 missing 字段对应的层来源，但每次仍需 `--confirm-cost` 授权新的增量硬预算；
- `retrieved_at` 不是 `official_date`；
- API 模型要有工具卡；
- 订阅套餐不能有工具卡；
- 正式 Apply 前必须人工确认；
- 失败草案要保留，成功后才删除；
- 不要提交 `data/manual/catalog-drafts/`、事务 staging 或本地配置；
- 本流程不会自动提交或推送 Git。
