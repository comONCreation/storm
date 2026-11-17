// Host-side Find in Files check inside a real VS Code: simulates the webview typing a query
// character by character (as the popup does) and checks that the last search completes.
// code ... --extensionTestsPath=<repo>/test/smoke/hostFind.js <project folder>
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const out = [];
  const log = (s) => out.push(`[${new Date().toISOString().slice(11, 23)}] ${s}`);
  const report = path.join(__dirname, '..', '..', 'out-test', 'hostfind-report.txt');
  const query = process.env.STORM_QUERY || 'findAll';
  try {
    const api = await vscode.extensions.getExtension(require('../../package.json').publisher + '.storm').activate();
    const t0 = Date.now();
    while (api.client.status.state !== 'ready' && Date.now() - t0 < 180000) await sleep(250);
    log(`status ${JSON.stringify(api.client.status)} after ${Date.now() - t0} ms`);

    await vscode.commands.executeCommand('storm.findInFiles');
    await sleep(2500);
    const popup = api.popup;
    log(`popup open=${popup.isOpen} ready=${popup.ready}`);
    const got = new Map();
    const origPost = popup.post.bind(popup);
    popup.post = (m) => {
      if (m.type === 'findResults') {
        const g = got.get(m.seq) ?? { lines: 0, done: false, batches: 0 };
        g.lines += m.items.length;
        g.batches++;
        if (m.done) {
          g.done = true;
          g.stats = m.stats;
          g.error = m.error;
        }
        got.set(m.seq, g);
      }
      origPost(m);
    };
    const base = { matchCase: false, words: false, regex: false, replace: '', replaceMode: false, maskEnabled: false, mask: '*.php', scope: 'project', directory: '', module: '', namedScope: 'all' };
    let seq = 1000;
    for (let i = 1; i <= query.length; i++) {
      seq++;
      await popup.onMessage({ type: 'find', seq, options: { ...base, query: query.slice(0, i) } });
      await sleep(45);
    }
    const last = seq;
    const t1 = Date.now();
    while (!got.get(last)?.done && Date.now() - t1 < 30000) await sleep(100);
    for (const [s, g] of got) log(`seq ${s} (${query.slice(0, s - 1000)}): ${JSON.stringify(g)}`);
    log(`LAST ${got.get(last)?.done ? 'DONE' : 'NOT DONE'} after ${Date.now() - t1} ms`);
    // same with the *.php mask
    seq++;
    await popup.onMessage({ type: 'find', seq, options: { ...base, query, maskEnabled: true } });
    const t2 = Date.now();
    while (!got.get(seq)?.done && Date.now() - t2 < 30000) await sleep(100);
    log(`MASK ${JSON.stringify(got.get(seq))} after ${Date.now() - t2} ms`);
  } catch (e) {
    log('ERROR ' + (e && e.stack ? e.stack : e));
  }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n'));
};
