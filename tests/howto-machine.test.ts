import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentProbe } from "../src/env/index.js";
import type { MergedDoc } from "../src/corpus/index.js";
import { SessionKV } from "../src/session/index.js";
import { mintUniqueToken } from "../src/session/index.js";
import { readKnowledge } from "../src/memory/index.js";
import {
  advanceHowto,
  installApprovalId,
  loadHowtoState,
  runApprovalId,
} from "../src/howto/index.js";
import type {
  DiagnoseResult,
  HowtoCandidate,
  HowtoDeps,
  HowtoSection,
  InstallPlanItem,
  RunOutcome,
  WritebackResult,
} from "../src/howto/types.js";
import { fakeEnv, tempXdg } from "./helpers.js";

/**
 * How-to state machine tests — all IO injected, all files inside temp XDG
 * trees, every secret-looking value FAKE.
 */

const NOW = new Date("2026-10-21T12:00:00.000Z");

const DEFAULT_CANDIDATES: HowtoCandidate[] = [
  {
    id: 1,
    title: "curl the status endpoint",
    script: "set -euo pipefail\ncurl -fsSL https://status.example.com/health",
    rationale: "fake candidate 1",
    source: "corpus",
    corpusDoc: "demo",
  },
  {
    id: 2,
    title: "git status",
    script: "set -euo pipefail\ngit status --short",
    rationale: "fake candidate 2",
    source: "corpus",
    corpusDoc: "demo",
  },
  {
    id: 3,
    title: "echo hello",
    script: "echo hello",
    rationale: "fake candidate 3",
    source: "template",
  },
];

interface Spy {
  runs: { script: string; attempt: number }[];
  installs: InstallPlanItem[];
  candidateCalls: number;
  writebacks: HowtoSection[];
}

interface DepOpts {
  tools?: string[];
  installers?: string[];
  outcomes?: RunOutcome[];
  diagnose?: (script: string) => Promise<DiagnoseResult>;
  writeback?: Partial<WritebackResult>;
  candidates?: HowtoCandidate[];
}

