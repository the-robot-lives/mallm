import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "../session/kv.js";
import { redact } from "./redactor.js";
import type { RedactionRuleId } from "./redactor.js";

export type EnvLike = Record<string, string | undefined>;

/**
 * Append-only action history at `~/.local/share/mallm/history.jsonl`.
 * Every record is redacted STRICTLY before the write — there is no raw
 * escape hatch (no flag, no parameter, no bypass).
 */

export interface HistoryRecord {
  ts: string;
  session: string;
  action: string;
  command: string;
  files: string[];
  outcome: string;
  redactions: RedactionRuleId[];
}

export function historyPath(env: EnvLike = process.env): string {
  return join(dataHome(env), "mallm", "history.jsonl");
}

export interface HistoryInput {
  session: string;
  action: string;
  command: string;
  files: string[];
  outcome: string;
}

/**
 * Redact every string field, then append one JSONL line.
 * Returns the record as written.
 */
export function appendHistory(
  input: HistoryInput,
  opts: { env?: EnvLike; extraPatterns?: readonly string[]; now?: Date } = {}
): HistoryRecord {
  const extra = opts.extraPatterns ?? [];
  const action = redact(input.action, extra);
  const command = redact(input.command, extra);
  const outcome = redact(input.outcome, extra);
  const files = input.files.map((f) => redact(f, extra));
  const applied = [
    ...new Set([...action.applied, ...command.applied, ...outcome.applied, ...files.flatMap((f) => f.applied)]),
  ];

  const record: HistoryRecord = {
    ts: (opts.now ?? new Date()).toISOString(),
    session: input.session,
    action: action.text,
    command: command.text,
    files: files.map((f) => f.text),
    outcome: outcome.text,
    redactions: applied,
  };

  const path = historyPath(opts.env ?? process.env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  return record;
}

export function readHistory(
  opts: { session?: string; tail?: number; env?: EnvLike; path?: string } = {}
): HistoryRecord[] {
  const path = opts.path ?? historyPath(opts.env ?? process.env);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const records: HistoryRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as HistoryRecord;
      if (typeof parsed?.ts === "string" && typeof parsed?.action === "string") {
        records.push(parsed);
      }
    } catch {
      // skip corrupt lines — history is append-only but never a hard dependency
    }
  }
  const filtered = opts.session
    ? records.filter((r) => r.session === opts.session)
    : records;
  return typeof opts.tail === "number" && opts.tail >= 0
    ? filtered.slice(-opts.tail)
    : filtered;
}
