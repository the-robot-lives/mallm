/**
 * Small hand-rolled BM25 over the howtos.json index — no new dependencies,
 * no embeddings. Field weights: title/tool/tags boosted x2 over summary/os/ranges.
 */

export interface HowtoDoc {
  id: string;
  tool: string;
  title: string;
  summary: string;
  tags: string[];
  os: string[];
  ranges: Record<string, string>;
}

export interface Bm25Index {
  docs: HowtoDoc[];
  /** doc id → term → tf */
  docTerms: Map<string, Map<string, number>>;
  /** term → doc frequency */
  df: Map<string, number>;
  avgdl: number;
  k1: number;
  b: number;
}

export interface SearchHit {
  id: string;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function docText(doc: HowtoDoc): string {
  const boosted = [doc.title, doc.title, doc.tool, doc.tool, ...doc.tags, ...doc.tags];
  const plain = [doc.summary, ...doc.os, ...Object.values(doc.ranges ?? {})];
  return [...boosted, ...plain].join(" ");
}

export function buildIndex(
  docs: HowtoDoc[],
  opts: { k1?: number; b?: number } = {}
): Bm25Index {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const docTerms = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tf = new Map<string, number>();
    for (const term of tokenize(docText(doc))) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    docTerms.set(doc.id, tf);
    totalLength += tf.size;
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return {
    docs,
    docTerms,
    df,
    avgdl: docs.length > 0 ? totalLength / docs.length : 0,
    k1,
    b,
  };
}

export function search(
  index: Bm25Index,
  query: string,
  opts: { limit?: number } = {}
): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 10;
  const N = index.docs.length;

  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    const tf = index.docTerms.get(doc.id);
    if (!tf) continue;
    const dl = tf.size;
    let score = 0;
    let matched = false;
    for (const term of terms) {
      const termTf = tf.get(term);
      if (!termTf) continue;
      matched = true;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = index.avgdl > 0 ? dl / index.avgdl : 1;
      score +=
        idf *
        ((termTf * (index.k1 + 1)) /
          (termTf + index.k1 * (1 - index.b + index.b * norm)));
    }
    if (matched && score > 0) hits.push({ id: doc.id, score });
  }

  hits.sort((a, b2) => b2.score - a.score || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  return hits.slice(0, limit);
}
