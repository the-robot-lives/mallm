# PROJ-FAQ — mallm

Anticipated why/when/compared-to-what questions. For procedures, see [PROJ-HOWTO.md](PROJ-HOWTO.md); for design rationale, see [PROJ-ARCH.md](PROJ-ARCH.md).

## Motivation

### Why would I use mallm instead of just reading a tool's `--help` output?

Because `--help` gives you flags, not judgment — it can't tell an agent *when* to reach for a tool, *what workflow* it fits into, or *what gotcha* burned the last three attempts. `mallm.yaml`'s `context` section (`when_to_use`, `when_not_to_use`, `common_patterns`, `gotchas`) exists specifically to carry that judgment, hand-authored once instead of re-discovered per session. The honest trade-off: if nobody authors that context, `mallm` degrades to a `--help` re-parse (`help-generated` source) that's barely better than the original — the value is proportional to authoring effort, not automatic.

→ *See [PROJ-HOWTO.md#how-to-look-up-documentation-for-a-cli-tool](PROJ-HOWTO.md#how-to-look-up-documentation-for-a-cli-tool).*

### Why YAML files instead of just writing a better README or man page?

Because agents need to parse the answer programmatically (`--json`, `_meta` provenance), and a README's prose doesn't have addressable fields like `arguments[].type` or `environment[].required`. YAML is still human-authored and human-readable — it's not a new format to fight, just a schema-shaped one. The trade-off: you're maintaining a second doc surface (README/man page *and* `mallm.yaml`) unless you fold one into the other, and mallm does nothing to keep them in sync.

### Why does mallm live outside the `k8-lib`/`.infra-config.yaml` conventions the rest of `utilities/` follows?

Because mallm documents tools, it isn't one of the shell utilities those conventions were built for — coupling it to `k8-lib` would buy nothing and cost a dependency. It's a standalone Node package (`npm install && npm run build && npm link`); `make install-utilities` skips it entirely.

→ *See [PROJ-ARCH.md#ecosystem-fit](PROJ-ARCH.md#ecosystem-fit).*

## Fit

### When is mallm the wrong tool to reach for?

When the tool already has good `--help` text, is used rarely, or is a one-off script nobody else will run — authoring a `mallm.yaml` for it is pure overhead with no payoff. mallm earns its keep for tools that are (a) used repeatedly by agents/scouts across sessions, (b) have non-obvious workflows or footguns, or (c) get asked "should I use this or X?" often enough that the answer is worth writing down once.

### Should I use mallm for third-party tools I don't own or can't modify?

Yes — that's what project-local and user-config definitions are for; you don't need write access to the tool itself. You only need the native `--mallm` protocol if you *do* own the tool and want it to stay self-documenting without a separate file to keep in sync.

→ *See [PROJ-HOWTO.md#how-to-make-your-own-tool-natively-mallm-aware](PROJ-HOWTO.md#how-to-make-your-own-tool-natively-mallm-aware).*

## Comparison

### How does `mallm.yaml` differ from a man page?

A man page is prose for humans; `mallm.yaml` is structured data with an LLM-facing `context` section (`when_to_use`, `when_not_to_use`, `common_patterns`, `gotchas`) that man pages don't have a slot for. mallm can *fall back* to parsing `--help` text (a man-page-adjacent source) when no structured file exists, but that fallback is explicitly the degraded case, not the target experience.

### How does project-local (`.mallm/<app>.yaml`) differ from user-config (`~/.config/mallm/<app>/`)?

Project-local travels with the repo and always wins resolution when present, but has no version concept. User-config is per-machine, supports `<version>/mallm.yaml` subdirectories plus a `latest/` fallback, and is what you use if you want more than one revision of a tool's docs on disk at once. Pick project-local for docs that belong to the repo (like the bundled `helm-upgrade`/`docker-build` examples); pick user-config for personal or versioned overrides.

→ *See [PROJ-HOWTO.md#how-to-version-a-tools-documentation](PROJ-HOWTO.md#how-to-version-a-tools-documentation).*

### How does `mallm validate` differ from validating against `schemas/mallm.schema.json`?

`mallm validate` is a lightweight, hardcoded check — it only confirms `mallm`, `name`, `summary` exist and that `arguments[]` entries have `name`/`type`/`description`. It does **not** run the full JSON Schema, so a file can pass `validate` and still violate the canonical schema (wrong enum value, missing conditionally-required field, etc.). Use `mallm schema` + an external JSON Schema validator (e.g. `ajv-cli`) for anything you actually need to trust, such as CI gating.

→ *See [PROJ-HOWTO.md#how-to-validate-a-mallmyaml-before-committing-it](PROJ-HOWTO.md#how-to-validate-a-mallmyaml-before-committing-it) and [#how-to-get-the-canonical-schema-for-external-validation](PROJ-HOWTO.md#how-to-get-the-canonical-schema-for-external-validation).*

### How does the native `--mallm` protocol differ from a file-based definition?

A file-based definition is static and can go stale as the tool changes; native `--mallm` is generated by the tool itself at call time, so it can't drift from the code. The cost is that mallm has to shell out and trust the tool's exit code and output — see the Caveats entry on native resolution below before relying on it for anything unattended.

### Why does a stale project-local file always outrank a live native `--mallm` response?

Because resolution priority is fixed (project-local → user-config → native → help fallback) and doesn't compare freshness or "trustworthiness" — it takes the first match, full stop. A checked-in `.mallm/<app>.yaml` that nobody updated after the tool changed will silently shadow that tool's own current self-description, with no warning. The mitigation is procedural, not automatic: if a tool natively answers `--mallm`, don't also create a project-local or user-config file for it (see PROJ-HOWTO's native-aware how-to).

→ *See [PROJ-HOWTO.md#how-to-make-your-own-tool-natively-mallm-aware](PROJ-HOWTO.md#how-to-make-your-own-tool-natively-mallm-aware).*

## Capability

### Can mallm document a CLI tool I've never touched, with zero authoring?

Yes, via the `--help` fallback — but the result is intentionally bare-bones (regex-extracted summary/arguments/subcommands, no `when_to_use`/gotchas), and if `--help` fails or is empty you get the same thin template as a tool with no help text at all, silently. Treat the fallback as a starting point to run through `mallm init`, not a finished artifact.

### Can I keep multiple versions of a tool's docs around and pick one explicitly?

Yes, but only in user-config (`~/.config/mallm/<app>/<version>/mallm.yaml`) — project-local `.mallm/<app>.yaml` has no version concept and always wins resolution regardless of any `--version` flag, which surprises people who expect `--version` to override it.

→ *See [PROJ-HOWTO.md#how-to-version-a-tools-documentation](PROJ-HOWTO.md#how-to-version-a-tools-documentation).*

### Does mallm require the target tool to actually be installed?

No — for lookup, only a `mallm.yaml` (project-local or user-config) needs to exist; resolution reaches the native/`--help` tiers only when no file is found. It's entirely reasonable to document a tool that isn't installed on the current machine, as long as you're not relying on native or help-fallback resolution for it.

### Why doesn't `mallm list` show tools that only have native or help-fallback coverage?

Because `list` only enumerates files on disk (`.mallm/` and `~/.config/mallm/`); discovering native (`--mallm`) or help-fallback coverage would mean executing every candidate binary on the system just to see what answers, which isn't what a listing command should cost. Treat `mallm list` as an inventory of *authored* definitions, not a full picture of everything `mallm show` could eventually resolve.

→ *See [PROJ-HOWTO.md#how-to-see-every-mallm-definition-available-to-you](PROJ-HOWTO.md#how-to-see-every-mallm-definition-available-to-you).*

## Caveats

### If I edit `.mallm/<app>.yaml` and don't see the change, what's wrong?

Almost certainly a wrong-directory issue: resolution walks up from `cwd` looking for `.git` or `.mallm`, so an edit made outside that ancestor chain is invisible to the lookup you're running. Confirm you're inside (or under) the git root that owns the file before assuming mallm is broken.

### Is the native `--mallm` protocol safe to rely on unattended?

Mostly, with one sharp edge: resolution shells out with a 5-second timeout and treats non-zero exit or stderr as "unsupported," silently falling through to the `--help` fallback. A slow or crashing `--mallm` handler in your own tool won't surface as an error — it'll just quietly serve worse docs, which can mask a real bug in your handler for a long time.

### Does mallm cache anything, and can that go stale?

No — there's no cache; every lookup re-stats the filesystem and (if needed) re-execs the target tool, by design (the maintainers judged resolution cheap enough that caching wasn't worth the invalidation complexity). The practical implication is the opposite of staleness risk: you always see current file contents, at the cost of one extra stat/exec per lookup.

### Is `mallm init`'s seed output trustworthy enough to commit as-is?

No — it's explicitly a stub. `TODO:` markers are left for `when_to_use`/`when_not_to_use` (and `summary` if `--help` parsing came up empty), and re-running `init` on an existing file is a no-op rather than a refresh, so a stale stub won't self-correct. Someone has to actually fill it in for the value described in the Motivation section above to materialize.

### Why doesn't `mallm init` overwrite an existing file instead of no-op'ing?

Because a blind overwrite would clobber whatever hand-authored `context`/`gotchas` content someone already wrote in place of the seed — the no-op is a safety choice, not a missing feature. The trade-off is the mirror image of the previous answer: if the existing file is itself a bad or outdated stub, `init` won't refresh it for you; delete it first if you actually want a fresh seed.

→ *See [PROJ-HOWTO.md#how-to-create-a-mallmyaml-stub-for-a-tool-you-own](PROJ-HOWTO.md#how-to-create-a-mallmyaml-stub-for-a-tool-you-own).*

## Trust

### Does mallm send my tool docs or usage anywhere?

No — it's a single-process local CLI with no persistence layer and no network calls beyond shelling out to the target tool itself (for native `--mallm` or `--help` resolution). Everything it reads and writes stays on disk under `.mallm/`, `~/.config/mallm/`, or wherever you point it.

→ *See [PROJ-ARCH.md#overview](PROJ-ARCH.md#overview).*

### What happens to my `mallm.yaml` files over time — does mallm manage history for me?

Nothing automatic — mallm has no versioning or backup machinery of its own beyond the user-config `<version>/` subdirectory convention, which you manage by hand (`mkdir`, `cp`). Project-local files live in git like any other repo file, so their history is whatever your normal commit discipline provides; there's no mallm-side undo if you overwrite one.
