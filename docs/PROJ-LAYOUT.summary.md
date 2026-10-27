# Project Layout — Summary

```
mallm/
├── src/                        # TypeScript source (~6k lines)
│   ├── index.ts                #   CLI entry (all commands + global flags)
│   ├── resolver.ts             #   4-tier resolution chain
│   ├── formatter.ts            #   Markdown / JSON output
│   ├── init.ts                 #   Stub generator
│   ├── help-parser.ts          #   --help parser
│   ├── schema.ts               #   mallm.yaml TS types
│   ├── config/                 #   Platform config chain (loader, types)
│   ├── corpus/                 #   Source adapters, cache, merge
│   ├── env/                    #   Environment probe
│   ├── session/                #   Glyph tokens + file-backed SessionKV
│   ├── changelog/              #   history.jsonl + strict redactor
│   ├── llm/                    #   OpenAI-compatible chat client
│   ├── jev/                    #   TypeSafe systemone client + quiz
│   ├── memory/                 #   Tier resolution + knowledge.yaml
│   ├── search/                 #   BM25 index + corpus mapping
│   └── howto/                  #   Gated how-to machine, drafts, script, write-back
├── schemas/                    #   mallm.schema.json (canonical)
├── examples/                   #   Example mallm.yaml files
├── tests/                      #   node:test suites (13 files)
├── dist/                       #   Build output (gitignored)
├── docs/                       #   PROJ-ARCH/-LAYOUT/-SCHEMA/-HOWTO/-FAQ + THREAT-MODEL (+ summaries), howto/
├── .github/workflows/ci.yml    #   CI: lint + typecheck + test
├── .claude/worktrees/          #   Agent worktrees (gitignored)
├── .gitignore                  #   node_modules, dist, .env*, .claude/worktrees/
├── AGENT.md / AGENTS.md        #   AGENTS.md-shaped tool guidance (kept aligned)
├── CLAUDE.md                   #   Claude Code guidance
├── Makefile                    #   Monorepo hook stubs
├── CHANGELOG.md                #   Dated work log
├── merge-notes.md              #   Branch/merge history notes
├── package.json                #   Config and deps
├── package-lock.json           #   Lockfile
├── tsconfig.json               #   TypeScript config (ESM, Node >=20)
├── tsconfig.tests.json         #   Test tsconfig (typecheck target)
└── README.md                   #   Project docs
```
