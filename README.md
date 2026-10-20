# mallm — manifests branch

This branch is the **mallm manifest/corpus branch**: the hand-authored source of
truth for the tool registry and the SemText how-to corpus that mallm serves.

## Layout

- `corpus/tools.yaml` — tool registry: aliases, version grammar hint
  (`semver`/`loose`/`enum` with example ranges), per-OS installers
  (macos: brew · linux: apt/dnf · windows: winget/scoop), and the corpus doc
  filename for each tool.
- `corpus/*.sem.html` — the corpus docs themselves, hand-authored in
  **SemText v0.8** (`.html`, never `.xhtml`). Spec digest:
  `Projects/commands/sem-text-author/sem-text.v0.8.spec.html` (§8 = variant
  projection: `sem-dims`, `sem-alternatives`/`sem-variant`, `sem-for`/`sem-is`,
  range grammar).
- `dist/` — **CI-GENERATED ONLY. Never hand-edit.** The generated corpus
  artifacts (index/howtos json, projected copies) arrive here with a later CI
  workflow; do not create or commit `dist/` by hand.

## Rules

- Everything under `corpus/` is human/agent-authored; `dist/` is derived.
- Corpus docs must validate as SemText v0.8 (balanced tags; declared dims for
  every guard; `sem-alternatives` with >=2 children and at most one bare
  default; attributes quoted; tag form canonical, class form only read).
- How-to sections carry `<name>` (title), a one-paragraph goal (summary) and a
  `<tags>` child so the BM25 indexer can lift `title` / `goal` / `tags` per
  section, plus doc-level title/summary/tags at the root.
- This branch never merges into `develop` — it is consumed by the dist build,
  not the product source.
