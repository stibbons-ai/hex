# hex

## Agent skills

### Issue tracker

GitHub Issues on `stibbons-ai/hex` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Vendored repositories

Upstream sources live under `vendors/` as squashed git subtrees, pinned to the versions hex installs:

- `vendors/effect`: Effect at `effect@4.1.0` (`https://github.com/Effect-TS/effect.git`)
- `vendors/imapflow`: imapflow at `v2.10.0` (`https://github.com/postalsys/imapflow.git`)

- Use them as read-only reference material when working with these libraries; prefer their source, tests and docs over guesses, web search or the compiled code in `node_modules`.
- When writing Effect code, read `vendors/effect/LLMS.md` first, then inspect `vendors/effect/` for idiomatic usage, tests, module structure and API design.
- Do not edit files under `vendors/` unless explicitly asked, and never import from it: application code imports from the normal package dependencies.
- Lint, formatting, tests and the container build skip `vendors/`. Lint runs with `--disable-nested-config` (else it loads `vendors/effect/.oxlintrc.json`), so a nested `.oxlintrc.json` under `packages/` would be ignored: put lint configuration in the root `.oxlintrc.json`.
- When a pin changes in the root `package.json` catalog, move its subtree to the same tag in the same change: `git subtree pull -S --prefix=vendors/<name> <url> <tag> --squash`.
