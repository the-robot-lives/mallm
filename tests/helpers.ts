import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test helpers — every file-writing test gets its own temp XDG tree under the
 * system temp dir. Tests NEVER touch the real $HOME, and the fake env carries a
 * HOME override too so homedir() fallbacks stay inside the temp root.
 */

export interface TempXdg {
  root: string;
  cache: string;
  data: string;
  config: string;
  restore(): void;
}

export function tempXdg(): TempXdg {
  const root = mkdtempSync(join(tmpdir(), "mallm-test-"));
  const cache = join(root, "cache");
  const data = join(root, "data");
  const config = join(root, "config");
  for (const dir of [cache, data, config]) mkdirSync(dir, { recursive: true });

  const previous = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.XDG_CACHE_HOME = cache;
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_CONFIG_HOME = config;

  return {
    root,
    cache,
    data,
    config,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function fakeEnv(xdg: TempXdg): Record<string, string | undefined> {
  return {
    XDG_CACHE_HOME: xdg.cache,
    XDG_DATA_HOME: xdg.data,
    XDG_CONFIG_HOME: xdg.config,
    HOME: xdg.root,
    PATH: process.env.PATH,
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mallm-testdir-"));
}
