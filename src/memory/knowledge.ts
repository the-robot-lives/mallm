import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * knowledge.yaml — `{topics: [{id, name, confidence 0-10, lastSeen, sources[]}]}`
 * with read/update helpers. Helpers are path-parametric so tests (and other
 * CLIs) can point them at temp dirs.
 */

export interface KnowledgeTopic {
  id: string;
  name: string;
  /** 0–10 */
  confidence: number;
  lastSeen: string;
  sources: string[];
}

export interface Knowledge {
  topics: KnowledgeTopic[];
}

export function emptyKnowledge(): Knowledge {
  return { topics: [] };
}

function sanitizeTopics(raw: unknown): KnowledgeTopic[] {
  if (!Array.isArray(raw)) return [];
  const topics: KnowledgeTopic[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") continue;
    topics.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      confidence:
        typeof record.confidence === "number" && Number.isFinite(record.confidence)
          ? Math.min(10, Math.max(0, record.confidence))
          : 0,
      lastSeen:
        typeof record.lastSeen === "string" ? record.lastSeen : new Date().toISOString(),
      sources: Array.isArray(record.sources)
        ? record.sources.filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return topics.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function readKnowledge(path: string): Knowledge {
  if (!existsSync(path)) return emptyKnowledge();
  try {
    const parsed = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown> | null;
    return { topics: sanitizeTopics(parsed?.topics) };
  } catch {
    return emptyKnowledge();
  }
}

/** Persist knowledge.yaml (sorted by topic id, matching upsertTopic's ordering). */
export function writeKnowledge(path: string, knowledge: Knowledge): void {
  const sorted: Knowledge = {
    topics: [...knowledge.topics].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(sorted, { lineWidth: 100 }));
}

export interface TopicUpdate {
  id: string;
  name?: string;
  confidence?: number;
  lastSeen?: string;
  sources?: string[];
}

/** Insert or merge a topic by id: name overwrites, confidence takes the max, sources union, lastSeen refreshes. */
export function upsertTopic(path: string, update: TopicUpdate): Knowledge {
  const knowledge = readKnowledge(path);
  const existing = knowledge.topics.find((t) => t.id === update.id);
  const now = new Date().toISOString();

  if (existing) {
    existing.name = update.name ?? existing.name;
    existing.confidence = Math.min(
      10,
      Math.max(existing.confidence, update.confidence ?? existing.confidence)
    );
    existing.lastSeen = update.lastSeen ?? now;
    existing.sources = [
      ...new Set([...existing.sources, ...(update.sources ?? [])]),
    ].sort();
  } else {
    knowledge.topics.push({
      id: update.id,
      name: update.name ?? update.id,
      confidence: Math.min(10, Math.max(0, update.confidence ?? 0)),
      lastSeen: update.lastSeen ?? now,
      sources: [...(update.sources ?? [])].sort(),
    });
    knowledge.topics.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(knowledge, { lineWidth: 100 }));
  return knowledge;
}
