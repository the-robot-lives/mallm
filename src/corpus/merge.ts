import type { MallmSource, SourceKind } from "../config/types.js";
import { DEFAULT_SOURCE_PRIORITY } from "../config/types.js";
import type { SyncResult } from "./adapters.js";

export interface MergedDoc {
  name: string;
  doc: Record<string, unknown>;
  sourceName: string;
  sourceKind: SourceKind;
  priority: number;
}

/**
 * Priority-ordered merge: lower priority number = higher precedence.
 * Ties break on source name (ascending) so merges stay deterministic.
 * The winning source is recorded as provenance on each merged doc.
 */
export function mergeCorpus(results: SyncResult[]): Map<string, MergedDoc> {
  const ordered = [...results]
    .filter((r) => r.ok)
    .map((r) => ({ r, p: r.source.priority ?? DEFAULT_SOURCE_PRIORITY }))
    .sort(
      (a, b) =>
        a.p - b.p ||
        (a.r.source.name < b.r.source.name
          ? -1
          : a.r.source.name > b.r.source.name
            ? 1
            : 0)
    );

  const merged = new Map<string, MergedDoc>();
  for (const { r, p } of ordered) {
    for (const d of r.docs) {
      if (merged.has(d.name)) continue;
      merged.set(d.name, {
        name: d.name,
        doc: d.doc,
        sourceName: r.source.name,
        sourceKind: r.source.kind,
        priority: p,
      });
    }
  }
  return merged;
}
