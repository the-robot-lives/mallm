#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { resolve_mallm, listAvailable } from "./resolver.js";
import { formatMarkdown, formatJson } from "./formatter.js";
import { initMallm } from "./init.js";
import {
  SOURCE_KINDS,
  type MallmSource,
  type SourceKind,
  firstWritableConfigPath,
  resolvePlatformConfig,
  upsertSource,
} from "./config/index.js";
import { cacheRoot, defaultRunGit, syncSource } from "./corpus/index.js";
import { probeEnvironment } from "./env/index.js";
import { SessionKV, listSessions, sessionsDir } from "./session/index.js";
import { appendHistory, historyPath, readHistory } from "./changelog/index.js";
import { redact } from "./changelog/redactor.js";
import { isConfigured } from "./llm/index.js";
import { resolveTiers, sortSources } from "./memory/index.js";

const program = new Command();

program
  .name("mallm")
  .description("man pages for LLMs — structured CLI documentation for AI agents")
  .version("0.1.0");

program
  .command("show <app>")
  .description("Show mallm documentation for a command")
  .option("--json", "Output as structured JSON instead of markdown")
  .option("--version <ver>", "Request documentation for a specific version")
  .action((app: string, opts: { json?: boolean; version?: string }) => {
    showApp(app, opts);
  });

program
  .command("init <app>")
  .description("Create a mallm.yaml stub for a command (seeds from --help if available)")
  .option("--global", "Create in ~/.config/mallm/ instead of project .mallm/")
  .action((app: string, opts: { global?: boolean }) => {
    const result = initMallm(app, {
      global: opts.global,
      project: !opts.global,
    });
    console.log(result);
  });

program
  .command("list")
  .description("List all available mallm definitions")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    const items = listAvailable();

    if (items.length === 0) {
      console.log(chalk.dim("No mallm definitions found."));
      console.log(chalk.dim("Create one with: mallm init <app>"));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    console.log(chalk.bold("Available mallm definitions:\n"));

    const bySource = new Map<string, typeof items>();
    for (const item of items) {
      const group = bySource.get(item.source) ?? [];
      group.push(item);
      bySource.set(item.source, group);
    }

    for (const [source, group] of bySource) {
      console.log(chalk.underline(source));
      for (const item of group) {
        console.log(`  ${chalk.green(item.name)}  ${chalk.dim(item.path)}`);
      }
      console.log("");
    }
  });

program
  .command("validate <path>")
  .description("Validate a mallm.yaml file")
  .action((path: string) => {
    try {
      const content = readFileSync(path, "utf-8");
      const config = parseYaml(content);

      const errors: string[] = [];
      if (!config.mallm) errors.push("Missing 'mallm' version field");
      else if (!["1.0", "1.1"].includes(config.mallm))
        errors.push(`Unknown 'mallm' version: ${config.mallm} (expected 1.0 or 1.1)`);
      if (!config.name) errors.push("Missing 'name' field");
      if (!config.summary) errors.push("Missing 'summary' field");

      if (config.arguments) {
        for (const arg of config.arguments) {
          if (!arg.name) errors.push("Argument missing 'name'");
          if (!arg.type) errors.push(`Argument '${arg.name}' missing 'type'`);
          if (!arg.description)
            errors.push(`Argument '${arg.name}' missing 'description'`);
        }
      }

      if (errors.length > 0) {
        console.error(chalk.red("Validation failed:"));
        for (const err of errors) {
          console.error(chalk.red(`  - ${err}`));
        }
        process.exit(1);
      }

      console.log(chalk.green(`Valid: ${path}`));
      console.log(chalk.dim(`  name: ${config.name}`));
      console.log(chalk.dim(`  summary: ${config.summary}`));
      if (config.mallm) console.log(chalk.dim(`  schema: ${config.mallm}`));
      if (config.arguments)
        console.log(chalk.dim(`  arguments: ${config.arguments.length}`));
      if (config.subcommands)
        console.log(chalk.dim(`  subcommands: ${config.subcommands.length}`));
    } catch (e) {
      console.error(chalk.red(`Failed to parse: ${e}`));
      process.exit(1);
    }
  });

program
  .command("schema")
  .description("Print the mallm.yaml JSON Schema")
  .action(() => {
    const schemaPath = new URL("../schemas/mallm.schema.json", import.meta.url);
    try {
      const schema = readFileSync(schemaPath, "utf-8");
      console.log(schema);
    } catch {
      console.error(chalk.red("Schema file not found. Run from installed package."));
      process.exit(1);
    }
  });

// --- sources -------------------------------------------------------------------

