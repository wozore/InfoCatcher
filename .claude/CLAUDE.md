# CLAUDE.md — KnowView

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

### Code standards (enforced by check-standards, CI-gated)

- Full architecture specification, subdomain patterns, and T1–T14 templates: see `docs/manual/codebase-standards.md`.
- Dependency direction is one-way: web/maintainer-web (browser, must not import Node modules) → HTTP → maintenance (server) → business domains → shared; business domains must not require each other; src→scripts is forbidden; shared must not depend back on business domains. Cross-domain needs move up into shared, or go through service-facade injection.
- Compatibility shims are forbidden: `module.exports = require(...)` and pure re-export files (providers/index.js is an assembly root, exempt).
- Before placing new code, declare its type template (T1–T14) and subdomain per `docs/manual/codebase-standards.md`; single file ≤400 lines, ≤15 exports; CommonJS named exports (entry main excepted).
- A stale contract is any narrative describing things that no longer exist (history of deleted fields/files/behavior): erase it together with the code when fixing; live gates keep their logic and get their wording rewritten as current-contract statements; banner/group-number decoration is not forbidden.
- `scripts/check-standards.js` is the zero-dependency static standards checker (wired into validate.js and all CI workflows); the whitelist `scripts/check-standards.whitelist.json` is strictly shrink-only — new violations must be fixed in code, never by adding whitelist entries.
- Adding/moving/deleting code files requires syncing `CODEBASE-MAP.md` (check-standards mechanically verifies registration completeness of src code files).

### Domain docs

Single-context repo — `CONTEXT.md` at repo root (exists); `docs/adr/` is created lazily by `/domain-modeling` and stays uncommitted.
