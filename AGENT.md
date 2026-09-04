# AGENT.md — mallm

LLM helper CLI; see bin/ and README.md for commands.


Part of the Noizu utilities fleet (trl-infra monorepo, `Portfolio/Utilities/source/*`). Installed to `~/.local/bin` via monorepo root `make install-utilities`; some packages are also dual-path registered at repo-root `utilities/<group>/` (same remote/SHA).

## Commands

```bash
make test      # test target (see Makefile; some are no-op placeholders)
make install   # install binaries/completions to ~/.local/bin
```

## Monorepo rules (REQUIRED)

- **Trinity Protocol (REQUIRED)**: substantive responses run Orientation → Friction → Response (assumptions surfaced; WEDGE/SHADOW/CRITIC; meta-review). Full text: trl-infra `protocols/the-trinity-protocol.md` (+ `.summary.md`).
- **No shell in the main thread** — delegate lookups/builds/test runs to tasker subagents; they report answers, not raw output.
- **All work on worktrees** (from this repo's own .git). Integration-testing consolidation branches: `epic.<group>` forked from `develop` (`feature/if-testing-just-one` for single items); feature→epic merges use PR + squash flow for provenance; a fully-passing epic becomes one PR for the group.

Monorepo-wide ops (secrets/dc, terraform, submodule sweeps): see `../../../../CLAUDE.md` and `docs/secret-management.md` at the trl-infra root.
