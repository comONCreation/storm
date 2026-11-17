// Renders sample code with VS Code's own TextMate engine and the grammars of the
// local VS Code installation, for Dark 2026 and the Storm Dark variants.
// Output: out-test/theme-preview.html (TextMate only: semantic highlighting from language
// servers such as Intelephense is not simulated).
//
// usage: npm run theme:preview

const fs = require('fs');
const path = require('path');
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const extensionsDir = process.argv[2] || require('./extdir');

// Token metadata layout of vscode-textmate (EncodedTokenAttributes): font style in bits 11-14, foreground in bits 15-23.
const foregroundOf = (meta) => (meta & 0x00ff8000) >>> 15;
const fontStyleOf = (meta) => (meta & 0x00007800) >>> 11; // 1 italic, 2 bold, 4 underline

function readJsonc(file) {
  const s = fs.readFileSync(file, 'utf8');
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += s[++i];
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && s[i + 1] === '*') i = s.indexOf('*/', i + 2) + 1;
    else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// --- grammars of the installed VS Code
const grammarFiles = new Map();
const injections = new Map();
for (const dir of fs.readdirSync(extensionsDir)) {
  const pj = path.join(extensionsDir, dir, 'package.json');
  if (!fs.existsSync(pj)) continue;
  const gs = JSON.parse(fs.readFileSync(pj, 'utf8')).contributes?.grammars ?? [];
  for (const g of gs) {
    if (!g.scopeName || !g.path) continue;
    grammarFiles.set(g.scopeName, path.join(extensionsDir, dir, g.path));
    for (const target of g.injectTo ?? []) injections.set(target, [...(injections.get(target) ?? []), g.scopeName]);
  }
}

const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
const onigLib = oniguruma.loadWASM(wasm).then(() => ({
  createOnigScanner: (p) => new oniguruma.OnigScanner(p),
  createOnigString: (s) => new oniguruma.OnigString(s),
}));

// --- themes
function themeTokenColors(file) {
  const json = readJsonc(file);
  const base = json.include ? themeTokenColors(path.join(path.dirname(file), json.include)) : { rules: [], colors: {} };
  return { rules: [...base.rules, ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])], colors: { ...base.colors, ...(json.colors ?? {}) } };
}
const defaults = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'theme-defaults', 'package.json'), 'utf8')).contributes.themes;
const d2026 = defaults.find((t) => (t.id || t.label) === 'Dark 2026');
const themes = [
  { name: 'Dark 2026 (VS Code)', ...themeTokenColors(path.join(extensionsDir, 'theme-defaults', d2026.path)) },
  { name: 'Storm Dark (coloration JetBrains)', ...themeTokenColors(path.join(__dirname, '..', '..', 'themes', 'storm-dark.json')) },
];

const SAMPLES = [
  {
    title: 'PHP (Laravel)',
    scope: 'text.html.php',
    code: `<?php

namespace App\\Http\\Controllers;

use App\\Models\\Article;
use Illuminate\\Http\\Request;

/**
 * Lists the articles of the current tenant.
 *
 * @param Request $request the incoming request
 * @return array<int, Article>
 */
#[Route('/articles', methods: ['GET'])]
final class ArticleController extends Controller
{
    public const PER_PAGE = 25;
    private static int $hits = 0;

    public function __construct(private readonly ArticleService $articles)
    {
    }

    public function index(Request $request): array
    {
        $limit = (int) $request->query('limit', self::PER_PAGE);
        self::$hits++;
        if ($limit > 100 || !$this->articles->enabled) {
            return [];
        }
        // newest first
        return Article::query()->latest()->limit($limit)->get()->all();
    }
}

enum Status: string
{
    case Draft = 'draft';
    case Published = "published-{$suffix}\\n";
}`,
  },
  {
    title: 'TypeScript',
    scope: 'source.ts',
    code: `import { useState } from 'react';

/** Debounced search input. */
export class SearchBox<T extends object> {
  private static instances = 0;
  readonly delay = 250;

  constructor(private readonly onSearch: (q: string) => Promise<T[]>) {
    SearchBox.instances++;
  }

  async search(query: string): Promise<T[]> {
    if (!query.trim()) return [];
    const results = await this.onSearch(query); // remote call
    return results.filter((r) => r !== null);
  }
}`,
  },
  {
    title: 'JSON',
    scope: 'source.json',
    code: `{
  "name": "my-app",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build" },
  "version": 3
}`,
  },
  {
    title: 'YAML',
    scope: 'source.yaml',
    code: `services:
  app:
    image: php:8.3-fpm
    ports:
      - "8080:80"
    restart: unless-stopped # always on`,
  },
];

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

