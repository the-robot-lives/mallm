# Project Architecture — Summary

**mallm** is a Node.js CLI that provides structured, LLM-friendly documentation for command-line tools.

**Resolution chain**: project-local `.mallm/` → user `~/.config/mallm/` → native `--mallm` protocol → `--help` fallback parsing.

**Core components**: CLI entry (commander), resolver (4-tier file/exec lookup), formatter (markdown/JSON), help parser (regex extraction), init (stub scaffolding), schema (TypeScript types + JSON Schema).

**Data model**: `MallmConfig` — summary, usage examples, typed arguments, subcommands, environment vars, LLM context (when to use, patterns, gotchas), output semantics, skill/related cross-references.

**Ecosystem fit**: a portfolio submodule of the Noizu Infra monorepo (`Portfolio/Utilities/source/mallm`, branch `mono-repo-dev`) but standalone — no `k8-lib`, no `.infra-config.yaml` coupling, installed via npm link (Makefile is monorepo hook stubs, not `make install-utilities`). Its job is documenting the repo's DevOps CLIs (helm-upgrade, docker-build, etc.) for LLM agents.

**Validation**: `mallm validate` is a lightweight required-field check; `schemas/mallm.schema.json` is the canonical spec but not yet enforced by the CLI.

**Stack**: TypeScript 5.8, Node ≥20 ESM, Commander 13, yaml 2.7, Chalk 5. No bundler — `tsc` only.
