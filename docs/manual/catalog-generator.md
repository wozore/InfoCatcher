# 五模块目录生成器手动使用说明

本文说明如何在 Windows 上手动把一个新工具、API 模型或订阅套餐加入五模块目录。

## 1. 前置条件

需要：

- Node.js；
- 在项目根目录执行命令；
- 目录模块配置的 DeepSeek provider 对应 API Key 环境变量（默认是 `DEEPSEEK_API_KEY`）；
- 官方资料搜索和正文提取使用 Tavily。目录生成器的联网命令必须显式传入 `--tavily-access-mode keyed`，使用 `TAVILY_API_KEY`；本轮工具卡生成不使用 keyless 模式。缺少 Key 时会在发出请求前 fail-closed；不要把真实 Key 写入 Seed、配置文件、BAT 或目录 JSON。
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
| `probe --confirm-cost --tavily-access-mode keyed` | 检查 Tavily 检索和 DeepSeek 合成配置 | 会调用一次 Tavily | 否 |
| `new --seed <file> --confirm-cost --tavily-access-mode keyed` | 按计划联网研究并生成 schema v3 Preview Draft | 会联网并可能产生费用 | 否 |
| `resume <draft-id> --confirm-cost --tavily-access-mode keyed` | 只补 FieldCoverage 中仍缺失字段对应的层来源并重新合成 | 会联网并可能产生费用 | 否 |
| `list` | 列出草案及状态 | 否 | 否 |
| `review <draft-id>` | 重算字段覆盖、LayerPatch、Preview hash 和目录版本 | 否 | 否 |
| `apply <draft-id>` | 等待 `APPLY <draft-id>` 确认后正式写入 | 通常不需要 AI 调用 | 是 |
| `cancel <draft-id>` | 删除尚未 Apply 的草案 | 否 | 否 |
| `remove --targets <file> --expected-revision <revision> --confirm "REMOVE <file>"` | 按精确 area/id 列表事务化删除目录记录并清理父级引用 | 否 | 是 |
| `recover` | 恢复中断的目录事务 | 否 | 可能回滚本地事务文件 |

其中 `probe`、`new` 和 `resume` 可能产生 API 费用；先用 `plan` 查看本次 ResearchScope 和硬上限。`apply`、`cancel` 和 `recover` 可能修改本地文件。

输入完整命令后按回车执行，例如：

```text
probe --confirm-cost --tavily-access-mode keyed
```

也可以在 CMD 或 PowerShell 中直接带参数执行：

```bat
bat\catalog-generator.bat probe --confirm-cost --tavily-access-mode keyed
```

双击后直接按回车会退出，不会修改任何文件。命令执行完毕后窗口不会自动进入下一轮交互；需要执行下一条命令时重新双击 BAT，或在终端中再次运行。

## 3. 先检查 Tavily 检索和 DeepSeek 提取配置

在项目根目录执行：

```bat
bat\catalog-generator.bat probe --confirm-cost --tavily-access-mode keyed
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

### 自动补全父级引用（link-only）

当新增二级分组或三级详情时，生成器会检查已有父层是否已经持有对应稳定引用。缺少时，计划会把该父层标记为 `replace + link_only`：

- 只复制当前父记录并追加缺失的 `level2_refs` 或 `detail_refs`；
- 不重新检索、不调用模型改写父级标题、描述、状态、特征或价格，也不增加 ResearchScope 与 AI 成本；
- Preview 中仍显示为 `replace`，以便 Apply 的 revision、preview hash 和共同事务完整保护这次关系更新；
- 父记录字段不完整、引用目标不存在或快照不合法时保持 fail-closed，不能用 link-only 绕过校验。

这保证新卡可从厂商一级/二级导航到，不会形成只有数据记录但页面无法到达的孤立分组或详情。

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
bat\catalog-generator.bat new --seed data\manual\catalog-seed.json --confirm-cost --tavily-access-mode keyed
```

`new` 会依次执行：

