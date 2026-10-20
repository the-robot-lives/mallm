import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  parsePlatformConfig,
  resolvePlatformConfig,
  upsertSource,
  userConfigPath,
} from "../src/config/index.js";
import { fakeEnv, tempDir, tempXdg } from "./helpers.js";

const V10_FIXTURE = readFileSync(
  new URL("../examples/helm-upgrade.mallm.yaml", import.meta.url),
  "utf-8"
);

test("a v1.0 mallm.yaml parses with defaults — v1.0 stays valid", () => {
  const cfg = parsePlatformConfig(parseYaml(V10_FIXTURE));
  assert.equal(cfg.version, "1.0");
  assert.deepEqual(cfg.sources, []);
  assert.deepEqual(cfg.inference, {});
  assert.deepEqual(cfg.redaction.patterns, []);
  assert.equal(cfg.sessionTtl, DEFAULT_SESSION_TTL_SECONDS);
});

test("v1.1 keys parse and normalize", () => {
  const cfg = parsePlatformConfig({
    mallm: "1.1",
    name: "mallm-config",
    summary: "test",
    sources: [
      { name: "remote", kind: "http", url: "https://fake.example/corpus.yaml", priority: 10 },
      { name: "repo", kind: "git", repo: "https://fake.example/repo.git", branch: "develop" },
      { name: "local", kind: "dir", url: "/tmp/somewhere" },
      { name: "bad-kind", kind: "ftp", url: "x" },
      { name: "no-url-http", kind: "http" },
    ],
    inference: { baseUrl: "https://fake.example/v1", apiKeyEnv: "FAKE_KEY_ENV", model: "fake-model" },
    redaction: { patterns: ["FAKE\\d+"] },
    sessionTtl: 3600,
  });
  assert.equal(cfg.version, "1.1");
  assert.equal(cfg.sources.length, 3); // invalid entries dropped
  assert.deepEqual(
    cfg.sources.map((s) => s.name),
    ["remote", "repo", "local"]
  );
  assert.equal(cfg.sources[1].priority, 100); // default filled
  assert.equal(cfg.sources[1].branch, "develop");
  assert.equal(cfg.inference.baseUrl, "https://fake.example/v1");
  assert.equal(cfg.redaction.patterns[0], "FAKE\\d+");
  assert.equal(cfg.sessionTtl, 3600);
});

test("malformed config input falls back to defaults without throwing", () => {
  const cfg = parsePlatformConfig("not-an-object");
  assert.deepEqual(cfg.sources, []);
  assert.equal(cfg.sessionTtl, DEFAULT_SESSION_TTL_SECONDS);
});

test("project .mallm/config.yaml overrides the user layer", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);

  // user layer
  writeFileSync(
    userConfigPath(env),
    "mallm: '1.1'\nname: mallm-config\nsummary: user layer\nsessionTtl: 200\n"
  );

  const noProject = tempDir();
  const withoutProject = resolvePlatformConfig(env, noProject);
  assert.equal(withoutProject.sessionTtl, 200); // user layer applied

  // project layer
  const projectRoot = tempDir();
  mkdirSync(join(projectRoot, ".mallm"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".mallm", "config.yaml"),
    "mallm: '1.1'\nname: mallm-config\nsummary: project layer\nsessionTtl: 100\nsources:\n  - name: proj\n    kind: dir\n    url: /tmp/proj-corpus\n"
  );

  const withProject = resolvePlatformConfig(env, projectRoot);
  assert.equal(withProject.sessionTtl, 100);
  assert.equal(withProject.sources.length, 1);
  assert.equal(withProject.sources[0].name, "proj");
});

test("a malformed layer is skipped, not fatal", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const env = fakeEnv(xdg);
  writeFileSync(userConfigPath(env), "{{{{ not yaml ::\n\t\x00garbage");
  const cfg = resolvePlatformConfig(env, tempDir());
  assert.equal(cfg.sessionTtl, DEFAULT_SESSION_TTL_SECONDS);
});

test("upsertSource creates then updates by name", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const path = join(xdg.config, "mallm", "config.yaml");

  const created = upsertSource(path, {
    name: "alpha",
    kind: "http",
    url: "https://fake.example/one.yaml",
  });
  assert.equal(created.created, true);
  assert.ok(existsSync(path));

  const updated = upsertSource(path, {
    name: "alpha",
    kind: "http",
    url: "https://fake.example/two.yaml",
  });
  assert.equal(updated.created, false);

  const doc = parseYaml(readFileSync(path, "utf-8"));
  assert.equal(doc.mallm, "1.1");
  assert.equal(doc.name, "mallm-config");
  assert.equal(doc.sources.length, 1);
  assert.equal(doc.sources[0].url, "https://fake.example/two.yaml");

  upsertSource(path, { name: "beta", kind: "dir", url: "/tmp/beta" });
  const after = parseYaml(readFileSync(path, "utf-8"));
  assert.equal(after.sources.length, 2);
});
