# PROJ-FAQ.summary — mallm

Question index only. Full answers in [PROJ-FAQ.md](PROJ-FAQ.md).

## Motivation
- Why would I use mallm instead of just reading a tool's `--help` output?
- Why YAML files instead of just writing a better README or man page?
- Why does mallm live outside the `k8-lib`/`.infra-config.yaml` conventions the rest of `utilities/` follows?

## Fit
- When is mallm the wrong tool to reach for?
- Should I use mallm for third-party tools I don't own or can't modify?

## Comparison
- How does `mallm.yaml` differ from a man page?
- How does project-local (`.mallm/<app>.yaml`) differ from user-config (`~/.config/mallm/<app>/`)?
- How does `mallm validate` differ from validating against `schemas/mallm.schema.json`?
- How does the native `--mallm` protocol differ from a file-based definition?
- Why does a stale project-local file always outrank a live native `--mallm` response?

## Capability
- Can mallm document a CLI tool I've never touched, with zero authoring?
- Can I keep multiple versions of a tool's docs around and pick one explicitly?
- Does mallm require the target tool to actually be installed?
- Why doesn't `mallm list` show tools that only have native or help-fallback coverage?

## Caveats
- If I edit `.mallm/<app>.yaml` and don't see the change, what's wrong?
- Is the native `--mallm` protocol safe to rely on unattended?
- Does mallm cache anything, and can that go stale?
- Is `mallm init`'s seed output trustworthy enough to commit as-is?
- Why doesn't `mallm init` overwrite an existing file instead of no-op'ing?

## Trust
- Does mallm send my tool docs or usage anywhere?
- What happens to my `mallm.yaml` files over time — does mallm manage history for me?
