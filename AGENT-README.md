# AGENT-README

> Orientation for AI coding agents working in this repo. Human docs: README.md.

## Type

node-cli

## Purpose

`man` pages for LLM agents — a Node CLI that serves per-tool documentation from `mallm.yaml` files (when to use, workflows, gotchas, argument schemas) as Markdown or JSON.

## Stack

TypeScript, Node >= 20; `commander`, `yaml`, `chalk`; built with `tsc`, run in dev via `tsx`. Binary `bin: mallm → ./dist/index.js`.

## Dev mode

```bash
make install                    # or: npm install && npm run build && npm link
npm run dev                     # tsx src/index.ts
mallm helm-upgrade              # look up a tool
mallm init my-tool [--global]   # create a mallm.yaml stub
npm run dev -- <args>           # run the CLI from source
```

## Ports / URLs

- none (library/CLI)

## Tests

```bash
npm test                        # tsx --test tests/*.test.ts
make test                       # same target
```

## Gotchas

- Resolution order: project-local `.mallm/<app>.yaml` (nearest git root) → `~/.config/mallm/<app>/mallm.yaml` → native `<app> --mallm` → parse `<app> --help` into a basic stub.
- XDG-layout state: sessions `~/.local/share/mallm/sessions/`, history `~/.local/share/mallm/history.jsonl` (redacted), corpus cache `~/.cache/mallm/corpus/` — all env-overridable.
- `schemas/mallm.schema.json` is the canonical spec; `mallm validate` is only a lightweight required-field check.
- Worked examples in `examples/`; platform config (v1.1) lives in `.mallm/config.yaml` / `~/.config/mallm/config.yaml`.
