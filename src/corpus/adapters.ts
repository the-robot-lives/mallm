import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MallmSource } from "../config/types.js";
import {
  cacheEntryDir,
  readCacheMeta,
  sha256Hex,
  writeCacheMeta,
} from "./cache.js";

export interface SourceDoc {
  name: string;
  doc: Record<string, unknown>;
}

export interface SyncResult {
  source: MallmSource;
  ok: boolean;
  /** true when the payload came from cache (ETag pin or unchanged commit) */
  cached: boolean;
  docs: SourceDoc[];
  error?: string;
}

// --- injectable execution surfaces (tests run without network) ----------------

export interface FetchLikeResponse {
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<FetchLikeResponse>;

export type RunGit = (args: string[], cwd?: string) => Promise<string>;

export function defaultRunGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

// --- payload → docs -----------------------------------------------------------

function docFromRecord(record: Record<string, unknown>, fallbackName: string): SourceDoc | null {
  const name =
    typeof record.name === "string" && record.name.trim() !== ""
      ? record.name
      : fallbackName;
  if (typeof record !== "object" || record === null) return null;
  return { name, doc: record };
}

export function parseDocsPayload(payload: string, sourceName: string): SourceDoc[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(payload); // JSON is a YAML subset
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item, i) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? [docFromRecord(item as Record<string, unknown>, `${sourceName}:${i}`)!]
        : []
    );
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.docs)) {
      return record.docs.flatMap((item: unknown, i: number) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? [docFromRecord(item as Record<string, unknown>, `${sourceName}:${i}`)!]
          : []
      );
    }
    return [docFromRecord(record, sourceName)!];
  }
  return [];
}

function collectYamlDocs(dir: string, sourceName: string): SourceDoc[] {
  if (!existsSync(dir)) return [];
  const docs: SourceDoc[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  for (const rel of entries.sort()) {
    if (rel.split(sep).includes(".git")) continue;
    if (!rel.endsWith(".yaml") && !rel.endsWith(".yml")) continue;
    const abs = join(dir, rel);
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(abs, "utf-8"));
    } catch {
      continue;
    }
    const base =
      rel.split(sep).pop()?.replace(/\.(ya?ml)$/, "") ?? rel.replace(/\.(ya?ml)$/, "");
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const d = docFromRecord(item as Record<string, unknown>, `${sourceName}:${base}`);
          if (d) docs.push(d);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      const d = docFromRecord(parsed as Record<string, unknown>, base);
      if (d) docs.push(d);
    }
  }
  return docs;
}

// --- adapters ------------------------------------------------------------------

