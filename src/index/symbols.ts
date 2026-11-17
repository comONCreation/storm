// Lightweight, regex based symbol extraction. It does not try to be a parser:
// it is the equivalent of IntelliJ's "stub index" for navigation purposes and
// runs in the index worker, so it must be fast and never throw.

import type { SymbolKind } from '../shared/protocol';

export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  container: string;
}

type Lang = 'php' | 'js' | 'py' | 'java' | 'go' | 'rust' | 'ruby' | 'none';

const EXT_LANG: Record<string, Lang> = {
  php: 'php', phtml: 'php', inc: 'php', module: 'php',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', scala: 'java', groovy: 'java', dart: 'java', swift: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby', rake: 'ruby',
};

export function languageOf(fileName: string): Lang {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'none';
  return EXT_LANG[fileName.slice(dot + 1).toLowerCase()] ?? 'none';
}

const MAX_SYMBOLS_PER_FILE = 5000;

export function extractSymbols(fileName: string, text: string): RawSymbol[] {
  const lang = languageOf(fileName);
  if (lang === 'none') return [];
  try {
    switch (lang) {
      case 'php':
        return extractBraceLang(text, PHP_RULES, true);
      case 'js':
        return extractBraceLang(text, JS_RULES, false);
      case 'java':
        return extractBraceLang(text, JAVA_RULES, false);
      case 'go':
        return extractBraceLang(text, GO_RULES, false);
      case 'rust':
        return extractBraceLang(text, RUST_RULES, false);
      case 'py':
        return extractIndentLang(text, PY_RULES);
      case 'ruby':
        return extractRuby(text);
    }
  } catch {
    return [];
  }
  return [];
}

interface Rule {
  re: RegExp;
  kind: SymbolKind | ((inClass: boolean, m: RegExpExecArray) => SymbolKind | null);
  /** capture group holding the name */
  group?: number;
  /** only top level (outside any class body) */
  topLevel?: boolean;
  /** only directly inside a class body */
  inClassOnly?: boolean;
  /** opens a class-like container */
  container?: boolean;
  /** match against the raw line instead of the line without strings/comments */
  raw?: boolean;
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'foreach', 'elseif', 'else', 'do', 'try', 'new', 'typeof',
  'await', 'yield', 'match', 'fn', 'array', 'isset', 'unset', 'empty', 'list', 'echo', 'print', 'include', 'require',
  'require_once', 'include_once', 'super', 'this', 'constructor_', 'synchronized', 'using', 'lock', 'when', 'sizeof',
  'throw', 'delete', 'void', 'case', 'default', 'import', 'export', 'from', 'as', 'with', 'assert', 'static',
]);

const PHP_RULES: Rule[] = [
  { re: /^\s*namespace\s+([A-Za-z_\\][\w\\]*)\s*[;{]/, kind: 'namespace' },
  { re: /^\s*(?:(?:abstract|final|readonly)\s+)*class\s+([A-Za-z_]\w*)/, kind: 'class', container: true },
  { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface', container: true },
  { re: /^\s*trait\s+([A-Za-z_]\w*)/, kind: 'trait', container: true },
  { re: /^\s*enum\s+([A-Za-z_]\w*)/, kind: 'enum', container: true },
  { re: /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/, kind: (inClass) => (inClass ? 'method' : 'function') },
  { re: /^\s*(?:(?:public|protected|private|final)\s+)*const\s+(?:[A-Za-z_?\\|]+\s+)?([A-Za-z_]\w*)\s*=/, kind: 'constant' },
  { re: /^\s*case\s+([A-Za-z_]\w*)\s*[;=]/, kind: 'constant', inClassOnly: true },
  { re: /^\s*(?:(?:public|protected|private|var|static|readonly)\s+)+(?:\??[A-Za-z_\\|]+\s+)?\$([A-Za-z_]\w*)/, kind: 'field', inClassOnly: true },
  { re: /^\s*define\s*\(\s*['"]([A-Za-z_]\w*)['"]/, kind: 'constant', topLevel: true, raw: true },
];

const JS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', container: true },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', container: true },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', container: true },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/, kind: 'namespace' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', topLevel: true },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>)/, kind: 'function', topLevel: true },
  { re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, kind: 'constant', topLevel: true },
  { re: /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set)\s+)*\*?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\((?:[^;]*$|[^)]*\)\s*(?::\s*[^={;]+)?\s*\{)/, kind: (inClass, m) => (inClass && !KEYWORDS.has(m[1]) ? 'method' : null), inClassOnly: true },
  { re: /^\s*(?:(?:public|private|protected|static|readonly|declare|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=;]+)?(?:=[^>]|;|$)/, kind: (inClass, m) => (inClass && !KEYWORDS.has(m[1]) ? 'field' : null), inClassOnly: true },
];

