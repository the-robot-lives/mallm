#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { resolve_mallm, listAvailable } from "./resolver.js";
import { formatMarkdown } from "./formatter.js";
import { initMallm } from "./init.js";
import {
  SOURCE_KINDS,
  type MallmSource,
  type SourceKind,
  firstWritableConfigPath,
  resolvePlatformConfig,
  upsertSource,
} from "./config/index.js";
import { cacheRoot, defaultRunGit, loadCorpus, loadCorpusFromCache, syncSource } from "./corpus/index.js";
import { osContext, probeEnvironment } from "./env/index.js";
import { SessionKV, listSessions, mintUniqueToken, sessionFilePath, sessionsDir } from "./session/index.js";
import { appendHistory, historyPath, readHistory } from "./changelog/index.js";
import { redact } from "./changelog/redactor.js";
import { isConfigured } from "./llm/index.js";
import { readKnowledge, resolveTiers, sortSources, writeKnowledge } from "./memory/index.js";
import { buildIndex, search } from "./search/index.js";
import { howtoDocsFromCorpus } from "./search/corpus.js";
import { advanceHowto } from "./howto/index.js";
import { buildHowtoDeps, helpOrManText, renderHowtoStep } from "./howto/cli.js";
import {
  applyQuizAnswers,
  askSystemOne,
  buildQuiz,
  renderQuizPlain,
} from "./jev/index.js";

const program = new Command();

program
  .name("mallm")
  .description("man pages for LLMs — structured CLI documentation for AI agents")
  .version("0.1.0");