const sourcesCmd = program
  .command("sources")
  .description("Manage how-to corpus sources (http | git | dir)");

function sortedSources(): MallmSource[] {
  return sortSources(resolvePlatformConfig().sources);
}

function sourceTarget(s: MallmSource): string {
  return s.kind === "git"
    ? `${s.repo ?? ""}@${s.branch ?? "main"}`
    : (s.url ?? "");
}

sourcesCmd
  .command("list")
  .description("List configured corpus sources in priority order")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    const rows = sortedSources();
    if (opts.json || (program.opts() as { json?: boolean }).json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(chalk.dim("No sources configured."));
      console.log(chalk.dim("Add one: mallm sources add <name> --kind http --url <url>"));
      return;
    }
    console.log(chalk.bold("Corpus sources (lower priority number = higher precedence):\n"));
    for (const s of rows) {
      console.log(
        `  ${String(s.priority).padStart(3)}  ${chalk.green(s.name)}  ${chalk.dim(s.kind)}  ${sourceTarget(s)}`
      );
    }
  });

sourcesCmd
  .command("add <name>")
  .description("Add a corpus source (kind: http | git | dir)")
  .requiredOption("--kind <kind>", "source kind: http | git | dir")
  .option("--url <url>", "http: URL to fetch; dir: local directory path")
  .option("--repo <repo>", "git: repository URL")
  .option("--branch <branch>", "git: branch to track (default main)")
  .option("--priority <priority>", "precedence (lower wins, default 100)", (v: string) => Number(v))
  .option("--creds-ref <ref>", "credential reference (a name, never a value)")
  .action(
    (
      name: string,
      opts: {
        kind: string;
        url?: string;
        repo?: string;
        branch?: string;
        priority?: number;
        credsRef?: string;
      }
    ) => {
      const kind = opts.kind as SourceKind;
      if (!SOURCE_KINDS.includes(kind)) {
        console.error(chalk.red(`Invalid --kind '${opts.kind}' (expected http | git | dir).`));
        process.exit(1);
      }
      if (kind === "http" && !opts.url) {
        console.error(chalk.red("http sources need --url."));
        process.exit(1);
      }
      if (kind === "git" && !opts.repo) {
        console.error(chalk.red("git sources need --repo."));
        process.exit(1);
      }
      if (kind === "dir" && !opts.url) {
        console.error(chalk.red("dir sources need --url (a directory path)."));
        process.exit(1);
      }
      const source: MallmSource = {
        name,
        kind,
        url: opts.url,
        repo: opts.repo,
        branch: opts.branch,
        priority: Number.isFinite(opts.priority) ? opts.priority : undefined,
        credsRef: opts.credsRef,
      };
      const target = firstWritableConfigPath();
      const { path, created } = upsertSource(target, source);
      console.log(
        `${created ? "Created" : "Updated"} source ${chalk.green(name)} (${kind}) in ${path}`
      );
      logCliAction("sources.add", [path], `added ${name} (${kind})`);
    }
  );

sourcesCmd
  .command("update")
  .description("Sync corpus sources into the local cache (fetch-on-miss)")
  .option("--name <name>", "update a single source by name")
  .action(async (opts: { name?: string }) => {
    const cfg = resolvePlatformConfig();
    const targets = cfg.sources.filter((s) => !opts.name || s.name === opts.name);
    if (targets.length === 0) {
      console.error(chalk.red(opts.name ? `No source named '${opts.name}'.` : "No sources configured."));
      process.exit(1);
    }
    const results = await Promise.all(
      targets.map((source) => syncSource(source, { cacheRoot: cacheRoot() }))
    );
    let ok = 0;
    for (const r of results) {
      if (r.ok) {
        ok += 1;
        console.log(
          `  ${chalk.green("ok")}   ${r.source.name}  ${r.cached ? chalk.dim("(cached)") : ""}  ${r.docs.length} docs`
        );
      } else {
        console.log(`  ${chalk.red("err")}  ${r.source.name}  ${chalk.dim(r.error ?? "failed")}`);
      }
    }
    logCliAction("sources.update", [], `synced ${ok}/${results.length}`);
    if (ok < results.length) process.exit(1);
  });

// --- session -------------------------------------------------------------------

const sessionCmd = program
  .command("session")
  .description("Inspect a session KV store, or clear sessions");

