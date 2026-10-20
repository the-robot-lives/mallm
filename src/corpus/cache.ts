import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MallmSource } from "../config/types.js";

export type EnvLike = Record<string, string | undefined>;

export interface CacheMeta {
  key: string;
  /** http sources: last ETag seen */
  etag?: string;
  /** git sources: commit currently checked out in the cache entry */
  commit?: string;
  /** payload digest (hex) */
  sha256?: string;
  fetchedAt: string;
}

/** Default corpus cache root: `$XDG_CACHE_HOME/mallm/corpus` (fallback `~/.cache/mallm/corpus`). */
export function cacheRoot(env: EnvLike = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim();
  return join(base ? base : join(homedir(), ".cache"), "mallm", "corpus");
}

export function cacheKeyFor(source: MallmSource): string {
  const ident =
    source.kind === "git"
      ? `${source.repo ?? ""}|${source.branch ?? ""}`
      : `${source.url ?? ""}`;
  return createHash("sha256")
    .update(`${source.kind}:${source.name}:${ident}`)
    .digest("hex")
    .slice(0, 24);
}

export function cacheEntryDir(root: string, source: MallmSource): string {
  return join(root, cacheKeyFor(source));
}

function metaPath(dir: string): string {
  return join(dir, "meta.json");
}

export function readCacheMeta(
  root: string,
  source: MallmSource
): CacheMeta | null {
  const path = metaPath(cacheEntryDir(root, source));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheMeta;
    if (typeof parsed?.key === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeCacheMeta(
  root: string,
  source: MallmSource,
  meta: Omit<CacheMeta, "key">
): CacheMeta {
  const dir = cacheEntryDir(root, source);
  const full: CacheMeta = { ...meta, key: cacheKeyFor(source) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(dir), JSON.stringify(full, null, 2));
  return full;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
