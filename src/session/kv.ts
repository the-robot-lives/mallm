import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Generic file-backed session KV — deliberately zero-dependency on the rest of
 * mallm (node builtins only) so other CLIs can lift it as-is.
 */

export const SESSION_BUCKETS = [
  "env",
  "downloads",
  "installed",
  "approvals",
  "decisions",
  "howto",
] as const;

export type SessionBucket = (typeof SESSION_BUCKETS)[number];

export type BucketData = Record<string, unknown>;

export interface SessionData {
  token: string;
  createdAt: string;
  updatedAt: string;
  buckets: Record<SessionBucket, BucketData>;
}

export type EnvLike = Record<string, string | undefined>;

const ITEMS_KEY = "items";
const INJECT_VALUE_LIMIT = 160;

export function dataHome(env: EnvLike = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? xdg : join(homedir(), ".local", "share");
}

export function sessionsDir(env: EnvLike = process.env): string {
  return join(dataHome(env), "mallm", "sessions");
}

export function sessionFilePath(token: string, env: EnvLike = process.env): string {
  return join(sessionsDir(env), `${token}.json`);
}

export function listSessions(env: EnvLike = process.env): string[] {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function emptyData(token: string): SessionData {
  const now = new Date().toISOString();
  const buckets = {} as Record<SessionBucket, BucketData>;
  for (const b of SESSION_BUCKETS) buckets[b] = {};
  return { token, createdAt: now, updatedAt: now, buckets };
}

function sanitize(raw: unknown, token: string): SessionData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const rawBuckets = (record.buckets ?? {}) as Record<string, unknown>;
  const buckets = {} as Record<SessionBucket, BucketData>;
  for (const b of SESSION_BUCKETS) {
    const v = rawBuckets[b];
    buckets[b] =
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? { ...(v as BucketData) }
        : {};
  }
  return {
    token: typeof record.token === "string" ? record.token : token,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    buckets,
  };
}

function compact(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > INJECT_VALUE_LIMIT
    ? `${json.slice(0, INJECT_VALUE_LIMIT)}…`
    : json;
}

export class SessionKV {
  readonly token: string;
  private data: SessionData;
  private readonly filePath: string;

  private constructor(token: string, filePath: string, data: SessionData) {
    this.token = token;
    this.filePath = filePath;
    this.data = data;
  }

  static open(
    token: string,
    opts: { env?: EnvLike; dir?: string } = {}
  ): SessionKV {
    const filePath = opts.dir
      ? join(opts.dir, `${token}.json`)
      : sessionFilePath(token, opts.env ?? process.env);
    const exists = existsSync(filePath);
    let data: SessionData | null = null;
    if (exists) {
      try {
        data = sanitize(JSON.parse(readFileSync(filePath, "utf-8")), token);
      } catch {
        data = null;
      }
    }
    return new SessionKV(token, filePath, data ?? emptyData(token));
  }

  /** Whether the session file is on disk right now (live — reflects clear()/save()). */
  get existsOnDisk(): boolean {
    return existsSync(this.filePath);
  }

  get(bucket: SessionBucket, key: string): unknown {
    this.assertBucket(bucket);
    return this.data.buckets[bucket][key];
  }

  set(bucket: SessionBucket, key: string, value: unknown): this {
    this.assertBucket(bucket);
    this.touch();
    if (key === ITEMS_KEY) {
      throw new Error(`key '${ITEMS_KEY}' is reserved; use push() for list items`);
    }
    this.data.buckets[bucket][key] = value;
    return this;
  }

  push(bucket: SessionBucket, value: unknown): this {
    this.assertBucket(bucket);
    this.touch();
    const items = Array.isArray(this.data.buckets[bucket][ITEMS_KEY])
      ? (this.data.buckets[bucket][ITEMS_KEY] as unknown[])
      : [];
    items.push(value);
    this.data.buckets[bucket][ITEMS_KEY] = items;
    return this;
  }

  items(bucket: SessionBucket): unknown[] {
    this.assertBucket(bucket);
    const items = this.data.buckets[bucket][ITEMS_KEY];
    return Array.isArray(items) ? [...items] : [];
  }

  save(): this {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    return this;
  }

  clear(): this {
    if (existsSync(this.filePath)) {
      rmSync(this.filePath, { force: true });
    }
    this.data = emptyData(this.token);
    return this;
  }

  /** Age of the last update, in seconds. */
  ageSeconds(now: Date = new Date()): number {
    const updated = Date.parse(this.data.updatedAt);
    if (Number.isNaN(updated)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (now.getTime() - updated) / 1000);
  }

  isExpired(ttlSeconds: number, now: Date = new Date()): boolean {
    return this.ageSeconds(now) > ttlSeconds;
  }

  /** Compact context block for prompt re-injection. */
  inject(): string {
    const lines: string[] = [
      `# mallm session ${this.token} (updated ${this.data.updatedAt})`,
    ];
    for (const bucket of SESSION_BUCKETS) {
      const data = this.data.buckets[bucket];
      const keys = Object.keys(data).filter((k) => k !== ITEMS_KEY).sort();
      const items = this.items(bucket);
      if (keys.length === 0 && items.length === 0) continue;
      lines.push(`## ${bucket}`);
      for (const key of keys) lines.push(`  ${key} = ${compact(data[key])}`);
      for (const item of items) lines.push(`  - ${compact(item)}`);
    }
    return lines.join("\n");
  }

  toJSON(): SessionData {
    return JSON.parse(JSON.stringify(this.data)) as SessionData;
  }

  private assertBucket(bucket: SessionBucket): void {
    if (!(SESSION_BUCKETS as readonly string[]).includes(bucket)) {
      throw new Error(`unknown session bucket: ${String(bucket)}`);
    }
  }

  private touch(): void {
    this.data.updatedAt = new Date().toISOString();
  }
}
