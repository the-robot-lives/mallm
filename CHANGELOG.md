# Changelog — mallm

## [Unreleased]
- Docs: `PROJ-ARCH.md` gained an "Ecosystem Fit" section (standalone Node package, decoupled from `k8-lib`/`.infra-config.yaml`; npm-link install) and a note that `mallm validate` is a lightweight required-field check while `schemas/mallm.schema.json` remains the canonical spec
- Docs: `PROJ-LAYOUT.md` and both `.summary.md` quick references updated to reflect the full docs set and Makefile hook stubs

## [m1-subtree-import] — 2026-06-14 — tag: `utilities-agent-mallm/m1-subtree-import`
Milestone summary: mallm — "man pages for LLMs" — landed in the monorepo as a squashed git subtree, arriving feature-complete as a TypeScript CLI that serves structured, LLM-friendly documentation (`mallm.yaml`) for command-line tools, followed by ignore-file hygiene.

### Added
- CLI (`src/`): entry point, config resolver (project-local → user-config → native → `--help` fallback), help-text parser, output formatter, schema types, and `mallm init` scaffolding
- `schemas/mallm.schema.json` — JSON Schema spec for `mallm.yaml` definitions (summary, usage, arguments, subcommands, env vars, when-to-use/gotcha context, output semantics, skill cross-references)
- `examples/` — `helm-upgrade.mallm.yaml` and `docker-build.mallm.yaml` definitions for monorepo DevOps utilities
- README, `docs/PROJ-ARCH.md` + `docs/PROJ-LAYOUT.md` (with summaries), Makefile monorepo hook stubs, TypeScript 5.8 / Node ≥20 ESM package setup (Commander, yaml, Chalk)

### Changed
- `.gitignore` extended beyond `node_modules/`/`dist/` to cover `*.tsbuildinfo`, editor swap files, `.DS_Store`, and local env files (`.env`, `.env.local`, `.envrc.local`)
