import type { MergedDoc } from "../corpus/index.js";
import type { HowtoDoc } from "./bm25.js";

/**
 * Corpus docs → BM25-indexable HowtoDoc[]:
 * - one doc-level entry per corpus doc (name/tool/title/summary/tags/os/ranges)
 * - one extra entry per `howtos[]` section (written back by `mallm how-to`),
 *   so freshly written-back how-tos are searchable immediately. The script
 *   body is truncated before it enters the index so huge scripts don't swamp
 *   field-length normalization.
 */

const SCRIPT_INDEX_LIMIT = 500;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function howtoDocsFromCorpus(merged: Map<string, MergedDoc>): HowtoDoc[] {
  const docs: HowtoDoc[] = [];
  for (const { name, doc } of merged.values()) {
    docs.push({
      id: name,
      tool: name,
      title: str(doc.title) ?? name,
      summary: str(doc.summary) ?? "",
      tags: strings(doc.tags),
      os: strings(doc.os),
      ranges:
        doc.ranges && typeof doc.ranges === "object" && !Array.isArray(doc.ranges)
          ? Object.fromEntries(
              Object.entries(doc.ranges as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string"
              )
            )
          : {},
    });

    if (Array.isArray(doc.howtos)) {
      doc.howtos.forEach((entry, i) => {
        if (typeof entry !== "object" || entry === null) return;
        const section = entry as Record<string, unknown>;
        const script =
          typeof section.script === "string" ? section.script.slice(0, SCRIPT_INDEX_LIMIT) : "";
        docs.push({
          id: `${name}#${i}`,
          tool: name,
          title: str(section.title) ?? str(section.goal) ?? `${name} how-to ${i + 1}`,
          summary: str(section.goal) ?? "",
          tags: strings(section.tags),
          os: strings(section.os),
          ranges: script ? { script } : {},
        });
      });
    }
  }
  return docs;
}
