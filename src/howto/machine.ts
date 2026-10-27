// 〚📁:8655c684-30b8-5143-8f20-9aa15ebfa254〛 mallm how-to state machine :: Resumable, approval-gated how-to pipeline

import { sha256Hex } from "../corpus/index.js";
import type { EnvironmentProbe } from "../env/index.js";
import type { MergedDoc } from "../corpus/index.js";
import { appendHistory } from "../changelog/index.js";
import { redact } from "../changelog/redactor.js";
import type { SessionKV } from "../session/index.js";
import { upsertTopic } from "../memory/index.js";
import { missingTools, planInstalls, scriptCommands } from "./script.js";
import { llmDiagnose, rotateCandidate, templateCandidates } from "./drafts.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  DraftContext,
  HowtoCandidate,
  HowtoDeps,
  HowtoInput,
  HowtoRunRecord,
  HowtoRunState,
  HowtoStage,
  HowtoStepResult,
  InstallPlanItem,
  InstallResult,
  WritebackResult,
} from "./types.js";
import { HOWTO_STAGES, MAX_RUN_ATTEMPTS } from "./types.js";

/**
 * The how-to state machine. One CLI invocation = one `advanceHowto` call:
 * reload state from the session KV, run stages until an approval/selection is
 * missing or a terminal stage is reached, persist, report. Gates NEVER
 * auto-approve — decisions arrive via the approvals bucket (`mallm session
 * approve <token> <id>`) or the narrow `--approve-install`/`--approve-run`
 * flags for THIS invocation. There is no `--yes`.
 */

const STATE_BUCKET = "howto" as const;
const STATE_KEY = "run";
const HISTORY_LIMIT = 100;

// --- persistence ---------------------------------------------------------------------

export function loadHowtoState(kv: SessionKV): HowtoRunState | null {
  const raw = kv.get(STATE_BUCKET, STATE_KEY);
  return sanitizeState(raw);
}

export function saveHowtoState(kv: SessionKV, state: HowtoRunState): void {
  kv.set(STATE_BUCKET, STATE_KEY, state);
  kv.save();
}

export function newState(
  goal: string,
  tool: string | undefined,
  nowIso: string
): HowtoRunState {
  return {
    version: 1,
    goal,
    tool,
    stage: "intake",
    attempt: 1,
    candidates: [],
    runs: [],
    history: [],
    startedAt: nowIso,
    updatedAt: nowIso,
  };
}

function isStage(v: unknown): v is HowtoStage {
  return typeof v === "string" && (HOWTO_STAGES as readonly string[]).includes(v);
}

/** Defensive reload: malformed state becomes null (fresh run), never a throw. */
function sanitizeState(raw: unknown): HowtoRunState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.goal !== "string" || r.goal.trim() === "") return null;
  if (!isStage(r.stage)) return null;
  return {
    version: 1,
    goal: r.goal,
    tool: typeof r.tool === "string" ? r.tool : undefined,
    stage: r.stage,
    attempt: typeof r.attempt === "number" && r.attempt >= 1 ? Math.floor(r.attempt) : 1,
    intake:
      typeof r.intake === "object" && r.intake !== null
        ? (r.intake as HowtoRunState["intake"])
        : undefined,
    candidates: Array.isArray(r.candidates) ? (r.candidates as HowtoRunState["candidates"]) : [],
    selectedId: typeof r.selectedId === "number" ? r.selectedId : undefined,
    script: typeof r.script === "string" ? r.script : undefined,
    scriptSource: typeof r.scriptSource === "string" ? r.scriptSource : undefined,
    installPlan: Array.isArray(r.installPlan)
      ? (r.installPlan as HowtoRunState["installPlan"])
      : typeof r.installPlan === "object" && r.installPlan !== null
        ? (r.installPlan as HowtoRunState["installPlan"])
        : undefined,
    missingUninstallable: Array.isArray(r.missingUninstallable)
      ? (r.missingUninstallable as string[])
      : undefined,
    installResults: Array.isArray(r.installResults)
      ? (r.installResults as HowtoRunState["installResults"])
      : undefined,
    pendingApproval:
      typeof r.pendingApproval === "object" && r.pendingApproval !== null
        ? (r.pendingApproval as HowtoRunState["pendingApproval"])
        : undefined,
    runs: Array.isArray(r.runs) ? (r.runs as HowtoRunState["runs"]) : [],
    outcome: r.outcome === "success" || r.outcome === "stopped" ? r.outcome : undefined,
    outcomeDetail: typeof r.outcomeDetail === "string" ? r.outcomeDetail : undefined,
    writeback:
      typeof r.writeback === "object" && r.writeback !== null
        ? (r.writeback as HowtoRunState["writeback"])
        : undefined,
    history: Array.isArray(r.history) ? (r.history as HowtoRunState["history"]) : [],
    startedAt: typeof r.startedAt === "string" ? r.startedAt : new Date().toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
  };
}