const JAVA_RULES: Rule[] = [
  { re: /^\s*(?:package|namespace)\s+([\w.]+)/, kind: 'namespace' },
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|inner|enum|annotation|value)\s+)*(?:class|object|record)\s+([A-Za-z_]\w*)/, kind: 'class', container: true },
  { re: /^\s*(?:(?:public|private|protected|internal|static|sealed|fun)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface', container: true },
  { re: /^\s*(?:(?:public|private|protected|internal|static)\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, kind: 'enum', container: true },
  { re: /^\s*(?:(?:public|private|protected|internal|static|readonly)\s+)*struct\s+([A-Za-z_]\w*)/, kind: 'struct', container: true },
  { re: /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|private|operator|static)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, kind: (inClass) => (inClass ? 'method' : 'function') },
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|sealed|extern|unsafe|new|native|default)\s+)+(?:<[^>]*>\s*)?[\w<>\[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/, kind: (inClass, m) => (KEYWORDS.has(m[1]) ? null : inClass ? 'method' : 'function') },
  { re: /^\s*(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:final\s+|const\s+|readonly\s+)+[\w<>\[\],.?]+\s+([A-Z_][A-Z0-9_]*)\s*=/, kind: 'constant', inClassOnly: true },
];

const GO_RULES: Rule[] = [
  { re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method' },
  { re: /^func\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'struct' },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface' },
  { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: 'type' },
  { re: /^(?:const|var)\s+([A-Za-z_]\w*)\s/, kind: 'constant' },
];

const RUST_RULES: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', container: true },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module' },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, kind: () => null, container: true },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/, kind: (inClass) => (inClass ? 'method' : 'function') },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:/, kind: 'constant' },
];

/** Strips strings and comments from a line (keeps length), tracking block comments across lines. */
class Scrubber {
  inBlock = false;
  constructor(private readonly hashComments: boolean) {}
  scrub(line: string): string {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (this.inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) {
          out += ' '.repeat(n - i);
          return out;
        }
        out += ' '.repeat(end + 2 - i);
        i = end + 2;
        this.inBlock = false;
        continue;
      }
      const c = line[i];
      if (c === '/' && line[i + 1] === '*') {
        this.inBlock = true;
        out += '  ';
        i += 2;
        continue;
      }
      if ((c === '/' && line[i + 1] === '/') || (this.hashComments && c === '#' && line[i + 1] !== '[')) {
        out += ' '.repeat(n - i);
        return out;
      }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < n && line[j] !== c) {
          if (line[j] === '\\') j++;
          j++;
        }
        out += c + ' '.repeat(Math.max(0, Math.min(j, n) - i - 1)) + (j < n ? c : '');
        i = j + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }
}

