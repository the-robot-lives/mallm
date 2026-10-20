import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { MallmSource } from "../config/types.js";
import type { EnvLike } from "../config/loader.js";
import { redact } from "../changelog/redactor.js";
import type { HowtoSection, WritebackResult } from "./types.js";

/**
 * D4 write-back: append the finalized how-to as a `howtos:` section entry to
 * the corpus source doc. Two adapters:
 * - `dir`  → local commit on branch `howto/<session-token>` (no push)
 * - `git`  → branch `howto/<session-token>` off the source's tracked branch
 *            (the `manifests` branch in SemText corpora), push, then a PR via
 *            the gh CLI authenticated with a per-source token env
 *            (`sources[].tokenEnv` — a NAME, never a value).
 *
 * Tokens never appear in argv or remote URLs: git pushes authenticate through
 * an env-injected credential helper (the token env var is expanded by the
 * helper's shell at runtime), and gh reads GH_TOKEN from its environment.
 * Every adapter returns a typed result; nothing here throws to callers.
 */

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: EnvLike }
) => Promise<{ stdout: string; stderr: string }>;

export const DEFAULT_GH_BIN = "/opt/homebrew/bin/gh";

export function defaultRunCommand(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: EnvLike }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        env: opts?.env ? ({ ...process.env, ...opts.env } as NodeJS.ProcessEnv) : process.env,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const message = redact(
            `${err.message}${stderr ? `: ${String(stderr).slice(0, 500)}` : ""}`
          ).text;
          reject(new Error(message));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

export interface WritebackOpts {
  runCmd?: RunCommand;
  ghBin?: string;
  env?: EnvLike;
  /** tests: pre-populated clone directory — skips the clone step */
  workDir?: string;
}

// --- section rendering ---------------------------------------------------------------

export function renderSectionEntry(section: HowtoSection): Record<string, unknown> {
  return {
    title: section.goal.slice(0, 200),
    goal: section.goal.slice(0, 500),
    os: section.os,
    tags: [],
    script: section.script,
    provenance: {
      session: section.sessionToken,
      createdAt: section.createdAt,
      attempts: section.attempts,
    },
  };
}

// --- target doc file -------------------------------------------------------------------

function slugify(tool: string): string {
  return (
    tool
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "howto"
  );
}

export interface DocTarget {
  /** absolute file to write */
  file: string;
  /** true when the file already exists (record-form doc, matching name) */
  exists: boolean;
}

/**
 * Find the record-form yaml file whose top-level doc `name` matches `tool`.
 * Array-form files are rejected (typed error) — write-back only appends to
 * single-doc files or creates new ones.
 */
export function findDocFile(
  dir: string,
  tool: string
): { target: DocTarget; error?: undefined } | { target?: undefined; error: string } {
  const candidates: string[] = [];
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const rel of entries.sort()) {
      if (rel.split(sep).includes(".git")) continue;
      if (rel.endsWith(".yaml") || rel.endsWith(".yml")) candidates.push(join(dir, rel));
    }
  } catch {
    return { error: `cannot read source directory: ${dir}` };
  }
  const exact = candidates.find((f) => {
    const base = f.split(sep).pop() ?? "";
    return base.replace(/\.ya?ml$/, "") === tool;
  });
  for (const file of exact ? [exact] : candidates) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      return { error: `${file} is array-form; write-back supports record-form docs only` };
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.name === tool) return { target: { file, exists: true } };
    }
  }
  if (exact) return { target: { file: exact, exists: true } };
  return { target: { file: join(dir, `${slugify(tool)}.yaml`), exists: false } };
}

/** Append the section entry to the target file (creating a minimal doc when new). */
export function appendSection(target: DocTarget, section: HowtoSection): void {
  let doc: Record<string, unknown> = {};
  if (target.exists && existsSync(target.file)) {
    const parsed = parseYaml(readFileSync(target.file, "utf-8"));
    if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
      throw new Error(`${target.file} is not a record-form yaml doc`);
    }
    doc = parsed as Record<string, unknown>;
  } else {
    doc = {
      mallm: "1.1",
      name: section.tool,
      summary: section.goal.slice(0, 200),
    };
  }
  const howtos = Array.isArray(doc.howtos) ? [...doc.howtos] : [];
  howtos.push(renderSectionEntry(section));
  doc.howtos = howtos;
  writeFileSync(target.file, stringifyYaml(doc, { lineWidth: 100 }));
}

// --- shared git plumbing ------------------------------------------------------------------

function redactedResult(
  partial: Omit<WritebackResult, "ok">,
  error?: string
): WritebackResult {
  return { ...partial, ok: !error, ...(error ? { error: redact(error).text } : {}) };
}

// --- dir adapter ------------------------------------------------------------------------------

