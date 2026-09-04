# CLAUDE.md — KnowView (知览)

Early-stage project, no user feedback yet. Data files are iterated freely during development, but this does NOT authorize hand-authoring catalog records to replace failed research/synthesis (see Runtime prerequisites). If anything in the project surprises you, alert the developer you are working with.

## Codebase map

Index: `../CODEBASE-MAP.md`. Read it before changing code; keep it in sync whenever code files are added, moved, or removed.

## Runtime prerequisites

- All runtime API keys live only in the repository-root `.env`; never request, print, copy, or persist key values in code, drafts, JSON, docs, or commands.
- Project CLI entry points load `.env` themselves. Before calling internal modules via `node -e`, tests, or custom scripts, call `loadDotEnv()` from `src/shared/env` first; bypassing this step makes configured providers appear unauthenticated.
- Catalog generation is fail-closed: it requires both the configured extraction provider key (`ZHIPU_API_KEY` by default; `DEEPSEEK_API_KEY` when the provider switch is set back to deepseek) and `TAVILY_API_KEY` from `.env`. Do not replace failed research/synthesis with hand-authored catalog records.
- `config/catalog-generator.local.json` is optional and currently absent. Use module defaults unless a local config is intentionally added; do not create or commit it as an implicit workaround.
- `scripts/build-dist.js` recursively replaces the generated `dist/` directory. Treat `dist/` as disposable build output, not a source of truth.

## Repository conventions

### Docs commit boundary

Engineering docs stay out of version control; only user-facing `docs/manual/**/*.md` is committed (see `.gitignore`). Convention docs under `docs/agents/` and `docs/adr/` are local reference only.

### Development records

Development log is committed at `docs/manual/dev-log.md` (public process record). Development plans stay on the maintainer's machine only (personal record, never committed).

### Issue tracker

Issues live in GitHub Issues owned by `wozore/KnowView`.

### 代码规范（check-standards 门禁，CI 强制）

- 依赖方向单向（§1.1）：web/maintainer-web（浏览器，禁 import Node 模块）→ HTTP → maintenance（server）→ 业务域 → shared；业务域之间禁止互引；禁止 src→scripts；shared 不反向依赖业务域。跨域需求上移 shared 或经 service 门面注入。
- 禁止兼容垫片：`module.exports = require(...)` 与纯 re-export 文件（providers/index.js 是装配真身，豁免）。
- 新代码落位前先声明所属类型模板（T1-T14）与子域归属（模板表见本地 `docs/codebase-refactor-plan.md` §1.3，不入库）；单文件 ≤400 行、导出 ≤15 个；CommonJS 命名导出（入口 main 除外）。
- 旧契约 = 描述已不存在事物的叙述（已删除字段/文件/行为的历史叙事）：修正代码时随实现一起抹除；活门禁保留逻辑本体、文案改写为当前契约表述；横幅/组编号等装饰形式不禁止。
- `scripts/check-standards.js` 为零依赖规范静态检查器（并入 validate.js 与全部 CI 工作流）；白名单 `scripts/check-standards.whitelist.json` 铁律**只减不增**——新增违规必须改代码消除，不得加白名单条目。
- 新增/移动/删除代码文件必须同步 `CODEBASE-MAP.md`（check-standards 机械校验 src 代码文件的登记完整性）。

### Domain docs

Single-context repo — `CONTEXT.md` at repo root (exists); `docs/adr/` is created lazily by `/domain-modeling` and stays uncommitted.
