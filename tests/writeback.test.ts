import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MallmSource } from "../src/config/types.js";
import {
  DEFAULT_GH_BIN,
  findDocFile,
  renderSectionEntry,
  writebackHowto,
} from "../src/howto/writeback.js";
import type { RunCommand } from "../src/howto/writeback.js";
import type { HowtoSection } from "../src/howto/types.js";

/**
 * Write-back (D4) tests — git/gh fully mocked via RunCommand; only the yaml
 * file surgery runs for real against temp directories. Token fixtures FAKE.
 */

const NOW = "2026-10-21T10:00:00.000Z";

function section(overrides: Partial<HowtoSection> = {}): HowtoSection {
  return {
    tool: "demo",
    goal: "run the demo checks",
    script: "set -euo pipefail\ndemo check --all",
    os: ["macos"],
    sessionToken: "wbT0",
    createdAt: NOW,
    attempts: 1,
    ...overrides,
  };
}

interface Recorded {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

function recorder(
  handle: (r: Recorded) => { stdout: string; stderr: string } | "reject"
): { runCmd: RunCommand; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runCmd: RunCommand = async (cmd, args, opts) => {
    const rec = { cmd, args, cwd: opts?.cwd, env: opts?.env };
    calls.push(rec);
    const result = handle(rec);
    if (result === "reject") {
      throw new Error(`mock failure for ${cmd} ${args.join(" ")}`);
    }
    return result;
  };
  return { runCmd, calls };
}

const GIT_DEFAULT = (r: Recorded): { stdout: string; stderr: string } | "reject" => {
  if (r.cmd !== "git") return "reject";
  if (r.args[0] === "rev-parse") {
    return r.args[1] === "HEAD" ? { stdout: "feedface00\n", stderr: "" } : { stdout: "true\n", stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

function writeDemoDoc(dir: string, name = "demo", extra = ""): string {
  const file = join(dir, `${name}.yaml`);
  writeFileSync(
    file,
    `mallm: "1.1"\nname: ${name}\nsummary: demo doc\n${extra}`.replace(/\n$/, "\n")
  );
  return file;
}

test("renderSectionEntry carries script + provenance", () => {
  const entry = renderSectionEntry(section());
  assert.equal(entry.title, "run the demo checks");
  assert.equal(entry.script, "set -euo pipefail\ndemo check --all");
  const provenance = entry.provenance as Record<string, unknown>;
  assert.equal(provenance.session, "wbT0");
  assert.equal(provenance.attempts, 1);
});

test("dir adapter: appends howtos to the matched doc and commits on howto/<token>", async (t) => {
  t.after(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), "mallm-wb-dir-"));
  const file = writeDemoDoc(dir, "demo", "howtos:\n  - title: existing\n    goal: existing\n");

  const { runCmd, calls } = recorder(GIT_DEFAULT);
  const result = await writebackHowto(
    { name: "local", kind: "dir", url: dir, priority: 10 },
    section(),
    { runCmd }
  );

  assert.equal(result.ok, true);
  assert.equal(result.adapter, "dir");
  assert.equal(result.branch, "howto/wbT0");
  assert.equal(result.commit, "feedface00");
  assert.equal(result.file, file);

  const parsed = parseYaml(readFileSync(file, "utf-8")) as {
    name: string;
    howtos: Array<{ title: string; script: string }>;
  };
  assert.equal(parsed.howtos.length, 2, "appended after the existing entry");
  assert.equal(parsed.howtos[1].title, "run the demo checks");
  assert.ok(parsed.howtos[1].script.includes("demo check --all"));

  const checkout = calls.find((c) => c.args[0] === "checkout");
  assert.deepEqual(checkout?.args.slice(0, 2), ["checkout", "-b"]);
  assert.equal(checkout?.args[2], "howto/wbT0");
  assert.equal(checkout?.cwd, dir);
  const add = calls.find((c) => c.args[0] === "add");
  assert.equal(add?.args[1], "demo.yaml");
  const commit = calls.find((c) => c.args[0] === "commit");
  assert.ok(commit?.args[2].includes("run the demo checks"));
  assert.ok(commit?.args[2].includes("session wbT0"));
  assert.equal(calls.filter((c) => c.cmd !== "git").length, 0, "no gh, no push for dir sources");
});

test("dir adapter: creates a fresh doc file when no match exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mallm-wb-new-"));
  const { runCmd } = recorder(GIT_DEFAULT);
  const result = await writebackHowto(
    { name: "local", kind: "dir", url: dir, priority: 10 },
    section({ tool: "fresh-tool" }),
    { runCmd }
  );
  assert.equal(result.ok, true);
  const parsed = parseYaml(readFileSync(join(dir, "fresh-tool.yaml"), "utf-8")) as {
    name: string;
    mallm: string;
    howtos: unknown[];
  };
  assert.equal(parsed.name, "fresh-tool");
  assert.equal(parsed.mallm, "1.1");
  assert.equal(parsed.howtos.length, 1);
});