async function main() {
  const html = [];
  for (const theme of themes) {
    const registry = new vsctm.Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        const f = grammarFiles.get(scopeName);
        if (!f) return null;
        return vsctm.parseRawGrammar(fs.readFileSync(f, 'utf8'), f);
      },
      getInjections: (scopeName) => injections.get(scopeName),
    });
    const fg = theme.colors['editor.foreground'] ?? '#cccccc';
    const bg = theme.colors['editor.background'] ?? '#1e1e1e';
    registry.setTheme({ settings: [{ settings: { foreground: fg, background: bg } }, ...theme.rules] });
    const colorMap = registry.getColorMap();
    theme.html = [];
    theme.bg = bg;
    for (const sample of SAMPLES) {
      const grammar = await registry.loadGrammar(sample.scope);
      let ruleStack = vsctm.INITIAL;
      let out = '';
      for (const line of sample.code.split('\n')) {
        const r = grammar.tokenizeLine2(line, ruleStack);
        const toks = r.tokens;
        for (let i = 0; i < toks.length; i += 2) {
          const start = toks[i];
          const end = i + 2 < toks.length ? toks[i + 2] : line.length;
          const meta = toks[i + 1];
          const color = colorMap[foregroundOf(meta)];
          const fs_ = fontStyleOf(meta);
          const style = `color:${color}${fs_ & 1 ? ';font-style:italic' : ''}${fs_ & 2 ? ';font-weight:bold' : ''}`;
          out += `<span style="${style}">${esc(line.slice(start, end))}</span>`;
        }
        out += '\n';
        ruleStack = r.ruleStack;
      }
      theme.html.push(out);
    }
  }
  html.push(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Storm Dark — aperçu</title><style>
  body{margin:0;background:#121314;color:#ccc;font-family:'Segoe UI',system-ui,sans-serif}
  h1{font-size:16px;font-weight:600;margin:16px}
  h2{font-size:13px;font-weight:600;margin:20px 16px 8px;color:#9d9d9d}
  .row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 16px}
  .col h3{font-size:12px;font-weight:600;margin:0 0 6px;color:#aaa}
  pre{margin:0;padding:12px;border-radius:8px;overflow:auto;font:13px/1.5 'JetBrains Mono',Consolas,monospace;border:1px solid #2b2b2b}
  p.note{margin:8px 16px;font-size:12px;color:#888}
  </style></head><body><h1>Storm Dark — Dark 2026 + coloration JetBrains (Islands Dark / New UI Dark)</h1>
  <p class="note">Rendu par le moteur TextMate de VS Code avec les grammaires installées. La coloration sémantique des serveurs de langage (Intelephense, TypeScript) n'est pas simulée ici.</p>`);
  SAMPLES.forEach((s, i) => {
    html.push(`<h2>${esc(s.title)}</h2><div class="row">`);
    for (const t of themes) html.push(`<div class="col"><h3>${esc(t.name)}</h3><pre style="background:${t.bg}">${t.html[i]}</pre></div>`);
    html.push('</div>');
  });
  html.push('</body></html>');
  const out = path.join(__dirname, '..', '..', 'out-test', 'theme-preview.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html.join('\n'));
  console.log('written', out);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
