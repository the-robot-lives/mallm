import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLYPH_BASE,
  GLYPH_RANGES,
  MALLM_SESSION_NAMESPACE_UUID,
  TOKEN_LENGTH,
  encodeGlyphs,
  glyphFromIndex,
  indexFromGlyph,
  mintSessionToken,
  mintUniqueToken,
  seedString,
  uuidToString,
  uuidV5,
  DNS_NAMESPACE,
} from "../src/session/token.js";

// Golden vectors computed independently from the doc-pointers reference
// algorithm (SHA-1 UUIDv5 + base-5744 big-endian division over the four
// hieroglyph ranges).
const GOLDEN_SEED = {
  iso: "2026-10-21T00:00:00.000Z",
  host: "testhost",
  pid: 4242,
  counter: 1,
};
const GOLDEN_UUID = "1dbe1295-fc34-5f2c-b86b-55861f2d0e08";
const GOLDEN_CODE_POINTS = [0x14434, 0x13cbd, 0x14098, 0x13598];

test("charset is exactly 5744 glyphs across the four ranges", () => {
  assert.equal(GLYPH_BASE, 5744);
  const sizes = GLYPH_RANGES.map(([start, end]) => end - start + 1);
  assert.deepEqual(sizes, [32, 1072, 4000, 640]);
});

test("glyphFromIndex / indexFromGlyph round-trip at range boundaries", () => {
  for (const index of [0, 31, 32, 1103, 1104, 5103, 5104, 5743]) {
    const cp = glyphFromIndex(index);
    assert.equal(indexFromGlyph(cp), index);
  }
  assert.equal(indexFromGlyph(0x1097f), null); // just below Meroitic block
  assert.equal(indexFromGlyph(0x14680), null); // just above Anatolian block
});

test("namespace constant matches the independently computed golden vector", () => {
  // uuidv5(DNS-ns, "mallm-sessions") computed out-of-band
  assert.equal(MALLM_SESSION_NAMESPACE_UUID, "51a63118-3554-5181-884e-a54807ee6bfb");
});

test("mintSessionToken matches golden UUID + glyph token", () => {
  const minted = mintSessionToken(GOLDEN_SEED);
  assert.equal(minted.uuid, GOLDEN_UUID);
  const codePoints = [...minted.token].map((c) => c.codePointAt(0) as number);
  assert.deepEqual(codePoints, GOLDEN_CODE_POINTS);
  assert.equal(codePoints.length, TOKEN_LENGTH);
});

test("seedString carries the attempt suffix only on retries", () => {
  assert.equal(
    seedString({ ...GOLDEN_SEED }),
    "mallm-session:2026-10-21T00:00:00.000Z:testhost:4242:1"
  );
  assert.equal(
    seedString({ ...GOLDEN_SEED, attempt: 1 }),
    "mallm-session:2026-10-21T00:00:00.000Z:testhost:4242:1:1"
  );
});

test("minting is deterministic for identical seeds", () => {
  const a = mintSessionToken({ ...GOLDEN_SEED });
  const b = mintSessionToken({ ...GOLDEN_SEED });
  assert.deepEqual(a, b);
});

test("different seeds produce different tokens", () => {
  const a = mintSessionToken({ ...GOLDEN_SEED, counter: 1 });
  const b = mintSessionToken({ ...GOLDEN_SEED, counter: 2 });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.uuid, b.uuid);
});

test("every minted glyph lands inside the charset ranges", () => {
  for (let counter = 1; counter <= 25; counter++) {
    const { token } = mintSessionToken({ ...GOLDEN_SEED, counter });
    for (const ch of [...token]) {
      const cp = ch.codePointAt(0) as number;
      const inRange = GLYPH_RANGES.some(([start, end]) => cp >= start && cp <= end);
      assert.ok(inRange, `code point ${cp.toString(16)} out of range`);
    }
  }
});

test("collision retry uses an attempt-suffixed seed", () => {
  const first = mintSessionToken({ ...GOLDEN_SEED, counter: 7 });
  let collisions = 0;
  const minted = mintUniqueToken(
    (token) => {
      collisions += 1;
      return token === first.token; // first mint collides, second is free
    },
    (attempt) => ({ ...GOLDEN_SEED, counter: 7, attempt })
  );
  assert.equal(minted.attempts, 2);
  assert.equal(collisions, 2);
  assert.notEqual(minted.token, first.token);
});

test("exhausted retries throw instead of looping forever", () => {
  assert.throws(
    () =>
      mintUniqueToken(
        () => true,
        (attempt) => ({ ...GOLDEN_SEED, counter: 9, attempt }),
        3
      ),
    /failed after 3 collision retries/
  );
});

test("uuidV5 sets version 5 and RFC 4122 variant bits", () => {
  const uuid = uuidV5(DNS_NAMESPACE, "example.com");
  const hex = uuid.toString("hex");
  assert.equal(hex.slice(12, 16).startsWith("5"), true);
  assert.equal(parseInt(hex.slice(16, 18), 16) >> 6, 0b10);
  assert.match(uuidToString(uuid), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal([...encodeGlyphs(uuid)].length, 4); // astral glyphs: 4 code points, 8 UTF-16 units
});
