// Debug helper: prints scope → colour for each token of a sample (env DUMP_CODE, DUMP_SCOPE e.g. source.tsx, FULL=1).
const fs = require('fs'), path = require('path');
const vsctm = require('vscode-textmate'), onig = require('vscode-oniguruma');
const extensionsDir = require('./extdir');
const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'themes', 'storm-dark.json'), 'utf8'));
const files = new Map();
for (const d of fs.readdirSync(extensionsDir)) { const pj = path.join(extensionsDir, d, 'package.json'); if (!fs.existsSync(pj)) continue; for (const g of JSON.parse(fs.readFileSync(pj, 'utf8')).contributes?.grammars ?? []) if (g.scopeName && g.path) files.set(g.scopeName, path.join(extensionsDir, d, g.path)); }
const lib = onig.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer).then(() => ({ createOnigScanner: (p) => new onig.OnigScanner(p), createOnigString: (s) => new onig.OnigString(s) }));
const reg = new vsctm.Registry({ onigLib: lib, loadGrammar: async (s) => (files.get(s) ? vsctm.parseRawGrammar(fs.readFileSync(files.get(s), 'utf8'), files.get(s)) : null) });
reg.setTheme({ settings: [{ settings: { foreground: theme.colors['editor.foreground'], background: '#000000' } }, ...theme.tokenColors] });
const code = process.env.DUMP_CODE || `<?php
class ItemController extends Controller {
    public function __construct(private readonly ApiService $api) {}
    public function folder(Request $request, FeedFolder $feedFolder): Response {
        return $this->renderIndex($request, folderId: $feedFolder->id);
    }
}`;
(async () => {
  const g = await reg.loadGrammar(process.env.DUMP_SCOPE || 'text.html.php'); const cm = reg.getColorMap(); let st = vsctm.INITIAL;
  for (const line of code.split('\n')) {
    const t = g.tokenizeLine(line, st);
    const t2 = g.tokenizeLine2(line, st);
    st = t.ruleStack;
    for (const tok of t.tokens) {
      const txt = line.slice(tok.startIndex, tok.endIndex); if (!txt.trim()) continue;
      // colour of this token from the binary tokens
      let meta = 0; for (let i = 0; i < t2.tokens.length; i += 2) if (t2.tokens[i] <= tok.startIndex) meta = t2.tokens[i + 1];
      const color = cm[(meta & 0x00ff8000) >>> 15]; const it = ((meta & 0x00007800) >>> 11) & 1 ? ' italic' : '';
      console.log(JSON.stringify(txt).padEnd(22), (color + it).padEnd(15), (process.env.FULL ? tok.scopes : tok.scopes.slice(-2)).join(' > '));
    }
  }
})();