sessionCmd
  .description("Show a session's KV content (compact inject block)")
  .argument("[token]", "4-glyph session token")
  .option("--json", "Output the raw KV JSON instead of the inject block")
  .action((token: string | undefined, opts: { json?: boolean }) => {
    const globalOpts = program.opts() as { session?: string; json?: boolean };
    const tok = token ?? globalOpts.session;
    if (!tok) {
      sessionCmd.help();
      return;
    }
    const kv = SessionKV.open(tok);
    if (!kv.existsOnDisk) {
      console.error(chalk.red(`No session found for token '${tok}'.`));
      process.exit(1);
    }
    if (opts.json || globalOpts.json) {
      console.log(JSON.stringify(kv.toJSON(), null, 2));
      return;
    }
    console.log(kv.inject());
  });

sessionCmd
  .command("clear")
  .description("Remove session KV files (all, --token <tok> for one, --expired for TTL-pruned only)")
  .option("--token <tok>", "clear a single session token")
  .option("--expired", "only clear sessions past the configured sessionTtl")
  .action((opts: { token?: string; expired?: boolean }) => {
    const cfg = resolvePlatformConfig();
    const dir = sessionsDir();
    const all = listSessions();
    const targets: string[] = [];
    if (opts.token) {
      targets.push(opts.token);
    } else if (opts.expired) {
      for (const tok of all) {
        if (SessionKV.open(tok).isExpired(cfg.sessionTtl)) targets.push(tok);
      }
    } else {
      targets.push(...all);
    }
    let removed = 0;
    for (const tok of targets) {
      const kv = SessionKV.open(tok);
      if (kv.existsOnDisk || existsSync(`${dir}/${tok}.json`)) {
        rmSync(`${dir}/${tok}.json`, { force: true });
        removed += 1;
      }
    }
    console.log(`Removed ${removed} session${removed === 1 ? "" : "s"}.`);
    logCliAction("session.clear", [], `removed ${removed}`);
  });

// --- history -------------------------------------------------------------------

program
  .command("history")
  .description("Read the (pre-redacted) mallm history log")
  .option("--session <tok>", "filter by session token")
  .option("--tail <n>", "show only the last N entries", (v: string) => Number(v))
  .option("--json", "Output as JSON")
  .action((opts: { session?: string; tail?: number; json?: boolean }) => {
    const globalOpts = program.opts() as { session?: string; json?: boolean };
    const records = readHistory({
      session: opts.session ?? globalOpts.session,
      tail: opts.tail,
    });
    if (opts.json || globalOpts.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log(chalk.dim("No history entries."));
      return;
    }
    for (const r of records) {
      console.log(`${chalk.dim(r.ts)}  ${r.session}  ${chalk.green(r.action)}  ${r.outcome}`);
    }
  });

// --- doctor --------------------------------------------------------------------

