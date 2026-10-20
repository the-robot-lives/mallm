import type { PlatformConfig } from "../config/types.js";
import { cacheRoot as defaultCacheRoot } from "./cache.js";
import type { FetchLike, RunGit, SyncResult } from "./adapters.js";
import { syncSource } from "./adapters.js";
import { mergeCorpus } from "./merge.js";
import type { MergedDoc } from "./merge.js";

export type { CacheMeta } from "./cache.js";
export { cacheRoot, cacheKeyFor, cacheEntryDir, readCacheMeta, writeCacheMeta, sha256Hex } from "./cache.js";
export type { FetchLike, FetchLikeResponse, RunGit, SourceDoc, SyncResult } from "./adapters.js";
export { defaultRunGit, syncSource, syncHttpSource, syncGitSource, syncDirSource, parseDocsPayload } from "./adapters.js";
export type { MergedDoc } from "./merge.js";
export { mergeCorpus } from "./merge.js";

export interface LoadCorpusResult {
  merged: Map<string, MergedDoc>;
  results: SyncResult[];
}

/** Sync every configured source (fetch-on-miss through the cache) and priority-merge the docs. */
export async function loadCorpus(
  config: PlatformConfig,
  opts: { cacheRoot?: string; fetchImpl?: FetchLike; runGit?: RunGit } = {}
): Promise<LoadCorpusResult> {
  const root = opts.cacheRoot ?? defaultCacheRoot();
  const results = await Promise.all(
    config.sources.map((source) => syncSource(source, { cacheRoot: root, ...opts }))
  );
  return { merged: mergeCorpus(results), results };
}
