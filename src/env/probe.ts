import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { join } from "node:path";

export type OsFlavor =
  | "windows"
  | "linux"
  | "macos"
  | "chromeos"
  | "android"
  | "ios";

export interface ToolInfo {
  name: string;
  path: string;
  version?: string;
}

export interface EnvironmentProbe {
  os: { flavor: OsFlavor; version: string };
  arch: string;
  shell: string;
  host: string;
  tools: ToolInfo[];
  installers: string[];
  scannedAt: string;
}

/**
 * Curated common-tool list — version-probing every PATH executable would take
 * minutes; these (plus any explicitly requested) get the `--version` probe.
 */
export const COMMON_TOOLS: readonly string[] = [
  "git", "gh", "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "python3", "pip3", "docker", "kubectl", "helm", "terraform", "tofu",
  "terragrunt", "argocd", "curl", "wget", "jq", "yq", "go", "rustc",
  "cargo", "gcc", "make", "cmake", "brew", "ffmpeg", "rsync", "ssh", "openssl",
];

export const INSTALLERS: readonly string[] = [
  "brew", "apt", "winget", "scoop", "choco", "npm",
];

export type EnvLike = Record<string, string | undefined>;
export type ExecFn = (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export function defaultExecFn(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
      (err, stdout, stderr) =>
        resolve(err ? { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") } : { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    );
  });
}

function readOsRelease(): Record<string, string> | null {
  try {
    const text = readFileSync("/etc/os-release", "utf-8");
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(?:"([^"]*)"|(.+))$/.exec(line.trim());
      if (m) out[m[1]] = m[2] ?? m[3] ?? "";
    }
    return out;
  } catch {
    return null;
  }
}

function detectOs(): { flavor: OsFlavor; version: string } {
  const version = release();
  switch (platform()) {
    case "win32":
      return { flavor: "windows", version };
    case "darwin":
      return { flavor: "macos", version };
    default: {
      const osRelease = readOsRelease();
      const id = osRelease?.ID?.toLowerCase();
      if (id?.includes("android")) return { flavor: "android", version };
      if (osRelease?.CHROMEOS_RELEASE_NAME || id?.includes("chrom")) {
        return { flavor: "chromeos", version };
      }
      if (id === "ios") return { flavor: "ios", version };
      return { flavor: "linux", version };
    }
  }
}

/** Scan every PATH directory and map executable name → first path seen. */
export function scanPathTools(env: EnvLike = process.env): Map<string, string> {
  const sep = platform() === "win32" ? ";" : ":";
  const dirs = (env.PATH ?? "").split(sep).filter((d) => d.trim() !== "");
  const found = new Map<string, string>();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!found.has(entry.name)) found.set(entry.name, join(dir, entry.name));
    }
  }
  return found;
}

export async function probeToolVersion(
  tool: string,
  path: string,
  execFn: ExecFn = defaultExecFn
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFn(path, ["--version"]);
    const line = [stdout, stderr]
      .join("\n")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line?.slice(0, 120);
  } catch {
    return undefined;
  }
}

export async function probeEnvironment(
  opts: { extraTools?: string[]; env?: EnvLike; execFn?: ExecFn } = {}
): Promise<EnvironmentProbe> {
  const env = opts.env ?? process.env;
  const found = scanPathTools(env);
  const installers = INSTALLERS.filter((i) => found.has(i));

  const wanted = [
    ...new Set([...COMMON_TOOLS, ...(opts.extraTools ?? [])]),
  ]
    .filter((t) => found.has(t))
    .sort();

  const tools = await Promise.all(
    wanted.map(async (name) => ({
      name,
      path: found.get(name) as string,
      version: await probeToolVersion(name, found.get(name) as string, opts.execFn),
    }))
  );

  const shell =
    env.SHELL ?? env.ComSpec ?? (platform() === "win32" ? "cmd.exe" : "/bin/sh");

  return {
    os: detectOs(),
    arch: process.arch,
    shell,
    host: hostname(),
    tools,
    installers,
    scannedAt: new Date().toISOString(),
  };
}
