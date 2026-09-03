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

### Domain docs

Single-context repo — `CONTEXT.md` at repo root (exists); `docs/adr/` is created lazily by `/domain-modeling` and stays uncommitted.