1. 根据 `detail_kind + modality` 选择 CatalogProfile，并计算需要研究的 vendor/group/detail scope；
2. 使用 Tavily Search 按官方域名和谓词联想搜索 developer/API/OpenAPI/pricing/credits/specifications 等资料；
3. `detail` scope 还会把 Seed 的 `official_url` 与 `discovery_sources[kind=official_hint]` 作为指定官方来源直接加入待提取列表；它们不只是信任根，适用于用户已核验的具体 release notes、定价页或产品文档；
4. canonicalize URL、过滤非官方域名，再用 Tavily Extract 获取清洗后的 markdown/text 正文；
5. DeepSeek 不使用 web tools，单段式直接基于各层官方来源正文合成全部层字段与来源 provenance；
6. 计算 FieldCoverage；任一适用字段缺值、占位或未引用官方来源时保持 blocked；
7. 验证每个字段引用的 source_id 真实存在，并校验记录完整性；
8. 本地生成每层完整的 `create/replace/noop` LayerPatch，禁止空值、`null`、空数组和 `unknown/未知`；
9. 校验 FutureSnapshot、revision 与 Preview hash；
10. 将 schema v3 Draft 保存到 `data/manual/tools/catalog-drafts/<draft-id>.json`；
11. 输出 Preview，不会写入正式 catalog。

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
bat\catalog-generator.bat resume draft-xxxxxxxxxxxx-xxxxxxxx --confirm-cost --tavily-access-mode keyed
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

## 8. 精确删除目录记录

维护者需要删除已下线的工具卡及其完整层级时，先准备只包含精确 `{area,id}` 的 JSON：

```json
{
  "targets": [
    { "area": "vendor-card", "id": "vendor-card:example" },
    { "area": "vendor-level1", "id": "vendor-level1:example" },
    { "area": "vendor-level2", "id": "vendor-level2:example:models" },
    { "area": "tool-level3", "id": "tool-level3:example" },
    { "area": "tool-card", "id": "tool-card:example" }
  ]
}
```

执行前先读取当前 revision，并把预览输出中的确认值原样传回：

```bat
node scripts/catalog-generator.js remove --targets data\manual\tools\removal-targets.json --expected-revision sha256:... --confirm "REMOVE removal-targets.json"
```

该入口只接受已登记 area 和精确 ID：目标缺失、重复、revision 变化或删除后留下非法引用都会拒绝写入。通过校验后，它会在共同锁、staging、backup、journal 和 staged dist 事务中删除记录，自动清理指向这些 ID 的父级引用；构建或替换失败时按 journal 回滚。不要用名称模糊匹配，也不要直接编辑五份 catalog JSON。

## 9. 取消、恢复和失败处理

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

## 10. Apply 后验证

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

## 11. 热点候选的边界

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

## 12. 批量生成（热点待补卡 → 正式目录）

`min-review feedback` 产出的 `data/manual/tools/tool-cards-pending.json` 由 `batch` 命令一键转成正式目录卡片：

```text
tool-cards-pending.json
  → 查重（正式 tool-card / 进行中 draft / 同批）
  → 厂商/官方源解析（人工登记表命中 | Tavily 搜工具名 → 厂商名 + 官方域名）
  → 成本估算 → --confirm-cost 全局确认一次
  → 逐工具 prepare → review → 自动 apply
  → 批量报告（applied / skipped / failed / unresolved）
```

### 人工官方 URL 登记表

批量生成前把已知来源登记到两个相互引用的文件中：

- `data/manual/archive/official-url-registry.json`：厂商表，只保存厂商级官方文档/API 入口和 `model_prefixes`。
- `data/manual/archive/official-product-url-registry.json`：产品表，保存 Cursor、Claude Code、图像/音频工具和编程 Agent 等具体产品，通过 `vendor_key` 引用厂商表。

两个文件由 `src/catalog/official-url-registry.js` 统一读取。调用方不需要知道文件拆分：

- `detailKind=tool`：产品精确名称/词边界前缀优先，再回退厂商名称。
- `detailKind=api_model`：厂商精确名称/模型前缀优先，特殊产品模型再回退产品精确名称。
- 未提供类型时：产品优先，再匹配厂商模型。

产品记录使用 `lifecycle`（`active` / `deprecated` / `discontinued` / `unknown`）、`last_verified_at` 和可选 `last_official_update_at`。产品过期不代表官方服务停止；使用 audit 命令区分“待核验”“半年未更新”和“已弃用”。只登记官网、官方文档、官方定价或官方更新页；不要把 `agent`、`code`、`ai` 等通用词登记为产品前缀。