export async function syncHttpSource(
  source: MallmSource,
  opts: { cacheRoot: string; fetchImpl?: FetchLike }
): Promise<SyncResult> {
  const fetchImpl = opts.fetchImpl ?? ((u: string, i?: { method?: string; headers?: Record<string, string> }) =>
    fetch(u, i) as unknown as Promise<FetchLikeResponse>);
  const fail = (error: string): SyncResult => ({ source, ok: false, cached: false, docs: [], error });

  if (source.kind !== "http" || !source.url) return fail("source is not http or has no url");

  const dir = cacheEntryDir(opts.cacheRoot, source);
  const meta = readCacheMeta(opts.cacheRoot, source);
  const headers: Record<string, string> = {};
  if (meta?.etag) headers["if-none-match"] = meta.etag;

  let payload: string;
  let cached = false;
  let etag: string | undefined;
  try {
    const res = await fetchImpl(source.url, { headers });
    if (res.status === 304 && meta) {
      try {
        payload = readFileSync(join(dir, "payload"), "utf-8");
        cached = true;
      } catch {
        return fail("cache miss after 304");
      }
    } else if (res.status >= 200 && res.status < 300) {
      payload = await res.text();
      etag = res.headers?.get?.("etag") ?? undefined;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "payload"), payload);
    } else {
      return fail(`HTTP ${res.status}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  writeCacheMeta(opts.cacheRoot, source, {
    ...(etag !== undefined ? { etag } : meta?.etag !== undefined ? { etag: meta.etag } : {}),
    sha256: cached ? meta?.sha256 : sha256Hex(payload),
    fetchedAt: new Date().toISOString(),
  });

  return { source, ok: true, cached, docs: parseDocsPayload(payload, source.name) };
}

export async function syncGitSource(
  source: MallmSource,
  opts: { cacheRoot: string; runGit?: RunGit }
): Promise<SyncResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const fail = (error: string): SyncResult => ({ source, ok: false, cached: false, docs: [], error });
  if (source.kind !== "git" || !source.repo) return fail("source is not git or has no repo");

  const dir = cacheEntryDir(opts.cacheRoot, source);
  const branch = source.branch ?? "main";
  try {
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(dir), { recursive: true });
      await runGit(["clone", "--depth", "1", "--branch", branch, source.repo, dir]);
    } else {
      await runGit(["fetch", "--depth", "1", "origin", branch], dir);
      await runGit(["checkout", "--quiet", "FETCH_HEAD"], dir);
    }
    const commit = (await runGit(["rev-parse", "HEAD"], dir)).trim();
    const previous = readCacheMeta(opts.cacheRoot, source);
    const cached = previous?.commit === commit;
    writeCacheMeta(opts.cacheRoot, source, { commit, fetchedAt: new Date().toISOString() });
    return { source, ok: true, cached, docs: collectYamlDocs(dir, source.name) };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function syncDirSource(source: MallmSource): SyncResult {
  if (source.kind !== "dir" || !source.url) {
    return { source, ok: false, cached: false, docs: [], error: "source is not dir or has no url" };
  }
  if (!existsSync(source.url)) {
    return { source, ok: false, cached: false, docs: [], error: `directory not found: ${source.url}` };
  }
  return { source, ok: true, cached: true, docs: collectYamlDocs(source.url, source.name) };
}

export async function syncSource(
  source: MallmSource,
  opts: { cacheRoot: string; fetchImpl?: FetchLike; runGit?: RunGit }
): Promise<SyncResult> {
  switch (source.kind) {
    case "http":
      return syncHttpSource(source, opts);
    case "git":
      return syncGitSource(source, opts);
    case "dir":
      return syncDirSource(source);
  }
}

// --- cache-only variants (no network, no fetch; used by search/show defaults) ----

export function syncHttpSourceCached(
  source: MallmSource,
  opts: { cacheRoot: string }
): SyncResult {
  const fail = (error: string): SyncResult => ({ source, ok: false, cached: false, docs: [], error });
  if (source.kind !== "http" || !source.url) return fail("source is not http or has no url");
  const dir = cacheEntryDir(opts.cacheRoot, source);
  try {
    const payload = readFileSync(join(dir, "payload"), "utf-8");
    return { source, ok: true, cached: true, docs: parseDocsPayload(payload, source.name) };
  } catch {
    return fail("not cached yet (run `mallm sources update`)");
  }
}

export function syncGitSourceCached(
  source: MallmSource,
  opts: { cacheRoot: string }
): SyncResult {
  const fail = (error: string): SyncResult => ({ source, ok: false, cached: false, docs: [], error });
  if (source.kind !== "git" || !source.repo) return fail("source is not git or has no repo");
  const dir = cacheEntryDir(opts.cacheRoot, source);
  if (!existsSync(join(dir, ".git"))) {
    return fail("not cached yet (run `mallm sources update`)");
  }
  return { source, ok: true, cached: true, docs: collectYamlDocs(dir, source.name) };
}

export function syncSourceCached(
  source: MallmSource,
  opts: { cacheRoot: string }
): SyncResult {
  switch (source.kind) {
    case "http":
      return syncHttpSourceCached(source, opts);
    case "git":
      return syncGitSourceCached(source, opts);
    case "dir":
      return syncDirSource(source);
  }
}
