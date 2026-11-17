// Git ignore rules (.gitignore, .git/info/exclude), evaluated like git does:
// - a pattern without "/" (other than a trailing one) matches at any depth below its .gitignore,
//   a pattern with a "/" is anchored to the directory of its .gitignore;
// - a trailing "/" only matches directories, "!" re-includes, the last matching rule wins and
//   rules of deeper .gitignore files win over the shallower ones;
// - a file inside an ignored directory is ignored, whatever "!" rules say (git does not even
//   look inside ignored directories).
// Pure module (no vscode, no fs) so it can be unit tested.

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
const escapeRe = (s: string) => s.replace(REGEX_SPECIAL, '\\$&');

/** Converts the body of a gitignore pattern (wildmatch syntax) to a regular expression source. */
function patternSource(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        const atEnd = i + 2 === p.length || p[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === p.length) {
            // "abc/**": everything inside abc
            out += '.*';
            i += 1;
          } else {
            // "**/x" or "a/**/x": zero or more directories
            out += '(?:.*/)?';
            i += 2;
          }
          continue;
        }
        i++; // "a**b" behaves like "a*b"
      }
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let body = p.slice(i + 1, end);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      out += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`;
      i = end;
    } else if (c === '\\' && i + 1 < p.length) {
      out += escapeRe(p[++i]);
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

/**
 * Parses the content of an ignore file. `base` is the directory of that file relative to the
 * matching root, with "/" separators and no leading or trailing slash ("" for the root).
 */
export function parseGitignore(content: string, base: string, ignoreCase: boolean): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const prefix = base ? escapeRe(base) + '/' : '';
  for (let line of content.split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    // trailing spaces are ignored unless escaped
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = patternSource(line);
    const src = `^${prefix}${anchored ? '' : '(?:.*/)?'}${body}$`;
    try {
      rules.push({ re: new RegExp(src, ignoreCase ? 'i' : ''), negate, dirOnly });
    } catch {
      /* invalid pattern: git ignores it too */
    }
  }
  return rules;
}

/** Rules of one directory: ignore files at the same level are merged (info/exclude first). */
interface Level {
  base: string;
  rules: IgnoreRule[];
}

export class IgnoreMatcher {
  private levels = new Map<string, Level>();
  private dirCache = new Map<string, boolean>();
  readonly ignoreCase: boolean;

  constructor(ignoreCase: boolean) {
    this.ignoreCase = ignoreCase;
  }

  /** Adds the content of an ignore file located in `base` (relative to the root). */
  add(base: string, content: string) {
    base = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const key = this.ignoreCase ? base.toLowerCase() : base;
    const rules = parseGitignore(content, base, this.ignoreCase);
    if (!rules.length) return;
    const level = this.levels.get(key);
    if (level) level.rules.push(...rules);
    else this.levels.set(key, { base, rules });
    this.dirCache.clear();
  }

  get size() {
    let n = 0;
    for (const l of this.levels.values()) n += l.rules.length;
    return n;
  }

  /** Last matching rule, from the deepest level to the root: true = ignored, false = re-included, undefined = no rule. */
  private match(rel: string, isDir: boolean): boolean | undefined {
    const key = this.ignoreCase ? rel.toLowerCase() : rel;
    // ancestors of rel, deepest first: "a/b/c" → "a/b", "a", ""
    let end = key.length;
    while (true) {
      end = key.lastIndexOf('/', end - 1);
      const level = this.levels.get(end < 0 ? '' : key.slice(0, end));
      if (level) {
        for (let i = level.rules.length - 1; i >= 0; i--) {
          const r = level.rules[i];
          if (r.dirOnly && !isDir) continue;
          if (r.re.test(rel)) return !r.negate;
        }
      }
      if (end < 0) return undefined;
    }
  }

  private dirIgnored(dir: string): boolean {
    if (!dir) return false;
    const cached = this.dirCache.get(dir);
    if (cached !== undefined) return cached;
    const slash = dir.lastIndexOf('/');
    const v = this.dirIgnored(slash < 0 ? '' : dir.slice(0, slash)) || this.match(dir, true) === true;
    this.dirCache.set(dir, v);
    return v;
  }

  /** Is the path (relative to the root, "/" separators) ignored? */
  ignores(rel: string, isDir = false): boolean {
    if (!this.levels.size) return false;
    rel = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rel) return false;
    const slash = rel.lastIndexOf('/');
    if (slash >= 0 && this.dirIgnored(rel.slice(0, slash))) return true;
    return isDir ? this.dirIgnored(rel) : this.match(rel, false) === true;
  }
}
