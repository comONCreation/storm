// Generates the Storm Dark themes: the workbench colours of VS Code's
// "Dark 2026" theme, read from the local VS Code installation, plus the
// JetBrains syntax palettes of palettes.js.
//
// usage: npm run theme   (or: node scripts/theme/build.js [path to VS Code's resources/app/extensions])

const fs = require('fs');
const path = require('path');
const { variants, textMateRules, semanticTokenColors } = require('./palettes');

/** JSON with comments and trailing commas (VS Code theme files). */
function readJsonc(file) {
  let s = fs.readFileSync(file, 'utf8');
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
    } else if (ch === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Workbench colours of a theme, following its "include" chain (base first). */
function resolveColors(file) {
  const json = readJsonc(file);
  const base = json.include ? resolveColors(path.join(path.dirname(file), json.include)) : {};
  return { ...base, ...(json.colors || {}) };
}

const extensionsDir = process.argv[2] || require('./extdir');
const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'theme-defaults', 'package.json'), 'utf8'));
const dark2026 = pkg.contributes.themes.find((t) => (t.id || t.label) === 'Dark 2026');
if (!dark2026) throw new Error('"Dark 2026" not found in this VS Code version');
const baseColors = resolveColors(path.join(extensionsDir, 'theme-defaults', dark2026.path));
const vscodeVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionsDir, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const outDir = path.join(__dirname, '..', '..', 'themes');
fs.mkdirSync(outDir, { recursive: true });
for (const v of variants) {
  const theme = {
    $schema: 'vscode://schemas/color-theme',
    name: v.label,
    type: 'dark',
    semanticHighlighting: true,
    // Workbench colours: Dark 2026 as is, only the default text colour follows the JetBrains scheme.
    colors: { ...baseColors, 'editor.foreground': v.palette.text },
    tokenColors: textMateRules(v.palette),
    semanticTokenColors: semanticTokenColors(v.palette),
  };
  fs.writeFileSync(path.join(outDir, v.file), JSON.stringify(theme, null, 2) + '\n');
  console.log(`${v.file}: ${Object.keys(baseColors).length} workbench colours from Dark 2026 (VS Code ${vscodeVersion}), ${theme.tokenColors.length} token rules`);
}
