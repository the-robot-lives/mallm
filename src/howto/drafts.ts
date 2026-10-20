import type { InferenceConfig } from "../config/types.js";
import type { ChatFetch, ChatMessage } from "../llm/index.js";
import { chat, isConfigured } from "../llm/index.js";
import { buildIndex, search } from "../search/index.js";
import { howtoDocsFromCorpus } from "../search/corpus.js";
import type { MergedDoc } from "../corpus/index.js";
import type { HowtoCandidate, HowtoRunRecord, DiagnoseResult } from "./types.js";

/**
 * DRAFT stage: produce 2–3 candidate bash scripts for the goal.
 * - LLM path when inference is configured (fenced-bash extraction, capped at 3)
 * - corpus-adapted path otherwise (BM25 over the corpus, scripts adapted from
 *   usage examples / common patterns)
 * - template fallback guarantees candidates even with no key, no corpus
 * Every path degrades; generation NEVER throws.
 */

const MAX_CANDIDATES = 3;

// --- fenced bash extraction ---------------------------------------------------------

const FENCE_RE = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g;

export function parseFencedBash(text: string): string[] {
  const scripts: string[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const body = (m[1] ?? "").trim();
    if (body.length > 0) scripts.push(body);
  }
  return scripts;
}

// --- llm path -------------------------------------------------------------------------

function envSummary(ctx: { goal: string; tool?: string; os?: string; arch?: string; tools?: string[] }): string {
  return JSON.stringify({
    goal: ctx.goal,
    tool: ctx.tool ?? null,
    os: ctx.os ?? "unknown",
    arch: ctx.arch ?? "unknown",
    tools: (ctx.tools ?? []).slice(0, 40),
  });
}

export async function llmCandidates(
  ctx: {
    goal: string;
    tool?: string;
    os?: string;
    arch?: string;
    tools?: string[];
    corpusTitles?: string[];
  },
  opts: { inference: InferenceConfig; env?: Record<string, string | undefined>; fetchImpl?: ChatFetch }
): Promise<HowtoCandidate[]> {
  if (!isConfigured(opts.inference)) return [];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You draft short, safe, single-purpose bash scripts (POSIX, set -euo pipefail). " +
        "Reply with 2 or 3 candidate scripts, each in its own ```bash fenced block, " +
        "each preceded by a one-line title starting with 'Title:'. " +
        "Prefer tools listed in the environment. Never embed secrets.",
    },
    {
      role: "user",
      content:
        `Environment: ${envSummary(ctx)}\n` +
        `Corpus docs available: ${JSON.stringify((ctx.corpusTitles ?? []).slice(0, 30))}\n` +
        `Goal: ${ctx.goal}`,
    },
  ];
  const result = await chat(messages, {
    inference: opts.inference,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
  });
  if (!result.ok) return [];

  const candidates: HowtoCandidate[] = [];
  const lines = result.content.split("\n");
  const scripts = parseFencedBash(result.content);
  scripts.slice(0, MAX_CANDIDATES).forEach((script, i) => {
    // prefer the i-th "Title:" line the model emitted ahead of each block
    const titleLines = lines.filter((l) =>
      l.trim().toLowerCase().startsWith("title:")
    );
    const title = (titleLines[i] ?? "").replace(/^\s*title:\s*/i, "").trim();
    candidates.push({
      id: 0, // renumbered by the caller
      title: title !== "" ? title.slice(0, 120) : `LLM candidate ${i + 1}`,
      script,
      rationale: `drafted by ${opts.inference.model ?? "llm"}`,
      source: "llm",
    });
  });
  return candidates;
}

// --- corpus path ------------------------------------------------------------------------

interface CorpusLikeDoc {
  name: string;
  doc: Record<string, unknown>;
}

function scriptFromDoc(doc: Record<string, unknown>): { script: string; origin: string } | null {
  const usage = doc.usage as Record<string, unknown> | undefined;
  if (usage && Array.isArray(usage.examples) && usage.examples.length > 0) {
    const ex = usage.examples[0] as Record<string, unknown>;
    if (typeof ex.command === "string" && ex.command.trim() !== "") {
      return { script: `set -euo pipefail\n${ex.command.trim()}`, origin: "usage example" };
    }
  }
  const context = doc.context as Record<string, unknown> | undefined;
  if (context && Array.isArray(context.common_patterns) && context.common_patterns.length > 0) {
    const pattern = context.common_patterns[0] as Record<string, unknown>;
    if (Array.isArray(pattern.steps) && pattern.steps.length > 0) {
      const steps = pattern.steps.filter((s): s is string => typeof s === "string");
      if (steps.length > 0) {
        return { script: `set -euo pipefail\n${steps.join("\n")}`, origin: "common pattern" };
      }
    }
  }
  if (Array.isArray(doc.howtos) && doc.howtos.length > 0) {
    const entry = doc.howtos[doc.howtos.length - 1] as Record<string, unknown>;
    if (typeof entry.script === "string" && entry.script.trim() !== "") {
      return { script: entry.script.trim(), origin: "written-back how-to" };
    }
  }
  return null;
}

