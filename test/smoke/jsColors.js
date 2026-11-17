// JetBrains-accurate JS/TS colours in a real VS Code (Storm Dark must be the theme of the test profile).
// env: STORM_FILE (absolute path of a .tsx file)
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const out = [];
  const report = path.join(__dirname, '..', '..', 'out-test', 'jscolors-report.txt');
  try {
    const api = await vscode.extensions.getExtension(require('../../package.json').publisher + '.storm').activate();
    out.push('theme: ' + vscode.workspace.getConfiguration('workbench').get('colorTheme'));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(process.env.STORM_FILE));
    await vscode.window.showTextDocument(doc);
    const t0 = Date.now();
    let r;
    while (!(r = api.jsColors.last.get(doc.uri.fsPath)) && Date.now() - t0 < 20000) await sleep(200);
    out.push(`after ${Date.now() - t0} ms: ${JSON.stringify(r, null, 1)}`);
    // switching to another theme removes the colours
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Dark Modern', vscode.ConfigurationTarget.Global);
    await sleep(1000);
    api.jsColors.last.delete(doc.uri.fsPath);
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Storm Dark', vscode.ConfigurationTarget.Global);
    await sleep(1000);
    out.push('re-applied after switching back: ' + !!api.jsColors.last.get(doc.uri.fsPath));
  } catch (e) {
    out.push('ERROR ' + (e && e.stack ? e.stack : e));
  }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n'));
};
