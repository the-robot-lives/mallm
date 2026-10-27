# Project Layout

```
mallm/
├── src/                        # TypeScript source (~6k lines)
│   ├── index.ts                #   CLI entry (commander): show, init, list, validate, schema,
│   │                           #     sources, session, history, doctor, how-to, search, quiz, learn
│   ├── resolver.ts             #   4-tier mallm.yaml resolution: project → user → native (--mallm) → --help
│   ├── formatter.ts            #   Markdown and JSON (`_meta`) output formatters
│   ├── init.ts                 #   `mallm init` — stub generator (seeds from --help)
│   ├── help-parser.ts          #   Parses `--help` text into a mallm structure
│   ├── schema.ts               #   TypeScript types for mallm.yaml (MallmConfig, ResolvedMallm, …)
│   ├── config/                 #   Platform config resolver chain (v1.1 keys)
│   │   ├── loader.ts           #     .mallm/config.yaml → ~/.config/mallm/config.yaml → defaults
│   │   ├── types.ts            #     PlatformConfig, MallmSource, InferenceConfig, defaults
│   │   └── index.ts
│   ├── corpus/                 #   How-to corpus sources
│   │   ├── adapters.ts         #     http (ETag) / git (clone+fetch) / dir adapters
│   │   ├── cache.ts            #     on-disk cache + meta.json under $XDG_CACHE_HOME/mallm/corpus
│   │   ├── merge.ts            #     priority-ordered deterministic merge
│   │   └── index.ts            #     loadCorpus (fetch) / loadCorpusFromCache (offline)
│   ├── env/                    #   Environment probe
│   │   ├── probe.ts            #     OS flavor/version, arch, shell, PATH tool scan, installers
│   │   └── index.ts
│   ├── session/                #   Session state
│   │   ├── token.ts            #     4-glyph UUIDv5 tokens (base-5744 hieroglyph charset)
│   │   ├── kv.ts               #     file-backed SessionKV at $XDG_DATA_HOME/mallm/sessions
│   │   └── index.ts
│   ├── changelog/              #   Action history
│   │   ├── history.ts          #     append-only history.jsonl (redacted before write)
│   │   ├── redactor.ts         #     strict pre-write redaction (PEM, tokens, env, entropy)
│   │   └── index.ts
│   ├── llm/                    #   OpenAI-compatible chat client (degrades, never throws)
│   │   ├── client.ts
│   │   └── index.ts
│   ├── jev/                    #   TypeSafe "systemone" client + quiz
│   │   ├── client.ts           #     POST /systemone, bearer key from JEV_API_KEY / TYPESAFE_API_KEY
│   │   ├── quiz.ts             #     knowledge.yaml topics → quiz round; answer application
│   │   └── index.ts
│   ├── memory/                 #   Memory tiers + knowledge.yaml
│   │   ├── tiers.ts            #     universal (corpus) / org (first git source) / project / user
│   │   ├── knowledge.ts        #     read / upsert / write knowledge topics
│   │   └── index.ts
│   ├── search/                 #   BM25 (no embeddings, no new deps)
│   │   ├── bm25.ts
│   │   ├── corpus.ts           #     corpus doc → searchable HowtoDoc
│   │   └── index.ts
│   └── howto/                  #   Resumable how-to pipeline
│       ├── machine.ts          #     INTAKE→DRAFT→SELECT→GATE_INSTALL→GATE_RUN→OBSERVE→DIAGNOSE→…
│       ├── cli.ts              #     dep wiring: bash run, installer exec, man/--help fold
│       ├── drafts.ts           #     candidate generation (llm / corpus / template) + diagnose
│       ├── script.ts           #     heuristic script→command extraction, install planning
│       ├── writeback.ts        #     dir / git write-back adapters (commit, push, gh PR)
│       ├── types.ts            #     shared pipeline types + stage constants
│       └── index.ts
├── schemas/
│   └── mallm.schema.json       #   JSON Schema (draft 2020-12) for mallm.yaml — canonical
├── examples/                   #   Reference mallm.yaml files
│   ├── helm-upgrade.mallm.yaml
│   └── docker-build.mallm.yaml
├── tests/                      #   node:test suites via tsx (13 files)
├── dist/                       #   Compiled JS output (gitignored; `npm run build`)
├── docs/                       #   Documentation
│   ├── PROJ-ARCH.md / .summary.md
│   ├── PROJ-LAYOUT.md / .summary.md
│   ├── PROJ-SCHEMA.md / .summary.md
│   ├── PROJ-HOWTO.md / .summary.md
│   ├── PROJ-FAQ.md / .summary.md
│   ├── THREAT-MODEL.md / .summary.md
│   └── howto/author-mallm-yaml.md
├── .github/workflows/ci.yml    #   CI: npm ci + lint + typecheck + test (Node 20)
├── .claude/worktrees/          #   Agent worktrees (gitignored; see CLAUDE.md)
├── .gitignore                  #   node_modules, dist, .env*, .claude/worktrees/
├── AGENT.md / AGENTS.md        #   Guidance for AGENTS.md-shaped tools (kept aligned)
├── CLAUDE.md                   #   Claude Code guidance (commands, monorepo rules)
├── Makefile                    #   Monorepo hook stubs (compile/test no-ops; install → npm)
├── CHANGELOG.md                #   Dated work log
├── merge-notes.md              #   Branch/merge history notes
├── package.json                #   mallm v0.1.0 — bin (`mallm`), scripts, deps
├── package-lock.json           #   Lockfile
├── tsconfig.json               #   TypeScript config (ESM, Node >=20)
├── tsconfig.tests.json         #   Test-specific tsconfig (typecheck target)
└── README.md                   #   Usage, schema reference, resolution order
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry; all commands and global flags |
| `src/resolver.ts` | 4-tier resolution: `.mallm/` → `~/.config/mallm/` → `--mallm` → `--help` |
| `src/howto/machine.ts` | Gated how-to state machine (no `--yes`; per-attempt approvals) |
| `src/session/kv.ts` | File-backed session KV (liftable, zero mallm deps) |
| `src/changelog/redactor.ts` | Strict pre-write redaction — no raw-output escape hatch |
| `schemas/mallm.schema.json` | Canonical mallm.yaml contract |
| `examples/*.mallm.yaml` | Working examples for reference and testing |

## Build & Install

```bash
npm install && npm run build   # Compile TypeScript
npm link                       # Make `mallm` available globally
```
