# Project Layout

```
mallm/
├── src/                        # TypeScript source
│   ├── index.ts                #   CLI entry point (commander): show, init, list, validate, schema
│   ├── resolver.ts             #   Resolution chain: project → user → native (--mallm) → help fallback
│   ├── formatter.ts            #   Markdown and JSON output formatters
│   ├── init.ts                 #   `mallm init` — stub generator (seeds from --help)
│   ├── help-parser.ts          #   Parses `--help` output into mallm structure
│   └── schema.ts               #   Schema types and validation helpers
├── schemas/                    # Validation
│   └── mallm.schema.json       #   JSON Schema for mallm.yaml format (canonical)
├── examples/                   # Reference mallm.yaml files
│   ├── helm-upgrade.mallm.yaml #   Multi-option orchestrator tool example
│   └── docker-build.mallm.yaml #   Simpler build tool example
├── dist/                       # Compiled JS output (gitignored; `npm run build`)
├── docs/                       # Documentation
│   ├── PROJ-ARCH.md            #   Architecture overview
│   ├── PROJ-ARCH.summary.md    #   Architecture quick reference
│   ├── PROJ-LAYOUT.md          #   This file
│   ├── PROJ-LAYOUT.summary.md  #   Layout quick reference (kept in sync)
│   ├── PROJ-HOWTO.md           #   How-to guide for authoring/using mallm docs
│   ├── PROJ-HOWTO.summary.md   #   How-to quick reference
│   ├── PROJ-FAQ.md             #   Frequently asked questions
│   ├── PROJ-FAQ.summary.md     #   FAQ quick reference
│   └── howto/
│       └── author-mallm-yaml.md #  Guide: authoring a mallm.yaml for your tool
├── .gitignore                  # Ignores node_modules, dist, *.tsbuildinfo, .env*, swap files
├── CLAUDE.md                   # Claude Code guidance (commands, monorepo rules)
├── Makefile                    # Monorepo hook stubs (compile/test no-ops; install → npm)
├── CHANGELOG.md                # Release history
├── merge-notes.md              # Branch/merge history notes (sep-1 sweep, 2026-09-01)
├── package.json                # mallm v0.1.0 — bin entry (`mallm`), scripts, deps
├── package-lock.json           # Lockfile
├── tsconfig.json               # TypeScript config (ESM, Node >=20)
└── README.md                   # Usage, schema reference, resolution order
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI commands: `show`, `init`, `list`, `validate`, `schema` |
| `src/resolver.ts` | 4-tier resolution: `.mallm/` → `~/.config/mallm/` → `--mallm` → `--help` |
| `schemas/mallm.schema.json` | Canonical schema defining the mallm.yaml format |
| `examples/*.mallm.yaml` | Working examples for reference and testing |

## Build & Install

```bash
npm install && npm run build   # Compile TypeScript
npm link                       # Make `mallm` available globally
```
