# PROJ-HOWTO — mallm

Task-oriented guides for the things you'll actually do with `mallm`. For *what it is*, see [PROJ-ARCH.md](PROJ-ARCH.md); for *where things live*, see [PROJ-LAYOUT.md](PROJ-LAYOUT.md).

## How to: install mallm and confirm it works

**Goal:** get the `mallm` command on your PATH.
**Prereqs:** Node.js ≥20.

1. ```sh
   cd utilities/agent/mallm
   npm install
   npm run build
   npm link
   ```

**Verify:** `mallm --version` prints `0.1.0`.
**Gotchas:**
- `npm link` requires npm's global bin dir on `$PATH`; if `mallm: command not found` after linking, check `npm config get prefix`.
- There's no `make install-utilities` path for this tool — it's decoupled from the shell-utility/`k8-lib` convention its siblings use (see PROJ-ARCH's Ecosystem Fit section). `Makefile`'s `install` target only prints a pointer back to npm.

## How to: look up documentation for a CLI tool

**Goal:** get structured when-to-use/how-to/gotcha docs for a tool instead of raw `--help`.
**Prereqs:** `mallm` installed; the target tool on PATH if you want native/help-fallback resolution.

1. ```sh
   mallm helm-upgrade          # shorthand for: mallm show helm-upgrade
   mallm show docker-build     # explicit form
   ```

**Verify:** markdown output with `Summary`, `Usage`, `Context` sections (or a `help-generated` provenance note if no `mallm.yaml` exists yet).
**Gotchas:**
- Resolution order is project-local (`.mallm/<app>.yaml`) → user-config (`~/.config/mallm/<app>/`) → native (`<app> --mallm`) → `--help` fallback. If you edited a `.mallm/<app>.yaml` and don't see the change, confirm you're in (or under) the git root that owns it — resolution walks up from `cwd` looking for `.git` or `.mallm`.
- No definition anywhere → `No mallm documentation found` and exit 1. Create one with `mallm init <app>`.

## How to: get machine-readable output for scripting

**Goal:** consume mallm docs programmatically (agent tool calls, pipelines).
**Prereqs:** same as lookup, above.

1. ```sh
   mallm show docker-build --json
   ```

**Verify:** JSON with the full `MallmConfig` plus a `_meta` block (`source`, resolved `path`, timestamp).
**Gotchas:** `--json` works on the shorthand form too (`mallm docker-build --json`), not just `show`.

## How to: create a mallm.yaml stub for a tool you own

**Goal:** bootstrap documentation for a tool instead of authoring the YAML from scratch.
**Prereqs:** the target tool responds to `--help` (recommended, not required).

1. ```sh
   mallm init my-tool            # writes .mallm/my-tool.yaml at the git root
   mallm init my-tool --global   # writes ~/.config/mallm/my-tool/mallm.yaml instead
   ```

**Verify:** command prints `Created: <path>`; open the file and fill in the `TODO:` markers (`when_to_use`, `when_not_to_use`, `summary` if `--help` parsing came up empty).
**Gotchas:**
- Re-running `init` on an existing target is a no-op — it prints `Already exists: <path>` rather than overwriting; delete the file first if you want a fresh seed.
- Project-local writes go to the **git root's** `.mallm/`, not your current directory, even if you're several subdirectories deep.
- If `<app> --help` fails or is empty, you get the same bare-bones template as a tool with no help text at all — there's no error, just less to start from.

## How to: write a complete mallm.yaml by hand

Author the full schema — usage examples, typed arguments, subcommands, LLM-facing context — for a tool that deserves more than the `init` seed.
→ *See [howto/author-mallm-yaml.md](howto/author-mallm-yaml.md)*

## How to: validate a mallm.yaml before committing it

**Goal:** catch missing required fields before an agent hits a malformed definition.
**Prereqs:** a `mallm.yaml` file (from `init` or hand-authored).

1. ```sh
   mallm validate .mallm/my-tool.yaml
   ```

**Verify:** `Valid: <path>` plus a name/summary/argument-count summary; exit code 0.
**Gotchas:**
- This is a **lightweight** check — it only confirms `mallm`, `name`, `summary` are present and that each `arguments[]` entry has `name`/`type`/`description`. It is *not* full JSON Schema validation against `schemas/mallm.schema.json`; a file can pass `validate` and still violate the canonical schema (see `mallm schema` below to compare by hand).
- Parse errors (bad YAML) report `Failed to parse: <error>` and exit 1 — same exit code as a validation failure, so scripts checking `$?` treat both cases identically.

## How to: see every mallm definition available to you

**Goal:** discover what's already documented before writing a duplicate.
**Prereqs:** none.

1. ```sh
   mallm list          # grouped by source: project-local, user-config
   mallm list --json
   ```

**Verify:** definitions grouped under `project-local` / `user-config` headers with name and path; empty case prints a hint to run `mallm init`.
**Gotchas:** `list` only enumerates project-local and user-config files on disk — it can't discover native (`--mallm`) or help-fallback coverage, since those require executing each candidate tool.

## How to: get the canonical schema for external validation

**Goal:** validate a `mallm.yaml` against the full JSON Schema (e.g. in CI, or with a schema-aware editor).
**Prereqs:** none.

1. ```sh
   mallm schema > mallm.schema.json
   # then feed to any JSON Schema validator, e.g.:
   npx ajv-cli validate -s mallm.schema.json -d .mallm/my-tool.yaml
   ```

**Verify:** valid JSON Schema document printed to stdout.
**Gotchas:** `mallm schema` only works when run from the installed package (it reads `schemas/mallm.schema.json` relative to the built `dist/`); it fails with a "not found" error if that file is missing from the install.

## How to: make your own tool natively mallm-aware

**Goal:** skip the file-based lookup entirely — your tool answers `--mallm` directly, so it's always in sync with the code.
**Prereqs:** a tool you control that can add a flag.

1. Make `<your-tool> --mallm` print valid `mallm.yaml`-shaped YAML to stdout (same schema as any hand-authored file — see `mallm schema`).
2. Don't create a `.mallm/<app>.yaml` or `~/.config/mallm/<app>/mallm.yaml` for that tool — project-local and user-config both outrank native in the resolution order, so a stale file would shadow your live `--mallm` output.

**Verify:** `mallm <your-tool>` shows a `native` source/provenance instead of `help-generated`.
**Gotchas:** native resolution shells out with a 5s timeout and swallows non-zero exit / stderr as "unsupported" — a slow or crashing `--mallm` handler silently falls through to the `--help` fallback instead of erroring, which can mask a bug in your handler.

## How to: version a tool's documentation

**Goal:** keep multiple `mallm.yaml` revisions around (e.g. docs matching `v1` vs `v2` of a CLI) and pick one explicitly.
**Prereqs:** documentation lives in **user-config**, not project-local — only `~/.config/mallm/<app>/` supports version subdirectories.

1. ```sh
   mkdir -p ~/.config/mallm/my-tool/2.0
   cp draft.yaml ~/.config/mallm/my-tool/2.0/mallm.yaml
   mallm show my-tool --version 2.0
   ```

**Verify:** the returned doc's path includes `.../my-tool/2.0/mallm.yaml`.
**Gotchas:**
- `--version` only affects user-config resolution; project-local `.mallm/<app>.yaml` has no version concept and always wins if present, regardless of `--version`.
- Without `--version` (or if the requested version dir is missing), lookup falls back to `.../my-tool/latest/mallm.yaml`, then `.../my-tool/mallm.yaml` — keep a `latest/` populated if you rely on unversioned lookups.