// --- approvals -------------------------------------------------------------------------

export function runApprovalId(attempt: number): string {
  return `howto-run:${attempt}`;
}

export function installApprovalId(plan: readonly InstallPlanItem[]): string {
  const tools = plan.map((p) => p.tool).sort().join(",");
  return `howto-install:${sha256Hex(tools).slice(0, 8)}`;
}

function decisionOf(kv: SessionKV, id: string): ApprovalDecision | null {
  const raw = kv.get("approvals", id);
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.decision !== "granted" && r.decision !== "denied") return null;
  return {
    decision: r.decision,
    at: typeof r.at === "string" ? r.at : new Date().toISOString(),
    by: typeof r.by === "string" ? r.by : "unknown",
    note: typeof r.note === "string" ? r.note : undefined,
  };
}

function recordDecision(
  kv: SessionKV,
  id: string,
  decision: "granted" | "denied",
  by: string,
  nowIso: string,
  note?: string
): ApprovalDecision {
  const entry: ApprovalDecision = { decision, at: nowIso, by, ...(note ? { note } : {}) };
  kv.set("approvals", id, entry);
  return entry;
}

function requestApproval(
  deps: HowtoDeps,
  state: HowtoRunState,
  req: ApprovalRequest
): void {
  state.pendingApproval = req;
  deps.kv.set("approvals", `request:${req.id}`, req);
  try {
    appendHistory(
      {
        session: deps.kv.token,
        action: "how-to.await-approval",
        command: `${state.goal} [${req.kind} gate ${req.id}]`,
        files: [],
        outcome: req.prompt,
      },
      { env: deps.env, extraPatterns: deps.config.redaction.patterns }
    );
  } catch {
    // history must never break the machine
  }
}

// --- small helpers -----------------------------------------------------------------------

function to(
  state: HowtoRunState,
  stage: HowtoStage,
  note: string | undefined,
  nowIso: string
): void {
  state.history.push({
    at: nowIso,
    from: state.stage,
    to: stage,
    ...(note ? { note } : {}),
  });
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  state.stage = stage;
  state.pendingApproval = undefined;
}

function stopRun(state: HowtoRunState, detail: string, nowIso: string): void {
  state.outcome = "stopped";
  state.outcomeDetail = detail;
  to(state, "stopped", detail, nowIso);
}

function logTerminal(deps: HowtoDeps, state: HowtoRunState, outcome: string): void {
  try {
    appendHistory(
      {
        session: deps.kv.token,
        action: "how-to.close",
        command: state.goal,
        files: state.writeback?.file ? [state.writeback.file] : [],
        outcome,
      },
      { env: deps.env, extraPatterns: deps.config.redaction.patterns }
    );
  } catch {
    // never break the machine on history errors
  }
}

function errText(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e)).text;
}

