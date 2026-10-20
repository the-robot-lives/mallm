# Changelog — mallm

## [Unreleased]
- Docs: `PROJ-ARCH.md` gained an "Ecosystem Fit" section (standalone Node package, decoupled from `k8-lib`/`.infra-config.yaml`; npm-link install) and a note that `mallm validate` is a lightweight required-field check while `schemas/mallm.schema.json` remains the canonical spec
- Docs: `PROJ-LAYOUT.md` and both `.summary.md` quick references updated to reflect the full docs set and Makefile hook stubs

## [semtext-foundation] — 2026-10-21
Foundation wave of the SemText-powered how-to platform: config, corpus, env probe, sessions, redacting history, inference client, BM25 search, memory tiers.

### Added
- `src/config/` — platform config resolver chain (project `.mallm/config.yaml` → user `~/.config/mallm/config.yaml` → defaults) with v1.1 keys: `sources[]` (http|git|dir, url or repo+branch, priority, credsRef), `inference{baseUrl,apiKeyEnv,model}`, `redaction.patterns[]`, `sessionTtl`; v1.0 files stay valid via defaults
- `src/corpus/` — source adapters (http GET with ETag pinning, git clone/fetch of repo+branch, local dir), priority-ordered deterministic merge, on-disk cache at `$XDG_CACHE_HOME/mallm/corpus/` (~/.cache default) with fetch-on-miss
- `src/env/` — environment probe: OS flavor (windows|linux|macos|chromeos|android|ios) + version, arch, shell, PATH-scan tool inventory with `--version` probing (curated list + explicit requests), installer detection (brew/apt/winget/scoop/choco/npm)
- `src/session/` — glyph session tokens (UUIDv5 SHA-1 over UTC-iso+host+pid+counter seed → 4 glyphs base-5744 over the doc-pointers hieroglyph charset, collision retry on attempt-suffixed seed) + file-backed `SessionKV` at `$XDG_DATA_HOME/mallm/sessions/<token>.json` with buckets env/downloads/installed/approvals/decisions and `inject()` prompt context block; zero deps on other mallm modules (liftable)
- `src/changelog/` — append-only `history.jsonl` at `$XDG_DATA_HOME/mallm/` ({ts,session,action,command,files,outcome,redactions}) with a STRICTLY pre-write redactor (env assignments, bearer/AKIA/prefixed tokens, PEM blocks, credentialed URLs, config patterns, entropy guard ≥20 chars >4.5 bits/char) — no raw-output escape hatch; redactor exported for reuse
- `src/llm/` — minimal OpenAI-compatible chat client; every consumer degrades to a typed `no-inference` result when unconfigured, never throws
- `src/search/` — hand-rolled BM25 over the `howtos.json` doc shape ({id,tool,title,summary,tags,os,ranges}); no new deps, no embeddings
- `src/memory/` — tier resolution (universal = corpus sources, org = highest-precedence git source, project = `<cwd>/.mallm/`, user = `~/.config/mallm/`) + `knowledge.yaml` read/upsert helpers
- CLI: `mallm sources list|add|update`, `mallm session <TOKEN>|clear`, `mallm history [--session] [--tail N]`, `mallm doctor` (env probe + source reachability + inference check); global flags `--session --os --os-version --tool-version --json --no-color`
- Tests (`tests/`, Node built-in `node:test` via tsx): redactor on FAKE values, token determinism + golden vector + collision retry, KV round-trip + inject, config v1.1 parse with v1.0 fixture staying valid, corpus priority merge + stubbed http caching, BM25 ranking, history redaction on disk; all file I/O in temp XDG dirs
- CI (`.github/workflows/ci.yml`): npm ci + lint + typecheck + test on Node 20 (repo previously had no CI)

### Changed
- `schemas/mallm.schema.json` — `mallm` enum widened to `["1.0","1.1"]`; `sources`, `inference`, `redaction`, `sessionTtl` added as optional properties (required set unchanged — every v1.0 file still validates)
- `mallm validate` accepts `mallm: "1.1"` and reports the schema version
- `package.json` — `test` (tsx --test) and `typecheck` scripts; no new runtime dependencies

## [m1-subtree-import] — 2026-06-14 — tag: `utilities-agent-mallm/m1-subtree-import`
Milestone summary: mallm — "man pages for LLMs" — landed in the monorepo as a squashed git subtree, arriving feature-complete as a TypeScript CLI that serves structured, LLM-friendly documentation (`mallm.yaml`) for command-line tools, followed by ignore-file hygiene.

### Added
- CLI (`src/`): entry point, config resolver (project-local → user-config → native → `--help` fallback), help-text parser, output formatter, schema types, and `mallm init` scaffolding
- `schemas/mallm.schema.json` — JSON Schema spec for `mallm.yaml` definitions (summary, usage, arguments, subcommands, env vars, when-to-use/gotcha context, output semantics, skill cross-references)
- `examples/` — `helm-upgrade.mallm.yaml` and `docker-build.mallm.yaml` definitions for monorepo DevOps utilities
- README, `docs/PROJ-ARCH.md` + `docs/PROJ-LAYOUT.md` (with summaries), Makefile monorepo hook stubs, TypeScript 5.8 / Node ≥20 ESM package setup (Commander, yaml, Chalk)

### Changed
- `.gitignore` extended beyond `node_modules/`/`dist/` to cover `*.tsbuildinfo`, editor swap files, `.DS_Store`, and local env files (`.env`, `.env.local`, `.envrc.local`)
