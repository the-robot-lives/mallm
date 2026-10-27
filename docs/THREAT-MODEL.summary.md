# Threat Model — Summary

Local CLI; no network listener or database, but outbound egress on explicit action (corpus sync,
inference, Jev, write-back) and local persisted state. Dominant boundaries: data → execution (the
`app` argument and YAML/LLM content reach shell/`execSync` and agent-consumed output) and data →
egress (prompts/corpus → third-party inference with provider keys).

**Register (10)**: T-001 shell injection via unsanitized `app` in `execSync` templates (resolver +
init) — High, **Open**. T-002 unvalidated YAML cast into agent output (resolver + corpus) — Medium,
**Open**. T-003 YAML/parse DoS — Low, Partial (alias caps + timeouts + buffers). T-004 `_meta` path
disclosure + stderr fold — Low, Accepted. T-005 `init` path traversal via `app` — Low, **Open**. T-006
npm supply chain (commander/yaml/chalk, no new deps) — Low, Accepted. T-007 how-to bash execution
(LLM/corpus-drafted) — Medium, **Mitigated with residual** (per-attempt approval, no `--yes`,
pre-persist redaction; gate = consent, not sandbox). T-008 inference/Jev egress with API keys —
Medium, **Partial** (keys in header only, env names in errors; data leaves host). T-009 corpus
source fetch/clone (http/git/dir) — Low, **Partial**. T-010 write-back token handling — Low,
**Mitigated** (token via env-injected git credential helper + `GH_TOKEN`, never argv/URLs; residual:
child-process env).

**Coverage**: 2 mitigated w/ residual · 3 partial · 2 accepted · 3 open.

**Key remediations**: argv-array `execFileSync` (or `[A-Za-z0-9._-]+` allowlist) for T-001; schema-
validate on load and on corpus docs for T-002/T-009; single-path-segment check for T-005.

**Residual**: agent-mediated injection accepted until argv-array execution lands — treat
agent-sourced `app` names as shell-equivalent; approved LLM scripts run with user privileges;
enabling inference sends prompt/corpus data off-host. No secret values are stored or emitted.