async function safeProbe(
  deps: HowtoDeps,
  state: HowtoRunState
): Promise<EnvironmentProbe> {
  try {
    return await deps.probe(state.tool ? [state.tool] : undefined);
  } catch {
    return {
      os: { flavor: "linux", version: "unknown" },
      arch: "unknown",
      shell: "/bin/sh",
      host: "unknown",
      tools: [],
      installers: [],
      scannedAt: new Date().toISOString(),
    };
  }
}

async function safeLoadCorpus(deps: HowtoDeps): Promise<MergedDoc[]> {
  try {
    const result = await deps.loadCorpus();
    return [...result.merged.values()];
  } catch {
    return [];
  }
}

function draftContext(
  state: HowtoRunState,
  docs: MergedDoc[]
): DraftContext {
  return {
    goal: state.goal,
    tool: state.tool,
    os: state.intake?.os ?? "unknown",
    arch: state.intake?.arch ?? "unknown",
    tools: state.intake?.tools ?? [],
    docs,
  };
}

function deriveTool(state: HowtoRunState): string {
  if (state.tool) return state.tool;
  const first = state.script ? scriptCommands(state.script)[0] : undefined;
  if (first) return first;
  return state.goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "howto";
}

// --- stage handlers --------------------------------------------------------------------------

async function handleIntake(
  deps: HowtoDeps,
  state: HowtoRunState,
  local: { probe?: EnvironmentProbe; docs?: MergedDoc[] },
  nowIso: string
): Promise<void> {
  const probe = local.probe ?? (local.probe = await safeProbe(deps, state));
  let corpusOk = 0;
  let docs: MergedDoc[] = [];
  try {
    const result = await deps.loadCorpus();
    corpusOk = result.results.filter((r) => r.ok).length;
    docs = [...result.merged.values()];
    local.docs = docs;
  } catch {
    docs = local.docs ?? [];
  }
  const tiers = (() => {
    try {
      return deps.tiers();
    } catch {
      return null;
    }
  })();
  state.intake = {
    os: `${probe.os.flavor} ${probe.os.version}`,
    arch: probe.arch,
    shell: probe.shell,
    installerPreference: probe.installers[0] ?? null,
    tools: probe.tools.map((t) => t.name),
    tiers: tiers
      ? {
          universal: tiers.universal.map((s) => s.name),
          org: tiers.org?.name ?? null,
          project: tiers.project,
          user: tiers.user,
        }
      : { universal: [], org: null, project: "", user: "" },
    corpusDocs: docs.map((d) => d.name),
    corpusOk,
    tool: state.tool,
    scannedAt: nowIso,
  };
  deps.kv.set("env", "probe", {
    os: state.intake.os,
    arch: probe.arch,
    shell: probe.shell,
    tools: probe.tools.map((t) => t.name),
    installers: probe.installers,
  });
}

async function handleDraft(
  deps: HowtoDeps,
  state: HowtoRunState,
  local: { probe?: EnvironmentProbe; docs?: MergedDoc[] }
): Promise<void> {
  const docs = local.docs ?? (local.docs = await safeLoadCorpus(deps));
  let candidates: HowtoCandidate[] = [];
  try {
    candidates = await deps.generateCandidates(draftContext(state, docs));
  } catch {
    candidates = []; // every path degrades — never throws
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    candidates = templateCandidates(state.goal, state.tool);
  }
  state.candidates = candidates
    .filter((c) => typeof c.script === "string" && c.script.trim() !== "")
    .slice(0, 3)
    .map((c, i) => ({ ...c, id: i + 1 }));
}

async function defaultDiagnose(
  deps: HowtoDeps,
  state: HowtoRunState,
  lastRun: HowtoRunRecord,
  ctx: DraftContext
) {
  const llm = await llmDiagnose(
    state.script ?? "",
    lastRun,
    { goal: state.goal, os: ctx.os },
    { inference: deps.config.inference, env: deps.env }
  );
  if (llm.script) return llm;
  return rotateCandidate(state.candidates, state.script ?? "");
}

// --- the machine ---------------------------------------------------------------------------------