test("dir adapter: non-repo directory is a typed error, never a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mallm-wb-nogit-"));
  const { runCmd } = recorder((r) => (r.args[0] === "rev-parse" ? "reject" : { stdout: "", stderr: "" }));
  const result = await writebackHowto(
    { name: "local", kind: "dir", url: dir, priority: 10 },
    section(),
    { runCmd }
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("not a git repository"));
});

test("array-form doc files are rejected for write-back", () => {
  const dir = mkdtempSync(join(tmpdir(), "mallm-wb-arr-"));
  writeFileSync(join(dir, "demo.yaml"), "- name: demo\n  summary: array form\n");
  const found = findDocFile(dir, "demo");
  assert.ok(found.error?.includes("array-form"));
});

test("git adapter: push env keeps the token out of argv; gh opens the PR with GH_TOKEN", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "mallm-wb-git-"));
  writeDemoDoc(workDir, "demo");
  const FAKE_TOKEN = "fake-gh-token-ABC123XYZ";

  const { runCmd, calls } = recorder((r) => {
    if (r.cmd === "git") return GIT_DEFAULT(r);
    if (r.cmd === DEFAULT_GH_BIN && r.args[0] === "pr") {
      return { stdout: "https://github.com/acme/corp/pull/7\n", stderr: "" };
    }
    return "reject";
  });
  const source: MallmSource = {
    name: "corp",
    kind: "git",
    repo: "https://github.com/acme/corp.git",
    branch: "manifests",
    tokenEnv: "MALLM_WB_TOKEN",
    priority: 10,
  };
  const result = await writebackHowto(source, section(), {
    runCmd,
    ghBin: DEFAULT_GH_BIN,
    env: { MALLM_WB_TOKEN: FAKE_TOKEN },
    workDir,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.adapter, "git");
  assert.equal(result.branch, "howto/wbT0");
  assert.equal(result.commit, "feedface00");
  assert.equal(result.pullRequest?.number, 7);
  assert.ok(result.pullRequest?.url.includes("acme/corp/pull/7"));

  // the token never appears in ANY argv (process-listing safety)
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.args).includes(FAKE_TOKEN), `token leaked into argv: ${call.args.join(" ")}`);
  }
  // push authenticates via an env-injected credential helper referencing the var NAME
  const push = calls.find((c) => c.cmd === "git" && c.args[0] === "push");
  assert.ok(push, "pushed");
  assert.equal(push?.args[1], "origin");
  assert.equal(push?.env?.GIT_CONFIG_COUNT, "1");
  assert.ok(push?.env?.GIT_CONFIG_VALUE_0?.includes("$MALLM_WB_TOKEN"));
  assert.ok(!push?.env?.GIT_CONFIG_VALUE_0?.includes(FAKE_TOKEN));
  // gh gets the token via env only
  const gh = calls.find((c) => c.cmd === DEFAULT_GH_BIN);
  assert.deepEqual(
    gh?.args.slice(0, 5),
    ["pr", "create", "--repo", "acme/corp", "--base"]
  );
  assert.equal(gh?.args.includes("manifests"), true);
  assert.equal(gh?.args.includes("howto/wbT0"), true);
  assert.equal(gh?.env?.GH_TOKEN, FAKE_TOKEN);
  // the branch was cut in the provided work dir (no clone call)
  assert.equal(calls.some((c) => c.args[0] === "clone"), false);
});

test("git adapter: missing token env fails fast with the env NAME only", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "mallm-wb-notoken-"));
  writeDemoDoc(workDir, "demo");
  const { runCmd, calls } = recorder(GIT_DEFAULT);
  const result = await writebackHowto(
    {
      name: "corp",
      kind: "git",
      repo: "https://github.com/acme/corp.git",
      branch: "manifests",
      tokenEnv: "MALLM_MISSING_TOKEN",
      priority: 10,
    },
    section(),
    { runCmd, env: {}, workDir }
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("MALLM_MISSING_TOKEN"), "error names the env var");
  assert.equal(calls.length, 0, "fails before any git/gh call");
});

test("git adapter: pushes without a token when tokenEnv is unset (ambient auth)", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "mallm-wb-ambient-"));
  writeDemoDoc(workDir, "demo");
  const { runCmd, calls } = recorder((r) => {
    if (r.cmd === "git") return GIT_DEFAULT(r);
    return { stdout: "https://github.com/acme/corp/pull/9\n", stderr: "" };
  });
  const result = await writebackHowto(
    { name: "corp", kind: "git", repo: "git@github.com:acme/corp.git", branch: "main", priority: 10 },
    section(),
    { runCmd, ghBin: DEFAULT_GH_BIN, env: {}, workDir }
  );
  assert.equal(result.ok, true, result.error);
  const push = calls.find((c) => c.cmd === "git" && c.args[0] === "push");
  assert.equal(push?.env?.GIT_CONFIG_COUNT, undefined, "no credential helper injected");
  assert.equal(push?.env?.GH_TOKEN, undefined);
});

test("http sources have no write-back adapter", async () => {
  const { runCmd } = recorder(GIT_DEFAULT);
  const result = await writebackHowto(
    { name: "web", kind: "http", url: "https://example.com/docs.yaml", priority: 10 },
    section(),
    { runCmd }
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("no write-back adapter"));
});
