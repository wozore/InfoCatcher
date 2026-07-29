This project is very early-stage with no user feedback. Even if you modify the data files, it doesn't matter—we are working hard to adjust it to the correct state.

The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project. If you ever encounter something in the project that surprises you, please alert the developer working with you.

## Data inventory

- tools.json  # 45 个工具
- data/catalog/ — tool-intelligence.json, glossary.json, scenes.json, featured.json
- data/acquisition/ — intel-sources.json
- data/news/ — config/, sources/, manual/, runtime/, output/

## Agent skills

### Issue tracker

Issues live in GitHub Issues owned by `wozore/InfoCatcher-Engineering`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context repo — `CONTEXT.md` and `docs/adr/` at repo root (currently absent; created lazily by `/domain-modeling`). See `docs/agents/domain.md`.
