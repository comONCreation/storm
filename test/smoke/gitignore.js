// .gitignore support inside a real VS Code. The workspace is prepared by the caller:
// <repo>/.gitignore ("*.secret"), <repo>/.git/info/exclude ("local.txt") and the workspace
// folder <repo>/app (see the README "Développement" section).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  const out = [];
  const log = (s) => out.push(s);
  const report = path.join(__dirname, '..', '..', 'out-test', 'gitignore-report.txt');
  let ok = true;
  const expect = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (!pass) ok = false;
    log(`${pass ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${pass ? '' : ' expected ' + JSON.stringify(expected)}`);
  };
  try {
    const api = await vscode.extensions.getExtension(require('../../package.json').publisher + '.storm').activate();
    const ready = async () => {
      const t0 = Date.now();
      while (api.client.status.state !== 'ready' && Date.now() - t0 < 60000) await sleep(100);
    };
    await ready();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const base = { query: 'needle', matchCase: false, words: false, regex: false, replace: '', replaceMode: false, maskEnabled: false, mask: '', scope: 'project', directory: '', module: '', namedScope: 'all' };
    const find = (o) =>
      new Promise((resolve) => {
        const files = new Set();
        api.search.runText({ ...base, ...o }, 1000, (items, done) => {
          for (const it of items) files.add(it.rel);
          if (done) resolve([...files].sort());
        });
      });
    const poll = async (run, until) => {
      const t0 = Date.now();
      let r = await run();
      while (!until(r) && Date.now() - t0 < 10000) {
        await sleep(500);
        r = await run();
      }
      return r;
    };
    log(`status: ${JSON.stringify(api.client.status)}`);
    expect('project', await find({}), ['_ide_helper.php', 'src/a.php', 'sub/keep.log']);
    expect('all places', await find({ scope: 'scope', namedScope: 'all' }), ['_ide_helper.php', 'src/a.php', 'sub/keep.log', 'vendor/lib/V.php']);
    expect('including ignored', await find({ scope: 'scope', namedScope: 'ignored' }), [
      '_ide_helper.php', 'build/out.js', 'debug.log', 'local.txt', 'src/a.php', 'sub/keep.log', 'sub/other.log', 'vendor/lib/V.php', 'x.secret',
    ]);
    expect('directory build', await find({ scope: 'directory', directory: 'build' }), ['build/out.js']);

    // a new ignored file: not indexed, but found by the ignored scope
    fs.writeFileSync(path.join(root, 'build', 'new.js'), 'needle');
    await sleep(1500);
    expect('new ignored file, project', await find({}), ['_ide_helper.php', 'src/a.php', 'sub/keep.log']);
    // the file system watcher can take a few seconds to report the file in a window that just started
    expect('new ignored file, directory', await poll(() => find({ scope: 'directory', directory: 'build' }), (r) => r.includes('build/new.js')), ['build/new.js', 'build/out.js']);

    // a whole directory created under a directory-only rule ("dist/")
    fs.mkdirSync(path.join(root, 'dist', 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'js', 'app.js'), 'needle');
    await sleep(1500);
    expect('new ignored directory, project', (await find({})).includes('dist/js/app.js'), false);
    expect('new ignored directory, directory', await poll(() => find({ scope: 'directory', directory: 'dist' }), (r) => r.length > 0), ['dist/js/app.js']);

    // .gitignore edited: build is not ignored any more
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\nvendor/\n_ide_helper.php\ndist/\n');
    const t0 = Date.now();
    let after = [];
    while (Date.now() - t0 < 15000) {
      await sleep(500);
      await ready();
      after = await find({});
      if (after.includes('build/out.js')) break;
    }
    expect('after .gitignore edit', after, ['_ide_helper.php', 'build/new.js', 'build/out.js', 'src/a.php', 'sub/keep.log']);

    // setting off: nothing is ignored
    await vscode.workspace.getConfiguration('storm').update('useIgnoreFiles', false, vscode.ConfigurationTarget.Workspace);
    const t1 = Date.now();
    while (Date.now() - t1 < 15000) {
      await sleep(500);
      await ready();
      after = await find({});
      if (after.includes('debug.log')) break;
    }
    expect('useIgnoreFiles off', after, ['_ide_helper.php', 'build/new.js', 'build/out.js', 'debug.log', 'dist/js/app.js', 'local.txt', 'src/a.php', 'sub/keep.log', 'sub/other.log', 'x.secret']);

    // A nested repository ignored by the enclosing one ("inner/" in its .gitignore) keeps its
    // files: only its own rules apply to them, as in git (e.g. a workspace repository ignoring com_*).
    await vscode.workspace.getConfiguration('storm').update('useIgnoreFiles', true, vscode.ConfigurationTarget.Workspace);
    fs.mkdirSync(path.join(root, 'inner', '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inner', '.git', 'info', 'exclude'), 'local-only.php\n');
    fs.writeFileSync(path.join(root, 'inner', '.gitignore'), '*.tmp\n');
    for (const f of ['x.php', 'y.tmp', 'local-only.php']) fs.writeFileSync(path.join(root, 'inner', f), 'needle');
    fs.appendFileSync(path.join(root, '.gitignore'), 'inner/\n');
    const inner = (r) => r.filter((x) => x.startsWith('inner/'));
    expect('nested repository', inner(await poll(async () => (await ready(), find({})), (r) => r.includes('inner/x.php') && !r.includes('debug.log'))), ['inner/x.php']);
    expect('nested repository, ignored files', inner(await find({ scope: 'scope', namedScope: 'ignored' })), ['inner/local-only.php', 'inner/x.php', 'inner/y.tmp']);
  } catch (e) {
    ok = false;
    log('ERROR ' + (e && e.stack ? e.stack : e));
  }
  log(ok ? 'GITIGNORE OK' : 'GITIGNORE FAILED');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, out.join('\n'));
};
