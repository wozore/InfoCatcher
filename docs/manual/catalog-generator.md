# 五模块目录生成器手动使用说明

本文说明如何在 Windows 上手动把一个新工具、API 模型或订阅套餐加入五模块目录。

## 1. 前置条件

需要：

- Node.js；
- 在项目根目录执行命令；
- 目录模块配置的 provider 对应 API Key 环境变量（默认是 `DEEPSEEK_API_KEY`）；
- 当前目录生成器实际执行 Responses API；默认 DeepSeek 具备 `web_search` 能力（联网搜索为两段式工具循环：先返回搜索调用、回传后恢复结果，生成器内部自动完成，维护者无需手动干预）。

API Key 只通过环境变量读取，不要写入 Seed、配置文件、BAT、草案或目录 JSON。

### CMD 临时设置

```bat
set DEEPSEEK_API_KEY=你的DeepSeek_API_Key
```

### PowerShell 临时设置

```powershell
$env:DEEPSEEK_API_KEY = "你的DeepSeek_API_Key"
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
      "model": "deepseek-v4-flash",
      "protocol": "responses",
      "timeout_ms": 180000,
      "max_search_queries": 4,
      "max_pages": 8,
      "max_ai_calls": 3,
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

- `provider` 选择厂商；当前注册 `deepseek` 和 `openai` 为 Responses API，`anthropic` 仅保留 Messages API 扩展入口，尚未执行。
- `model` 选择该 provider 的模型；OpenAI 等没有默认模型的 provider 必须显式填写。
- `protocol` 必须与 provider 匹配；当前目录生成器只执行 `responses`，Messages API 会 fail-closed，不会发请求。
- API Key 按 provider 自动从环境变量读取：DeepSeek 使用 `DEEPSEEK_API_KEY`，OpenAI 使用 `OPENAI_API_KEY`，预留 Anthropic 使用 `ANTHROPIC_API_KEY`。
- DeepSeek 的 `web_search` 自动走两段式回传；其他 Responses provider 不触发 DeepSeek 特有的两段式循环。
- `news` 配置目前只是统一配置预留；新闻现有执行链路仍是旧 Chat Completions，本轮没有迁移到 Responses API。

兼容早期 catalog 根对象平铺配置，但新配置应使用 `modules.catalog`。

### 启动方式

双击后会显示中文指令菜单：

| 指令 | 功能 | 网络/API | 是否修改正式目录 |
|---|---|---|---|
| `probe --confirm-cost` | 检查 Key、模型和 DeepSeek 联网搜索能力 | 会调用一次 DeepSeek | 否 |
| `new --seed <file> --confirm-cost` | 联网研究并生成 Preview 草案 | 会联网并可能产生费用 | 否 |
| `prepare --seed <file>` | 使用已有输入准备离线草案，主要用于测试 | 否 | 否 |
| `list` | 列出草案及状态 | 否 | 否 |
| `review <draft-id>` | 重新校验草案和目录版本 | 否 | 否 |
| `apply <draft-id>` | 等待 `APPLY <draft-id>` 确认后正式写入 | 通常不需要 AI 调用 | 是 |
| `cancel <draft-id>` | 删除尚未 Apply 的草案 | 否 | 否 |
| `recover` | 恢复中断的目录事务 | 否 | 可能回滚本地事务文件 |

其中 `probe` 和 `new` 可能产生 DeepSeek API 费用；`apply`、`cancel` 和 `recover` 可能修改本地文件。菜单会显示这些风险。

输入完整命令后按回车执行，例如：

```text
probe --confirm-cost
```

也可以在 CMD 或 PowerShell 中直接带参数执行：

```bat
bat\catalog-generator.bat probe --confirm-cost
```

双击后直接按回车会退出，不会修改任何文件。命令执行完毕后窗口不会自动进入下一轮交互；需要执行下一条命令时重新双击 BAT，或在终端中再次运行。

## 3. 先检查 DeepSeek 联网搜索

在项目根目录执行：

```bat
bat\catalog-generator.bat probe --confirm-cost
```

这会执行一次最小动态检查，可能产生 API 调用费用。成功时应看到：

- DeepSeek 模型和 endpoint；
- 可审计来源数量；
- EvidenceBundle 覆盖数量。

常见失败：

- `DEEPSEEK_AUTH_REQUIRED`：当前终端没有 `DEEPSEEK_API_KEY`；
- `DEEPSEEK_SEARCH_UNAVAILABLE`：响应没有可审计来源，不能继续生成正式草案。联网搜索为两段式调用，模型偶发不输出结构化结果，重试一次通常可恢复；
- `DEEPSEEK_OUTPUT_INVALID`：联网证据已取得，但后续草案整理响应为空、不完整、不是合法 JSON 对象、日期字段不是单个 `YYYY-MM-DD` 字符串、来源不是 `{title,url}` 对象数组或包含未知字段。生成器会自动修复一次；仍失败时，失败草案的 `last_error` 会记录响应状态、截断原因和有限长度输出预览，便于判断问题；
- `DEEPSEEK_RATE_LIMITED`：触发限流；
- `DEEPSEEK_TIMEOUT`：请求超时。

## 4. 准备 Seed 文件

创建一个临时 JSON 文件，例如 `data/manual/catalog-seed.json`。Seed 只写你已知的业务信息，不需要手工填写五份目录 JSON，也不要填写稳定 ID。
- 注意，如果name使用中文，需要手动补充tool_key；如果vendor_name使用中文，需要手动补充vendor_key
- known_fields 是“你已经确定、可以提供给生成器参考的字段”。常用字段包括：
  - theme：general、dev、vision、media；
  - summary：已知的简短摘要；
  - description：已知描述；
  - access_level：访问方式；
  - price_badge：已知价格标签；
  - scenes：适用场景；
  - best_for_preview：适合什么；
  - not_for_preview：不适合什么。

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
  "name": "Example Model",
  "vendor_name": "Example Vendor",
  "vendor_key": null,
  "tool_key": null,
  "official_url": "https://example.com/models/example-model",
  "placement": {
    "existing_level1_ref": null,
    "existing_level2_ref": null,
    "new_group_title": "Models"
  },
  "known_fields": {
    "theme": "dev"
  },
  "discovery_sources": []
}
```