function makeDeps(xdg: ReturnType<typeof tempXdg>, token: string, opts: DepOpts = {}): { deps: HowtoDeps; spy: Spy } {
  const sessionDir = join(xdg.data, "mallm", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const probe: EnvironmentProbe = {
    os: { flavor: "macos", version: "25.6.0" },
    arch: "arm64",
    shell: "/bin/zsh",
    host: "test-host",
    tools: (opts.tools ?? ["git", "curl", "bash"]).map((n) => ({ name: n, path: `/usr/bin/${n}` })),
    installers: opts.installers ?? ["brew"],
    scannedAt: NOW.toISOString(),
  };
  const demoDoc: MergedDoc = {
    name: "demo",
    doc: {
      mallm: "1.1",
      name: "demo",
      summary: "demo tool",
      usage: { synopsis: "demo [options]", examples: [{ command: "demo --run", description: "run the demo" }] },
    },
    sourceName: "local",
    sourceKind: "dir",
    priority: 10,
  };
  const spy: Spy = { runs: [], installs: [], candidateCalls: 0, writebacks: [] };
  const outcomes = opts.outcomes ?? [{ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, timedOut: false }];
  let outcomeIdx = 0;
  const deps: HowtoDeps = {
    env: fakeEnv(xdg),
    config: {
      version: "1.1",
      sources: [{ name: "local", kind: "dir", url: join(xdg.root, "source"), priority: 10 }],
      inference: {},
      redaction: { patterns: [] },
      sessionTtl: 86_400,
    },
    cwd: xdg.root,
    kv: SessionKV.open(token, { dir: sessionDir }),
    probe: async () => probe,
    loadCorpus: async () => ({ merged: new Map([["demo", demoDoc]]), results: [] }),
    generateCandidates: async () => {
      spy.candidateCalls += 1;
      return (opts.candidates ?? DEFAULT_CANDIDATES).map((c) => ({ ...c }));
    },
    ...(opts.diagnose ? { diagnose: async (script: string) => opts.diagnose!(script) } : {}),
    runScript: async (script, attempt) => {
      spy.runs.push({ script, attempt });
      const outcome = outcomes[Math.min(outcomeIdx, outcomes.length - 1)];
      outcomeIdx += 1;
      return { ...outcome };
    },
    installTool: async (item) => {
      spy.installs.push(item);
      return { tool: item.tool, installer: item.installer, ok: true, output: "installed" };
    },
    writeback: async (section) => {
      spy.writebacks.push(section);
      return {
        ok: true,
        source: "local",
        adapter: "dir",
        branch: `howto/${token}`,
        commit: "deadbeef",
        file: "/tmp/demo.yaml",
        ...(opts.writeback ?? {}),
      };
    },
    tiers: () => ({
      universal: [{ name: "local", kind: "dir", url: join(xdg.root, "source"), priority: 10 }],
      org: null,
      project: xdg.root,
      user: join(xdg.root, "config"),
    }),
    knowledgePath: join(xdg.root, "knowledge.yaml"),
    now: () => NOW,
  };
  return { deps, spy };
}

function reopen(xdg: ReturnType<typeof tempXdg>, token: string, opts: DepOpts = {}): { deps: HowtoDeps; spy: Spy } {
  return makeDeps(xdg, token, opts);
}

function grant(xdg: ReturnType<typeof tempXdg>, token: string, id: string, decision: "granted" | "denied" = "granted"): void {
  SessionKV.open(token, { dir: join(xdg.data, "mallm", "sessions") })
    .set("approvals", id, { decision, at: NOW.toISOString(), by: "test" })
    .save();
}

test("golden path: gates required, run approval via session KV, redacted write-back, knowledge upsert", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;

  const FAKE_SECRET = "FAKE-super-secret-token-0123456789abcd";
  const FAKE_BEARER = "FAKEbearertoken1234567890";
  const outcomes: RunOutcome[] = [
    { exitCode: 0, stdout: `TOKEN=${FAKE_SECRET}\nBearer ${FAKE_BEARER}\nok`, stderr: "", durationMs: 5, timedOut: false },
  ];

  // 1. start: draft + pick in one call, no approvals yet → machine must STOP at the run gate
  const first = reopen(xdg, token, { outcomes });
  const r1 = await advanceHowto(first.deps, { goal: "check the demo endpoint", tool: "demo", pick: 1 });
  assert.equal(r1.status, "awaiting-approval");
  assert.equal(r1.approvalRequest?.kind, "run");
  assert.equal(r1.approvalRequest?.id, runApprovalId(1));
  assert.equal(first.spy.runs.length, 0, "no run without approval");

  // approval request is visible in the session KV (the `mallm session <token>` round trip)
  const kvView = SessionKV.open(token, { dir: join(xdg.data, "mallm", "sessions") });
  assert.ok(kvView.get("approvals", `request:${runApprovalId(1)}`), "request mirrored into the approvals bucket");

  // 2. a second call with still no decision changes nothing
  const second = reopen(xdg, token, { outcomes });
  const r2 = await advanceHowto(second.deps, {});
  assert.equal(r2.status, "awaiting-approval");
  assert.equal(second.spy.runs.length, 0, "still no run without approval");

  // 3. grant via the approvals bucket, then a fresh process runs to completion
  grant(xdg, token, runApprovalId(1));
  const third = reopen(xdg, token, { outcomes });
  const r3 = await advanceHowto(third.deps, {});
  assert.equal(r3.status, "closed");
  assert.equal(r3.state.outcome, "success");
  assert.equal(third.spy.runs.length, 1);
  assert.equal(third.spy.writebacks.length, 1);
  assert.equal(third.spy.writebacks[0].tool, "demo");

  // GATE_RUN capture redacted pre-write: state AND the on-disk session file
  const run = r3.state.runs[0];
  assert.ok(run.stdout.includes("[REDACTED:"), "run record redacted");
  assert.ok(!run.stdout.includes(FAKE_SECRET), "fake secret never persisted");
  assert.ok(!run.stdout.includes(FAKE_BEARER), "fake bearer never persisted");
  const sessionFile = readFileSync(join(xdg.data, "mallm", "sessions", `${token}.json`), "utf-8");
  assert.ok(!sessionFile.includes(FAKE_SECRET), "session file clean");
  assert.ok(!sessionFile.includes(FAKE_BEARER), "session file clean");

  // knowledge topic created on close
  const topics = readKnowledge(join(xdg.root, "knowledge.yaml")).topics;
  assert.ok(topics.some((tp) => tp.id === "demo" && tp.confidence >= 5));

  // resumability of terminal state: another call is a no-op
  const fourth = reopen(xdg, token, { outcomes });
  const r4 = await advanceHowto(fourth.deps, {});
  assert.equal(r4.status, "closed");
  assert.equal(fourth.spy.runs.length, 0);
});