program
  .command("show <app>")
  .description("Show mallm documentation for a command, folded with OS details, man/--help text, and the cached corpus entry")
  .option("--json", "Output as structured JSON instead of markdown")
  .option("--version <ver>", "Request documentation for a specific version")
  .option("--agent", "Append a SESSION <4 glyphs> suffix (reuses --session, else mints a fresh session)")
  .action(async (app: string, opts: { json?: boolean; version?: string; agent?: boolean }) => {
    await showApp(app, opts);
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
  .option("--token-env <env>", "git: env var NAME holding the write-back push/PR token (never a value)")
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
        tokenEnv?: string;
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
        tokenEnv: opts.tokenEnv,
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

function decideApproval(
  token: string,
  requestId: string,
  decision: "granted" | "denied",
  note?: string
): void {
  const kv = SessionKV.open(token);
  if (!kv.existsOnDisk) {
    console.error(chalk.red(`No session found for token '${token}'.`));
    process.exit(1);
  }
  kv.set("approvals", requestId, {
    decision,
    at: new Date().toISOString(),
    by: `session ${decision}`,
    ...(note ? { note } : {}),
  });
  kv.save();
  console.log(
    `${decision === "granted" ? "Granted" : "Denied"} ${chalk.green(requestId)} in session ${chalk.green(token)}.`
  );
  if (decision === "granted") {
    console.log(chalk.dim(`Resume with: mallm how-to --session ${token}`));
  }
  logCliAction(`session.${decision}`, [], `${requestId} in ${token}`);
}

sessionCmd
  .command("approve <token> <requestId>")
  .description("Grant a pending how-to gate approval request")
  .option("--note <note>", "why (recorded in the approvals bucket)")
  .action((token: string, requestId: string, opts: { note?: string }) => {
    decideApproval(token, requestId, "granted", opts.note);
  });

sessionCmd
  .command("deny <token> <requestId>")
  .description("Deny a pending how-to gate approval request")
  .option("--note <note>", "why (recorded in the approvals bucket)")
  .action((token: string, requestId: string, opts: { note?: string }) => {
    decideApproval(token, requestId, "denied", opts.note);
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

// --- how-to -----------------------------------------------------------------------

const howtoCmd = program
  .command("how-to")
  .description("Resumable how-to state machine: INTAKE → DRAFT → SELECT → gates → SUCCESS → WRITEBACK (gates need explicit approvals; no --yes exists)");

howtoCmd
  .description("Run or resume a how-to (one-shot per call; state persists in the session KV)")
  .argument("[goal]", "what the how-to should accomplish")
  .option("--tool <tool>", "focus tool (corpus doc name used for write-back)")
  .option("--dry-run", "stop after DRAFT/SELECT — never installs or runs anything")
  .option("--pick <n>", "select candidate n (1-based) from the last DRAFT", (v: string) => Number(v))
  .option("--approve-install", "grant the pending install gate for this invocation only")
  .option("--approve-run", "grant the pending run gate for this invocation only")
  .option("--json", "Output structured JSON")
  .action(async (
    goal: string | undefined,
    opts: {
      tool?: string;
      dryRun?: boolean;
      pick?: number;
      approveInstall?: boolean;
      approveRun?: boolean;
      json?: boolean;
    }
  ) => {
    const globalOpts = program.opts() as { session?: string; json?: boolean };
    let token = globalOpts.session;
    if (!token) {
      if (!goal) {
        howtoCmd.help();
        return;
      }
      token = mintUniqueToken((t) => existsSync(sessionFilePath(t))).token;
    }
    const kv = SessionKV.open(token);
    const deps = buildHowtoDeps({ kv });
    try {
      const result = await advanceHowto(deps, {
        goal,
        tool: opts.tool,
        pick: opts.pick,
        approveInstall: opts.approveInstall,
        approveRun: opts.approveRun,
        dryRun: opts.dryRun,
      });
      renderHowtoStep(result, { json: opts.json || globalOpts.json });
      logCliAction("how-to", [], `${result.status} @ ${result.stage}`);
      if (result.status === "stopped") process.exitCode = 2;
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
  });

// --- search -----------------------------------------------------------------------

program
  .command("search <query>")
  .description("BM25 search over the how-to corpus (cache-only; --refresh re-syncs sources first)")
  .option("--refresh", "sync sources (network) before searching")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { refresh?: boolean; json?: boolean }) => {
    const cfg = resolvePlatformConfig();
    const root = cacheRoot();
    const loaded = opts.refresh
      ? await loadCorpus(cfg, { cacheRoot: root })
      : await loadCorpusFromCache(cfg, { cacheRoot: root });
    const docs = howtoDocsFromCorpus(loaded.merged);
    const hits = search(buildIndex(docs), query, { limit: 10 });
    const rows = hits.flatMap((h) => {
      const doc = docs.find((d) => d.id === h.id);
      return doc
        ? [{
            id: doc.id,
            tool: doc.tool,
            title: doc.title,
            summary: doc.summary,
            os: doc.os,
            score: Math.round(h.score * 1000) / 1000,
          }]
        : [];
    });
    if (opts.json || (program.opts() as { json?: boolean }).json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(chalk.dim(`No matches for '${query}'. Try --refresh, or 'mallm sources update'.`));
      return;
    }
    for (const r of rows) {
      console.log(
        `  ${chalk.green(r.id)}  ${r.title}  ${chalk.dim(`(${r.tool}, score ${r.score})`)}`
      );
    }
    logCliAction("search", [], `${rows.length} hits for '${query}'`);
  });

// --- quiz / learn (jev — TypeSafe systemone) -----------------------------------------

function knowledgePath(): string {
  const cfg = resolvePlatformConfig();
  return join(resolveTiers(cfg).user, "knowledge.yaml");
}

async function corpusSynopses(): Promise<Record<string, string>> {
  const synopses: Record<string, string> = {};
  try {
    const cfg = resolvePlatformConfig();
    const { merged } = await loadCorpusFromCache(cfg, { cacheRoot: cacheRoot() });
    for (const [name, m] of merged) {
      const usage = m.doc.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.synopsis === "string" && usage.synopsis.trim() !== "") {
        synopses[name] = usage.synopsis;
      }
    }
  } catch {
    // synopses are optional context for choice questions
  }
  return synopses;
}

program
  .command("quiz")
  .description("Plain-text quiz from knowledge.yaml topics (lowest confidence first)")
  .option("--topic <id>", "quiz a single topic id")
  .option("--json", "Output as JSON")
  .action(async (opts: { topic?: string; json?: boolean }) => {
    const topics = readKnowledge(knowledgePath()).topics;
    if (topics.length === 0) {
      console.log(
        chalk.dim(
          "No knowledge topics yet — they appear as how-to runs complete (write-back) or are hand-authored in knowledge.yaml."
        )
      );
      return;
    }
    const round = buildQuiz(topics, { topicId: opts.topic, synopses: await corpusSynopses() });
    if (opts.json || (program.opts() as { json?: boolean }).json) {
      console.log(JSON.stringify(round, null, 2));
      return;
    }
    console.log(renderQuizPlain(round));
  });

program
  .command("learn")
  .description("Run a jev (TypeSafe systemone) quiz round and apply the answers to knowledge.yaml")
  .option("--topic <id>", "limit the round to one topic id")
  .option("--limit <n>", "max topics probed", (v: string) => Number(v))
  .option("--json", "Output as JSON")
  .action(async (opts: { topic?: string; limit?: number; json?: boolean }) => {
    const path = knowledgePath();
    const topics = readKnowledge(path).topics;
    if (topics.length === 0) {
      console.log(chalk.dim("No knowledge topics to learn from yet."));
      return;
    }
    const round = buildQuiz(topics, {
      topicId: opts.topic,
      limit: opts.limit,
      synopses: await corpusSynopses(),
    });
    const state = {
      os: osContext(),
      tools: topics.map((t) => t.id),
      corpus: Object.keys(await corpusSynopses()),
    };
    const result = await askSystemOne(state, round.questions, { env: process.env });
    const asJson = opts.json || (program.opts() as { json?: boolean }).json;
    if (!result.ok) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, kind: result.kind, reason: result.reason, round }, null, 2));
      } else {
        console.log(chalk.yellow(`${result.reason} — rendering the quiz instead:`));
        console.log(renderQuizPlain(round));
      }
      return;
    }
    const applied = applyQuizAnswers(topics, round.questions, result.answers, round.expected);
    writeKnowledge(path, { topics: applied.topics });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, answers: result.answers, deltas: applied.deltas }, null, 2));
    } else {
      console.log(`jev round complete (${result.answers.length} answers applied):`);
      for (const d of applied.deltas) {
        console.log(`  ${chalk.green(d.topicId)}  ${d.from} → ${d.to}`);
      }
      if (applied.deltas.length === 0) console.log(chalk.dim("  (no confidence changes)"));
    }
    logCliAction("learn", [path], `${result.answers.length} answers, ${applied.deltas.length} deltas`);
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

