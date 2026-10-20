import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { MallmSource, PlatformConfig, SourceKind } from "./types.js";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_KINDS,
} from "./types.js";

export type EnvLike = Record<string, string | undefined>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Parse (and normalize) platform config out of a parsed mallm.yaml document.
 * Unknown or malformed keys are dropped — parsing never throws.
 * `base` is the accumulated config so far; defined keys in `raw` win.
 */
export function parsePlatformConfig(
  raw: unknown,
  base?: PlatformConfig
): PlatformConfig {
  const cfg: PlatformConfig = base
    ? {
        version: base.version,
        sources: [...base.sources],
        inference: { ...base.inference },
        redaction: { patterns: [...base.redaction.patterns] },
        sessionTtl: base.sessionTtl,
      }
    : {
        version: "1.1",
        sources: [],
        inference: {},
        redaction: { patterns: [] },
        sessionTtl: DEFAULT_SESSION_TTL_SECONDS,
      };

  if (!isRecord(raw)) return cfg;

  const version = str(raw.mallm);
  if (version === "1.0" || version === "1.1") cfg.version = version;

  if (Array.isArray(raw.sources)) {
    const sources: MallmSource[] = [];
    for (const entry of raw.sources) {
      if (!isRecord(entry)) continue;
      const name = str(entry.name);
      const kind = str(entry.kind) as SourceKind | undefined;
      if (!name || !kind || !SOURCE_KINDS.includes(kind)) continue;
      const source: MallmSource = {
        name,
        kind,
        url: str(entry.url),
        repo: str(entry.repo),
        branch: str(entry.branch),
        priority: numberOr(undefined, entry.priority) ?? DEFAULT_SOURCE_PRIORITY,
        credsRef: str(entry.credsRef),
        tokenEnv: str(entry.tokenEnv),
      };
      if (source.kind === "http" && !source.url) continue;
      if (source.kind === "git" && !source.repo) continue;
      if (source.kind === "dir" && !source.url) continue;
      sources.push(source);
    }
    cfg.sources = sources;
  }

  if (isRecord(raw.inference)) {
    cfg.inference = {
      baseUrl: str(raw.inference.baseUrl) ?? cfg.inference.baseUrl,
      apiKeyEnv: str(raw.inference.apiKeyEnv) ?? cfg.inference.apiKeyEnv,
      model: str(raw.inference.model) ?? cfg.inference.model,
    };
  }

  if (isRecord(raw.redaction) && Array.isArray(raw.redaction.patterns)) {
    cfg.redaction = {
      patterns: raw.redaction.patterns.filter(
        (p): p is string => typeof p === "string" && p.trim() !== ""
      ),
    };
  }

  const ttl = numberOr(cfg.sessionTtl, raw.sessionTtl);
  cfg.sessionTtl = ttl !== undefined && ttl > 0 ? Math.floor(ttl) : cfg.sessionTtl;

  return cfg;
}

function numberOr(fallback: number | undefined, v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
}

export function configHomeDir(env: EnvLike = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : join(homedir(), ".config");
}

export function userConfigPath(env: EnvLike = process.env): string {
  return join(configHomeDir(env), "mallm", "config.yaml");
}

function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".mallm")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectConfigPath(cwd: string = process.cwd()): string | null {
  const root = findProjectRoot(cwd);
  return root ? join(root, ".mallm", "config.yaml") : null;
}

/** Resolution order: project-local `.mallm/config.yaml`, then user `~/.config/mallm/config.yaml`. */
export function configLayerPaths(env: EnvLike = process.env, cwd: string = process.cwd()): string[] {
  const layers: string[] = [];
  const project = projectConfigPath(cwd);
  if (project) layers.push(project);
  layers.push(userConfigPath(env));
  return layers;
}

/**
 * Resolve the effective platform config by walking the chain
 * (user layer first, project layer overrides) and merging v1.1 keys over defaults.
 */
export function resolvePlatformConfig(
  env: EnvLike = process.env,
  cwd: string = process.cwd()
): PlatformConfig {
  let cfg = parsePlatformConfig(null);
  for (const path of [...configLayerPaths(env, cwd)].reverse()) {
    if (!existsSync(path)) continue;
    try {
      cfg = parsePlatformConfig(parseYaml(readFileSync(path, "utf-8")), cfg);
    } catch {
      // malformed layer: skip it, keep accumulating
    }
  }
  return cfg;
}

/**
 * Where `mallm sources add` should write: the project layer if one already
 * exists, otherwise the user layer (created on demand).
 */
export function firstWritableConfigPath(
  env: EnvLike = process.env,
  cwd: string = process.cwd()
): string {
  const project = projectConfigPath(cwd);
  if (project && existsSync(project)) return project;
  return userConfigPath(env);
}

/** Insert or replace (by name) a source in the config file at `path`, creating the file if needed. */
export function upsertSource(
  path: string,
  source: MallmSource
): { path: string; created: boolean } {
  let doc: Record<string, unknown> = {};
  let created = false;
  if (existsSync(path)) {
    try {
      const parsed = parseYaml(readFileSync(path, "utf-8"));
      if (isRecord(parsed)) doc = parsed;
    } catch {
      doc = {};
    }
  } else {
    created = true;
  }

  if (!str(doc.mallm)) doc.mallm = "1.1";
  if (!str(doc.name)) doc.name = "mallm-config";
  if (!str(doc.summary)) doc.summary = "mallm platform configuration";

  const entry = { ...source, priority: source.priority ?? DEFAULT_SOURCE_PRIORITY };
  const sources = Array.isArray(doc.sources) ? [...doc.sources] : [];
  const existing = sources.findIndex(
    (s) => isRecord(s) && s.name === entry.name
  );
  if (existing >= 0) sources[existing] = entry;
  else sources.push(entry);
  doc.sources = sources;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(doc, { lineWidth: 100 }));
  return { path, created };
}