async function checkSourceReachability(
  source: MallmSource
): Promise<{ reachable: boolean; detail: string }> {
  if (source.kind === "dir") {
    const ok = existsSync(source.url ?? "");
    return { reachable: ok, detail: ok ? "directory present" : "directory missing" };
  }
  if (source.kind === "git") {
    try {
      const out = await defaultRunGit([
        "ls-remote",
        "--heads",
        source.repo ?? "",
        source.branch ?? "main",
      ]);
      const head = out.trim().split("\n")[0]?.slice(0, 12) ?? "";
      return { reachable: true, detail: head || "reachable" };
    } catch (e) {
      return { reachable: false, detail: redact(e instanceof Error ? e.message : String(e)).text };
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(source.url ?? "", { signal: controller.signal });
      return { reachable: res.status < 500, detail: `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { reachable: false, detail: redact(e instanceof Error ? e.message : String(e)).text };
  }
}

program
  .command("doctor")
  .description("Environment probe, source reachability, and inference check")
  .action(async () => {
    const globalOpts = program.opts() as {
      os?: boolean;
      osVersion?: string;
      toolVersion?: string;
      json?: boolean;
    };
    const cfg = resolvePlatformConfig();
    const extraTools = globalOpts.toolVersion ? [globalOpts.toolVersion] : [];
    const probe = await probeEnvironment({ extraTools });

    const osDisplay = globalOpts.os
      ? `pinned (--os)${globalOpts.osVersion ? `, version pinned: ${globalOpts.osVersion}` : ""}`
      : `${probe.os.flavor} ${probe.os.version}${globalOpts.osVersion ? ` (version pinned: ${globalOpts.osVersion})` : ""}`;

    const sourceChecks = await Promise.all(
      sortedSources().map(async (s) => {
        const check = await checkSourceReachability(s);
        return {
          name: s.name,
          kind: s.kind,
          priority: s.priority,
          target: sourceTarget(s),
          ...check,
        };
      })
    );

    const tiers = resolveTiers(cfg);
    const report = {
      env: {
        os: osDisplay,
        arch: probe.arch,
        shell: probe.shell,
        tools: probe.tools.filter((t) => t.version).map((t) => `${t.name} ${t.version}`),
        installers: probe.installers,
      },
      sources: sourceChecks,
      inference: {
        configured: isConfigured(cfg.inference),
        baseUrl: cfg.inference.baseUrl ?? null,
        model: cfg.inference.model ?? null,
        apiKeyEnv: cfg.inference.apiKeyEnv ?? null,
        apiKeySet: cfg.inference.apiKeyEnv
          ? Boolean(process.env[cfg.inference.apiKeyEnv])
          : null,
      },
      paths: {
        cache: cacheRoot(),
        sessions: sessionsDir(),
        sessionCount: listSessions().length,
        history: historyPath(),
        knowledgeTiers: {
          universal: tiers.universal.map((s) => s.name),
          org: tiers.org?.name ?? null,
          project: tiers.project,
          user: tiers.user,
        },
      },
    };

    if (globalOpts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(chalk.bold("mallm doctor\n"));
    console.log(chalk.underline("Environment"));
    console.log(`  os:         ${report.env.os}`);
    console.log(`  arch:       ${report.env.arch}`);
    console.log(`  shell:      ${report.env.shell}`);
    console.log(`  installers: ${report.env.installers.join(", ") || "none"}`);
    console.log(`  tools:      ${report.env.tools.join(", ") || "none probed"}`);
    console.log("");
    console.log(chalk.underline("Sources"));
    if (report.sources.length === 0) {
      console.log(chalk.dim("  none configured"));
    }
    for (const s of report.sources) {
      const mark = s.reachable ? chalk.green("reachable") : chalk.red("unreachable");
      console.log(`  ${mark}  ${s.name} (${s.kind}, p${s.priority})  ${chalk.dim(s.detail)}`);
    }
    console.log("");
    console.log(chalk.underline("Inference"));
    console.log(
      report.inference.configured
        ? `  configured: ${report.inference.model} @ ${report.inference.baseUrl}` +
            (report.inference.apiKeyEnv
              ? ` (key env ${report.inference.apiKeyEnv}: ${report.inference.apiKeySet ? "set" : "NOT set"})`
              : "")
        : chalk.dim("  not configured (no-inference results will be returned)")
    );
    console.log("");
    console.log(chalk.underline("Paths"));
    console.log(`  cache:     ${report.paths.cache}`);
    console.log(`  sessions:  ${report.paths.sessions} (${report.paths.sessionCount})`);
    console.log(`  history:   ${report.paths.history}`);
    console.log(`  org tier:  ${report.paths.knowledgeTiers.org ?? "none"}`);
    console.log(`  project:   ${report.paths.knowledgeTiers.project}`);
    console.log(`  user:      ${report.paths.knowledgeTiers.user}`);
  });

// --- global flags + default action ----------------------------------------------

function logCliAction(action: string, files: string[], outcome: string): void {
  const globalOpts = program.opts() as { session?: string };
  try {
    appendHistory({
      session: globalOpts.session ?? "adhoc",
      action,
      command: process.argv.slice(2).join(" "),
      files,
      outcome,
    });
  } catch {
    // history must never break the command it is recording
  }
}

program
  .option("--session <token>", "Session token for session-scoped operations")
  .option("--os", "Pin the OS context (skip live OS probe)")
  .option("--os-version <ver>", "Pin the OS version context")
  .option("--tool-version <tool>", "Also probe this tool's version in doctor")
  .option("--no-color", "Disable colored output");

program.hook("preAction", () => {
  if ((program.opts() as { noColor?: boolean }).noColor) {
    chalk.level = 0;
  }
});

function showApp(app: string, opts?: { json?: boolean; version?: string }) {
  const resolved = resolve_mallm(app, { version: opts?.version });

  if (!resolved) {
    console.error(chalk.red(`No mallm documentation found for '${app}'.`));
    console.error(
      chalk.dim(
        `\nTo create one:\n  mallm init ${app}\n  mallm init ${app} --global`
      )
    );
    process.exit(1);
  }

  if (opts?.json) {
    console.log(formatJson(resolved));
  } else {
    console.log(formatMarkdown(resolved));
  }
}

// Default: `mallm <app>` as shorthand for `mallm show <app>`
program.argument("[app]", "Command to look up (shorthand for 'mallm show <app>')");
program.option("--json", "Output as structured JSON");
program.action((app?: string, opts?: { json?: boolean }) => {
  if (!app) {
    program.help();
    return;
  }
  showApp(app, opts);
});

program.parse();