test("gate refusal: --approve-run flag is the only in-call grant and is recorded", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;

  const a = reopen(xdg, token);
  const r1 = await advanceHowto(a.deps, { goal: "demo run", pick: 2 });
  assert.equal(r1.status, "awaiting-approval");
  assert.equal(a.spy.runs.length, 0);

  // flag grant runs immediately and leaves an audit entry in the approvals bucket
  const b = reopen(xdg, token);
  const r2 = await advanceHowto(b.deps, { approveRun: true });
  assert.equal(r2.status, "closed");
  assert.equal(b.spy.runs.length, 1);
  const kv = SessionKV.open(token, { dir: join(xdg.data, "mallm", "sessions") });
  const decision = kv.get("approvals", runApprovalId(1)) as { decision: string; by: string };
  assert.equal(decision.decision, "granted");
  assert.equal(decision.by, "--approve-run");
});

test("run cap: 3 failed loops stop the machine; each attempt needs its own approval", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;
  const fail = (n: number): RunOutcome => ({
    exitCode: 1,
    stdout: "",
    stderr: `boom attempt ${n}`,
    durationMs: 3,
    timedOut: false,
  });
  let patchCount = 0;
  const opts: DepOpts = {
    outcomes: [fail(1), fail(2), fail(3)],
    diagnose: async (script: string) => {
      patchCount += 1;
      return { script: `${script}\n# patched ${patchCount}`, note: `patch ${patchCount}` };
    },
  };

  // request → grant → run(1) fails → request run:2 → grant → run(2) fails →
  // request run:3 → grant → run(3) fails → STOPPED (no fourth request)
  const seq: Array<{
    input: Record<string, unknown>;
    grantFirst: string | null;
    expect: string;
    expectRunId?: string;
  }> = [
    { input: { goal: "flaky goal", pick: 1 }, grantFirst: null, expect: "awaiting-approval", expectRunId: runApprovalId(1) },
    { input: {}, grantFirst: runApprovalId(1), expect: "awaiting-approval", expectRunId: runApprovalId(2) },
    { input: {}, grantFirst: runApprovalId(2), expect: "awaiting-approval", expectRunId: runApprovalId(3) },
    { input: {}, grantFirst: runApprovalId(3), expect: "stopped" },
  ];
  let total = 0;
  for (const [i, step] of seq.entries()) {
    if (step.grantFirst) grant(xdg, token, step.grantFirst);
    const a = reopen(xdg, token, opts);
    const r = await advanceHowto(a.deps, step.input);
    total += a.spy.runs.length;
    assert.equal(r.status, step.expect, `seq step ${i + 1}`);
    if (step.expectRunId) assert.equal(r.approvalRequest?.id, step.expectRunId, `seq step ${i + 1} request id`);
  }
  assert.equal(total, 3, "exactly 3 runs");
  assert.equal(patchCount, 2, "diagnose patched twice (3rd failure hits the cap)");

  // further calls stay stopped
  const after = reopen(xdg, token, opts);
  const rAfter = await advanceHowto(after.deps, {});
  assert.equal(rAfter.status, "stopped");
  assert.equal(rAfter.state.outcomeDetail, "run cap exhausted after 3 attempts (max 3)");
  assert.equal(rAfter.approvalRequest, undefined, "no fourth approval request");
  assert.equal(after.spy.runs.length, 0);
});

test("resumability: state survives between invocations; DRAFT is not re-run after SELECT", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;

  // call 1: no pick → machine stops at SELECT
  const a = reopen(xdg, token);
  const r1 = await advanceHowto(a.deps, { goal: "pick later" });
  assert.equal(r1.status, "awaiting-selection");
  assert.equal(r1.state.candidates.length, 3);
  assert.equal(a.spy.candidateCalls, 1);

  // "kill": brand-new deps, state reloaded purely from disk
  const b = reopen(xdg, token);
  const r2 = await advanceHowto(b.deps, { pick: 2 });
  assert.equal(r2.status, "awaiting-approval");
  assert.equal(b.spy.candidateCalls, 0, "draft not re-run");
  assert.equal(b.spy.runs.length, 0);
  assert.equal(loadHowtoState(SessionKV.open(token, { dir: join(xdg.data, "mallm", "sessions") }))?.selectedId, 2);

  grant(xdg, token, runApprovalId(1));
  const c = reopen(xdg, token);
  const r3 = await advanceHowto(c.deps, {});
  assert.equal(r3.status, "closed");
  assert.equal(c.spy.runs[0]?.script, DEFAULT_CANDIDATES[1].script, "ran candidate 2");
});

