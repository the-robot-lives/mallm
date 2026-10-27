# mallm

<!-- 〚📁:af4b66c6-fdcd-5b96-a758-8bb7bb6b2d29〛 mallm README :: Overview, usage, resolution order, schema reference -->

**Repo:** https://github.com/the-robot-lives/mallm

`man` pages for LLM agents — structured, LLM-friendly documentation for CLI tools.

## What

A Node CLI (`mallm`, Node >= 20) that serves per-tool documentation from `mallm.yaml` files: when to use a tool vs alternatives, typical multi-step workflows, gotchas, argument/subcommand schemas, and links to extended docs. Output is Markdown (default) or JSON (`--json`, with `_meta` source/timestamp).

## Why

`--help` gives flags and `man` gives prose; neither tells an AI agent *when* to reach for a tool, what the working pattern looks like, or which pitfalls waste retries. mallm gives agents (and humans) that operational layer in a parseable, standardized format.

## Getting Started

```bash
make install          # or: npm install && npm run build && npm link
```

```sh
mallm helm-upgrade                    # look up a tool (shorthand)
mallm show docker-build --json        # explicit show, JSON output
mallm init my-tool [--global]         # create a mallm.yaml stub (seeds from --help)
mallm list                            # list all known definitions
mallm validate .mallm/my-tool.yaml    # validate a mallm.yaml
mallm schema                          # print the JSON Schema
mallm sources list|add|update         # how-to corpus sources (http | git | dir)
mallm session <TOKEN>|clear           # session KV (4-glyph hieroglyph tokens)
mallm history [--session <tok>] [--tail N]
mallm doctor                          # env probe + source reachability + inference check
make test                             # test suite
```

## How It Works

- **Resolution order**: project-local `.mallm/<app>.yaml` (nearest git root) → user config `~/.config/mallm/<app>/mallm.yaml` → native `<app> --mallm` (mallm-aware tools print their own YAML) → parse `<app> --help` into a basic stub.
- **Schema** (`schemas/mallm.schema.json`): `summary`, `usage.examples`, typed `arguments`/`subcommands`, `environment`, `context` (when_to_use / when_not_to_use / common_patterns / gotchas), `skills`, `related`, `output`.
- **`--mallm` protocol**: tools can natively answer `--mallm` with schema-valid YAML on stdout; optional — config files work without it.
- **Platform config (v1.1)**: `.mallm/config.yaml` (project) → `~/.config/mallm/config.yaml` (user) → defaults — corpus `sources[]`, `inference`, `redaction.patterns[]`, `sessionTtl`; v1.0 definition files remain valid. Sessions live at `~/.local/share/mallm/sessions/`, the redacted history log at `~/.local/share/mallm/history.jsonl`, the corpus cache at `~/.cache/mallm/corpus/` (all XDG-overridable).
- Worked examples live in `examples/` (`helm-upgrade.mallm.yaml`, `docker-build.mallm.yaml`); full docs in `docs/` (PROJ-ARCH/SCHEMA/HOWTO).

## Example

```yaml
mallm: "1.0"
name: helm-upgrade
context:
  when_to_use: |
    Use when deploying Kubernetes services. Prefer over raw
    `helm upgrade` for multi-chart deployments.
  gotchas:
    - "preApply manifests are kubectl-applied, not helm-managed"
```

## Repo Layout

- `src/` — TypeScript CLI (built with `npm run build`; `npm run dev` = tsx)
- `schemas/mallm.schema.json` — JSON Schema
- `examples/` — complete mallm.yaml files
