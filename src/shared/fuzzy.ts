// A fuzzy matcher modelled after IntelliJ's MinusculeMatcher ("CamelHumps").
//
//  - "UsCo", "uco", "user con"  → UserController
//  - "*troller"                 → anything containing "troller" without penalty
//  - trailing space             → the name must end with the last fragment
//  - upper-case letters / word starts / contiguous runs are rewarded,
//    jumping into the middle of a word is penalised.
//
// The result contains a score (higher is better) and the matched ranges
// (flat [start, end) pairs) used to highlight the name in the UI.

export interface FuzzyResult {
  score: number;
  ranges: number[];
}

export interface CompiledPattern {
  raw: string;
  chars: string; // pattern chars without wildcards / spaces
  lower: string;
  /** wildcard[i] === true if a '*' or ' ' preceded chars[i] */
  wildcard: boolean[];
  leadingWildcard: boolean;
  requireEnd: boolean;
}

export function compilePattern(raw: string): CompiledPattern {
  const requireEnd = /\S\s$/.test(raw);
  const trimmed = raw.trim();
  let chars = '';
  const wildcard: boolean[] = [];
  let pendingWild = false;
  for (const ch of trimmed) {
    if (ch === '*' || ch === ' ') {
      pendingWild = true;
      continue;
    }
    chars += ch;
    wildcard.push(pendingWild);
    pendingWild = false;
  }
  return {
    raw,
    chars,
    lower: chars.toLowerCase(),
    wildcard,
    leadingWildcard: trimmed.startsWith('*') || trimmed.startsWith(' '),
    requireEnd,
  };
}

const NEG = -1e9;

function isUpper(c: number) {
  return c >= 65 && c <= 90;
}
function isLower(c: number) {
  return c >= 97 && c <= 122;
}
function isDigit(c: number) {
  return c >= 48 && c <= 57;
}
function isSeparator(c: number) {
  // _ - . / \ space $ : # @
  return c === 95 || c === 45 || c === 46 || c === 47 || c === 92 || c === 32 || c === 36 || c === 58 || c === 35 || c === 64;
}

/** Word-start flags for a name ("camel humps", separators, digits). */
function wordStarts(name: string): Uint8Array {
  const n = name.length;
  const ws = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const c = name.charCodeAt(j);
    if (j === 0) {
      ws[j] = 1;
      continue;
    }
    const p = name.charCodeAt(j - 1);
    if (isSeparator(p) && !isSeparator(c)) ws[j] = 1;
    else if (isUpper(c) && (isLower(p) || isDigit(p))) ws[j] = 1;
    else if (isUpper(c) && isUpper(p) && j + 1 < n && isLower(name.charCodeAt(j + 1))) ws[j] = 1; // HTTPServer → S
    else if (isDigit(c) && !isDigit(p)) ws[j] = 1;
  }
  return ws;
}

/** Fast rejection: are all pattern chars present in order (case-insensitive)? */
export function isSubsequence(patLower: string, nameLower: string): boolean {
  let j = 0;
  const n = nameLower.length;
  for (let i = 0; i < patLower.length; i++) {
    const c = patLower.charCodeAt(i);
    while (j < n && nameLower.charCodeAt(j) !== c) j++;
    if (j === n) return false;
    j++;
  }
  return true;
}

export function fuzzyMatch(p: CompiledPattern, name: string, nameLower = name.toLowerCase()): FuzzyResult | null {
  const m = p.chars.length;
  const n = name.length;
  if (m === 0) return { score: 0, ranges: [] };
  if (m > n) return null;
  if (!isSubsequence(p.lower, nameLower)) return null;

  const ws = wordStarts(name);
  // dp[i*n + j]: best score with pattern[i] matched at name[j]
  const dp = new Float64Array(m * n).fill(NEG);
  const back = new Int32Array(m * n).fill(-1);

  for (let i = 0; i < m; i++) {
    const pc = p.lower.charCodeAt(i);
    const pRaw = p.chars.charCodeAt(i);
    const upperPat = isUpper(pRaw);
    const wild = p.wildcard[i];
    // running best of row i-1 over [0, j-2]
    let bestPrev = NEG;
    let bestPrevIdx = -1;
    for (let j = i; j < n; j++) {
      if (i > 0 && j >= 2) {
        const v = dp[(i - 1) * n + (j - 2)];
        if (v > bestPrev) {
          bestPrev = v;
          bestPrevIdx = j - 2;
        }
      }
      if (nameLower.charCodeAt(j) !== pc) continue;
      const nc = name.charCodeAt(j);
      let charScore = 1;
      if (ws[j]) charScore += 3;
      if (pRaw === nc) charScore += 0.5; // exact case
      if (upperPat && !ws[j]) charScore -= 4; // an upper-case pattern letter should start a hump

      if (i === 0) {
        let start: number;
        if (j === 0) start = 15;
        else if (ws[j]) start = 8;
        else start = p.leadingWildcard ? 0 : -8;
        dp[j] = charScore + start;
        continue;
      }
      let best = NEG;
      let from = -1;
      // contiguous
      if (j >= 1) {
        const v = dp[(i - 1) * n + (j - 1)];
        if (v > NEG) {
          const c = v + (wild ? 0 : 6);
          if (c > best) {
            best = c;
            from = j - 1;
          }
        }
      }
      // jump
      if (bestPrev > NEG) {
        const c = bestPrev + (ws[j] ? 3 : wild ? 0 : -6);
        if (c > best) {
          best = c;
          from = bestPrevIdx;
        }
      }
      if (from >= 0) {
        dp[i * n + j] = best + charScore;
        back[i * n + j] = from;
      }
    }
  }

  // best end position
  let bestScore = NEG;
  let endIdx = -1;
  const last = (m - 1) * n;
  for (let j = m - 1; j < n; j++) {
    const v = dp[last + j];
    if (v > bestScore) {
      bestScore = v;
      endIdx = j;
    }
  }
  if (endIdx < 0) return null;
  if (p.requireEnd && endIdx !== n - 1) return null;

  // backtrack
  const pos = new Array<number>(m);
  let j = endIdx;
  for (let i = m - 1; i >= 0; i--) {
    pos[i] = j;
    j = back[i * n + j];
  }
  const ranges: number[] = [];
  for (let i = 0; i < m; i++) {
    const s = pos[i];
    if (ranges.length && ranges[ranges.length - 1] === s) ranges[ranges.length - 1] = s + 1;
    else ranges.push(s, s + 1);
  }

  let score = bestScore;
  if (nameLower === p.lower) score += name === p.chars ? 120 : 100;
  else if (nameLower.startsWith(p.lower)) score += 40;
  if (endIdx === n - 1) score += 4;
  // prefer shorter names
  score -= n * 0.15;
  return { score, ranges };
}

/** Shifts ranges by an offset (used when matching a suffix of a longer string). */
export function shiftRanges(r: number[], by: number): number[] {
  return by === 0 ? r : r.map((x) => x + by);
}
