// Tiny syntax highlighter for the preview pane. It is intentionally simple
// (no grammar), fast, and good enough to give the preview the look of an editor.

export type Seg = [start: number, end: number, cls: string];

interface LangDef {
  line?: string[];
  block?: Array<[string, string]>;
  strings?: string[];
  multilineStrings?: boolean;
  triple?: boolean;
  keywords?: Set<string>;
  kwInsensitive?: boolean;
  varPrefix?: string;
  tags?: boolean;
  keysBeforeColon?: boolean;
}

const kw = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Keywords that TextMate grammars scope as keyword.control (if, return…), unlike declarations (class, public…). */
const CONTROL_KEYWORDS = kw(
  'if else elseif elif for foreach while do switch case default break continue return try catch finally except raise throw yield match await goto ' +
    'endif endforeach endfor endwhile endswitch enddeclare unless until loop when then begin rescue ensure end fi done esac',
);

const C_LIKE_KW = 'if else for while do switch case default break continue return function class interface extends implements new delete typeof instanceof this super null true false try catch finally throw throws import export from as const let var static public private protected abstract final void int long float double char boolean byte short enum struct namespace using package yield async await in of';

const LANGS: Record<string, LangDef> = {
  php: {
    line: ['//', '#'],
    block: [['/*', '*/']],
    strings: ['"', "'", '`'],
    multilineStrings: true,
    varPrefix: '$',
    keywords: kw(
      'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield null true false self parent int float string bool void mixed never object iterable',
    ),
    kwInsensitive: true,
  },
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'", '`'],
    keywords: kw(C_LIKE_KW + ' type declare readonly keyof infer satisfies undefined get set constructor debugger with any unknown never string number boolean symbol bigint object'),
  },
  py: {
    line: ['#'],
    strings: ['"', "'"],
    triple: true,
    keywords: kw('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls match case'),
  },
  ruby: { line: ['#'], strings: ['"', "'"], keywords: kw('def end class module if elsif else unless while until for in do return yield self nil true false and or not begin rescue ensure raise require require_relative include extend attr_accessor attr_reader attr_writer lambda proc then when case super private protected public') },
  sh: { line: ['#'], strings: ['"', "'"], varPrefix: '$', keywords: kw('if then else elif fi for while do done case esac function return in export local echo exit set unset source') },
  sql: { line: ['--', '#'], block: [['/*', '*/']], strings: ["'", '"', '`'], kwInsensitive: true, keywords: kw('select from where and or not insert into values update set delete create table alter drop index primary key foreign references join left right inner outer on as group by order having limit offset distinct union all null is like in between exists case when then else end default auto_increment unique varchar int integer text datetime timestamp boolean if begin commit rollback view trigger procedure function returns') },
  css: { block: [['/*', '*/']], line: ['//'], strings: ['"', "'"], keysBeforeColon: true },
  html: { block: [['<!--', '-->'], ['{{--', '--}}'], ['{#', '#}']], strings: ['"', "'"], tags: true },
  json: { line: ['//'], block: [['/*', '*/']], strings: ['"'], keywords: kw('true false null'), keysBeforeColon: true },
  yaml: { line: ['#'], strings: ['"', "'"], keywords: kw('true false null yes no on off'), keysBeforeColon: true },
  md: { strings: ['`'] },
  clike: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'], keywords: kw(C_LIKE_KW + ' fn impl pub mut let match mod crate trait where loop use go func chan defer map range select type interface struct val var fun when object override sealed data internal lateinit companion is open string bool decimal virtual override readonly out ref params base sizeof unsafe goto auto register extern union typedef signed unsigned volatile inline template typename') },
  plain: {},
};

const EXT: Record<string, string> = {
  php: 'php', phtml: 'php', inc: 'php', module: 'php',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', javascript: 'js', typescript: 'js', javascriptreact: 'js', typescriptreact: 'js',
  py: 'py', pyi: 'py', python: 'py',
  rb: 'ruby', rake: 'ruby', ruby: 'ruby',
  sh: 'sh', bash: 'sh', zsh: 'sh', shellscript: 'sh', env: 'sh', dotenv: 'sh', ini: 'sh', properties: 'sh', conf: 'sh', toml: 'sh', dockerfile: 'sh', makefile: 'sh',
  sql: 'sql', mysql: 'sql',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', twig: 'html', blade: 'html', xhtml: 'html', xsd: 'html', xsl: 'html', 'jinja-html': 'html',
  json: 'json', jsonc: 'json', json5: 'json', lock: 'json',
  yml: 'yaml', yaml: 'yaml', neon: 'yaml',
  md: 'md', markdown: 'md',
  java: 'clike', kt: 'clike', kts: 'clike', cs: 'clike', csharp: 'clike', go: 'clike', rs: 'clike', rust: 'clike', c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike', swift: 'clike', dart: 'clike', scala: 'clike', groovy: 'clike', kotlin: 'clike',
  txt: 'plain', plaintext: 'plain', log: 'plain', csv: 'plain',
};

export function langFor(languageId: string, path: string): LangDef {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name.endsWith('.blade.php')) return LANGS.html;
  const byId = EXT[languageId.toLowerCase()];
  if (byId) return LANGS[byId];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return LANGS[EXT[ext] ?? 'clike'];
}

const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
const isId = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

