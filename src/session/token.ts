import { createHash } from "node:crypto";
import { hostname } from "node:os";

/**
 * Session token mint — UUIDv5 over a unique seed, then a 4-glyph base-5744
 * encoding over the same hieroglyph charset as doc-pointers
 * (Meroitic + Egyptian Hieroglyphs + Anatolian), so tokens stay
 * scheme-compatible with the doc-pointer ecosystem.
 */

export const DNS_NAMESPACE = Buffer.from(
  "6ba7b8109dad11d180b400c04fd430c8",
  "hex"
);

/** Glyph ranges: 32 + 1072 + 4000 + 640 = 5744 code points exactly. */
export const GLYPH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x10980, 0x1099f], // Meroitic
  [0x13000, 0x1342f], // Egyptian Hieroglyphs
  [0x13460, 0x143ff], // Egyptian Hieroglyphs Supplement
  [0x14400, 0x1467f], // Anatolian Hieroglyphs
];

export const GLYPH_BASE = GLYPH_RANGES.reduce(
  (acc, [start, end]) => acc + (end - start + 1),
  0
);

export const TOKEN_LENGTH = 4;

export function uuidV5(namespace: Buffer, name: string): Buffer {
  const hash = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name, "utf-8")]))
    .digest();
  const uuid = Buffer.from(hash.subarray(0, 16));
  uuid[6] = (uuid[6] & 0x0f) | 0x50; // version 5
  uuid[8] = (uuid[8] & 0x3f) | 0x80; // RFC 4122 variant
  return uuid;
}

export function uuidToString(uuid: Buffer): string {
  const hex = uuid.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function glyphFromIndex(index: number): number {
  let remaining = index;
  for (const [start, end] of GLYPH_RANGES) {
    const size = end - start + 1;
    if (remaining < size) return start + remaining;
    remaining -= size;
  }
  throw new Error(`glyph index out of range: ${index}`);
}

export function indexFromGlyph(codePoint: number): number | null {
  let offset = 0;
  for (const [start, end] of GLYPH_RANGES) {
    const size = end - start + 1;
    if (codePoint >= start && codePoint <= end) return offset + (codePoint - start);
    offset += size;
  }
  return null;
}

function bufferToBigint(buf: Buffer): bigint {
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

/** Encode a 16-byte UUID as 4 glyphs, most-significant digit first (base-5744). */
export function encodeGlyphs(uuid: Buffer): string {
  let n = bufferToBigint(uuid);
  const indices: number[] = [];
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    indices.unshift(Number(n % BigInt(GLYPH_BASE)));
    n = n / BigInt(GLYPH_BASE);
  }
  return indices.map((i) => String.fromCodePoint(glyphFromIndex(i))).join("");
}

/** Fixed mallm session namespace: uuidv5(DNS-ns, "mallm-sessions"). */
export const MALLM_SESSION_NAMESPACE = uuidV5(DNS_NAMESPACE, "mallm-sessions");

export const MALLM_SESSION_NAMESPACE_UUID = uuidToString(
  MALLM_SESSION_NAMESPACE
);

// --- seed ---------------------------------------------------------------------

let monotonicCounter = 0;

export function nextMonotonicCounter(): number {
  monotonicCounter += 1;
  return monotonicCounter;
}

export interface TokenSeed {
  /** UTC ISO timestamp */
  iso: string;
  host: string;
  pid: number;
  counter: number;
  /** collision retry attempt; 0/undefined = first try (no suffix) */
  attempt?: number;
}

export function seedString(seed: TokenSeed): string {
  const parts = [
    "mallm-session",
    seed.iso,
    seed.host,
    String(seed.pid),
    String(seed.counter),
  ];
  if (seed.attempt !== undefined && seed.attempt > 0) {
    parts.push(String(seed.attempt));
  }
  return parts.join(":");
}

/** A fresh unique seed: UTC iso + host + pid + monotonic counter (+ attempt on retry). */
export function currentSeed(attempt?: number): TokenSeed {
  return {
    iso: new Date().toISOString(),
    host: hostname(),
    pid: process.pid,
    counter: nextMonotonicCounter(),
    attempt,
  };
}

export interface MintedToken {
  token: string;
  uuid: string;
}

export function mintSessionToken(seed: TokenSeed): MintedToken {
  const bytes = uuidV5(MALLM_SESSION_NAMESPACE, seedString(seed));
  return { token: encodeGlyphs(bytes), uuid: uuidToString(bytes) };
}

export interface MintedUniqueToken extends MintedToken {
  attempts: number;
}

/**
 * Mint a token guaranteed unique per the caller's `exists` predicate.
 * On collision, retry with an attempt-suffixed seed (fresh seed each time).
 */
export function mintUniqueToken(
  exists: (token: string) => boolean,
  seedFn: (attempt: number) => TokenSeed = currentSeed,
  maxAttempts = 8
): MintedUniqueToken {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const minted = mintSessionToken(seedFn(attempt));
    if (!exists(minted.token)) {
      return { ...minted, attempts: attempt + 1 };
    }
  }
  throw new Error(
    `session token mint failed after ${maxAttempts} collision retries`
  );
}
