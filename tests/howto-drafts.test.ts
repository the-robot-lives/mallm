import { test } from "node:test";
import assert from "node:assert/strict";
import type { EnvironmentProbe } from "../src/env/index.js";
import type { MergedDoc } from "../src/corpus/index.js";
import {
  corpusCandidates,
  generateCandidates,
  llmCandidates,
  parseFencedBash,
  templateCandidates,
} from "../src/howto/drafts.js";
import { missingTools, planInstalls, scriptCommands } from "../src/howto/script.js";
import type { ChatFetch } from "../src/llm/index.js";

function probe(names: string[], installers: string[] = ["brew"]): EnvironmentProbe {
  return {
    os: { flavor: "macos", version: "25.6.0" },
    arch: "arm64",
    shell: "/bin/zsh",
    host: "t",
    tools: names.map((n) => ({ name: n, path: `/usr/bin/${n}` })),
    installers,
    scannedAt: "2026-10-21T00:00:00.000Z",
  };
}

test("scriptCommands extracts first words, skipping comments, assignments, builtins, keywords", () => {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# a comment",
    "FOO=1 BAR=hello curl -fsSL https://example.com",
    "if [ -d .git ]; then",
    "  git status --short",
    "fi",
    "for f in *.txt; do",
    "  echo \"$f\"",
    "done",
    "export SECRET_NOTE=nope",
    "mkdir -p out",
  ].join("\n");
  assert.deepEqual(scriptCommands(script), ["curl", "git", "mkdir"]);
});

test("missingTools and planInstalls split installable from uninstallable", () => {
  const p = probe(["git", "curl", "bash"]);
  const script = "curl -fsSL https://x/p -o /tmp/p\njq .f /tmp/p\nterraform plan";
  assert.deepEqual(missingTools(script, p), ["jq", "terraform"]);

  const withBrew = planInstalls(["jq", "terraform"], p);
  assert.deepEqual(
    withBrew.plan.map((i) => [i.tool, i.installer, ...i.args]),
    [
      ["jq", "brew", "install", "jq"],
      ["terraform", "brew", "install", "terraform"],
    ]
  );
  assert.deepEqual(withBrew.uninstallable, []);

  const bare = planInstalls(["jq"], probe(["git"], []));
  assert.deepEqual(bare.plan, []);
  assert.deepEqual(bare.uninstallable, ["jq"]);
});

test("parseFencedBash extracts bash/sh/plain fences in order", () => {
  const text = [
    "Title: one",
    "```bash",
    "echo 1",
    "```",
    "some prose",
    "```sh",
    "echo 2",
    "```",
    "```",
    "   ",
    "```",
  ].join("\n");
  assert.deepEqual(parseFencedBash(text), ["echo 1", "echo 2"]);
  assert.deepEqual(parseFencedBash("no fences"), []);
});

const DEMO_DOC: MergedDoc = {
  name: "demo",
  doc: {
    mallm: "1.1",
    name: "demo",
    summary: "demo tool for testing",
    usage: {
      synopsis: "demo [options]",
      examples: [{ command: "demo --run --fast", description: "run fast" }],
    },
  },
  sourceName: "local",
  sourceKind: "dir",
  priority: 10,
};

test("corpusCandidates adapt usage examples into scripts", () => {
  const candidates = corpusCandidates("run the demo fast", [DEMO_DOC]);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].source, "corpus");
  assert.equal(candidates[0].corpusDoc, "demo");
  assert.ok(candidates[0].script.includes("demo --run --fast"));
});

test("templateCandidates always yield two non-empty candidates", () => {
  const candidates = templateCandidates("do the thing", "sometool");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.script.trim() !== ""));
  assert.ok(candidates[1].script.includes("sometool"));
});

test("generateCandidates degrades without inference (corpus + template mix)", async () => {
  const candidates = await generateCandidates(
    { goal: "run the demo", tool: "demo", os: "macos 25", arch: "arm64", tools: ["demo"], docs: [DEMO_DOC] },
    { inference: {}, env: {} }
  );
  assert.ok(candidates.length >= 2, `expected >= 2 candidates, got ${candidates.length}`);
  assert.ok(candidates[0].source === "corpus");
  assert.deepEqual(candidates.map((c) => c.id), candidates.map((_, i) => i + 1), "renumbered 1..n");

  // empty corpus + no inference still yields templates — never throws, never empty
  const bare = await generateCandidates(
    { goal: "anything at all", os: "linux", arch: "x64", tools: [], docs: [] },
    { inference: {}, env: {} }
  );
  assert.ok(bare.length >= 2);
  assert.ok(bare.every((c) => c.source === "template"));
});

function chatFetch(content: string, status = 200): ChatFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  });
}

test("llmCandidates parse titles + fenced scripts from a chat reply", async () => {
  const content = [
    "Title: fetch health",
    "```bash",
    "curl -fsSL https://h/health",
    "```",
    "Title: use the cli",
    "```bash",
    "demo --run",
    "```",
  ].join("\n");
  const candidates = await llmCandidates(
    { goal: "check health", tools: ["curl"] },
    {
      inference: { baseUrl: "http://fake.local/v1", model: "fake-model", apiKeyEnv: "FAKE_KEY" },
      env: { FAKE_KEY: "fake-key-123456" },
      fetchImpl: chatFetch(content),
    }
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].source, "llm");
  assert.equal(candidates[0].title, "fetch health");
  assert.ok(candidates[1].script.includes("demo --run"));
});

test("generateCandidates falls back to corpus when the LLM errors", async () => {
  const candidates = await generateCandidates(
    { goal: "run the demo", os: "macos 25", arch: "arm64", tools: [], docs: [DEMO_DOC] },
    {
      inference: { baseUrl: "http://fake.local/v1", model: "fake-model", apiKeyEnv: "FAKE_KEY" },
      env: { FAKE_KEY: "fake-key-123456" },
      fetchImpl: chatFetch("boom", 500),
    }
  );
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.some((c) => c.source === "corpus"), "corpus candidates picked up after llm failure");
});
