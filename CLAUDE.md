# CLAUDE.md — mallm

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
- **Worktrees (REQUIRED)**: canonical placement `.claude/worktrees/<name>/`, created from this repo's own `.git` off `develop`; `.claude/worktrees/` is gitignored — see **Worktrees — Canonical Convention** below.

Monorepo-wide ops (secrets/dc, terraform, submodule sweeps): see `../../../../CLAUDE.md` and `docs/secret-management.md` at the trl-infra root.

## Branch & PR Policy

- Submodules sit on **`develop`** — keep your checkout on `develop`.
- All PRs target **`develop`** (feature/bug/task branches fork from `develop`).
- **`main` is CI/CD-only**: CI/CD automation performs all merges into `main` (release path). Never merge to or push `main` by hand.

## Worktrees — Canonical Convention (REQUIRED)

All work happens on git worktrees, created from **this repo's own `.git`** — never work directly on a shared checkout of `develop`/`main`.

- **Placement (fixed):** every worktree lives inside this repo's checkout at **`.claude/worktrees/<name>/`** — never siblings (`<repo>.worktrees/`), never ad-hoc paths. Matches Claude Code's native worktree tooling, so harness-created and manual worktrees coexist.
- **Naming:** `<name>` = branch name with `/` → `-` (branch `feature/vfs-wave1` → `.claude/worktrees/feature-vfs-wave1`).
- **Creation** — from this repo's own `.git`, based on `develop` (never `main`):

  ```bash
  git -C <this-repo> worktree add .claude/worktrees/<name> -b <branch> develop
  ```

- **Hygiene:** `.claude/worktrees/` is gitignored in this repo; never commit its contents. One worktree per task; remove it when the work lands (`git worktree remove .claude/worktrees/<name>` — keep the branch).
- **Addressing:** `git -C <this-repo>/.claude/worktrees/<name> …`; verify branch + clean index before any git write; no `git stash`.
- **Elixir projects:** the MAIN checkout owns `deps/` + `_build/`; each worktree symlinks `deps` (and `_build` where needed) to the canonical checkout by **absolute path** — no per-worktree re-fetch/recompile.
- **Legacy placements** (`.worktrees/`, `.wt/`, `<repo>.worktrees/` siblings, `staging/`) are grandfathered — do not create new ones; migrate opportunistically. `staging/` remains local-only experiments (never pushed/submoduled).
