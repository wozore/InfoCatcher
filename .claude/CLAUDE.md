This project is very early-stage with no user feedback. Even if you modify the data files, it doesn't matter—we are working hard to adjust it to the correct state.

The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project. If you ever encounter something in the project that surprises you, please alert the developer working with you.

# Codebase map

@../CODEBASE-MAP.md

改动代码前先读上面的索引定位文件；新增/移动/删除代码文件后同步更新 `CODEBASE-MAP.md`。

## Runtime prerequisites

- All runtime API keys are stored only in the repository-root `.env`; never request, print, copy, or persist key values in code, drafts, JSON, docs, or commands.
- Project CLI entry points load `.env` themselves. Before calling internal modules through `node -e`, tests, or custom scripts, explicitly call `loadDotEnv()` from `src/shared/env` first; bypassing this step makes configured providers appear unauthenticated.
- Catalog generation is fail-closed: it requires both `DEEPSEEK_API_KEY` and `TAVILY_API_KEY` from `.env`. Do not replace failed research/synthesis with hand-authored catalog records.
- `config/catalog-generator.local.json` is optional and currently absent. Use module defaults unless a local config is intentionally added; do not create or commit it as an implicit workaround.
- `scripts/build-dist.js` recursively replaces the generated `dist/` directory. Treat `dist/` as disposable build output, not a source of truth.

## Agent skills

> **docs 目录入库边界**：工程文档不入库，仅 `docs/manual/**/*.md`（用户说明类）入库（见 `.gitignore`）。下述约定文档（`docs/agents/`、`docs/adr/`）均属工程文档，不在版本控制内；当前磁盘上尚未创建，未来创建时也不入库，仅作本地参考。

### Issue tracker

Issues live in GitHub Issues owned by `wozore/InfoCatcher-Engineering`. See `docs/agents/issue-tracker.md`（工程约定文档，不入库，本地参考）。

### Domain docs

Single-context repo — `CONTEXT.md` and `docs/adr/` at repo root (currently absent; created lazily by `/domain-modeling`). See `docs/agents/domain.md`（工程约定文档，不入库，本地参考）。
