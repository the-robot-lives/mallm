import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { resolvePlatformConfig } from "../config/index.js";
import type { EnvLike } from "../config/loader.js";
import { cacheRoot, loadCorpus } from "../corpus/index.js";
import { probeEnvironment } from "../env/index.js";
import { SessionKV } from "../session/index.js";
import { resolveTiers } from "../memory/index.js";
import { redact } from "../changelog/redactor.js";
import { generateCandidates } from "./drafts.js";
import { writableSource, writebackHowto } from "./writeback.js";
import type {
  HowtoDeps,
  HowtoStepResult,
  InstallPlanItem,
  InstallResult,
  RunOutcome,
} from "./types.js";

/**
 * Real (non-test) wiring for the how-to command: default injectable IO built
 * from the platform's own modules. Everything async degrades; the machine's
 * handlers already catch.
 */

const RUN_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;

export function howtoCacheDir(token: string, env: EnvLike = process.env): string {
  return join(dirname(cacheRoot(env)), "howto", token);
}

export function runScriptDefault(
  script: string,
  attempt: number,
  token: string,
  env: EnvLike = process.env
): Promise<RunOutcome> {
  const dir = howtoCacheDir(token, env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${attempt}.sh`);
  writeFileSync(file, `${script}\n`, { mode: 0o755 });
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      "bash",
      [file],
      {
        encoding: "utf-8",
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
        resolve({
          exitCode: err
            ? typeof code === "number"
              ? code
              : err.killed
                ? null
                : 127
            : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          durationMs: Date.now() - startedAt,
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}

export function installToolDefault(item: InstallPlanItem): Promise<InstallResult> {
  return new Promise((resolve) => {
    execFile(
      item.installer,
      item.args,
      {
        encoding: "utf-8",
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const output = redact(
          [String(stdout ?? ""), String(stderr ?? "")].join("\n").slice(0, 300)
        ).text;
        resolve({ tool: item.tool, installer: item.installer, ok: !err, output });
      }
    );
  });
}

export function buildHowtoDeps(opts: {
  kv: SessionKV;
  cwd?: string;
  env?: EnvLike;
}): HowtoDeps {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const config = resolvePlatformConfig(env, cwd);
  const tiers = () => resolveTiers(config, cwd, env);
  return {
    env,
    config,
    cwd,
    kv: opts.kv,
    probe: (extraTools) => probeEnvironment({ extraTools, env }),
    loadCorpus: () => loadCorpus(config, { cacheRoot: cacheRoot(env) }),
    generateCandidates: (ctx) => generateCandidates(ctx, { inference: config.inference, env }),
    runScript: (script, attempt) => runScriptDefault(script, attempt, opts.kv.token, env),
    installTool: (item) => installToolDefault(item),
    writeback: async (section) => {
      const source = writableSource(config.sources);
      if (!source) {
        return {
          ok: false,
          source: "(none)",
          adapter: "dir",
          branch: `howto/${section.sessionToken}`,
          error: "no writable corpus source configured (write-back needs a dir or git source)",
        };
      }
      return writebackHowto(source, section, { env });
    },
    tiers,
    knowledgePath: join(tiers().user, "knowledge.yaml"),
    now: () => new Date(),
  };
}

// --- rendering ---------------------------------------------------------------------

function scriptPreview(script: string, lines = 6): string {
  const body = script.split("\n").slice(0, lines).join("\n");
  const more = script.split("\n").length > lines ? "\n…" : "";
  return body + more;
}

export function renderHowtoStep(result: HowtoStepResult, opts: { json?: boolean } = {}): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          status: result.status,
          stage: result.stage,
          session: result.sessionToken,
          message: result.message,
          ...(result.approvalRequest ? { approvalRequest: result.approvalRequest } : {}),
          state: result.state,
        },
        null,
        2
      )
    );
    return;
  }

  const mark =
    result.status === "closed"
      ? chalk.green(result.status)
      : result.status === "stopped"
        ? chalk.red(result.status)
        : result.status === "awaiting-approval"
          ? chalk.yellow(result.status)
          : chalk.bold(result.status);
  console.log(`mallm how-to  [${mark}]  stage=${result.stage}  session=${chalk.green(result.sessionToken)}`);
  console.log(chalk.dim(result.message));
  console.log("");

  const state = result.state;
  if (result.status === "awaiting-selection" || result.status === "dry-run-stop") {
    if (state.candidates.length > 0) {
      console.log(chalk.bold("Candidates:"));
      for (const c of state.candidates) {
        console.log(`  ${chalk.green(String(c.id))}. [${c.source}] ${c.title}`);
        console.log(chalk.dim(`     ${c.rationale}`));
        console.log(chalk.dim(scriptPreview(c.script).replace(/^/gm, "     ")));
      }
      console.log(
        chalk.dim(`pick with: mallm how-to --session ${result.sessionToken} --pick N`)
      );
      console.log("");
    }
  }

  if (result.approvalRequest) {
    const req = result.approvalRequest;
    console.log(chalk.yellow(`approval required (${req.kind}): ${req.id}`));
    console.log(chalk.dim(`  ${req.prompt}`));
    console.log(
      chalk.dim(
        `  approve: mallm session approve ${result.sessionToken} ${req.id}` +
          `   (shortcut: rerun with ${req.kind === "install" ? "--approve-install" : "--approve-run"})`
      )
    );
    console.log(chalk.dim(`  deny:    mallm session deny ${result.sessionToken} ${req.id}`));
    console.log("");
  }

  const lastRun = state.runs[state.runs.length - 1];
  if (lastRun) {
    console.log(
      chalk.bold(`last run (attempt ${lastRun.attempt}, exit ${lastRun.exitCode ?? "n/a"}${lastRun.timedOut ? ", timed out" : ""}):`)
    );
    const tail = [lastRun.stderr, lastRun.stdout].filter((s) => s.trim() !== "").join("\n");
    console.log(chalk.dim((tail.split("\n").slice(-8).join("\n") || "(no output)").replace(/^/gm, "  ")));
    console.log("");
  }

  if (state.stage === "closed") {
    const wb = state.writeback;
    if (wb) {
      console.log(chalk.bold("write-back:"));
      console.log(
        wb.ok
          ? `  ${chalk.green("ok")}  ${wb.adapter}  ${wb.branch}${wb.pullRequest ? `  PR ${wb.pullRequest.number}: ${wb.pullRequest.url}` : ""}`
          : `  ${chalk.red("failed")}  ${wb.error ?? "unknown error"}`
      );
      if (wb.file) console.log(chalk.dim(`  file: ${wb.file}`));
    }
    console.log(chalk.dim(`full state: mallm session ${result.sessionToken} --json`));
  }
}

// --- man / --help fold -----------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function sanitizeManText(text: string, maxLines = 40): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/.\x08/g, "") // overstrike formatting (X\bX bold, _\bX underline)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, maxLines)
    .join("\n");
}

/** Best-effort fold of `man <app>` (pager forced to cat), falling back to `<app> --help`. */
export function helpOrManText(app: string): Promise<string> {
  const attempt = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { encoding: "utf-8", timeout: 5000, windowsHide: true },
        (err, stdout, stderr) => resolve(err ? { stdout: "", stderr: String(stderr ?? "") } : { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
      );
    });
  return (async () => {
    const man = await attempt("man", ["-P", "cat", app]);
    if (man.stdout.trim() !== "") return sanitizeManText(man.stdout);
    const help = await attempt(app, ["--help"]);
    if (help.stdout.trim() !== "" || help.stderr.trim() !== "") {
      return sanitizeManText([help.stdout, help.stderr].filter((s) => s.trim() !== "").join("\n"));
    }
    return "";
  })();
}
