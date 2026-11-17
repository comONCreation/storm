// Diagnostic run inside a real VS Code: prints the semantic tokens (type + modifiers)
// that the PHP language extension produces for given words of a file.
// env: STORM_FILE (absolute path), STORM_WORDS (comma separated)
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const out = [];
  const log = (s) => out.push(s);
  const report = path.join(__dirname, '..', '..', 'out-test', 'semantic-report.txt');
  try {
    const file = process.env.STORM_FILE;
    const words = (process.env.STORM_WORDS || '').split(',').filter(Boolean);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    log('language: ' + doc.languageId + ', extensions: ' + vscode.extensions.all.filter((e) => /devsense|intelephense/i.test(e.id)).map((e) => e.id).join(', '));
    let legend;
    let tokens;
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', doc.uri);
      tokens = legend ? await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', doc.uri) : undefined;
      const n = tokens && tokens.data ? tokens.data.length : 0;
      // wait until the language server has analysed the project: token count stable over 3 polls
      if (n && n === globalThis.__lastN) {
        globalThis.__stable = (globalThis.__stable || 0) + 1;
        if (globalThis.__stable >= 3) break;
      } else globalThis.__stable = 0;
      globalThis.__lastN = n;
      await sleep(5000);
    }
    if (!tokens || !tokens.data.length) {
      log('no semantic tokens after ' + (Date.now() - t0) + ' ms');
    } else {
      log(`after ${Date.now() - t0} ms: ${tokens.data.length / 5} tokens`);
      log(`legend types: ${legend.tokenTypes.join(' ')}`);
      log(`legend modifiers: ${legend.tokenModifiers.join(' ')}`);
      const d = tokens.data;
      let line = 0;
      let ch = 0;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 5) {
        line += d[i];
        ch = d[i] === 0 ? ch + d[i + 1] : d[i + 1];
        const len = d[i + 2];
        const text = doc.lineAt(line).text.substr(ch, len);
        if (!words.includes(text.replace(/^\$/, '')) && !words.includes(text)) continue;
        const mods = legend.tokenModifiers.filter((_, b) => d[i + 4] & (1 << b));
        const key = `${text}|${legend.tokenTypes[d[i + 3]]}|${mods.join('.')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        log(`${String(line + 1).padStart(4)}  ${text.padEnd(26)} ${legend.tokenTypes[d[i + 3]]}${mods.length ? '.' + mods.join('.') : ''}`);
      }
    }
  } catch (e) {
    log('ERROR ' + (e && e.stack ? e.stack : e));
  }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n'));
};
