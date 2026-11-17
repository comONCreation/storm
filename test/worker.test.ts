import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { WorkerEvent, WorkerRequest, FileTuple } from '../src/index/worker';
import type { IndexStatus, LineMatch, TextSearchStats } from '../src/shared/protocol';

const WORKER = path.resolve(__dirname, '..', 'dist', 'worker.js');

class Client {
  w: Worker;
  id = 1;
  status: IndexStatus | null = null;
  waiters = new Map<number, (e: WorkerEvent) => void>();
  statusWaiters: Array<(s: IndexStatus) => boolean> = [];
  constructor() {
    this.w = new Worker(WORKER);
    this.w.unref();
    this.w.on('message', (e: WorkerEvent) => {
      if (e.type === 'status') {
        this.status = e.status;
        this.statusWaiters = this.statusWaiters.filter((f) => !f(e.status));
      } else if (e.type === 'result' || e.type === 'textBatch') this.waiters.get(e.id)?.(e);
    });
  }
  send(m: WorkerRequest) {
    this.w.postMessage(m);
  }
  ready(): Promise<IndexStatus> {
    return new Promise((resolve) => {
      const check = (s: IndexStatus) => {
        if (s.state === 'ready') {
          resolve(s);
          return true;
        }
        return false;
      };
      this.statusWaiters.push(check);
    });
  }
  req<T>(m: any): Promise<T> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, (e) => {
        if (e.type === 'result') {
          if (e.error) reject(new Error(e.error));
          else resolve(e.payload as T);
        }
      });
      this.send({ ...m, id });
    });
  }
  text(query: string, opts: Partial<{ matchCase: boolean; words: boolean; regex: boolean }> = {}, scope: any = { includeLibraries: false }, limit = 1000) {
    const id = this.id++;
    const items: LineMatch[] = [];
    return new Promise<{ items: LineMatch[]; stats: TextSearchStats }>((resolve, reject) => {
      this.waiters.set(id, (e) => {
        if (e.type !== 'textBatch') return;
        if (e.error) reject(new Error(e.error));
        items.push(...e.items);
        if (e.done) resolve({ items, stats: e.stats! });
      });
      this.send({ type: 'searchText', id, query: { query, matchCase: false, words: false, regex: false, ...opts }, scope, limit });
    });
  }
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-test-'));
  const write = (rel: string, content: string | Buffer) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('app/Http/Controllers/UserController.php', `<?php\nnamespace App\\Http\\Controllers;\n\nclass UserController extends Controller\n{\n    public function index(Request $request)\n    {\n        return $this->userService->findAll(); // findAll users\n    }\n}\n`);
  write('app/Services/UserService.php', `<?php\nnamespace App\\Services;\n\nclass UserService\n{\n    public function findAll(): array\n    {\n        return [];\n    }\n}\n`);
  write('resources/js/app.js', 'export function boot() {\r\n  console.log("booting");\r\n  return findAll();\r\n}\r\n');
  write('vendor/acme/lib/src/FindAllHelper.php', '<?php\nclass FindAllHelper { function findAll() {} }\n');
  write('public/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]));
  write('README.md', '# Demo\nCall findAll() to list users.\n');
  const files: FileTuple[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(root, p).replace(/\\/g, '/');
        files.push([p, rel, rel.startsWith('vendor/')]);
      }
    }
  };
  walk(root);
  return { root, files, write };
}

