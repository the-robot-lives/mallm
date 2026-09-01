# Project Layout — Summary

```
mallm/
├── src/                        # TypeScript source
│   ├── index.ts                #   CLI entry point
│   ├── resolver.ts             #   Resolution chain
│   ├── formatter.ts            #   Output formatters
│   ├── init.ts                 #   Stub generator
│   ├── help-parser.ts          #   --help parser
│   └── schema.ts               #   Schema types
├── schemas/                    # JSON Schema (mallm.schema.json)
├── examples/                   # Example mallm.yaml files
├── dist/                       # Build output (gitignored)
├── docs/                       # PROJ-ARCH + PROJ-LAYOUT + PROJ-HOWTO + PROJ-FAQ (+ summaries), howto/
├── .gitignore                  # Ignores node_modules, dist, .env*
├── Makefile                    # Monorepo hook stubs
├── CHANGELOG.md                # Release history
├── merge-notes.md              # Branch/merge history notes
├── package.json                # Config and deps
├── package-lock.json           # Lockfile
├── tsconfig.json               # TypeScript config
└── README.md                   # Project docs
```