export function corpusCandidates(
  goal: string,
  docs: CorpusLikeDoc[],
  limit = MAX_CANDIDATES
): HowtoCandidate[] {
  const index = buildIndex(howtoDocsFromCorpus(new Map(docs.map((d) => [d.name, d as MergedDoc]))));
  const hits = search(index, goal, { limit: limit * 2 });
  const candidates: HowtoCandidate[] = [];
  for (const hit of hits) {
    const doc = docs.find((d) => d.name === hit.id || hit.id.startsWith(`${d.name}#`));
    if (!doc) continue;
    const built = scriptFromDoc(doc.doc);
    if (!built) continue;
    candidates.push({
      id: 0,
      title: `${doc.name}: ${goal}`.slice(0, 120),
      script: built.script,
      rationale: `adapted from corpus doc '${doc.name}' (${built.origin})`,
      source: "corpus",
      corpusDoc: doc.name,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

// --- template fallback ---------------------------------------------------------------------

export function templateCandidates(goal: string, tool?: string): HowtoCandidate[] {
  const safeGoal = goal.replace(/'/g, "'\\''").slice(0, 200);
  const first: HowtoCandidate = {
    id: 0,
    title: `Plan sketch: ${goal}`.slice(0, 120),
    script:
      `#!/usr/bin/env bash\nset -euo pipefail\n# goal: ${safeGoal}\n` +
      `# TODO(agent): replace this sketch with concrete steps, then re-run with --pick\necho "step 1: ${safeGoal}"`,
    rationale: "template sketch — no corpus match and no inference; edit before approving a run",
    source: "template",
  };
  const lookup = tool ?? "";
  const second: HowtoCandidate = {
    id: 0,
    title: `Docs lookup: ${lookup || goal}`.slice(0, 120),
    script:
      `#!/usr/bin/env bash\nset -euo pipefail\n` +
      (lookup
        ? `# inspect the tool before scripting against it\nman ${lookup} 2>/dev/null | head -n 40 || ${lookup} --help 2>&1 | head -n 40`
        : `# no tool focus given; dump nearby mallm docs\nmallm list 2>/dev/null | head -n 40 || true`),
    rationale: "template docs-lookup — safe read-only candidate",
    source: "template",
  };
  return [first, second];
}

// --- entry point -----------------------------------------------------------------------------

function renumber(candidates: HowtoCandidate[]): HowtoCandidate[] {
  return candidates
    .filter((c) => c.script.trim() !== "")
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({ ...c, id: i + 1 }));
}

export async function generateCandidates(
  ctx: {
    goal: string;
    tool?: string;
    os?: string;
    arch?: string;
    tools?: string[];
    docs: CorpusLikeDoc[];
  },
  opts: {
    inference: InferenceConfig;
    env?: Record<string, string | undefined>;
    fetchImpl?: ChatFetch;
  }
): Promise<HowtoCandidate[]> {
  const corpusTitles = ctx.docs.map((d) => d.name);
  let candidates: HowtoCandidate[] = [];
  try {
    candidates = await llmCandidates(
      { goal: ctx.goal, tool: ctx.tool, os: ctx.os, arch: ctx.arch, tools: ctx.tools, corpusTitles },
      opts
    );
  } catch {
    candidates = []; // belt and braces — llm/ already never throws
  }
  if (candidates.length < 2) {
    const corpus = corpusCandidates(ctx.goal, ctx.docs);
    for (const c of corpus) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (candidates.some((k) => k.script === c.script)) continue;
      candidates.push(c);
    }
  }
  if (candidates.length < 2) {
    for (const c of templateCandidates(ctx.goal, ctx.tool)) {
      if (candidates.length >= 2) break;
      if (candidates.some((k) => k.script === c.script)) continue;
      candidates.push(c);
    }
  }
  const numbered = renumber(candidates);
  return numbered.length > 0 ? numbered : renumber(templateCandidates(ctx.goal, ctx.tool));
}

// --- diagnose ----------------------------------------------------------------------------------

export async function llmDiagnose(
  script: string,
  lastRun: HowtoRunRecord,
  ctx: { goal: string; os?: string },
  opts: {
    inference: InferenceConfig;
    env?: Record<string, string | undefined>;
    fetchImpl?: ChatFetch;
  }
): Promise<DiagnoseResult> {
  if (!isConfigured(opts.inference)) {
    return { note: "no inference configured" };
  }
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You repair failing bash scripts. Reply with ONE corrected script in a single " +
        "```bash fenced block, or the single word SKIPPATCH when you cannot improve it.",
    },
    {
      role: "user",
      content:
        `Goal: ${ctx.goal}\nOS: ${ctx.os ?? "unknown"}\n` +
        `Script:\n\`\`\`bash\n${script}\n\`\`\`\n` +
        `Exit code: ${lastRun.exitCode ?? "n/a"}\n` +
        `stderr (tail, pre-redacted):\n${lastRun.stderr.split("\n").slice(-15).join("\n")}\n` +
        `stdout (tail, pre-redacted):\n${lastRun.stdout.split("\n").slice(-10).join("\n")}`,
    },
  ];
  const result = await chat(messages, { inference: opts.inference, env: opts.env, fetchImpl: opts.fetchImpl });
  if (!result.ok) return { note: `llm diagnose unavailable: ${result.reason}` };
  if (/\bskippatch\b/i.test(result.content.split("\n")[0] ?? "")) {
    return { note: "llm declined to patch" };
  }
  const patched = parseFencedBash(result.content)[0];
  if (!patched || patched === script) return { note: "llm produced no usable patch" };
  return { script: patched, note: "patched by llm" };
}

/** Fallback: rotate to the next untried candidate; stop when none remain. */
export function rotateCandidate(
  candidates: readonly HowtoCandidate[],
  triedScript: string
): DiagnoseResult {
  const current = candidates.find((c) => c.script === triedScript);
  const start = current ? current.id : 0;
  for (const c of candidates) {
    if (c.id > start && c.script !== triedScript) {
      return { script: c.script, note: `rotated to candidate ${c.id} ('${c.title}')` };
    }
  }
  return { note: "no alternative candidate left to try" };
}
