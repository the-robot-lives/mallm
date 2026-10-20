import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search } from "../src/search/bm25.js";
import type { HowtoDoc } from "../src/search/bm25.js";

const DOCS: HowtoDoc[] = [
  {
    id: "pg-macos",
    tool: "postgres",
    title: "Install PostgreSQL on macOS",
    summary: "brew install postgresql@16, initdb, and start the service",
    tags: ["postgres", "database", "brew"],
    os: ["macos"],
    ranges: { postgres: ">=16" },
  },
  {
    id: "nginx-linux",
    tool: "nginx",
    title: "Set up nginx on Linux",
    summary: "apt install nginx and configure server blocks",
    tags: ["nginx", "web", "apt"],
    os: ["linux"],
    ranges: {},
  },
  {
    id: "pg-linux",
    tool: "postgres",
    title: "PostgreSQL streaming replication on Linux",
    summary: "primary and replica setup for high availability",
    tags: ["postgres", "ha"],
    os: ["linux"],
    ranges: { postgres: ">=14" },
  },
];

test("relevant doc ranks first", () => {
  const index = buildIndex(DOCS);
  const hits = search(index, "install postgres macos");
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, "pg-macos");
});

test("tag/tool terms are searchable", () => {
  const index = buildIndex(DOCS);
  const hits = search(index, "nginx");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "nginx-linux");
});

test("scores are descending and limit truncates", () => {
  const index = buildIndex(DOCS);
  const hits = search(index, "postgres linux");
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].id, "pg-linux");
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score);
  }
  const limited = search(index, "postgres linux", { limit: 1 });
  assert.equal(limited.length, 1);
});

test("empty and no-match queries return empty results", () => {
  const index = buildIndex(DOCS);
  assert.deepEqual(search(index, ""), []);
  assert.deepEqual(search(index, "   "), []);
  assert.deepEqual(search(index, "zzzznotpresent"), []);
});

test("index over zero docs is safe", () => {
  const index = buildIndex([]);
  assert.deepEqual(search(index, "anything"), []);
});