#### 编程工具专用更新源契约（第 1 步）

产品条目可以额外包含可选 `update_sources`。它只供后续“网页更新 → 人工审核”链路使用，不替换、不删除 `official_urls`；`lookupOfficialUrl()` 和 `catalog batch` 仍只消费 `official_urls`。

```json
{
  "update_sources": [
    {
      "kind": "github_releases",
      "url": "https://github.com/acme/sample-tool/releases",
      "collector": "github_web_release",
      "product_surface": "cli",
      "repository": "acme/sample-tool",
      "tag_prefix": "v",
      "include_prerelease": false
    },
    {
      "kind": "github_file",
      "url": "https://github.com/acme/sample-tool/blob/main/CHANGELOG.md",
      "collector": "github_web_file",
      "product_surface": "cli",
      "repository": "acme/sample-tool"
    },
    {
      "kind": "changelog",
      "url": "https://acme.example/changelog",
      "collector": "tavily_extract",
      "product_surface": "product"
    }
  ]
}
```

契约硬规则：`kind` 只能是 `github_releases`、`github_file`、`changelog` 或 `release_notes`；collector 必须分别匹配 `github_web_release`、`github_web_file` 或 `tavily_extract`；`product_surface` 只能是 `product`、`cli`、`desktop`、`ide_extension`。GitHub URL 必须是可供人打开的 `https://github.com/<owner>/<repo>/releases...` 或 `/blob/<ref>/<file>` 页面，且 `<owner>/<repo>` 必须与 `repository` 对应；不持久化 `api.github.com`。价格页、Tags 页、单独 tag/commit 时间、重复 URL、HTTP、未知字段组合均拒绝。可选 `date_mode: "latest"` 表示该 changelog 列表页的全部条目都属于目标产品更新、多日期时取最新一条（GitHub Copilot 取最新 copilot 标签更新、Trae 全页均为 IDE 更新即此规则）。`updateSourcesForProduct()` 是只读读取接口，不参与 batch lookup。采集器对 `tavily_extract` 来源优先直接抓取官方 HTML 正文（Tavily Extract 对 JS 渲染/缓存文档站经常丢失 changelog 条目日期），HTML 失败才回退 Tavily Extract。

后续更新审核清单路径为 `data/manual/tools/tool-update-review.json`。第 4 步的 scan 只把确定性采集的 `UpdateEvidence` 交给 AI 做语义建议，再经 planner 生成 `candidate` 或 `blocked` 条目；默认 provider 是本地 Bonsai，DeepSeek 必须显式确认成本。AI 只能输出 `verdict`、`matched_surface`、`confidence`、`reason`、`supporting_excerpt` 五个字段，不能创建或改写产品键、URL、repository 或日期。清单默认 `review_status: pending`，不调用 catalog Apply。

第 5 步的日期 Apply 只允许显式 `mode: "advance_update"` 的 `tool.last_updated_date` 向前更新：新日期必须严格晚于当前日期、不晚于 Apply/扫描日，证据日期必须来自官方发布时间 metadata 或正文；模型 `release_date`、套餐、同日、回退、未来日期和非官方来源均拒绝。批量 Apply 先以同一 base revision 生成一份 preview/hash，再重新读取 registry、catalog 和 review queue，逐条确认 `review_status: approved` 与 candidate hash，任一冲突则整批不写入；成功提交只改变目标日期和必要的官方 source 追加，其他字段零漂移。

planner 只接受已登记来源、`detail_kind: tool`、官方 metadata/正文日期、晚于现有 `last_updated_date` 且不晚于扫描日的候选；低置信度、实体/组件错配、日期缺失、未来/同日/回退日期均记录阻断理由。审核条目按 `product_key + source_url + proposed_date + content_hash` 去重，重扫保留人工 `approved/rejected`；同一发布的 evidence hash 变化会重新变为 pending。队列只保存官方 URL、证据摘录、hash、日期和 AI 建议，不保存整页正文或凭据。

维护命令：

```bash
# 编程工具专用更新审核链路（不使用 gh）
bat\tool-update-review.bat preflight --tavily-access-mode keyless
bat\tool-update-review.bat scan --tavily-access-mode keyless
bat\tool-update-review.bat list --status pending
bat\tool-update-review.bat preview
bat\tool-update-review.bat apply --expected-revision sha256:... --preview-hash sha256:...
```

