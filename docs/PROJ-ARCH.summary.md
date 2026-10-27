# Project Architecture — Summary

**mallm** is a Node.js CLI that provides structured, LLM-friendly documentation for CLI tools plus a
gated, resumable how-to pipeline on top of it. Single process, no server or database; local
file-backed state under XDG dirs and outbound calls only on explicit action.

**Resolution chain**: project-local `.mallm/` → user `~/.config/mallm/` → native `--mallm` protocol
→ `--help` fallback parsing.

**Core components**: CLI entry (commander), resolver, formatter (markdown / JSON + `_meta`), help
parser, init, schema (TS types + JSON Schema), platform config chain, corpus adapters
(http/git/dir + cache + priority merge), env probe, glyph session tokens + `SessionKV`, redacted
history, OpenAI-compatible inference client, Jev (TypeSafe systemone) client, memory tiers +
`knowledge.yaml`, hand-rolled BM25 search, and the how-to state machine.

**Platform config (v1.1)**: `.mallm/config.yaml` → `~/.config/mallm/config.yaml` → defaults; keys
`sources[]`, `inference`, `redaction.patterns`, `sessionTtl`. v1.0 files stay valid.

**How-to pipeline**: INTAKE → DRAFT → SELECT → GATE_INSTALL → GATE_RUN → OBSERVE →
DIAGNOSE+PATCH (≤3) → SUCCESS → WRITEBACK → CLOSE. No `--yes`: install approval is plan-hash-scoped,
run approval is per-attempt; script output is redacted strictly pre-persist; write-back appends a
`howtos:` entry (dir = local commit, git = branch + push + PR).

**Local state**: sessions `$XDG_DATA_HOME/mallm/sessions/`, history `history.jsonl`, corpus cache
`$XDG_CACHE_HOME/mallm/corpus/`, knowledge `~/.config/mallm/knowledge.yaml`. No DB.

**Security posture**: inference/Jev keys only in `Authorization` headers (env names in errors);
write-back token via env-injected git credential helper + `GH_TOKEN` (never argv/URLs); how-to
scripts require explicit approval and are redacted pre-persist. Residual: `resolver.ts` native/help
tiers and `init.ts` still use `execSync` template strings with the `app` argument (see THREAT-MODEL).

**Ecosystem fit**: standalone portfolio submodule (no `k8-lib`, no `.infra-config.yaml`, npm-link
install); documents the monorepo's DevOps CLIs for LLM agents.

**Stack**: TypeScript 5.8, Node ≥20 ESM, Commander 13, yaml 2.7, Chalk 5, `tsc` only, `node:test`
via tsx.