test('worker: index, search, replace, persist', async () => {
  const { root, files, write } = makeProject();
  const storageFile = path.join(root, '.storage', 'index.bin');
  const settings = { maxFileSize: 1 << 20, contentCacheBytes: 16 << 20, persist: true, storageFile };

  const c = new Client();
  c.send({ type: 'init', settings });
  const ready = c.ready();
  c.send({ type: 'setFiles', files });
  const st = await ready;
  assert.equal(st.totalFiles, files.length);
  assert.ok(st.symbols >= 6, `symbols: ${st.symbols}`);

  // literal search, project scope excludes vendor
  let r = await c.text('findAll');
  assert.deepEqual(r.items.map((m) => `${m.rel}:${m.line + 1}`).sort(), [
    'README.md:2',
    'app/Http/Controllers/UserController.php:8',
    'app/Services/UserService.php:6',
    'resources/js/app.js:3',
  ]);
  const ctrl = r.items.find((m) => m.rel.endsWith('UserController.php'))!;
  assert.equal(ctrl.count, 2, 'two occurrences merged on one line');
  assert.equal(r.stats.matches, 5);
  assert.equal(ctrl.text.slice(ctrl.ranges[0], ctrl.ranges[1]), 'findAll');
  // all places include vendor
  r = await c.text('findAll', {}, { includeLibraries: true });
  assert.equal(r.stats.files, 5);
  // case sensitive / words / regex
  r = await c.text('FINDALL', { matchCase: true });
  assert.equal(r.items.length, 0);
  r = await c.text('user', { words: true });
  assert.deepEqual(r.items.map((m) => m.rel), []);
  r = await c.text('users', { words: true });
  assert.equal(r.items.length, 2);
  r = await c.text('function\\s+(index|findAll)\\(', { regex: true });
  assert.equal(r.items.length, 2);
  // CRLF file: columns are not shifted by \r, text excludes it
  r = await c.text('booting');
  assert.equal(r.items[0].line, 1);
  assert.ok(!r.items[0].text.includes('\r'));
  // multi-line literal across CRLF
  r = await c.text('boot() {\n  console');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].endLine, 1);
  // mask & directory scope
  r = await c.text('findAll', {}, { includeLibraries: false, mask: '*.php' });
  assert.equal(r.stats.files, 2);
  r = await c.text('findAll', {}, { includeLibraries: true, dirPrefix: path.join(root, 'app', 'Services') });
  assert.equal(r.stats.files, 1);
  // short query (no trigram) still works
  r = await c.text('[]');
  assert.equal(r.items.length, 1);

  // files & symbols
  const fh = await c.req<any[]>({ type: 'searchFiles', pattern: 'UsCo', includeLib: false, limit: 10, recent: [] });
  assert.equal(fh[0].name, 'UserController.php');
  const fl = await c.req<any[]>({ type: 'searchFiles', pattern: 'serv/user:6', includeLib: false, limit: 10, recent: [] });
  assert.equal(fl[0].name, 'UserService.php');
  assert.equal(fl[0].line, 5);
  const sh = await c.req<any[]>({ type: 'searchSymbols', pattern: 'UserService::findAll', classesOnly: false, includeLib: false, limit: 10 });
  assert.equal(sh[0].name, 'findAll');
  assert.equal(sh[0].container, 'UserService');
  const classes = await c.req<any[]>({ type: 'searchSymbols', pattern: 'fah', classesOnly: true, includeLib: false, limit: 10 });
  assert.equal(classes[0]?.name, 'FindAllHelper', 'falls back to libraries when nothing in project');

  // unsaved document override
  c.send({ type: 'override', path: path.join(root, 'README.md'), content: '# Demo\nnothing here\nfindAll twice findAll\n' });
  await new Promise((res) => setTimeout(res, 100));
  r = await c.text('findAll');
  const readme = r.items.find((m) => m.rel === 'README.md')!;
  assert.equal(readme.line, 2);
  assert.equal(readme.count, 2);
  c.send({ type: 'override', path: path.join(root, 'README.md'), content: null });

  // replace with groups
  const edits = await c.req<any[]>({
    type: 'computeReplace',
    query: { query: 'find(All)', matchCase: true, words: false, regex: true },
    scope: { includeLibraries: false, mask: '*.php' },
    replacement: 'get$1',
  });
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.flatMap((f: any) => f.edits.map((e: any) => e.text)), ['getAll', 'getAll', 'getAll']);

  // persistence
  await c.req({ type: 'flush' });
  assert.ok(fs.existsSync(storageFile));
  await c.w.terminate();

  // modify a file while "VS Code is closed"
  await new Promise((res) => setTimeout(res, 20));
  write('app/Services/UserService.php', `<?php\nclass UserService\n{\n    public function brandNewMethod() {}\n}\n`);

  const c2 = new Client();
  c2.send({ type: 'init', settings });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(c2.status?.totalFiles, files.length, 'index restored from disk before scanning');
  const ready2 = c2.ready();
  c2.send({ type: 'setFiles', files });
  await ready2;
  await new Promise((res) => setTimeout(res, 300));
  r = await c2.text('brandNewMethod');
  assert.equal(r.items.length, 1, 'modified file re-indexed');
  r = await c2.text('findAll');
  assert.equal(r.stats.files, 3);
  const sym = await c2.req<any[]>({ type: 'searchSymbols', pattern: 'brandNew', classesOnly: false, includeLib: false, limit: 10 });
  assert.equal(sym.length, 1);
  await c2.w.terminate();
  fs.rmSync(root, { recursive: true, force: true });
});