`preflight` 只检查登记表、GitHub 公共访问、Tavily 和本地 AI 能力，不写文件。`scan` 只采集专用 `update_sources`、调用语义审核 AI 并合并 `tool-update-review.json`，不调用 catalog Apply；含 Tavily 来源必须显式选择 `--tavily-access-mode keyed|keyless`，DeepSeek 还必须加 `--confirm-cost`，默认 provider 是本地 Bonsai。`list` 和 `preview` 只读；`preview` 输出当前 expected revision、精确变更和 preview hash。

`apply` 只接受人工把候选改为 `review_status: "approved"` 且仍为 `status: "candidate"` 的条目。它要求 `--expected-revision`、`--preview-hash`，并交互输入精确的 `APPLY TOOL-UPDATES <preview_hash>`；CLI 会重新读取 registry、catalog 和审核队列，复算 candidate/preview，最后复用日期批量事务。任何 revision、hash、来源、日期或审核状态冲突都 fail-closed，不能写入；本入口不更新 registry 的 `last_official_update_at` / `last_verified_at`，那属于后续维护步骤。


node scripts/catalog-generator.js url-registry vendor list
node scripts/catalog-generator.js url-registry vendor add --name 可灵 --vendor 快手可灵 --url https://klingai.com --model-prefix kling
node scripts/catalog-generator.js url-registry vendor remove --name 可灵

# 产品表
node scripts/catalog-generator.js url-registry product list
node scripts/catalog-generator.js url-registry product add --name cursor --vendor-key anysphere --url https://cursor.com/docs --alias Cursor --product-prefix cursor --lifecycle active --verified-at 2026-08-23
node scripts/catalog-generator.js url-registry product remove --name cursor

