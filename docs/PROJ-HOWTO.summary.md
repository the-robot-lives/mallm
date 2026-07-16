# PROJ-HOWTO.summary — mallm

Task list only — see [PROJ-HOWTO.md](PROJ-HOWTO.md) for full guides.

- **Install mallm and confirm it works** — get the `mallm` command on your PATH.
- **Look up documentation for a CLI tool** — get structured when-to-use/how-to/gotcha docs for a tool instead of raw `--help`.
- **Get machine-readable output for scripting** — consume mallm docs programmatically (agent tool calls, pipelines).
- **Create a mallm.yaml stub for a tool you own** — bootstrap documentation for a tool instead of authoring the YAML from scratch.
- **Write a complete mallm.yaml by hand** — author the full schema (usage, arguments, subcommands, context) for a tool that deserves more than the `init` seed. → [howto/author-mallm-yaml.md](howto/author-mallm-yaml.md)
- **Validate a mallm.yaml before committing it** — catch missing required fields before an agent hits a malformed definition.
- **See every mallm definition available to you** — discover what's already documented before writing a duplicate.
- **Get the canonical schema for external validation** — validate a `mallm.yaml` against the full JSON Schema (e.g. in CI, or with a schema-aware editor).
- **Make your own tool natively mallm-aware** — skip the file-based lookup entirely; your tool answers `--mallm` directly, always in sync with the code.
- **Version a tool's documentation** — keep multiple `mallm.yaml` revisions around and pick one explicitly.