export async function advanceHowto(
  deps: HowtoDeps,
  input: HowtoInput
): Promise<HowtoStepResult> {
  const kv = deps.kv;
  const nowIso = () => deps.now().toISOString();
  const extra = deps.config.redaction.patterns;

  let state = loadHowtoState(kv);
  if (state && input.goal !== undefined && input.goal !== state.goal) {
    state = newState(input.goal, input.tool ?? state.tool, nowIso());
    state.history.push({ at: nowIso(), from: "stopped", to: "intake", note: "restart with a new goal" });
  }
  if (!state) {
    if (input.goal === undefined || input.goal.trim() === "") {
      throw new Error("how-to needs a goal to start (or --session <token> to resume)");
    }
    state = newState(input.goal, input.tool, nowIso());
  }
  if (input.tool && !state.tool) state.tool = input.tool;

  const local: { probe?: EnvironmentProbe; docs?: MergedDoc[] } = {};

  const finish = (status: HowtoStepResult["status"], message: string): HowtoStepResult => {
    state.updatedAt = nowIso();
    saveHowtoState(kv, state);
    return {
      status,
      stage: state.stage,
      sessionToken: kv.token,
      message,
      state,
      ...(state.pendingApproval ? { approvalRequest: state.pendingApproval } : {}),
    };
  };

  let guard = 0;
  while (guard++ < 64) {
    switch (state.stage) {
      case "intake": {
        await handleIntake(deps, state, local, nowIso());
        to(state, "draft", "intake complete", nowIso());
        continue;
      }

      case "draft": {
        await handleDraft(deps, state, local);
        to(state, "select", `${state.candidates.length} candidates drafted`, nowIso());
        continue;
      }

      case "select": {
        const pick = input.pick;
        if (
          typeof pick === "number" && Number.isInteger(pick) &&
          pick >= 1 && pick <= state.candidates.length
        ) {
          const c = state.candidates[pick - 1];
          state.selectedId = c.id;
          state.script = c.script;
          state.scriptSource = `candidate:${c.id}`;
          deps.kv.set("decisions", "howtoCandidate", {
            pick,
            title: c.title,
            source: c.source,
            at: nowIso(),
          });
          to(state, "gate-install", `picked candidate ${pick} (${c.source})`, nowIso());
          continue;
        }
        if (state.selectedId !== undefined && state.script !== undefined) {
          to(state, "gate-install", "resumed: selection already made", nowIso());
          continue;
        }
        if (input.dryRun) {
          return finish(
            "dry-run-stop",
            `dry-run: ${state.candidates.length} candidates ready — rerun with --pick N (dry-run never installs or runs)`
          );
        }
        return finish(
          "awaiting-selection",
          `candidates ready — pick one with: mallm how-to --session ${kv.token} --pick N`
        );
      }

      case "gate-install": {
        if (input.dryRun) {
          return finish("dry-run-stop", "dry-run: stopped before the install gate");
        }
        if (state.installPlan === undefined) {
          const probe = local.probe ?? (local.probe = await safeProbe(deps, state));
          const missing = state.script ? missingTools(state.script, probe) : [];
          const { plan, uninstallable } = planInstalls(missing, probe);
          state.installPlan = plan;
          state.missingUninstallable = uninstallable;
        }
        if (state.installPlan.length === 0) {
          to(state, "gate-run", "no missing tools — install gate skipped", nowIso());
          continue;
        }
        const id = installApprovalId(state.installPlan);
        let decision = decisionOf(kv, id);
        if (decision === null && input.approveInstall) {
          decision = recordDecision(kv, id, "granted", "--approve-install", nowIso());
        }
        if (decision?.decision === "denied") {
          stopRun(state, `install gate denied (${id})`, nowIso());
          logTerminal(deps, state, `install denied for ${state.goal}`);
          return finish("stopped", `stopped — install approval was denied (${id})`);
        }
        if (decision?.decision !== "granted") {
          const req: ApprovalRequest = {
            id,
            kind: "install",
            sessionToken: kv.token,
            prompt:
              `Approve installing missing tools for how-to "${state.goal}": ` +
              state.installPlan.map((p) => `${p.installer} ${p.args.join(" ")}`).join("; "),
            payload: {
              tools: state.installPlan.map((p) => ({ tool: p.tool, installer: p.installer, args: p.args })),
            },
            createdAt: nowIso(),
          };
          requestApproval(deps, state, req);
          return finish(
            "awaiting-approval",
            `install gate: approve with 'mallm session approve ${kv.token} ${id}' (or rerun with --approve-install), then resume`
          );
        }
        const results: InstallResult[] = [];
        for (const item of state.installPlan) {
          results.push(
            await (async () => {
              try {
                return await deps.installTool(item);
              } catch (e) {
                return { tool: item.tool, installer: item.installer, ok: false, output: errText(e) };
              }
            })()
          );
        }
        state.installResults = results;
        for (const r of results) {
          if (r.ok) deps.kv.push("installed", { tool: r.tool, installer: r.installer, at: nowIso() });
        }
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          stopRun(state, `install failed: ${failed.map((f) => f.tool).join(", ")}`, nowIso());
          logTerminal(deps, state, `install failed for ${state.goal}`);
          return finish("stopped", `stopped — installing failed: ${failed.map((f) => f.tool).join(", ")}`);
        }
        to(state, "gate-run", `installed ${results.map((r) => r.tool).join(", ")}`, nowIso());
        continue;
      }

      case "gate-run": {
        const id = runApprovalId(state.attempt);
        let decision = decisionOf(kv, id);
        if (decision === null && input.approveRun) {
          decision = recordDecision(kv, id, "granted", "--approve-run", nowIso());
        }
        if (decision?.decision === "denied") {
          stopRun(state, `run gate denied (${id})`, nowIso());
          logTerminal(deps, state, `run denied for ${state.goal}`);
          return finish("stopped", `stopped — run approval was denied (${id})`);
        }
        if (decision?.decision !== "granted") {
          const scriptRedacted = redact(state.script ?? "", extra);
          const req: ApprovalRequest = {
            id,
            kind: "run",
            sessionToken: kv.token,
            prompt:
              `Approve RUN attempt ${state.attempt}/${MAX_RUN_ATTEMPTS} of the selected script for "${state.goal}"` +
              (state.missingUninstallable && state.missingUninstallable.length > 0
                ? ` (warning: ${state.missingUninstallable.join(", ")} missing and not auto-installable)`
                : ""),
            payload: {
              attempt: state.attempt,
              script: scriptRedacted.text,
            },
            createdAt: nowIso(),
          };
          requestApproval(deps, state, req);
          return finish(
            "awaiting-approval",
            `run gate (attempt ${state.attempt}): approve with 'mallm session approve ${kv.token} ${id}' (or rerun with --approve-run), then resume`
          );
        }
        const outcome = await (async () => {
          try {
            return await deps.runScript(state.script ?? "", state.attempt);
          } catch (e) {
            return {
              exitCode: null,
              stdout: "",
              stderr: errText(e),
              durationMs: 0,
              timedOut: false,
            };
          }
        })();
        // STRICTLY pre-write redaction — raw output never reaches state or KV
        const stdout = redact(outcome.stdout, extra);
        const stderr = redact(outcome.stderr, extra);
        const record: HowtoRunRecord = {
          attempt: state.attempt,
          exitCode: outcome.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          redactions: [...new Set([...stdout.applied, ...stderr.applied])],
          startedAt: nowIso(),
          durationMs: outcome.durationMs,
          timedOut: outcome.timedOut,
        };
        state.runs.push(record);
        to(
          state,
          "observe",
          `run attempt ${state.attempt} → exit ${outcome.exitCode ?? "n/a"}`,
          nowIso()
        );
        continue;
      }

      case "observe": {
        const last = state.runs[state.runs.length - 1];
        if (last && last.exitCode === 0) {
          state.outcome = "success";
          to(state, "success", "script exited 0", nowIso());
          continue;
        }
        if (state.attempt >= MAX_RUN_ATTEMPTS) {
          stopRun(
            state,
            `run cap exhausted after ${state.attempt} attempts (max ${MAX_RUN_ATTEMPTS})`,
            nowIso()
          );
          logTerminal(deps, state, `run cap exhausted for ${state.goal}`);
          return finish(
            "stopped",
            `stopped — ${MAX_RUN_ATTEMPTS} run attempts exhausted; last redacted output is in the session KV`
          );
        }
        to(state, "diagnose", `attempt ${state.attempt} failed`, nowIso());
        continue;
      }

      case "diagnose": {
        const last = state.runs[state.runs.length - 1];
        if (!last || state.script === undefined) {
          stopRun(state, "diagnose ran without a script or run record", nowIso());
          return finish("stopped", "stopped — nothing to diagnose");
        }
        const docs = local.docs ?? (local.docs = await safeLoadCorpus(deps));
        const ctx = draftContext(state, docs);
        const result = deps.diagnose
          ? await deps.diagnose(state.script, last, ctx)
          : await defaultDiagnose(deps, state, last, ctx);
        if (result.script && result.script.trim() !== "" && result.script !== state.script) {
          state.script = result.script;
          state.scriptSource = `patch:${result.note}`.slice(0, 120);
          state.attempt += 1;
          to(state, "gate-run", result.note, nowIso());
          continue;
        }
        stopRun(state, `diagnosis exhausted: ${result.note}`, nowIso());
        logTerminal(deps, state, `unpatchable failure for ${state.goal}`);
        return finish("stopped", `stopped — no working script found: ${result.note}`);
      }

      case "success": {
        to(state, "writeback", undefined, nowIso());
        continue;
      }

      case "writeback": {
        const tool = deriveTool(state);
        const section = {
          tool,
          goal: state.goal,
          script: state.script ?? "",
          os: state.intake ? [state.intake.os.split(" ")[0]] : [],
          sessionToken: kv.token,
          createdAt: nowIso(),
          attempts: state.runs.length,
        };
        let wb: WritebackResult;
        try {
          wb = await deps.writeback(section);
        } catch (e) {
          wb = {
            ok: false,
            source: "(unknown)",
            adapter: "dir",
            branch: `howto/${kv.token}`,
            error: errText(e),
          };
        }
        state.writeback = wb;
        if (deps.knowledgePath) {
          try {
            upsertTopic(deps.knowledgePath, {
              id: tool,
              name: tool,
              confidence: wb.ok ? Math.min(10, 5 + Math.max(0, 3 - state.runs.length)) : 2,
              sources: wb.ok ? [wb.source] : [],
            });
          } catch {
            // knowledge write is best-effort
          }
        }
        state.outcome = "success";
        to(
          state,
          "closed",
          wb.ok ? `write-back ok (${wb.adapter})` : `write-back failed: ${wb.error ?? "unknown"}`,
          nowIso()
        );
        logTerminal(deps, state, `success after ${state.runs.length} attempt(s); write-back ${wb.ok ? "ok" : "failed"}`);
        return finish(
          "closed",
          wb.ok
            ? `closed — how-to validated and written back (${wb.adapter}${
                wb.pullRequest ? `, PR ${wb.pullRequest.number}` : ""
              })`
            : `closed — how-to validated but write-back FAILED: ${wb.error ?? "unknown"}`
        );
      }

      case "closed": {
        return finish(
          "closed",
          `run already closed (${state.outcome ?? "success"}${state.outcomeDetail ? `: ${state.outcomeDetail}` : ""})`
        );
      }

      case "stopped": {
        return finish("stopped", `run stopped: ${state.outcomeDetail ?? "unknown reason"}`);
      }
    }
  }
  stopRun(state, "internal stage-loop guard tripped", nowIso());
  return finish("stopped", "stopped — internal stage-loop guard tripped");
}
