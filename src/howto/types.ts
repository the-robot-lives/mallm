import type { PlatformConfig } from "../config/types.js";
import type { EnvironmentProbe } from "../env/index.js";
import type { EnvLike } from "../env/index.js";
import type { MergedDoc, LoadCorpusResult } from "../corpus/index.js";
import type { MemoryTiers } from "../memory/index.js";
import type { SessionKV } from "../session/index.js";

/**
 * How-to pipeline state machine — shared types. The machine is RESUMABLE:
 * state lives in the session KV (`howto` bucket, key `run`) and every CLI
 * invocation reloads it from disk, advances as far as the granted approvals
 * allow, and persists again. Gates NEVER auto-approve — there is no `--yes`.
 */

export const HOWTO_STAGES = [
  "intake",
  "draft",
  "select",
  "gate-install",
  "gate-run",
  "observe",
  "diagnose",
  "success",
  "writeback",
  "closed",
  "stopped",
] as const;

export type HowtoStage = (typeof HOWTO_STAGES)[number];

export const MAX_RUN_ATTEMPTS = 3;

// --- intake ----------------------------------------------------------------------

export interface IntakeSnapshot {
  os: string;
  arch: string;
  shell: string;
  installerPreference: string | null;
  tools: string[];
  tiers: { universal: string[]; org: string | null; project: string; user: string };
  corpusDocs: string[];
  corpusOk: number;
  tool?: string;
  scannedAt: string;
}

// --- draft / select ----------------------------------------------------------------

export type CandidateSource = "llm" | "corpus" | "template";

export interface HowtoCandidate {
  /** 1-based, stable within a run */
  id: number;
  title: string;
  script: string;
  rationale: string;
  source: CandidateSource;
  corpusDoc?: string;
}

// --- install gate -------------------------------------------------------------------

export interface InstallPlanItem {
  tool: string;
  installer: string;
  args: string[];
}

export interface InstallResult {
  tool: string;
  installer: string;
  ok: boolean;
  output: string;
}

// --- run gate -----------------------------------------------------------------------

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface HowtoRunRecord {
  attempt: number;
  exitCode: number | null;
  /** REDACTED before it is ever persisted — no raw-output escape hatch */
  stdout: string;
  stderr: string;
  redactions: string[];
  startedAt: string;
  durationMs: number;
  timedOut: boolean;
}

// --- approvals ------------------------------------------------------------------------

export type ApprovalKind = "install" | "run";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  sessionToken: string;
  prompt: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalDecision {
  decision: "granted" | "denied";
  at: string;
  by: string;
  note?: string;
}

// --- diagnose -------------------------------------------------------------------------

export interface DiagnoseResult {
  /** absent = no patch available (machine stops) */
  script?: string;
  note: string;
}

// --- write-back (D4) --------------------------------------------------------------------

export interface HowtoSection {
  tool: string;
  goal: string;
  script: string;
  os: string[];
  sessionToken: string;
  createdAt: string;
  attempts: number;
}

export interface WritebackResult {
  ok: boolean;
  source: string;
  adapter: "dir" | "git";
  branch: string;
  commit?: string;
  file?: string;
  pullRequest?: { number: number; url: string };
  error?: string;
}

// --- run state ---------------------------------------------------------------------------

export type HowtoOutcome = "success" | "stopped";

export interface StageEvent {
  at: string;
  from: HowtoStage;
  to: HowtoStage;
  note?: string;
}

export interface HowtoRunState {
  version: 1;
  goal: string;
  tool?: string;
  stage: HowtoStage;
  /** next run attempt number (1-based); equals runs.length + 1 while looping */
  attempt: number;
  intake?: IntakeSnapshot;
  candidates: HowtoCandidate[];
  selectedId?: number;
  script?: string;
  scriptSource?: string;
  installPlan?: InstallPlanItem[];
  missingUninstallable?: string[];
  installResults?: InstallResult[];
  pendingApproval?: ApprovalRequest;
  runs: HowtoRunRecord[];
  outcome?: HowtoOutcome;
  outcomeDetail?: string;
  writeback?: WritebackResult;
  history: StageEvent[];
  startedAt: string;
  updatedAt: string;
}

// --- invocation input / result ---------------------------------------------------------

export interface HowtoInput {
  goal?: string;
  tool?: string;
  /** 1-based candidate number for SELECT */
  pick?: number;
  /** grant the current install gate for this invocation (recorded in the approvals bucket) */
  approveInstall?: boolean;
  /** grant the current run gate for this invocation (recorded in the approvals bucket) */
  approveRun?: boolean;
  /** stop after DRAFT/SELECT — no installs, no runs, ever */
  dryRun?: boolean;
}

export type HowtoStatus =
  | "advanced"
  | "awaiting-selection"
  | "awaiting-approval"
  | "dry-run-stop"
  | "stopped"
  | "closed";

export interface HowtoStepResult {
  status: HowtoStatus;
  stage: HowtoStage;
  sessionToken: string;
  message: string;
  state: HowtoRunState;
  approvalRequest?: ApprovalRequest;
}

// --- injectable dependencies ------------------------------------------------------------

export interface DraftContext {
  goal: string;
  tool?: string;
  os: string;
  arch: string;
  tools: string[];
  docs: MergedDoc[];
}

export interface HowtoDeps {
  env: EnvLike;
  config: PlatformConfig;
  cwd: string;
  kv: SessionKV;
  probe: (extraTools?: string[]) => Promise<EnvironmentProbe>;
  loadCorpus: () => Promise<LoadCorpusResult>;
  generateCandidates: (ctx: DraftContext) => Promise<HowtoCandidate[]>;
  /** absent = built-in default (LLM patch when configured, else candidate rotation) */
  diagnose?: (script: string, lastRun: HowtoRunRecord, ctx: DraftContext) => Promise<DiagnoseResult>;
  runScript: (script: string, attempt: number) => Promise<RunOutcome>;
  installTool: (item: InstallPlanItem) => Promise<InstallResult>;
  writeback: (section: HowtoSection) => Promise<WritebackResult>;
  tiers: () => MemoryTiers;
  knowledgePath?: string;
  now: () => Date;
}
