// Query compilation helpers shared by the worker (search) and the webview (preview highlighting).

import type { TextQuery } from './protocol';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/** Builds the regular expression source for a query, or throws on an invalid pattern. */
export function buildSource(q: TextQuery): string {
  let src: string;
  if (q.regex) {
    src = q.query;
  } else {
    // Literal search: line separators are normalised so that a multi-line query
    // matches both LF and CRLF files (PhpStorm does the same).
    src = q.query
      .split(/\r?\n/)
      .map(escapeRegExp)
      .join('\\r?\\n');
  }
  if (q.words) {
    src = `(?<!\\w)(?:${src})(?!\\w)`;
  }
  return src;
}

export function buildRegExp(q: TextQuery, global = true): RegExp {
  const flags = (global ? 'g' : '') + (q.matchCase ? '' : 'i') + 'm';
  return new RegExp(buildSource(q), flags);
}

export function tryBuildRegExp(q: TextQuery, global = true): RegExp | string {
  try {
    return buildRegExp(q, global);
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e);
  }
}

/**
 * Extracts literal fragments that any match MUST contain. They are used to
 * query the trigram index. Returning an empty array means "no filtering possible".
 */
export function requiredLiterals(q: TextQuery): string[] {
  if (!q.query) return [];
  if (!q.regex) {
    return q.query.split(/\r?\n/).filter((s) => s.length >= 3);
  }
  return regexLiterals(q.query).filter((s) => s.length >= 3);
}

function regexLiterals(src: string): string[] {
  const out: string[] = [];
  let run = '';
  let depth = 0;
  const flush = () => {
    if (run.length) out.push(run);
    run = '';
  };
  /** Kind of quantifier starting at j: optional (?, *, {0..}), repeated (+, {n..}) or none. */
  const quantAt = (j: number): 'opt' | 'rep' | null => {
    const c = src[j];
    if (c === '?' || c === '*') return 'opt';
    if (c === '+') return 'rep';
    if (c === '{') {
      const m = /^\{(\d+)(,\d*)?\}/.exec(src.slice(j));
      if (m) return m[1] === '0' ? 'opt' : 'rep';
    }
    return null;
  };
  const closing = (from: number, ch: string) => {
    const k = src.indexOf(ch, from);
    return k < 0 ? src.length : k + 1;
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    let lit: string | null = null;
    let next = i + 1;
    if (ch === '\\') {
      const e = src[i + 1];
      if (e === undefined) break;
      next = i + 2;
      if (/[dDwWsSbBpPkcux0-9nrtfv]/.test(e)) {
        if (e === 'u') next = src[i + 2] === '{' ? closing(i, '}') : i + 6;
        else if (e === 'x') next = i + 4;
        else if ((e === 'p' || e === 'P') && src[i + 2] === '{') next = closing(i, '}');
        else if (e === 'c') next = i + 3;
        else if (e === 'k' && src[i + 2] === '<') next = closing(i, '>');
      } else {
        lit = e;
      }
    } else if (ch === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '\\') j++;
        j++;
      }
      next = j + 1;
    } else if (ch === '(') {
      if (depth === 0) flush();
      depth++;
      i++;
      continue;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    } else if (ch === '|') {
      if (depth === 0) return []; // top-level alternation: nothing is mandatory
    } else if ('.^$?*+{}'.includes(ch)) {
      // meta character: breaks the run
    } else {
      lit = ch;
    }
    i = next;
    if (depth > 0) continue;
    const q = quantAt(next);
    if (lit === null || q === 'opt') {
      flush();
    } else if (q === 'rep') {
      run += lit;
      flush();
    } else {
      run += lit;
    }
  }
  flush();
  return out;
}

// ---------- Glob / file mask ----------

export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBrace++;
      re += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace--;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else if (c === '\\') {
      re += '/';
    } else {
      re += escapeRegExp(c);
    }
    i++;
  }
  return new RegExp('^' + re + '$', 'i');
}

export interface MaskMatcher {
  (relPath: string, fileName: string): boolean;
}

/**
 * PhpStorm-style file mask: comma separated globs, "!" negates.
 * Globs without "/" are matched against the file name, others against the relative path.
 */
export function compileMask(mask: string): MaskMatcher | undefined {
  const parts = mask.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const pos: Array<{ re: RegExp; path: boolean }> = [];
  const neg: Array<{ re: RegExp; path: boolean }> = [];
  for (const p of parts) {
    const negative = p.startsWith('!');
    const g = negative ? p.slice(1) : p;
    if (!g) continue;
    const entry = { re: globToRegExp(g.replace(/\\/g, '/')), path: g.includes('/') || g.includes('\\') };
    (negative ? neg : pos).push(entry);
  }
  return (rel, name) => {
    const test = (e: { re: RegExp; path: boolean }) => e.re.test(e.path ? rel : name);
    if (neg.some(test)) return false;
    return pos.length === 0 || pos.some(test);
  };
}