function extractBraceLang(text: string, rules: Rule[], hashComments: boolean): RawSymbol[] {
  const out: RawSymbol[] = [];
  const lines = text.split('\n');
  const scrub = new Scrubber(hashComments);
  let depth = 0;
  let namespace = '';
  // Stack of open containers: name + brace depth of their body.
  const containers: Array<{ name: string; depth: number }> = [];
  let pendingContainer: string | null = null;

  for (let ln = 0; ln < lines.length && out.length < MAX_SYMBOLS_PER_FILE; ln++) {
    const raw = lines[ln];
    if (raw.length > 1000) continue; // minified / generated line
    // Rules are matched against the raw line (strings may contain names, e.g. define('X')),
    // braces are counted on the scrubbed line.
    const clean = scrub.scrub(raw);
    const trimmed = clean.trimStart();
    const top = containers[containers.length - 1];
    const inClass = !!top && depth === top.depth;
    if (trimmed.length > 0) {
      for (const rule of rules) {
        if (rule.topLevel && containers.length > 0) continue;
        if (rule.inClassOnly && !inClass) continue;
        const m = rule.re.exec(rule.raw ? raw : clean);
        if (!m) continue;
        const name = m[rule.group ?? 1];
        if (!name) continue;
        const kind = typeof rule.kind === 'function' ? rule.kind(inClass, m) : rule.kind;
        if (kind === 'namespace') {
          namespace = name;
          break;
        }
        if (kind) {
          const container = inClass ? top!.name : namespace;
          out.push({ name, kind, line: ln, col: Math.max(0, raw.indexOf(name, m.index)), container });
        }
        if (rule.container) {
          pendingContainer = name;
        }
        break;
      }
    }
    // brace counting
    for (let i = 0; i < clean.length; i++) {
      const c = clean.charCodeAt(i);
      if (c === 123 /* { */) {
        depth++;
        if (pendingContainer !== null) {
          containers.push({ name: pendingContainer, depth });
          pendingContainer = null;
        }
      } else if (c === 125 /* } */) {
        if (containers.length && containers[containers.length - 1].depth === depth) containers.pop();
        depth = Math.max(0, depth - 1);
      } else if (c === 59 /* ; */ && pendingContainer !== null && depth === (containers.length ? containers[containers.length - 1].depth : 0)) {
        // forward declaration "class Foo;"
        pendingContainer = null;
      }
    }
  }
  return out;
}

const PY_RULES = {
  cls: /^(\s*)class\s+([A-Za-z_]\w*)/,
  def: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  constant: /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/,
};

function extractIndentLang(text: string, rules: typeof PY_RULES): RawSymbol[] {
  const out: RawSymbol[] = [];
  const lines = text.split('\n');
  const stack: Array<{ name: string; indent: number }> = [];
  for (let ln = 0; ln < lines.length && out.length < MAX_SYMBOLS_PER_FILE; ln++) {
    const line = lines[ln];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    let m = rules.cls.exec(line);
    if (m) {
      out.push({ name: m[2], kind: 'class', line: ln, col: line.indexOf(m[2]), container: stack.map((s) => s.name).join('.') });
      stack.push({ name: m[2], indent });
      continue;
    }
    m = rules.def.exec(line);
    if (m) {
      const parent = stack[stack.length - 1];
      out.push({ name: m[2], kind: parent ? 'method' : 'function', line: ln, col: line.indexOf(m[2]), container: parent ? parent.name : '' });
      stack.push({ name: m[2], indent });
      continue;
    }
    if (indent === 0) {
      m = rules.constant.exec(line);
      if (m) out.push({ name: m[1], kind: 'constant', line: ln, col: 0, container: '' });
    }
  }
  return out;
}

function extractRuby(text: string): RawSymbol[] {
  const out: RawSymbol[] = [];
  const lines = text.split('\n');
  const stack: string[] = [];
  const reClass = /^\s*(class|module)\s+([A-Z][\w:]*)/;
  const reDef = /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/;
  for (let ln = 0; ln < lines.length && out.length < MAX_SYMBOLS_PER_FILE; ln++) {
    const line = lines[ln];
    let m = reClass.exec(line);
    if (m) {
      out.push({ name: m[2], kind: m[1] === 'class' ? 'class' : 'module', line: ln, col: line.indexOf(m[2]), container: stack.join('::') });
      stack.push(m[2]);
      continue;
    }
    m = reDef.exec(line);
    if (m) {
      out.push({ name: m[2], kind: stack.length ? 'method' : 'function', line: ln, col: line.indexOf(m[2]), container: stack[stack.length - 1] ?? '' });
      continue;
    }
    if (/^\s*end\b/.test(line) && /^(\s*)/.exec(line)![1].length < 2 * stack.length) {
      // Crude: an "end" at a class indentation closes it.
      const ind = /^(\s*)/.exec(line)![1].length;
      if (ind <= 2 * (stack.length - 1)) stack.pop();
    }
  }
  return out;
}
