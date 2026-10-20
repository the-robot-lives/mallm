import { join } from "node:path";
import type { MallmSource, PlatformConfig } from "../config/types.js";
import { DEFAULT_SOURCE_PRIORITY } from "../config/types.js";
import { configHomeDir } from "../config/loader.js";
import type { EnvLike } from "../config/loader.js";

/**
 * Memory tier resolution:
 * - universal: corpus sources (priority order)
 * - org: the highest-precedence git source (org source repo)
 * - project: `<cwd>/.mallm/`
 * - user: `~/.config/mallm/`
 */

export interface MemoryTiers {
  universal: MallmSource[];
  org: MallmSource | null;
  project: string;
  user: string;
}

export function sortSources(sources: readonly MallmSource[]): MallmSource[] {
  return [...sources]
    .map((s) => ({ ...s, priority: s.priority ?? DEFAULT_SOURCE_PRIORITY }))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
}

export function resolveTiers(
  config: PlatformConfig,
  cwd: string = process.cwd(),
  env: EnvLike = process.env
): MemoryTiers {
  const universal = sortSources(config.sources);
  const org = universal.find((s) => s.kind === "git") ?? null;
  return {
    universal,
    org,
    project: join(cwd, ".mallm"),
    user: join(configHomeDir(env), "mallm"),
  };
}
