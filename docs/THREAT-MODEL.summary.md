# Threat Model — Summary

Stateless local CLI; no network, persistence, or secrets. Dominant boundary is data → execution: the `app` argument and YAML content reach `execSync` shell strings and agent-consumed output.

**Register**: T-001 shell injection via unsanitized `app` in `execSync` templates (resolver + init) — High, Open. T-002 parsed YAML cast unvalidated into agent output (doc injection) — Medium, Open. T-003 YAML/parse DoS — Low, Partial (alias caps + 5 s exec timeouts). T-004 `_meta` path disclosure + stderr merge in help fallback — Low, Accepted. T-005 `init` path traversal via `app` in output paths — Low, Open. T-006 npm supply chain (commander/yaml/chalk, lockfile) — Low, Accepted.

**Key remediations**: argv-array `execFileSync` (or `[A-Za-z0-9._-]+` allowlist) for T-001; schema-validate on load for T-002/T-005.

**Residual**: agent-mediated injection accepted until argv-array execution lands — treat agent-sourced `app` names as shell-equivalent.
