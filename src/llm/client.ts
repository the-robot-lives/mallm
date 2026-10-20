import type { InferenceConfig } from "../config/types.js";

/**
 * Minimal OpenAI-compatible chat client. Every consumer must degrade
 * gracefully when inference is unconfigured: `chat` returns a typed
 * "no-inference" result and NEVER throws.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatResult =
  | { ok: true; content: string; usage?: Record<string, unknown> }
  | { ok: false; kind: "no-inference"; reason: string }
  | { ok: false; kind: "error"; reason: string };

export const DEFAULT_CHAT_TIMEOUT_MS = 30_000;

export function isConfigured(inference: InferenceConfig): boolean {
  return Boolean(inference.baseUrl && inference.model);
}

export function chatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export interface ChatFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type ChatFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<ChatFetchResponse>;

const defaultChatFetch: ChatFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<ChatFetchResponse>;

export async function chat(
  messages: ChatMessage[],
  opts: {
    inference: InferenceConfig;
    timeoutMs?: number;
    fetchImpl?: ChatFetch;
    env?: Record<string, string | undefined>;
  }
): Promise<ChatResult> {
  const inference = opts.inference;
  if (!isConfigured(inference)) {
    return {
      ok: false,
      kind: "no-inference",
      reason: "inference not configured (config.inference needs baseUrl and model)",
    };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (inference.apiKeyEnv) {
    const key = (opts.env ?? process.env)[inference.apiKeyEnv];
    if (!key) {
      return {
        ok: false,
        kind: "error",
        reason: `api key env ${inference.apiKeyEnv} is not set`,
      };
    }
    headers.authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  );
  try {
    const res = await (opts.fetchImpl ?? defaultChatFetch)(
      chatEndpoint(inference.baseUrl as string),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ model: inference.model, messages }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      return { ok: false, kind: "error", reason: `HTTP ${res.status}` };
    }
    const json = JSON.parse(await res.text()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: Record<string, unknown>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { ok: false, kind: "error", reason: "malformed chat response (missing choices[0].message.content)" };
    }
    return { ok: true, content, usage: json.usage };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, kind: "error", reason: controller.signal.aborted ? `request timed out: ${reason}` : reason };
  } finally {
    clearTimeout(timer);
  }
}