# 纯本地新鲜度审计，不发网络请求、不改登记表
node scripts/catalog-generator.js url-registry product audit --stale-days 183
```

### 先 dry-run 预览

```bash
node scripts/catalog-generator.js batch --file data/manual/tools/tool-cards-pending.json --dry-run --tavily-access-mode keyed
```

写 `data/manual/tools/batch-seeds-preview.json`（已解析 seed + 每工具成本估算），不建草案、零研究零合成。

### 正式批量生成

```bash
node scripts/catalog-generator.js batch --file data/manual/tools/tool-cards-pending.json --confirm-cost --tavily-access-mode keyed
```

- 全局成本确认一次后，每个工具 readiness ready 即自动写入正式五模块目录（跳过人工 `APPLY <id>` 输入）。
- 复用上次 dry-run 的解析结果避免重复花解析费：加 `--from-preview`；缺省每次重新解析。
- 失败隔离：单个工具失败跳过并记录原因，不阻塞后续；失败草案保留供 `resume` 续跑。
- unresolved（解析不出厂商/官方域名）不硬猜，落在报告的 unresolved 列表，人工补登记表或补 seed 后重跑。

### 分组归属

非 LLM 工具与专用模型（编程、图像、视频、实时语音、翻译、套餐等）不设 `placement.new_group_title` 时，分组名默认 = 工具名（deriveKeys 回退 `seed.name`，匹配现有"GPT-5.6"家族组约定）。

### LLM 二级系列自动归属（通用大语言模型）

通用 LLM 模型（`detail_kind=api_model` 且属于政策中的 `general_llm` 家族）在批量 prepare 前由「LLM 二级系列分类政策」决定归属，不再默认以模型名建组：

1. **政策规则源**：`data/manual/archive/llm-series-policy.json` 声明 16 个厂商的模型家族、用途、版本轴、允许的目标二级系列、容量（同系列最多 3 个，第 4 个触发拆分）与证据状态。未知厂商/非法规则一律 fail-closed，绝不回退到以具体模型名建组。
2. **确定性判定**：`src/catalog/catalog-series-policy.js` 的 `planSeriesPlacement` 用品牌提示/家族 pattern 识别已知 LLM，直接产出 `existing`（加入已有系列）或 `create`（用政策稳定 id/标题新建）。已知模型不需要 AI，零成本。
3. **AI 只作 hint**：仅当候选用途/家族无法确定性判定（`needs_ai`，如无任何品牌命中的新模型）且显式放行 `allowAiPlacement` 时，才调用 `catalog-series-placement-ai` 输出 `usage_kind/family/cohort/confidence` 建议，再由政策重算最终归属。AI 低置信、未知家族、与政策冲突一律 fail-closed；缺账本、未放行时直接 `PLACEMENT_MANUAL_REQUIRED`，绝不静默建组。
4. **第 4 个成员触发拆分迁移**：目标系列成员数已达拆分阈值（3）时，新候选返回 `PLACEMENT_MIGRATION_REQUIRED` 并阻断该 seed，**不自动重排既有成员**。需要拆分时由维护者更新政策（声明 newest/last 系列）后执行系列迁移（见下）。
5. **人工 placement 仍最高优先**：Seed/待补卡显式指定 `existing_level2_ref` 时直接采用，但必须通过引用 kind/存在性/厂商归属校验，非法即 fail-closed。

### 二级系列迁移（合并/拆分当前目录）

治理既有 LLM 二级系列用独立迁移入口（不经过生成器 Draft）：

```bash
node scripts/catalog-series-migration.js                        # 只读预览（含目标 revision）
node scripts/catalog-series-migration.js --json                 # 结构化预览
node scripts/catalog-series-migration.js --apply <targetRevision>  # 原子 Apply（必须传预览输出的目标 revision）
```

- 预览列出：删除的碎片系列、成员搬迁、孤儿、既有浮空详情警告、`id_map` 与 `vendor-level1.level2_refs` 重写。
- `--apply <targetRevision>` 会按当前快照**重新计算目标 revision**，与传入值不一致（数据已漂移）即中止；随后经 `commitSnapshotChange` 五文件事务 + dist 重建原子提交，并绑定 `expectedRevision` 防并发。
- 迁移只改 `vendor-preview-level1.json` / `vendor-preview-level2.json`；`tool-level3` 与 `tool-card` 零漂移。
- 第 4 个成员触发拆分时：先更新政策（把单系列改为 `*-newest` / `*-last` 双系列并分配成员），再跑迁移 Apply，最后重跑批量。

### 批量成本门禁（零确认零付费）

`batch` 的联网/付费解析与生成严格门禁：

- 未传 `--confirm-cost` 且非 `--dry-run`：**零付费返回**三本账成本估算，不执行任何 Tavily/DeepSeek 调用：
  - `resolution`：需要付费 vendor 解析的卡片数（人工登记表命中零成本）；
  - `placement`：AI 分类调用上界（默认 0，`allowAiPlacement` 才可能付费）；
  - `research`：各 seed 研究/合成硬上限。
- `--dry-run`：付费解析预览 + 确定性 placement 写入 preview，并回填 `resolve_cost`。
- `--confirm-cost`：确认后执行解析 → 批量生成 → 自动 Apply。
- **同厂商多候选顺序规划**：批量前置按顺序维护投影成员数，第 3 个正常加入、第 4 个触发迁移阻断；`migration_required` 与 `fail_closed` 天然使后续同家族候选持续阻断。
- **from-preview / resume 复用**：`--from-preview` 复用上次 dry-run 的 seed（含 `placement_decision`），确定性判定短路，**不重复调用 AI**；已持久化 decision 的 seed 在重跑/续跑时直接采用。

## 13. 概念批量生成（热点待补概念 → glossary.json）

`min-review feedback` 产出的 `data/manual/concepts/concept-cards-pending.json` 由**独立的 concept-generator 入口**转成正式 `data/catalog/glossary.json` 条目。概念生成产出的是 AI 概念知识库（glossary.json），不是五模块厂商/工具目录，故独立成入口，不挂在 catalog-generator 下。与工具批量链路（§11）不同，概念**不自动 apply**：batch 只合成出预览文件并停下，由维护者查看后再显式 `apply` 写入。

```text
concept-cards-pending.json
  → 查重（同批 + 正式 glossary，term 大小写不敏感）
  → 回读 approved 摘要作主证据 + vibe-hub.org 自动补充证据
  → 成本估算 → --confirm-cost 确认一次
  → 逐概念 DeepSeek 合成 → 写预览文件 data/manual/concepts/concept-previews.json
  → 维护者查看（preview）→ 显式 apply → 原子写 glossary.json
