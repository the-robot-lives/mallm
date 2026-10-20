import type { EnvLike } from "../config/loader.js";

/**
 * TypeSafe "systemone" client for Jev. Mirrors llm/'s contract: a typed
 * result, graceful no-key degrade, NEVER a throw. The API key is read from
 * JEV_API_KEY (or TYPESAFE_API_KEY) and only ever travels in the
 * Authorization header — error messages carry env var NAMES, never values.
 */

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_MODEL = "jev-latest";
export const JEV_KEY_ENVS = ["JEV_API_KEY", "TYPESAFE_API_KEY"] as const;
export const JEV_BASE_URL_ENV = "JEV_BASE_URL";

export const DEFAULT_JEV_TIMEOUT_MS = 30_000;

export type JevQuestionType = "choice" | "score" | "boolean";

export interface JevQuestion {
  id: string;
  topicId: string;
  type: JevQuestionType;
  prompt: string;
  /** choice only */
  options?: string[];
  /** score only */
  scale?: { min: number; max: number };
}

export type JevAnswerValue = string | number | boolean;

export interface JevAnswer {
  id: string;
  answer: JevAnswerValue;
}

export type JevAskResult =
  | { ok: true; model: string; answers: JevAnswer[] }
  | { ok: false; kind: "no-key" | "error"; reason: string };

export interface JevFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type JevFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<JevFetchResponse>;

const defaultJevFetch: JevFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<JevFetchResponse>;

export function jevBaseUrl(env: EnvLike = process.env): string {
  const raw = env[JEV_BASE_URL_ENV]?.trim();
  if (!raw) return JEV_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function systemOneEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/systemone`;
}

/** Key env var NAME that holds the key, in resolution order; undefined = no key. */
export function jevKeyEnvName(env: EnvLike = process.env): string | undefined {
  for (const name of JEV_KEY_ENVS) {
    if (env[name] && env[name]?.trim() !== "") return name;
  }
  return undefined;
}

export function jevApiKey(env: EnvLike = process.env): string | undefined {
  const name = jevKeyEnvName(env);
  return name ? env[name] : undefined;
}

export async function askSystemOne(
  state: unknown,
  questions: JevQuestion[],
  opts: { env?: EnvLike; fetchImpl?: JevFetch; timeoutMs?: number } = {}
): Promise<JevAskResult> {
  const env = opts.env ?? process.env;
  const keyEnvName = jevKeyEnvName(env);
  const key = keyEnvName ? env[keyEnvName] : undefined;
  if (!key) {
    return {
      ok: false,
      kind: "no-key",
      reason: `no jev api key configured (set ${JEV_KEY_ENVS.join(" or ")})`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? defaultJevFetch)(systemOneEndpoint(jevBaseUrl(env)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, kind: "error", reason: `HTTP ${res.status}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { ok: false, kind: "error", reason: "malformed systemone response (not JSON)" };
    }
    const answers = parseAnswers(json, questions);
    if (answers === null) {
      return { ok: false, kind: "error", reason: "malformed systemone response (missing answers[])" };
    }
    return { ok: true, model: JEV_MODEL, answers };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      kind: "error",
      reason: controller.signal.aborted ? `request timed out: ${reason}` : reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate answers against the asked questions: unknown ids dropped, values type-checked. */
export function parseAnswers(json: unknown, questions: JevQuestion[]): JevAnswer[] | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = (json as Record<string, unknown>).answers;
  if (!Array.isArray(raw)) return null;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers: JevAnswer[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const question = byId.get(record.id);
    if (!question) continue;
    const value = record.answer;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    answers.push({ id: record.id, answer: value });
  }
  return answers;
}
