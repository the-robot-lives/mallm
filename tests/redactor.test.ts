import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHighEntropyToken,
  redact,
  shannonBitsPerChar,
} from "../src/changelog/redactor.js";

// Every secret-looking value below is FAKE — constructed in this file, never
// copied from a real credential store.

const FAKES = {
  bearer: "Bearer FAKEfaketokenFAKEfaketoken123",
  akia: "AKIAFAKEFAKEFAKEFAKE",
  ghp: "ghp_FAKEfaketokenFAKEfaketoken12345",
  sk: "sk-FAKEfaketokenFAKEfaketoken12345",
  pem: [
    "-----BEGIN RSA PRIVATE KEY-----",
    "FAKE0materiaFAKE0materiaFAKE0materia",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"),
  credUrl: "https://fakeuser:FAKEpassword123@example.com/repo.git",
  entropy: "Zk9xQ2vLmP4nR7tYw1BcD5eFgH8jKaS3",
  envAssign: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

test("entropy guard: fake high-entropy token trips, long hex does not", () => {
  assert.ok(shannonBitsPerChar(FAKES.entropy) > 4.5);
  assert.equal(isHighEntropyToken(FAKES.entropy), true);
  const longHex = "0123456789abcdef".repeat(4); // 4.0 bits/char exactly
  assert.ok(!isHighEntropyToken(longHex));
  assert.ok(!isHighEntropyToken("short"));
});

test("PEM blocks are redacted", () => {
  const { text, applied } = redact(`before ${FAKES.pem} after`);
  assert.ok(!text.includes("BEGIN"));
  assert.ok(!text.includes("FAKE0materia"));
  assert.ok(text.includes("[REDACTED:pem]"));
  assert.deepEqual(applied, ["pem"]);
});

test("credentialed URLs lose the password but keep the user", () => {
  const { text, applied } = redact(`clone ${FAKES.credUrl} now`);
  assert.ok(text.includes("://fakeuser:[REDACTED:cred-url]@example.com"));
  assert.ok(!text.includes("FAKEpassword123"));
  assert.deepEqual(applied, ["cred-url"]);
  // plain URLs survive
  const clean = redact("fetch https://example.com/plain");
  assert.equal(clean.text, "fetch https://example.com/plain");
  assert.deepEqual(clean.applied, []);
});

test("bearer tokens, AKIA keys, and prefixed tokens are redacted", () => {
  for (const fake of [FAKES.bearer, FAKES.akia, FAKES.ghp, FAKES.sk]) {
    const { text, applied } = redact(`auth ${fake} end`);
    assert.ok(!text.includes(fake.replace("Bearer ", "")), fake);
    assert.ok(text.includes("[REDACTED:bearer]"));
    assert.deepEqual(applied, ["bearer"]);
  }
});

test("secret-ish env-var assignments are redacted", () => {
  const { text, applied } = redact(`${FAKES.envAssign} ./run.sh`);
  assert.ok(text.startsWith("AWS_SECRET_ACCESS_KEY=[REDACTED:env-assign]"));
  assert.ok(!text.includes("wJalrXUtnFEMI"));
  assert.ok(applied.includes("env-assign"));
});

test("high-entropy value redacts even with a benign variable name", () => {
  const { text, applied } = redact(`MAGIC=${FAKES.entropy} run`);
  assert.ok(text.startsWith("MAGIC=[REDACTED:env-assign]"));
  assert.ok(applied.includes("env-assign"));
});

test("benign env assignments and ordinary commands survive", () => {
  const { text, applied } = redact("FOO=bar make test && kubectl get pods -n mallm");
  assert.equal(text, "FOO=bar make test && kubectl get pods -n mallm");
  assert.deepEqual(applied, []);
});

test("bare high-entropy tokens are caught by the entropy guard", () => {
  const { text, applied } = redact(`leaked token ${FAKES.entropy} in output`);
  assert.ok(!text.includes(FAKES.entropy));
  assert.ok(text.includes("[REDACTED:entropy]"));
  assert.deepEqual(applied, ["entropy"]);
});

test("config patterns are applied and invalid patterns are skipped", () => {
  const { text, applied } = redact("user FAKEPII12345 logged in", ["FAKEPII\\d+", "(["]);
  assert.ok(text.includes("[REDACTED:config-pattern]"));
  assert.ok(!text.includes("FAKEPII12345"));
  assert.deepEqual(applied, ["config-pattern"]);
});

test("multiple rules fire and are tracked in order", () => {
  const { text, applied } = redact(`${FAKES.pem} then ${FAKES.bearer}`);
  assert.ok(text.includes("[REDACTED:pem]"));
  assert.ok(text.includes("[REDACTED:bearer]"));
  assert.deepEqual(applied, ["pem", "bearer"]);
});