test('worker: performance on a synthetic project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-perf-'));
  const files: FileTuple[] = [];
  const words = ['user', 'order', 'invoice', 'product', 'customer', 'payment', 'shipping', 'cart', 'catalog', 'account'];
  for (let i = 0; i < 3000; i++) {
    const a = words[i % words.length];
    const b = words[(i * 7) % words.length];
    const name = `${a[0].toUpperCase()}${a.slice(1)}${b[0].toUpperCase()}${b.slice(1)}${i}`;
    const body = Array.from({ length: 60 }, (_, k) => `    public function ${b}Method${k}($${a}) { return $this->${a}Repository->find${k}($${a}->id); }`).join('\n');
    const rel = `src/${a}/${name}.php`;
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `<?php\nnamespace App\\${a};\n\nclass ${name}\n{\n${body}\n}\n${i === 1234 ? '// NEEDLE_UNIQUE_TOKEN\n' : ''}`);
    files.push([p, rel, false]);
  }
  const c = new Client();
  c.send({ type: 'init', settings: { maxFileSize: 1 << 20, contentCacheBytes: 256 << 20, persist: false } });
  const t0 = Date.now();
  const ready = c.ready();
  c.send({ type: 'setFiles', files });
  const st = await ready;
  const indexMs = Date.now() - t0;
  let t = Date.now();
  let r = await c.text('NEEDLE_UNIQUE_TOKEN');
  const rareMs = Date.now() - t;
  assert.equal(r.items.length, 1);
  t = Date.now();
  r = await c.text('customerRepository', {}, { includeLibraries: false }, 1000);
  const commonMs = Date.now() - t;
  assert.equal(r.stats.truncated, true);
  t = Date.now();
  const fh = await c.req<any[]>({ type: 'searchFiles', pattern: 'UsOr12', includeLib: false, limit: 50, recent: [] });
  const filesMs = Date.now() - t;
  t = Date.now();
  const sh = await c.req<any[]>({ type: 'searchSymbols', pattern: 'cartMethod59', classesOnly: false, includeLib: false, limit: 50 });
  const symMs = Date.now() - t;
  console.log(`  ${files.length} files / ${st.symbols} symbols indexed in ${indexMs} ms; rare text ${rareMs} ms; frequent text (1000 lines) ${commonMs} ms; files ${filesMs} ms; symbols ${symMs} ms`);
  assert.ok(fh.length > 0 && sh.length > 0);
  assert.ok(rareMs < 200, 'rare-term search should be near-instant thanks to the trigram index');

  // Bursts of file-system events (agents building in a worktree, git checkout…) must not freeze searches.
  const ghost = Array.from({ length: 20000 }, (_, i) => path.join(root, '.claude', 'worktrees', 'wt', 'vendor', `p${i % 300}`, `F${i}.php`));
  t = Date.now();
  for (let i = 0; i < ghost.length; i += 200) c.send({ type: 'deleted', paths: ghost.slice(i, i + 200) });
  r = await c.text('NEEDLE_UNIQUE_TOKEN');
  const burstDeleteMs = Date.now() - t;
  assert.equal(r.items.length, 1);
  const changed = files.map((f) => f[0]);
  t = Date.now();
  for (let i = 0; i < changed.length; i += 200) c.send({ type: 'changed', paths: changed.slice(i, i + 200) });
  r = await c.text('NEEDLE_UNIQUE_TOKEN');
  const burstChangeMs = Date.now() - t;
  assert.equal(r.items.length, 1);
  // deleting a real directory removes everything below it
  c.send({ type: 'deleted', paths: [path.join(root, 'src', 'user')] });
  r = await c.text('userRepository', {}, { includeLibraries: false }, 100000);
  assert.ok(r.items.every((m) => !m.rel.startsWith('src/user/')));
  console.log(`  burst: 20k excluded deletions → search in ${burstDeleteMs} ms; ${changed.length} changed files → search in ${burstChangeMs} ms`);
  assert.ok(burstDeleteMs < 2000, `search blocked ${burstDeleteMs} ms by a deletion burst`);
  assert.ok(burstChangeMs < 15000, `search blocked ${burstChangeMs} ms by a change burst`);
  await c.w.terminate();
  fs.rmSync(root, { recursive: true, force: true });
});