async function writebackDir(
  source: MallmSource,
  section: HowtoSection,
  opts: Required<Pick<WritebackOpts, "runCmd">> & WritebackOpts
): Promise<WritebackResult> {
  const runCmd = opts.runCmd;
  const dir = source.url ?? "";
  const branch = `howto/${section.sessionToken}`;
  const partial = { source: source.name, adapter: "dir" as const, branch };

  if (!existsSync(dir)) {
    return redactedResult({ ...partial, file: dir }, `source directory not found: ${dir}`);
  }
  try {
    await runCmd("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  } catch (e) {
    return redactedResult(
      { ...partial },
      `source dir is not a git repository (${e instanceof Error ? e.message : String(e)})`
    );
  }
  const found = findDocFile(dir, section.tool);
  if (found.error || !found.target) {
    return redactedResult({ ...partial }, found.error ?? "no target doc file");
  }
  try {
    await runCmd("git", ["checkout", "-b", branch], { cwd: dir }).catch(() =>
      runCmd("git", ["checkout", branch], { cwd: dir })
    );
    appendSection(found.target, section);
    const rel = found.target.file.slice(dir.length + 1);
    await runCmd("git", ["add", rel], { cwd: dir });
    await runCmd(
      "git",
      ["commit", "-m", `howto: ${section.goal.slice(0, 72)} (session ${section.sessionToken})`],
      { cwd: dir }
    );
    const commit = (await runCmd("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    return redactedResult({ ...partial, file: found.target.file, commit });
  } catch (e) {
    return redactedResult(
      { ...partial, file: found.target.file },
      e instanceof Error ? e.message : String(e)
    );
  }
}

// --- git adapter ---------------------------------------------------------------------------------

function repoSlug(repo: string): string {
  const https = repo.replace(/\.git$/, "");
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/.exec(https);
  if (m) return `${m[1]}/${m[2]}`;
  const ssh = /^[\w.-]+@[\w.-]+:(.+)$/.exec(repo);
  if (ssh) {
    const parts = ssh[1].replace(/\.git$/, "").split("/");
    if (parts.length >= 2) return parts.slice(-2).join("/");
  }
  const parts = https.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : https;
}

/**
 * Env config for an authenticated push WITHOUT the token in argv or URLs:
 * a git credential helper that echoes the token from the (inherited) env —
 * the helper text references the env var NAME, expanded at runtime.
 */
function pushEnv(base: EnvLike, tokenEnvName: string): EnvLike {
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0:
      `!f() { echo "username=x-access-token"; echo "password=$${tokenEnvName}"; }; f`,
  };
}

async function writebackGit(
  source: MallmSource,
  section: HowtoSection,
  opts: Required<Pick<WritebackOpts, "runCmd" | "ghBin" | "env">> & WritebackOpts
): Promise<WritebackResult> {
  const runCmd = opts.runCmd;
  const env = opts.env;
  const repo = source.repo ?? "";
  const base = source.branch ?? "main";
  const branch = `howto/${section.sessionToken}`;
  const partial = { source: source.name, adapter: "git" as const, branch };

  if (!repo) return redactedResult({ ...partial }, "git source has no repo");

  const tokenEnvName = source.tokenEnv;
  const token = tokenEnvName ? env[tokenEnvName] : undefined;
  if (tokenEnvName && !token) {
    return redactedResult(
      { ...partial },
      `token env ${tokenEnvName} is not set — cannot push or open a PR (set it or remove tokenEnv)`
    );
  }

  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "mallm-writeback-"));
  try {
    if (!opts.workDir) {
      await runCmd("git", ["clone", "--branch", base, repo, workDir]);
    }
    await runCmd("git", ["checkout", "-b", branch], { cwd: workDir }).catch(() =>
      runCmd("git", ["checkout", branch], { cwd: workDir })
    );
    const found = findDocFile(workDir, section.tool);
    if (found.error || !found.target) {
      return redactedResult({ ...partial }, found.error ?? "no target doc file");
    }
    appendSection(found.target, section);
    const rel = found.target.file.slice(workDir.length + 1);
    await runCmd("git", ["add", rel], { cwd: workDir });
    await runCmd(
      "git",
      ["commit", "-m", `howto: ${section.goal.slice(0, 72)} (session ${section.sessionToken})`],
      { cwd: workDir }
    );
    const commit = (await runCmd("git", ["rev-parse", "HEAD"], { cwd: workDir })).stdout.trim();
    const pushOptions = token
      ? { cwd: workDir, env: pushEnv({ ...env, [tokenEnvName as string]: token }, tokenEnvName as string) }
      : { cwd: workDir };
    await runCmd("git", ["push", "origin", branch], pushOptions);

    const slug = repoSlug(repo);
    const ghEnv: EnvLike = token ? { ...env, GH_TOKEN: token } : { ...env };
    const prOut = await runCmd(
      opts.ghBin,
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--base",
        base,
        "--head",
        branch,
        "--title",
        `howto: ${section.goal.slice(0, 60)}`,
        "--body",
        `Automated how-to write-back from mallm session ${section.sessionToken}.\n\nGoal: ${section.goal}\nTool: ${section.tool}\nAttempts: ${section.attempts}`,
      ],
      { cwd: workDir, env: ghEnv }
    );
    const prMatch = /pull\/(\d+)/.exec(prOut.stdout);
    return redactedResult({
      ...partial,
      commit,
      file: found.target.file,
      ...(prMatch
        ? { pullRequest: { number: Number(prMatch[1]), url: prOut.stdout.trim().split("\n")[0].trim() } }
        : {}),
    });
  } catch (e) {
    return redactedResult(
      { ...partial },
      e instanceof Error ? e.message : String(e)
    );
  }
}

// --- entry point ------------------------------------------------------------------------------------

export async function writebackHowto(
  source: MallmSource,
  section: HowtoSection,
  opts: WritebackOpts = {}
): Promise<WritebackResult> {
  const runCmd = opts.runCmd ?? defaultRunCommand;
  if (source.kind === "dir") {
    return writebackDir(source, section, { ...opts, runCmd });
  }
  if (source.kind === "git") {
    return writebackGit(source, section, {
      ...opts,
      runCmd,
      ghBin: opts.ghBin ?? DEFAULT_GH_BIN,
      env: opts.env ?? process.env,
    });
  }
  return redactedResult(
    { source: source.name, adapter: "dir", branch: `howto/${section.sessionToken}` },
    `source kind '${source.kind}' has no write-back adapter (dir and git only)`
  );
}

/** Pick the default write-back source: first dir source, else first git source. */
export function writableSource(
  sources: readonly MallmSource[]
): MallmSource | null {
  return sources.find((s) => s.kind === "dir") ?? sources.find((s) => s.kind === "git") ?? null;
}
