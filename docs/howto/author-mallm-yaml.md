# How to: write a complete mallm.yaml by hand

**Goal:** produce a `mallm.yaml` that gives an LLM agent everything `--help` can't — when to reach for the tool, real multi-step patterns, and the gotchas that waste retries — beyond the bare-bones `mallm init` seed.

**Prereqs:** `mallm` installed (for `mallm validate` / `mallm schema`); know whether this definition is project-local (`.mallm/<app>.yaml`, checked into the repo) or personal (`~/.config/mallm/<app>/mallm.yaml`).

## 1. Start from a seed, or from scratch

```sh
mallm init my-tool          # seeds from `my-tool --help` if it responds
```

Open the resulting `.mallm/my-tool.yaml` (or write one from nothing using the skeleton below).

## 2. Fill in the required fields

Only three fields are required by `mallm validate`:

```yaml
mallm: "1.0"
name: my-tool
summary: One line — what this tool does
```

## 3. Add usage examples

```yaml
usage:
  synopsis: "my-tool [OPTIONS] <target>"
  examples:
    - command: "my-tool build"
      description: "Build the default target"
    - command: "my-tool build --watch"
      description: "Rebuild on file change"
```

## 4. Type your arguments

Each argument needs `name`, `type` (`flag` | `option` | `positional` | `variadic`), and `description` — `mallm validate` flags any that are missing these three:

```yaml
arguments:
  - name: target
    type: positional
    required: false
    description: Build target name. Omit to build the default.
  - name: --watch
    type: flag
    description: Rebuild automatically on source changes.
  - name: --output
    type: option
    default: "dist/"
    description: Output directory for build artifacts.
```

## 5. Document subcommands, env vars, and files (if relevant)

```yaml
subcommands:
  - name: clean
    summary: Remove build artifacts
    examples:
      - command: "my-tool clean"
        description: "Delete dist/ and .cache/"

environment:
  - name: MY_TOOL_TOKEN
    required: true
    description: API token for the remote build cache.

files:
  - path: my-tool.config.yaml
    description: Per-project build configuration.
```

## 6. Write the `context` section — this is the part `--help` can't give you

This is the highest-value section for an agent deciding *whether* and *how* to use the tool:

```yaml
context:
  when_to_use: |
    Use when building this repo's TypeScript targets. Prefer over raw
    `tsc` for anything with a my-tool.config.yaml present.
  when_not_to_use: |
    Don't use for one-off scripts outside the project — plain `tsc` is
    simpler there.
  common_patterns:
    - name: Full rebuild and verify
      steps:
        - "my-tool clean"
        - "my-tool build"
        - "my-tool test"
  gotchas:
    - "--output is relative to the config file's directory, not cwd"
    - "MY_TOOL_TOKEN must be exported, not just set in .env — the tool doesn't load dotenv itself"
```

## 7. Describe output semantics (optional but useful for agents parsing stdout)

```yaml
output:
  stdout: Build progress lines, one per file
  stderr: Compiler errors and warnings
  exit_codes:
    0: Build succeeded
    1: Build failed
    2: Invalid configuration
```

## 8. Cross-reference related tools and extended docs

```yaml
related:
  - name: my-tool-deploy
    description: Deploy artifacts built by my-tool

skills:
  - name: my-tool-workflows
    path: docs/PROJ-HOWTO.md
    description: Full task-oriented guide for this tool's workflows
```

**Verify:**
```sh
mallm validate .mallm/my-tool.yaml   # required-field check
mallm show my-tool                   # render as a human would see it
mallm schema | npx ajv-cli validate -s /dev/stdin -d .mallm/my-tool.yaml   # full schema check
```

**Gotchas:**
- `mallm validate` is intentionally shallow (see PROJ-ARCH's Key Decisions) — it won't catch a malformed `common_patterns` shape or an `exit_codes` key that isn't numeric. Run the schema-based check above before treating a file as done.
- YAML multiline strings (`|`) are the right choice for `when_to_use`/`when_not_to_use` prose — plain scalars get awkward with punctuation and line wraps.
- Project-local (`.mallm/<app>.yaml`) always outranks user-config and native resolution — if you're editing a file and `mallm show` isn't reflecting your changes, check whether a project-local copy is shadowing the one you meant to edit.
