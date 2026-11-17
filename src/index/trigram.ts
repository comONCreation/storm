// Trigram index primitives.
//
// Every file is reduced to the set of (case-folded) 3-character sequences it
// contains. A text query can only match files that contain *all* trigrams of
// its mandatory literals, so intersecting a handful of posting lists turns a
// full project scan into a scan of a few candidate files. This is the same
// idea as IntelliJ's TrigramIndex used by "Find in Files".

/** Folds a UTF-16 code unit to an 8-bit bucket (lower-cased). Collisions only add false positives. */
const foldCache = new Map<number, number>();
export function foldChar(c: number): number {
  if (c < 128) return c >= 65 && c <= 90 ? c + 32 : c;
  let f = foldCache.get(c);
  if (f === undefined) {
    const lower = String.fromCharCode(c).toLowerCase();
    const lc = lower.length === 1 ? lower.charCodeAt(0) : c;
    f = 128 + (lc % 127);
    foldCache.set(c, f);
  }
  return f;
}

const BITMAP = new Uint8Array(1 << 21); // 2^24 bits
let scratch = new Uint32Array(1 << 16);

/** Returns the distinct trigrams of a text (unsorted). */
export function trigramsOf(text: string): Uint32Array {
  let count = 0;
  let a = 0;
  let b = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const m = foldChar(text.charCodeAt(i));
    if (i >= 2) {
      const t = (a << 16) | (b << 8) | m;
      const byte = t >>> 3;
      const bit = 1 << (t & 7);
      if ((BITMAP[byte] & bit) === 0) {
        BITMAP[byte] |= bit;
        if (count === scratch.length) {
          const bigger = new Uint32Array(scratch.length * 2);
          bigger.set(scratch);
          scratch = bigger;
        }
        scratch[count++] = t;
      }
    }
    a = b;
    b = m;
  }
  const out = scratch.slice(0, count);
  for (let i = 0; i < count; i++) BITMAP[out[i] >>> 3] = 0;
  return out;
}

/** Trigrams of a literal fragment (duplicates allowed). */
export function queryTrigrams(literal: string): number[] {
  const out: number[] = [];
  for (let i = 2; i < literal.length; i++) {
    out.push((foldChar(literal.charCodeAt(i - 2)) << 16) | (foldChar(literal.charCodeAt(i - 1)) << 8) | foldChar(literal.charCodeAt(i)));
  }
  return out;
}