test("dry-run stops after DRAFT/SELECT and never touches install or run gates", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;

  const a = reopen(xdg, token);
  const r1 = await advanceHowto(a.deps, { goal: "inspect only", pick: 1, dryRun: true });
  assert.equal(r1.status, "dry-run-stop");
  assert.equal(r1.state.stage, "gate-install");
  assert.equal(a.spy.runs.length, 0);
  assert.equal(a.spy.installs.length, 0);

  // a no-pick dry-run stops at selection (separate session)
  const tokenB = mintUniqueToken(() => false).token;
  const b = reopen(xdg, tokenB);
  const rB = await advanceHowto(b.deps, { goal: "inspect only 2", dryRun: true });
  assert.equal(rB.status, "dry-run-stop");
  assert.equal(rB.state.stage, "select");

  // resuming WITHOUT --dry-run proceeds to the run gate normally
  const c = reopen(xdg, token);
  const r2 = await advanceHowto(c.deps, {});
  assert.equal(r2.status, "awaiting-approval");
});

test("install gate: missing tool requires approval, installs run after grant, denial stops", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;
  const candidates: HowtoCandidate[] = [
    {
      id: 1,
      title: "jq parse",
      script: "set -euo pipefail\ncurl -fsSL https://x.example/p -o /tmp/p.json\njq .field /tmp/p.json",
      rationale: "needs jq",
      source: "corpus",
    },
    { id: 2, title: "fallback", script: "echo hi", rationale: "no jq", source: "template" },
    { id: 3, title: "fallback 2", script: "echo hi2", rationale: "no jq", source: "template" },
  ];
  const opts: DepOpts = { tools: ["git", "curl", "bash"], candidates };

  const a = reopen(xdg, token, opts);
  const r1 = await advanceHowto(a.deps, { goal: "parse payload", pick: 1 });
  assert.equal(r1.status, "awaiting-approval");
  assert.equal(r1.approvalRequest?.kind, "install");
  const planId = installApprovalId([{ tool: "jq", installer: "brew", args: ["install", "jq"] }]);
  assert.equal(r1.approvalRequest?.id, planId);
  assert.equal(a.spy.installs.length, 0);
  assert.equal(a.spy.runs.length, 0);

  // grant install → installs run, then the run gate (a DIFFERENT approval) blocks
  grant(xdg, token, planId);
  const b = reopen(xdg, token, opts);
  const r2 = await advanceHowto(b.deps, {});
  assert.equal(b.spy.installs.length, 1);
  assert.equal(b.spy.installs[0].tool, "jq");
  assert.equal(r2.status, "awaiting-approval");
  assert.equal(r2.approvalRequest?.kind, "run");
  const installed = SessionKV.open(token, { dir: join(xdg.data, "mallm", "sessions") }).items("installed");
  assert.equal(installed.length, 1);

  // denial path (fresh token): deny the install gate → stopped
  const token2 = mintUniqueToken(() => false).token;
  const c = reopen(xdg, token2, opts);
  const rC = await advanceHowto(c.deps, { goal: "parse payload", pick: 1 });
  grant(xdg, token2, rC.approvalRequest?.id ?? "", "denied");
  const d = reopen(xdg, token2, opts);
  const rD = await advanceHowto(d.deps, {});
  assert.equal(rD.status, "stopped");
  assert.ok(rD.state.outcomeDetail?.includes("install gate denied"));
  assert.equal(d.spy.installs.length, 0);
});

test("no-goal start without state is an explicit error", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;
  const { deps } = makeDeps(xdg, token);
  await assert.rejects(advanceHowto(deps, {}), /needs a goal/);
});

test("a fresh session file exists after the first advance", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const token = mintUniqueToken(() => false).token;
  const { deps } = makeDeps(xdg, token);
  await advanceHowto(deps, { goal: "anything" });
  assert.ok(existsSync(join(xdg.data, "mallm", "sessions", `${token}.json`)));
});
