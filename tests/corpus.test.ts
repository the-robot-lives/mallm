import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MallmSource } from "../src/config/types.js";
import {
  mergeCorpus,
  parseDocsPayload,
  readCacheMeta,
  sha256Hex,
  syncDirSource,
  syncHttpSource,
  writeCacheMeta,
  type SyncResult,
} from "../src/corpus/index.js";
import { tempDir, tempXdg } from "./helpers.js";

function dirSource(name: string, url: string, priority?: number): MallmSource {
  return { name, kind: "dir", url, priority };
}

test("dir adapter reads YAML docs from a directory tree", (t) => {
  const root = tempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(
    join(root, "alpha.yaml"),
    "name: alpha-doc\nsummary: fake doc\nvalue: 1\n"
  );
  writeFileSync(
    join(root, "nested", "beta.yaml"),
    "summary: nameless doc takes the file name\n"
  );
  writeFileSync(
    join(root, "list.yaml"),
    "- name: gamma\n  summary: first\n- name: delta\n  summary: second\n"
  );
  writeFileSync(join(root, "README.md"), "ignored\n");

  const result = syncDirSource(dirSource("local", root));
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.docs.map((d) => d.name).sort(),
    ["alpha-doc", "beta", "delta", "gamma"]
  );
});

test("dir adapter reports a missing directory as an error", () => {
  const result = syncDirSource(dirSource("ghost", "/nonexistent/definitely"));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /directory not found/);
});

test("payload parsing handles arrays, wrapped docs, and YAML/JSON", () => {
  const fromArray = parseDocsPayload("- name: a\nsummary: x\n", "src");
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].name, "a");

  const fromWrapped = parseDocsPayload(
    "docs:\n  - name: b\n    summary: y\n",
    "src"
  );
  assert.equal(fromWrapped.length, 1);
  assert.equal(fromWrapped[0].name, "b");

  const fromJson = parseDocsPayload('[{"name":"c","summary":"z"}]', "src");
  assert.equal(fromJson.length, 1);
  assert.equal(fromJson[0].name, "c");

  const fromGarbage = parseDocsPayload("{{{{", "src");
  assert.deepEqual(fromGarbage, []);
});

test("priority merge: lower priority number wins, ties deterministic, failures excluded", () => {
  const high = dirSource("alpha", "/a", 10);
  const low = dirSource("beta", "/b", 200);
  const failed = dirSource("down", "/c", 1);

  const results: SyncResult[] = [
    {
      source: low,
      ok: true,
      cached: true,
      docs: [
        { name: "shared", doc: { v: "low" } },
        { name: "only-low", doc: { v: "low" } },
      ],
    },
    {
      source: high,
      ok: true,
      cached: false,
      docs: [{ name: "shared", doc: { v: "high" } }],
    },
    {
      source: failed,
      ok: false,
      cached: false,
      docs: [{ name: "shared", doc: { v: "failed" } }],
      error: "unreachable",
    },
  ];

  const merged = mergeCorpus(results);
  assert.equal(merged.size, 2);
  assert.equal(merged.get("shared")?.doc.v, "high");
  assert.equal(merged.get("shared")?.sourceName, "alpha");
  assert.equal(merged.get("shared")?.priority, 10);
  assert.equal(merged.get("only-low")?.sourceName, "beta");

  // equal priority: name order decides deterministically
  const tie: SyncResult[] = [
    {
      source: dirSource("zzz", "/z", 5),
      ok: true,
      cached: true,
      docs: [{ name: "k", doc: { v: "zzz" } }],
    },
    {
      source: dirSource("aaa", "/a", 5),
      ok: true,
      cached: true,
      docs: [{ name: "k", doc: { v: "aaa" } }],
    },
  ];
  assert.equal(mergeCorpus(tie).get("k")?.doc.v, "aaa");
});

test("cache meta round-trips and keys are stable per source identity", (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const root = join(xdg.cache, "corpus");

  const source: MallmSource = {
    name: "s",
    kind: "http",
    url: "https://fake.example/x",
  };

  const meta = writeCacheMeta(root, source, {
    etag: 'W/"fake-etag"',
    sha256: sha256Hex("fake-payload"),
    fetchedAt: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(meta.key.length, 24);

  const read = readCacheMeta(root, source);
  assert.deepEqual(read, meta);

  // same identity → same key; different name → different key
  const renamed = readCacheMeta(root, { ...source, name: "other" });
  assert.equal(renamed, null);
});

test("http adapter: 200 pins payload + ETag, 304 reuses cache (stubbed fetch, no network)", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const root = join(xdg.cache, "corpus");
  const etag = 'W/"fake-v1"';

  const seenIfNoneMatch: Array<string | undefined> = [];
  const fetchImpl = async (
    _url: string,
    init?: { headers?: Record<string, string> }
  ) => {
    seenIfNoneMatch.push(init?.headers?.["if-none-match"]);
    if (init?.headers?.["if-none-match"] === etag) {
      return { status: 304, text: async () => "", headers: { get: () => etag } };
    }
    return {
      status: 200,
      text: async () => "- name: fake-doc\nsummary: from the wire\n",
      headers: { get: () => etag },
    };
  };

  const source: MallmSource = {
    name: "wire",
    kind: "http",
    url: "https://fake.example/corpus.yaml",
  };

  const first = await syncHttpSource(source, { cacheRoot: root, fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false); // fetch-on-miss
  assert.equal(first.docs[0]?.name, "fake-doc");
  assert.equal(readCacheMeta(root, source)?.etag, etag);

  const second = await syncHttpSource(source, { cacheRoot: root, fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true); // 304 → cache reuse
  assert.equal(second.docs[0]?.name, "fake-doc");
  assert.deepEqual(seenIfNoneMatch, [undefined, etag]);
});

test("http adapter: HTTP errors are reported, not thrown", async (t) => {
  const xdg = tempXdg();
  t.after(() => xdg.restore());
  const failing = async () => ({ status: 503, text: async () => "", headers: { get: () => null } });
  const result = await syncHttpSource(
    { name: "down", kind: "http", url: "https://fake.example/down" },
    { cacheRoot: join(xdg.cache, "corpus"), fetchImpl: failing }
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /HTTP 503/);
});
