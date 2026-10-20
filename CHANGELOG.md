# Changelog — mallm

## [Unreleased]
- Docs: `PROJ-ARCH.md` gained an "Ecosystem Fit" section (standalone Node package, decoupled from `k8-lib`/`.infra-config.yaml`; npm-link install) and a note that `mallm validate` is a lightweight required-field check while `schemas/mallm.schema.json` remains the canonical spec
- Docs: `PROJ-LAYOUT.md` and both `.summary.md` quick references updated to reflect the full docs set and Makefile hook stubs

## [semtext-howto] — 2026-10-21
Wave 2 of the SemText how-to platform: the resumable how-to state machine, the jev (TypeSafe systemone) client, gated script execution with strict redaction, and corpus write-back.

### Added
- `src/howto/` — resumable state machine (state in the session KV `howto` bucket; one CLI invocation = one advance): INTAKE (env probe + corpus + memory tiers) → DRAFT (2–3 candidate bash scripts via `llm/` when configured, corpus-adapted BM25 otherwise, template fallback — every path degrades, never throws) → SELECT → GATE_INSTALL (installs only with explicit approval; plan-hash-scoped approval id) → GATE_RUN (per-attempt approval id, output redacted STRICTLY pre-persist) → OBSERVE → DIAGNOSE+PATCH (LLM patch or candidate rotation) → back to GATE_RUN (max 3 attempts, then stopped) → SUCCESS → WRITEBACK → CLOSE. NO `--yes` bypass exists; approvals arrive via `mallm session approve|deny <token> <requestId>` or the narrow `--approve-install`/`--approve-run` flags for a single invocation
- `src/jev/` — TypeSafe systemone client: `POST {JEV_BASE_URL|https://api.typesafe.ai/v1}/systemone` with `{model:"jev-latest", state, questions}`, bearer key from `JEV_API_KEY`/`TYPESAFE_API_KEY` (env names only in errors); typed no-key/error degrade matching `llm/`; quiz building from knowledge.yaml topics (lowest-confidence first; boolean/score/choice with corpus-synopsis distractors) and answer application (boolean ±2, score sets, choice ±1, clamped 0–10)
- Write-back (D4) — finalized how-to appended as a `howtos:` entry to the corpus source doc: `dir` adapter = local commit on `howto/<session-token>`; `git` adapter = branch off the source's tracked branch + push + PR via gh. Push tokens travel via an env-injected git credential helper referencing the env var NAME (`sources[].tokenEnv` — never a value, never in argv/URLs); gh reads `GH_TOKEN` from env
- CLI: `how-to [goal] [--tool --dry-run --pick N --approve-install --approve-run --json]`, `search <query> [--refresh --json]` (BM25 over doc-level + howtos-section corpus entries), `quiz [--topic --json]` (plain-text rendering; SemText view-as=quiz lands wave 2b), `learn [--topic --limit --json]` (jev round applied to knowledge.yaml, degrades to quiz rendering), `show <app> [--agent --json]` now folds cached corpus entry + man/--help text + OS context and appends `SESSION <glyphs>` (reuses `--session` when live), `session approve|deny <token> <requestId> [--note]`, `sources add --token-env <env>`
- `src/search/corpus.ts` — corpus → BM25 doc mapping (one entry per corpus doc + one per `howtos[]` section)
- Tests (`tests/howto-machine.test.ts`, `tests/howto-drafts.test.ts`, `tests/jev.test.ts`, `tests/writeback.test.ts`): state-machine golden path + gate refusal (approval flags REQUIRED — zero runs without them) + 3-loop cap with per-attempt approvals + resumability across fresh instances, draft generation via mocked ChatFetch, jev client via mocked fetch, write-back via mocked git/gh asserting the token never reaches argv, GATE_RUN redaction proven on FAKE secrets in both state and the on-disk session file

### Changed
- `src/session/kv.ts` — new `howto` bucket (appended last; existing buckets unchanged)
- `src/env/` — light `osContext()` probe (OS flavor/version, arch, shell) without the PATH scan, for read paths
- `src/memory/knowledge.ts` — `writeKnowledge()` (sorted, lineWidth 100) for the learn/write-back paths
- `src/config/` — `sources[].tokenEnv` (env var NAME for write-back auth) accepted by the loader, CLI, and schema
- `src/corpus/` — cache-only sync/load helpers (`syncSourceCached`, `loadCorpusFromCache`) so `search` and `show` default to no network
- `.gitignore` — `.claude/worktrees/` (canonical worktree placement, per monorepo convention)
- manifests branch seeded: tools registry + git/docker-build/helm-upgrade v0.8 seeds

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
