import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JEV_DEFAULT_BASE_URL,
  applyQuizAnswers,
  askSystemOne,
  buildQuiz,
  jevApiKey,
  jevBaseUrl,
  jevKeyEnvName,
  parseAnswers,
  renderQuizPlain,
  systemOneEndpoint,
} from "../src/jev/index.js";
import type { JevFetch, JevQuestion } from "../src/jev/index.js";
import { readKnowledge, writeKnowledge } from "../src/memory/index.js";
import type { KnowledgeTopic } from "../src/memory/index.js";
import { tempDir } from "./helpers.js";

/** All key fixtures are FAKE; nothing here touches the network. */
const FAKE_KEY = "fake-jev-key-abcdef123456";

function mockFetch(
  respond: (url: string, init: { headers: Record<string, string>; body: string }) => { ok: boolean; status: number; body: string }
): { fetchImpl: JevFetch; seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> } {
  const seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetchImpl: JevFetch = async (url, init) => {
    seen.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    const r = respond(url, { headers: init.headers, body: init.body });
    return { ok: r.ok, status: r.status, text: async () => r.body };
  };
  return { fetchImpl, seen };
}

const QUESTIONS: JevQuestion[] = [
  { id: "docker:b", topicId: "docker", type: "boolean", prompt: "Can you write a docker how-to?" },
  { id: "docker:s", topicId: "docker", type: "score", prompt: "Rate docker confidence.", scale: { min: 0, max: 10 } },
];

test("base url and endpoint resolution", () => {
  assert.equal(jevBaseUrl({}), JEV_DEFAULT_BASE_URL);
  assert.equal(jevBaseUrl({ JEV_BASE_URL: "https://jev.example.com/v1/" }), "https://jev.example.com/v1");
  assert.equal(systemOneEndpoint("https://api.typesafe.ai/v1"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(systemOneEndpoint("https://x.example/"), "https://x.example/systemone");
});

test("key resolution: JEV_API_KEY wins over TYPESAFE_API_KEY", () => {
  assert.equal(jevKeyEnvName({}), undefined);
  assert.equal(jevKeyEnvName({ TYPESAFE_API_KEY: FAKE_KEY }), "TYPESAFE_API_KEY");
  assert.equal(jevKeyEnvName({ TYPESAFE_API_KEY: FAKE_KEY, JEV_API_KEY: FAKE_KEY + "2" }), "JEV_API_KEY");
  assert.equal(jevApiKey({ JEV_API_KEY: FAKE_KEY }), FAKE_KEY);
});

test("no key degrades to a typed no-key result without any fetch", async () => {
  const { fetchImpl, seen } = mockFetch(() => ({ ok: true, status: 200, body: "{}" }));
  const result = await askSystemOne({}, QUESTIONS, { env: {}, fetchImpl });
  assert.deepEqual(result, {
    ok: false,
    kind: "no-key",
    reason: "no jev api key configured (set JEV_API_KEY or TYPESAFE_API_KEY)",
  });
  assert.equal(seen.length, 0);
});

test("happy path: bearer header, body shape, filtered answers", async () => {
  const { fetchImpl, seen } = mockFetch(() => ({
    ok: true,
    status: 200,
    body: JSON.stringify({
      answers: [
        { id: "docker:b", answer: true },
        { id: "docker:s", answer: 7 },
        { id: "bogus", answer: "x" },
        { id: "docker:s", answer: null },
      ],
    }),
  }));
  const result = await askSystemOne({ os: "macos" }, QUESTIONS, {
    env: { JEV_API_KEY: FAKE_KEY },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.model, "jev-latest");
    assert.deepEqual(result.answers, [
      { id: "docker:b", answer: true },
      { id: "docker:s", answer: 7 },
    ]);
  }
  const call = seen[0];
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.os, "macos");
  assert.equal(body.questions.length, 2);
});

test("custom base url, HTTP errors and malformed bodies degrade to typed errors", async () => {
  const ok = await askSystemOne({}, [], {
    env: { JEV_API_KEY: FAKE_KEY, JEV_BASE_URL: "https://jev.example.com/v1/" },
    fetchImpl: async (url) => {
      assert.equal(url, "https://jev.example.com/v1/systemone");
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: [] }) };
    },
  });
  assert.ok(ok.ok);

  const httpErr = await askSystemOne({}, [], {
    env: { JEV_API_KEY: FAKE_KEY },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "oops" }),
  });
  assert.deepEqual(httpErr, { ok: false, kind: "error", reason: "HTTP 500" });

  const malformed = await askSystemOne({}, [], {
    env: { JEV_API_KEY: FAKE_KEY },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json" }),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.ok === false && malformed.kind, "error");

  const noAnswers = await askSystemOne({}, [], {
    env: { JEV_API_KEY: FAKE_KEY },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  });
  assert.equal(noAnswers.ok, false);
});