async function showApp(
  app: string,
  opts?: { json?: boolean; version?: string; agent?: boolean }
) {
  const globalOpts = program.opts() as { session?: string; json?: boolean };
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

  const os = osContext();
  const helpText = await helpOrManText(app);
  let corpusEntry: {
    name: string;
    source: string;
    kind: string;
    priority: number;
    summary: string | null;
  } | null = null;
  try {
    const cfg = resolvePlatformConfig();
    const { merged } = await loadCorpusFromCache(cfg, { cacheRoot: cacheRoot() });
    const doc = merged.get(app);
    if (doc) {
      corpusEntry = {
        name: doc.name,
        source: doc.sourceName,
        kind: doc.sourceKind,
        priority: doc.priority,
        summary: typeof doc.doc.summary === "string" ? doc.doc.summary : null,
      };
    }
  } catch {
    // corpus fold is best-effort
  }

  let token: string | null = null;
  if (opts?.agent) {
    const given = globalOpts.session;
    token = given && existsSync(sessionFilePath(given)) ? given : null;
    if (!token) {
      token = mintUniqueToken((t) => existsSync(sessionFilePath(t))).token;
      SessionKV.open(token).save();
    }
  }

  if (opts?.json || globalOpts.json) {
    console.log(
      JSON.stringify(
        {
          doc: resolved.config,
          docSource: resolved.source,
          docPath: resolved.path,
          os,
          help: helpText === "" ? null : helpText,
          corpus: corpusEntry,
          session: token,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatMarkdown(resolved));
  console.log(chalk.bold("## OS"));
  console.log(`  ${os.flavor} ${os.version} · ${os.arch} · ${os.shell}`);
  if (helpText !== "") {
    console.log("");
    console.log(chalk.bold("## Help (man/--help fold)"));
    console.log(chalk.dim(helpText.replace(/^/gm, "  ")));
  }
  if (corpusEntry) {
    console.log("");
    console.log(chalk.bold("## Corpus (cached)"));
    console.log(
      `  ${chalk.green(corpusEntry.name)} (${corpusEntry.kind}, p${corpusEntry.priority}, source ${corpusEntry.source})`
    );
    if (corpusEntry.summary) console.log(chalk.dim(`  ${corpusEntry.summary}`));
  }
  if (token) {
    console.log("");
    console.log(`SESSION ${chalk.green(token)}`);
  }
}

// Default: `mallm <app>` as shorthand for `mallm show <app>`
program.argument("[app]", "Command to look up (shorthand for 'mallm show <app>')");
program.option("--json", "Output as structured JSON");
program.action(async (app?: string, opts?: { json?: boolean }) => {
  if (!app) {
    program.help();
    return;
  }
  await showApp(app, opts);
});

program.parse();
