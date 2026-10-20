import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { appendHistory, historyPath, readHistory } from "../src/changelog/history.js";
import { fakeEnv, tempXdg } from "./helpers.js";

// All secret-looking material below is FAKE — invented for this test.

const FAKE_COMMAND =
  "mallm sources add wire --kind http --url https://ci:FAKEpassword123@fake.example/corpus.yaml";
const FAKE_FILE = "/tmp/fake/FAlwJalrXUtnFEMI7MDENGbPxRfiCYEXAMPLEKEY.yaml";

test("appendHistory redacts strictly BEFORE the write — no escape hatch", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  const record = appendHistory(
    {
      session: "adhoc",
      action: "sources.add",
      command: FAKE_COMMAND,
      files: [FAKE_FILE],
      outcome: "ok",
    },
    { env, now: new Date("2026-10-21T00:00:00.000Z") }
  );

  assert.equal(record.ts, "2026-10-21T00:00:00.000Z");
  assert.ok(!record.command.includes("FAKEpassword123"));
  assert.ok(record.command.includes("[REDACTED:cred-url]"));
  assert.ok(record.redactions.includes("cred-url"));

  // what landed on disk is already redacted
  const onDisk = readFileSync(historyPath(env), "utf-8");
  assert.ok(!onDisk.includes("FAKEpassword123"));
  const parsed = JSON.parse(onDisk.trim());
  assert.equal(parsed.action, "sources.add");
  assert.ok(parsed.command.includes("[REDACTED:cred-url]"));
});

test("readHistory filters by session and honors --tail", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  for (let i = 1; i <= 3; i++) {
    appendHistory(
      {
        session: i % 2 === 0 ? "session-even" : "session-odd",
        action: `step.${i}`,
        command: `mallm fake --step ${i}`,
        files: [],
        outcome: "ok",
      },
      { env, now: new Date(`2026-10-21T00:0${i}:00.000Z`) }
    );
  }

  const all = readHistory({ env });
  assert.equal(all.length, 3);

  const even = readHistory({ env, session: "session-even" });
  assert.equal(even.length, 1);
  assert.equal(even[0].action, "step.2");

  const tail = readHistory({ env, tail: 1 });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].action, "step.3");

  assert.deepEqual(readHistory({ env, path: "/nonexistent/history.jsonl" }), []);
});

test("readHistory skips corrupt lines without failing", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);
  appendHistory(
    { session: "s", action: "good", command: "mallm ok", files: [], outcome: "ok" },
    { env }
  );
  appendFileSync(historyPath(env), "this is not json\n");
  const records = readHistory({ env });
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "good");
});
