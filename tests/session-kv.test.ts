import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionKV, listSessions, sessionFilePath } from "../src/session/kv.js";
import { mintUniqueToken } from "../src/session/token.js";
import { fakeEnv, tempXdg } from "./helpers.js";

const TOKEN_A = mintUniqueToken(() => false).token;
const TOKEN_B = mintUniqueToken(
  (t) => t === TOKEN_A,
  (attempt) => ({
    iso: "2026-10-21T01:00:00.000Z",
    host: "kv-test",
    pid: process.pid,
    counter: 99 + attempt,
    attempt,
  })
).token;

test("session KV round-trips through disk", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  const kv = SessionKV.open(TOKEN_A, { env });
  assert.equal(kv.existsOnDisk, false);

  kv.set("env", "os", "macos");
  kv.set("env", "arch", "arm64");
  kv.push("downloads", { tool: "fake-tool", version: "1.0.0" });
  kv.push("installed", { tool: "other-tool" });
  kv.set("decisions", "strategy", { mode: "bm25" });
  kv.save();

  const path = sessionFilePath(TOKEN_A, env);
  assert.ok(existsSync(path), "session file written to the temp XDG tree");

  const reopened = SessionKV.open(TOKEN_A, { env });
  assert.equal(reopened.existsOnDisk, true);
  assert.equal(reopened.get("env", "os"), "macos");
  assert.equal(reopened.get("env", "arch"), "arm64");
  assert.deepEqual(reopened.items("downloads"), [{ tool: "fake-tool", version: "1.0.0" }]);
  assert.deepEqual(reopened.items("installed"), [{ tool: "other-tool" }]);
  assert.deepEqual(reopened.get("decisions", "strategy"), { mode: "bm25" });
});

test("inject() renders a compact, bucket-ordered context block", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const kv = SessionKV.open(TOKEN_B, { env: fakeEnv(xdg) });
  kv.set("env", "shell", "zsh");
  kv.push("approvals", "installed package fake-pkg");
  kv.save();

  const block = SessionKV.open(TOKEN_B, { env: fakeEnv(xdg) }).inject();
  assert.ok(block.startsWith(`# mallm session ${TOKEN_B}`));
  const envIdx = block.indexOf("## env");
  const approvalsIdx = block.indexOf("## approvals");
  assert.ok(envIdx > -1 && approvalsIdx > -1);
  assert.ok(envIdx < approvalsIdx, "fixed bucket order in inject output");
  assert.ok(block.includes("shell = \"zsh\""));
  assert.ok(block.includes("- \"installed package fake-pkg\""));
});

test("unknown buckets and the reserved items key are rejected", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const kv = SessionKV.open(TOKEN_A, { env: fakeEnv(xdg) });
  assert.throws(() => kv.set("bogus" as "env", "k", "v"), /unknown session bucket/);
  assert.throws(() => kv.get("nope" as "env", "k"), /unknown session bucket/);
  assert.throws(() => kv.set("downloads", "items", [1]), /reserved/);
});

test("listSessions and clear", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  SessionKV.open(TOKEN_A, { env }).set("env", "x", 1).save();
  SessionKV.open(TOKEN_B, { env }).set("env", "x", 2).save();
  assert.deepEqual(listSessions(env).sort(), [TOKEN_A, TOKEN_B].sort());

  const cleared = SessionKV.open(TOKEN_A, { env }).clear();
  assert.equal(cleared.existsOnDisk, false);
  assert.ok(!existsSync(sessionFilePath(TOKEN_A, env)));
  assert.ok(existsSync(sessionFilePath(TOKEN_B, env)), "other sessions untouched");
});

test("isExpired honors the session TTL", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  const kv = SessionKV.open(TOKEN_A, { env });
  kv.set("env", "fresh", true).save();

  const later = new Date(Date.now() + 10_000);
  assert.equal(kv.isExpired(3600), false); // 1h TTL, just written
  assert.equal(kv.isExpired(5, later), true); // 5s TTL, checked 10s later

  const path = sessionFilePath(TOKEN_A, env);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  raw.updatedAt = new Date(Date.now() - 86_400_000).toISOString();
  writeFileSync(path, JSON.stringify(raw));
  const stale = SessionKV.open(TOKEN_A, { env });
  assert.equal(stale.isExpired(3600), true); // a day old vs 1h TTL
});