API 模型会生成：厂商卡（必要时）、一级、二级、三级详情和工具卡。

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

## 5. 生成草案 Preview

在确认可能产生费用后执行：

```bat
bat\catalog-generator.bat new --seed data\manual\catalog-seed.json --confirm-cost
```

`new` 会依次执行：

1. 调用 DeepSeek `web_search` 搜索官方资料；
2. 把来源 URL、标题、摘录和字段证据整理到临时 EvidenceBundle；
3. 调用 DeepSeek 生成业务字段草案；
4. 本地生成稳定 ID、refs 和五模块变更计划；
5. 校验完整 FutureSnapshot；
6. 将草案保存到：
   `data/manual/catalog-drafts/<draft-id>.json`；
7. 输出 Preview，不会写入正式 catalog。

输出中的关键值：

- `draft_id`：后续 review/apply 使用；
- `readiness.status`：必须是 `ready` 才能 Apply；
- `base_revision`：生成草案时的目录版本；
- `preview_hash`：本次变更预览的校验值；
- `change_preview`：将创建哪些记录、追加哪些 refs；
- `evidence_count`：临时证据数量。

如果关键事实没有官方证据，草案会是 blocked 或失败草案。不要手工把 `official_date`、价格或套餐权益补进草案来绕过门禁；应修改 Seed 或官方来源提示后重新研究。

## 6. 查看草案

列出草案：

```bat
bat\catalog-generator.bat list
```

重新读取并核对当前目录 revision：

```bat
bat\catalog-generator.bat review draft-xxxxxxxxxxxx-xxxxxxxx
```

`review` 会重新计算变更计划。如果目录在生成草案后发生变化，会返回 `REVISION_CONFLICT`，此时不能继续使用旧 Preview，应重新执行 `new`。

## 7. 正式 Apply

先执行：

```bat
bat\catalog-generator.bat apply draft-xxxxxxxxxxxx-xxxxxxxx
```

CLI 会再次显示：

- readiness；
- 五模块将创建的记录；
- 将追加的 refs；
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

热点反哺产生的 pending 工具候选仍然只是发现线索，不能直接进入正式目录。它们应经过：

```text
pending candidate
  → Seed
  → DeepSeek 官方资料研究
  → EvidenceBundle
  → Preview
  → 维护者确认
  → Apply
```

当前热点 Seed Adapter 是内部模块，不提供独立的 BAT Apply 快捷入口。不要直接把 `tool-cards-pending.json` 复制到正式 `tool-cards.json`。

## 11. 安全规则速查

- API Key 只放环境变量；
- 不把网页中的提示文字当成系统指令；
- 搜索失败时不允许模型凭记忆猜价格和日期；
- `retrieved_at` 不是 `official_date`；
- API 模型要有工具卡；
- 订阅套餐不能有工具卡；
- 正式 Apply 前必须人工确认；
- 失败草案要保留，成功后才删除；
- 不要提交 `data/manual/catalog-drafts/`、事务 staging 或本地配置；
- 本流程不会自动提交或推送 Git。