/** Returns per-line segments (offsets relative to each line). */
export function tokenize(text: string, lang: LangDef): Seg[][] {
  const segs: Seg[] = [];
  const n = text.length;
  let i = 0;
  let inTag = false;
  const startsWith = (s: string, at: number) => text.startsWith(s, at);
  if (text.length > 3_000_000) return splitLines(text, []);
  outer: while (i < n) {
    const c = text.charCodeAt(i);
    // comments
    if (lang.block) {
      for (const [open, close] of lang.block) {
        if (startsWith(open, i)) {
          const end = text.indexOf(close, i + open.length);
          const e = end < 0 ? n : end + close.length;
          segs.push([i, e, 'c']);
          i = e;
          continue outer;
        }
      }
    }
    if (lang.line && !inTag) {
      for (const l of lang.line) {
        if (startsWith(l, i)) {
          // "#" in PHP attributes "#[" or CSS colors are not comments
          if (l === '#' && (text[i + 1] === '[' || lang === LANGS.css)) break;
          if (l === '//' && i > 0 && text[i - 1] === ':') break; // URLs
          let e = text.indexOf('\n', i);
          if (e < 0) e = n;
          segs.push([i, e, 'c']);
          i = e;
          continue outer;
        }
      }
    }
    // tags (html/xml/vue/blade)
    if (lang.tags) {
      if (c === 60 /* < */ && (isIdStart(text.charCodeAt(i + 1)) || text[i + 1] === '/' || text[i + 1] === '!' || text[i + 1] === '?')) {
        let j = i + 1;
        while (j < n && (isId(text.charCodeAt(j)) || '/!?-:.'.includes(text[j]))) j++;
        segs.push([i, j, 't']);
        i = j;
        inTag = true;
        continue;
      }
      if (inTag && (c === 62 /* > */ || (c === 47 && text[i + 1] === '>'))) {
        const e = c === 62 ? i + 1 : i + 2;
        segs.push([i, e, 't']);
        i = e;
        inTag = false;
        continue;
      }
      if (inTag && isIdStart(c)) {
        let j = i + 1;
        while (j < n && (isId(text.charCodeAt(j)) || text[j] === '-' || text[j] === ':' || text[j] === '@')) j++;
        segs.push([i, j, 'a']);
        i = j;
        continue;
      }
      if (!inTag) {
        i++;
        continue;
      }
    }
    // strings
    if (lang.strings) {
      const ch = text[i];
      if (lang.strings.includes(ch)) {
        if (lang.triple && startsWith(ch + ch + ch, i)) {
          const end = text.indexOf(ch + ch + ch, i + 3);
          const e = end < 0 ? n : end + 3;
          segs.push([i, e, 's']);
          i = e;
          continue;
        }
        let j = i + 1;
        const multi = lang.multilineStrings || ch === '`';
        while (j < n && text[j] !== ch) {
          if (text[j] === '\\') j++;
          else if (!multi && text[j] === '\n') break;
          j++;
        }
        const e = Math.min(n, j + 1);
        let cls = 's';
        if (lang.keysBeforeColon) {
          let k = e;
          while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
          if (text[k] === ':') cls = 'a';
        }
        segs.push([i, e, cls]);
        i = e;
        continue;
      }
    }
    // variables
    if (lang.varPrefix && text[i] === lang.varPrefix && isIdStart(text.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isId(text.charCodeAt(j))) j++;
      segs.push([i, j, 'v']);
      i = j;
      continue;
    }
    // numbers
    if (isDigit(c) && (i === 0 || !isId(text.charCodeAt(i - 1)))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
      const e = i + (m ? m[0].length : 1);
      segs.push([i, e, 'n']);
      i = e;
      continue;
    }
    // identifiers
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(text.charCodeAt(j))) j++;
      const word = text.slice(i, j);
      if (lang.keysBeforeColon && !lang.keywords?.has(word)) {
        let k = j;
        while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
        if (text[k] === ':' && text[k + 1] !== ':' && lineStartBefore(text, i)) {
          segs.push([i, j, 'a']);
          i = j;
          continue;
        }
      }
      if (lang.keywords && (lang.keywords.has(word) || (lang.kwInsensitive && lang.keywords.has(word.toLowerCase())))) {
        // Control-flow keywords get their own category: most themes colour them differently.
        segs.push([i, j, CONTROL_KEYWORDS.has(word.toLowerCase()) ? 'kc' : 'k']);
      } else if (lang.keywords) {
        let k = j;
        while (k < n && text[k] === ' ') k++;
        if (text[k] === '(') segs.push([i, j, 'f']);
        else if (c >= 65 && c <= 90 && j - i > 1 && /[a-z]/.test(word)) segs.push([i, j, 'y']);
      }
      i = j;
      continue;
    }
    // markdown headings
    if (lang === LANGS.md && c === 35 && (i === 0 || text[i - 1] === '\n')) {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      segs.push([i, e, 'k']);
      i = e;
      continue;
    }
    i++;
  }
  return splitLines(text, segs);
}

function lineStartBefore(text: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '-' && ch !== '{' && ch !== ',') return false;
  }
  return true;
}

function splitLines(text: string, segs: Seg[]): Seg[][] {
  const lines: Seg[][] = [];
  let lineStart = 0;
  let si = 0;
  let pending: Seg | null = null;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const out: Seg[] = [];
    if (pending) {
      out.push([0, Math.min(pending[1], lineEnd) - lineStart, pending[2]]);
      if (pending[1] <= lineEnd) pending = null;
    }
    while (!pending && si < segs.length && segs[si][0] < lineEnd) {
      const [s, e, cls] = segs[si++];
      if (e <= lineStart) continue;
      out.push([Math.max(s, lineStart) - lineStart, Math.min(e, lineEnd) - lineStart, cls]);
      if (e > lineEnd) pending = [s, e, cls];
    }
    lines.push(out);
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  return lines;
}