```

命令行与 BAT 两种方式等价（BAT 只转发 Node CLI）：

```bash
node scripts/concept-generator.js ...            # 或
bat\concept-generator.bat ...
```

### 先 dry-run 预览（零 AI 零网络）

```bash
node scripts/concept-generator.js batch --file data/manual/concepts/concept-cards-pending.json --dry-run
```

只做查重 + 本地摘要证据 + 成本估算（每条概念 1 次合成），不抓 vibe-hub、不调 DeepSeek、不写文件。

### 正式合成预览

```bash
node scripts/concept-generator.js batch --file data/manual/concepts/concept-cards-pending.json --confirm-cost
```

- 合成前会尽力抓 `https://vibe-hub.org/<slug>` 补充证据（term 为纯 ASCII 才尝试，含中文自动跳过；404/网络失败静默跳过，approved 摘要始终是主证据）。
- 逐概念 DeepSeek 合成 7 字段条目（term/full_name/category/summary/related_terms/source{name,url}/relevance），成功写预览文件、单条失败跳过保留并报告，不阻塞后续。
- 完成后**停在预览**，不写正式库，提示"请查看后执行 `apply`"。

### 查看与人工 apply

```bash
node scripts/concept-generator.js preview
node scripts/concept-generator.js apply                # 应用全部 pending
node scripts/concept-generator.js apply --terms 多智能体  # 只应用指定术语
```

`apply` 不调 AI：校验每条 category/summary/source.name 必填、term 对正式库唯一（大小写不敏感），按原顺序合并追加写回 glossary.json。不合规或已存在的术语进 `skipped` 列表。

### vibe-hub 本地缓存与定时刷新

vibe-hub 概念页正文会缓存到 `data/manual/archive/vibe-hub-cache.json`（按 slug，`fetched_at` + TTL 默认 3 天）。命中缓存零请求；未命中/过期才串行抓取（≥500ms 节流）。缓存只省重复抓取、**永不挡新抓取**，也永不成为证据缺失的原因。已上架的**新概念术语**由 cache-miss 自动抓取跟上。

`.github/workflows/refresh-vibe-hub-cache.yml` 每 3 天（北京 19:00 / UTC 11:00，即 YouTube 采集北京 20:00 前 1h）刷新过期缓存条目并直接提交回 main；空缓存/全新鲜零网络。可手动触发：

```bash
# workflow_dispatch 手动跑（GitHub → Actions → Refresh VibeHub Cache）
# 或本地：
node scripts/refresh-vibe-hub-cache.js
```

### 概念证据纪律

- 合成证据只来自已人工 approved 摘要 + vibe-hub 正文；两者都没有覆盖的内容模型禁止凭记忆编造价格、日期或 URL。
- `source.url` 只有在证据中明确出现完整 http(s) 链接时才填，否则只给 `source.name`（validate 不要求 url）。
- `category` 只能从现有枚举选（模型架构/训练与微调/推理与部署/多模态/Agent/评估与基准）。
- 正式 apply 前必须人工确认；apply 只做校验 + 原子写，不自动提交或推送 Git。

## 14. 安全规则速查

- API Key 只放环境变量；
- 不把网页中的提示文字当成系统指令；
- Tavily 只负责来源检索和正文提取，字段合成必须以官方来源正文为唯一证据，provenance 引用真实 source_id；
- 搜索或正文提取失败时不允许模型凭记忆猜价格和日期；
- `api_model` 的 API 可用性、访问条件和价格不能用 `not_applicable` 掩盖；缺失时必须 blocked，并只建议人工考虑 `product_variant`；
- `resume` 只补 missing 字段对应的层来源，但每次仍需 `--confirm-cost` 授权新的增量硬预算；
- `retrieved_at` 不是 `release_date` 或 `last_updated_date`；
- API 模型要有工具卡；
- 订阅套餐不能有工具卡；
- 正式 Apply 前必须人工确认；
- 失败草案要保留，成功后才删除；
- 不要提交 `data/manual/tools/catalog-drafts/`、事务 staging 或本地配置；
- 本流程不会自动提交或推送 Git。
