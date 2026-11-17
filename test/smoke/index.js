// Smoke test run inside a real VS Code instance:
// code --user-data-dir <tmp> --extensions-dir <tmp> --extensionDevelopmentPath=<repo> --extensionTestsPath=<repo>/test/smoke <repo>
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const out = [];
  const log = (s) => out.push(s);
  const report = path.join(__dirname, '..', '..', 'out-test', 'smoke-report.txt');
  try {
    const ext = vscode.extensions.getExtension(require('../../package.json').publisher + '.storm');
    const api = await ext.activate();
    log('activated');
    const t0 = Date.now();
    while (api.client.status.state !== 'ready' && Date.now() - t0 < 60000) await sleep(200);
    const s = api.client.status;
    log(`status ${s.state} files=${s.totalFiles} symbols=${s.symbols} trigrams=${s.trigrams} after ${Date.now() - t0} ms`);
    const files = await api.client.searchFiles('fuzzy', false, 5, []);
    log('files(fuzzy): ' + files.map((f) => f.rel).join(', '));
    const nm = await api.client.searchFiles('node_modules/esbuild/package.json', true, 5, []);
    log('node_modules excluded: ' + (nm.length === 0 || !nm[0].rel.startsWith('node_modules')));
    const classes = await api.client.searchSymbols('IdxCli', true, false, 5, []);
    log('classes(IdxCli): ' + classes.map((c) => `${c.name}@${c.rel}:${c.line + 1}`).join(', '));
    const methods = await api.client.searchSymbols('FindResults::step', false, false, 5);
    log('symbols(FindResults::step): ' + methods.map((c) => `${c.kind} ${c.container}.${c.name}`).join(', '));
    const items = [];
    let stats;
    const h = api.client.searchText({ query: 'trigramsOf', matchCase: true, words: true, regex: false }, { includeLibraries: false }, 100, (b, done, st) => {
      items.push(...b);
      if (done) stats = st;
    });
    await h.done;
    log(`text(trigramsOf): ${stats.matches} matches in ${stats.files} files, ${stats.durationMs} ms -> ` + [...new Set(items.map((i) => i.rel))].join(', '));

    await vscode.commands.executeCommand('storm.findInFiles');
    await sleep(1500);
    log('find popup open: ' + api.popup.isOpen + ', tab label: ' + vscode.window.tabGroups.activeTabGroup.activeTab?.label);
    await vscode.commands.executeCommand('storm.searchEverywhere');
    await sleep(800);
    log('search everywhere tab label: ' + vscode.window.tabGroups.activeTabGroup.activeTab?.label);
    api.popup.close();
    await sleep(300);
    log('popup closed: ' + !api.popup.isOpen);

    api.findResults.run({ query: 'openLocation', matchCase: false, words: false, regex: false, replace: '', replaceMode: false, maskEnabled: true, mask: '*.ts', scope: 'project', directory: '', module: '', namedScope: 'all' });
    await sleep(1500);
    log('find window: ' + api.findResults.view.message + ' | ' + api.findResults.view.description);
    await vscode.commands.executeCommand('storm.nextOccurrence');
    await sleep(800);
    const ed = vscode.window.activeTextEditor;
    log('next occurrence opened: ' + (ed ? `${path.basename(ed.document.fileName)}:${ed.selection.start.line + 1} "${ed.document.getText(ed.selection)}"` : 'none'));
    const conflicts = api.keymap.findConflicts();
    log('keymap conflicts: ' + conflicts.map((c) => `${c.key} <- ${c.theirs.map((t) => t.source + ':' + t.command).join('/')}`).join('; '));
    if (conflicts.length) {
      // applyKeymap writes the file synchronously, then waits on a notification nobody clicks here.
      api.keymap.applyKeymap();
      await sleep(500);
      const kb = fs.readFileSync(api.keymap.userKeybindingsPath(), 'utf8');
      log('user keybindings written: ' + kb);
      log('conflicts after apply: ' + api.keymap.findConflicts().length);
    }
    log('theme ' + vscode.workspace.getConfiguration().get('workbench.colorTheme') + ' colours: ' + JSON.stringify(api.tokenColors()));
    const ownThemes = vscode.extensions.getExtension(require('../../package.json').publisher + '.storm').packageJSON.contributes.themes.map((t) => t.label);
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Storm Dark', vscode.ConfigurationTarget.Global);
    await sleep(800);
    const sd = api.tokenColors();
    log(`Storm Dark (${ownThemes.join(', ')}): kind=${vscode.window.activeColorTheme.kind} keyword=${sd?.k?.fg} string=${sd?.s?.fg} comment=${sd?.c?.fg} variable=${sd?.v?.fg} function=${sd?.f?.fg}`);
    await vscode.workspace.getConfiguration('storm').update('previewColors', 'jetbrains', vscode.ConfigurationTarget.Global);
    log('jetbrains palette → ' + JSON.stringify(api.tokenColors() ?? null));
    await vscode.workspace.getConfiguration('storm').update('previewColors', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Light 2026', vscode.ConfigurationTarget.Global);
    await sleep(500);
    log('after switching to Light 2026: ' + JSON.stringify(api.tokenColors()?.kc));
    log('SMOKE OK');
  } catch (e) {
    log('ERROR ' + (e && e.stack ? e.stack : e));
  }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n'));
};
