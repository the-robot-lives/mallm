# AGENTS.md — mallm

Guidance for **Codex**, **Grok**, **Cursor**, and other `AGENTS.md` / `AGENT.md` tools.

Claude Code loads [CLAUDE.md](./CLAUDE.md). Same policy; this file is the harness-shaped sibling (numbered MUST first, markdown headings). If both this file and a parent `AGENTS.md` load, **this file wins on conflict**.

## MUST (every turn)

1. **Trinity Protocol (REQUIRED)**: substantive responses run Orientation → Friction → Response (assumptions surfaced; WEDGE/SHADOW/CRITIC; meta-review). Full text: trl-infra `protocols/the-trinity-protocol.md` (+ `.summary.md`).
2. **No shell in the main thread** — delegate lookups/builds/test runs to tasker subagents; they report answers, not raw output.
3. **All work on worktrees** (from this repo's own .git). Integration-testing consolidation branches: `epic.<group>` forked from `develop` (`feature/if-testing-just-one` for single items); feature→epic merges use PR + squash flow for provenance; a fully-passing epic becomes one PR for the group.
4. **PRs target `develop`.** Never merge or push `main` (CI/CD-only release path).

## Identity

LLM helper CLI; see bin/ and README.md for commands.

Part of the Noizu utilities fleet (trl-infra monorepo, `Portfolio/Utilities/source/*`). Installed to `~/.local/bin` via monorepo root `make install-utilities`; some packages are also dual-path registered at repo-root `utilities/<group>/` (same remote/SHA).

## Commands

```bash
make test      # test target (see Makefile; some are no-op placeholders)
make install   # install binaries/completions to ~/.local/bin
```

## Branch & PR Policy

- Submodules sit on **`develop`** — keep your checkout on `develop`.
- All PRs target **`develop`** (feature/bug/task branches fork from `develop`).
- **`main` is CI/CD-only**: CI/CD automation performs all merges into `main` (release path). Never merge to or push `main` by hand.

## Pointers

- Claude Code baseline: [CLAUDE.md](./CLAUDE.md)