test("parseAnswers validates ids and value types", () => {
  const answers = parseAnswers(
    { answers: [{ id: "docker:b", answer: true }, { id: "x", answer: 1 }, { id: "docker:s", answer: null }] },
    QUESTIONS
  );
  assert.deepEqual(answers, [{ id: "docker:b", answer: true }]);
  assert.equal(parseAnswers({}, QUESTIONS), null);
});

const TOPICS: KnowledgeTopic[] = [
  { id: "terraform", name: "terraform", confidence: 8, lastSeen: "2026-01-01T00:00:00.000Z", sources: [] },
  { id: "docker", name: "docker", confidence: 3, lastSeen: "2026-01-01T00:00:00.000Z", sources: [] },
  { id: "argo", name: "argo", confidence: 1, lastSeen: "2026-01-01T00:00:00.000Z", sources: [] },
];

test("buildQuiz orders lowest-confidence first, filters by topic, adds choice only with a synopsis", () => {
  const round = buildQuiz(TOPICS, {
    limit: 2,
    synopses: { docker: "docker build [OPTIONS] PATH" },
  });
  const order = [...new Set(round.questions.map((q) => q.topicId))];
  assert.deepEqual(order, ["argo", "docker"], "lowest confidence first, limit 2");
  const dockerIds = round.questions.filter((q) => q.topicId === "docker").map((q) => q.id);
  assert.deepEqual(dockerIds, ["docker:b", "docker:s", "docker:c"]);
  assert.equal(round.expected["docker:c"], "docker build [OPTIONS] PATH");
  assert.ok(!round.questions.some((q) => q.topicId === "argo" && q.type === "choice"));

  const single = buildQuiz(TOPICS, { topicId: "terraform" });
  assert.ok(single.questions.every((q) => q.topicId === "terraform"));
});

test("renderQuizPlain renders the wave-2b note and typed questions", () => {
  const round = buildQuiz([TOPICS[1]], { synopses: { docker: "docker build [OPTIONS] PATH" } });
  const text = renderQuizPlain(round);
  assert.ok(text.includes("view-as=quiz rendering lands in wave 2b"));
  assert.ok(text.includes("[boolean] docker"));
  assert.ok(text.includes("[score] docker"));
  assert.ok(text.includes("a) docker build [OPTIONS] PATH"));
});

test("applyQuizAnswers: boolean ±2, score sets, choice ±1, clamps, lastSeen", () => {
  const round = buildQuiz(TOPICS, {
    limit: 3,
    synopses: { docker: "docker build [OPTIONS] PATH", argo: "argo app sync" },
  });
  const { topics, deltas } = applyQuizAnswers(
    TOPICS,
    round.questions,
    [
      { id: "argo:b", answer: false }, // 1 - 2 → 0 (clamped)
      { id: "docker:b", answer: true }, // 3 + 2 → 5
      { id: "docker:s", answer: 9 }, // → 9 (last write wins per topic)
      { id: "docker:c", answer: "docker build [OPTIONS] PATH" }, // 9 + 1 → 10
      { id: "terraform:s", answer: "not a number" }, // ignored
      { id: "nope:b", answer: true }, // unknown → ignored
    ],
    round.expected,
    "2026-10-21T11:00:00.000Z"
  );
  const byId = new Map(topics.map((t) => [t.id, t]));
  assert.equal(byId.get("argo")?.confidence, 0);
  assert.equal(byId.get("docker")?.confidence, 10);
  assert.equal(byId.get("terraform")?.confidence, 8);
  assert.equal(byId.get("docker")?.lastSeen, "2026-10-21T11:00:00.000Z");
  assert.equal(byId.get("argo")?.lastSeen, "2026-10-21T11:00:00.000Z");
  assert.equal(byId.get("terraform")?.lastSeen, "2026-01-01T00:00:00.000Z");
  assert.ok(deltas.some((d) => d.topicId === "argo" && d.to === 0));
  assert.ok(!deltas.some((d) => d.topicId === "terraform"));

  // wrong choice lowers
  const wrong = applyQuizAnswers(
    [{ id: "docker", name: "docker", confidence: 5, lastSeen: "2026-01-01T00:00:00.000Z", sources: [] }],
    [{ id: "docker:c", topicId: "docker", type: "choice", prompt: "p", options: ["a", "b"] }],
    [{ id: "docker:c", answer: "man docker" }],
    { "docker:c": "a" }
  );
  assert.equal(wrong.topics[0].confidence, 4);
});

test("writeKnowledge round-trips through disk sorted by id", () => {
  const dir = tempDir();
  const path = join(dir, "knowledge.yaml");
  writeKnowledge(path, { topics: [...TOPICS] });
  const reloaded = readKnowledge(path);
  assert.deepEqual(
    reloaded.topics.map((t) => t.id),
    ["argo", "docker", "terraform"]
  );
  const raw = readFileSync(path, "utf-8");
  assert.ok(raw.includes("name: docker"), `unexpected file content:\n${raw.slice(0, 200)}`);
});
