// Index worker: owns the whole index and runs every search off the extension
// host thread. Communication happens through structured messages (see
// WorkerRequest / WorkerEvent below).

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { trigramsOf, queryTrigrams } from './trigram';
import { PostingStore, intersect } from './postings';
import { extractSymbols, RawSymbol } from './symbols';
import { compilePattern, fuzzyMatch, CompiledPattern } from '../shared/fuzzy';
import { buildRegExp, requiredLiterals, compileMask, MaskMatcher, expandReplacement } from '../shared/query';
import {
  CLASS_KINDS, FileHit, IndexStatus, LineMatch, ResolvedScope, SymbolHit, SymbolKind, TextQuery, TextSearchStats,
} from '../shared/protocol';

// ---------------------------------------------------------------------------
// Messages

export interface WorkerSettings {
  maxFileSize: number;
  contentCacheBytes: number;
  persist: boolean;
  storageFile?: string;
}

export type FileTuple = [path: string, rel: string, lib: boolean];

export interface ReplaceEdit {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

export type WorkerRequest =
  | { type: 'init'; settings: WorkerSettings }
  | { type: 'settings'; settings: WorkerSettings }
  | { type: 'setFiles'; files: FileTuple[] }
  | { type: 'addFiles'; files: FileTuple[] }
  | { type: 'changed'; paths: string[] }
  | { type: 'deleted'; paths: string[] }
  | { type: 'override'; path: string; content: string | null }
  | { type: 'rebuild' }
  | { type: 'flush'; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'searchText'; id: number; query: TextQuery; scope: ResolvedScope; limit: number }
  | { type: 'searchFiles'; id: number; pattern: string; includeLib: boolean; limit: number; recent: string[] }
  | { type: 'searchSymbols'; id: number; pattern: string; classesOnly: boolean; includeLib: boolean; limit: number }
  | { type: 'recentFiles'; id: number; recent: string[]; limit: number; exclude?: string }
  | { type: 'computeReplace'; id: number; query: TextQuery; scope: ResolvedScope; replacement: string; onlyPath?: string; onlyLine?: number };

export type WorkerEvent =
  | { type: 'status'; status: IndexStatus }
  | { type: 'textBatch'; id: number; items: LineMatch[]; done: boolean; stats?: TextSearchStats; error?: string }
  | { type: 'result'; id: number; payload: unknown; error?: string }
  | { type: 'log'; message: string };

// ---------------------------------------------------------------------------
// State

const IS_WIN = process.platform === 'win32';
const keyOf = (p: string) => (IS_WIN ? p.toLowerCase() : p);

const enum St {
  Pending = 0,
  Indexed = 1,
  Skipped = 2,
}

interface FileEntry {
  path: string;
  key: string;
  rel: string;
  relLower: string;
  name: string;
  nameLower: string;
  dir: string;
  dirLower: string;
  lib: boolean;
  mtime: number;
  size: number;
  state: St;
  docId: number; // id in posting lists, -1 when none
  symbols: RawSymbol[] | null;
  mark: number;
  /** true while the entry sits in the work queue (O(1) membership test). */
  queued: boolean;
}

let settings: WorkerSettings = { maxFileSize: 2560 * 1024, contentCacheBytes: 256 << 20, persist: false };
const entries = new Map<string, FileEntry>();
let docs: Array<FileEntry | null> = [];
let deadDocs = 0;
const postings = new PostingStore();
/** Files indexed since the last rebuild of the compact base segment. */
let docsSinceRebuild = 0;
const overrides = new Map<string, string>();
/**
 * Indexing queue. Membership is tracked with FileEntry.queued so that bursts of
 * file-system events (thousands of changes during a git checkout or a build)
 * stay linear instead of scanning the queue for every event.
 */
class WorkQueue {
  private urgent: FileEntry[] = [];
  private normal: FileEntry[] = [];
  private head = 0;
  get length() {
    return this.urgent.length + this.normal.length - this.head;
  }
  push(e: FileEntry, priority = false) {
    if (e.queued) return;
    e.queued = true;
    (priority ? this.urgent : this.normal).push(e);
  }
  shift(): FileEntry | undefined {
    let e = this.urgent.pop();
    if (!e && this.head < this.normal.length) {
      e = this.normal[this.head++];
      if (this.head > 4096 && this.head * 2 > this.normal.length) {
        this.normal = this.normal.slice(this.head);
        this.head = 0;
      }
    }
    if (e) e.queued = false;
    return e;
  }
  clear() {
    for (const e of this.urgent) e.queued = false;
    for (let i = this.head; i < this.normal.length; i++) this.normal[i].queued = false;
    this.urgent = [];
    this.normal = [];
    this.head = 0;
  }
}
const queue = new WorkQueue();
/** Entry keys sorted, for prefix (directory) lookups. Invalidated when entries are added/removed. */
let sortedKeys: string[] | null = null;
let sortedCache: FileEntry[] | null = null;
let symbolCache: Array<{ s: RawSymbol; e: FileEntry; lower: string }> | null = null;
let scanned = false; // received the initial file list
let dirty = false;
let searchGen = 0;
const cancelled = new Set<number>();

const post = (e: WorkerEvent) => parentPort!.postMessage(e);
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Content cache (LRU with a byte budget)

class ContentCache {
  private map = new Map<string, string>();
  bytes = 0;
  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  has(key: string) {
    return this.map.has(key);
  }
  set(key: string, v: string) {
    const size = v.length * 2;
    if (size > settings.contentCacheBytes / 4) return;
    this.delete(key);
    this.map.set(key, v);
    this.bytes += size;
    while (this.bytes > settings.contentCacheBytes && this.map.size) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }
  delete(key: string) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.bytes -= v.length * 2;
      this.map.delete(key);
    }
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}
const cache = new ContentCache();

// ---------------------------------------------------------------------------
// Entries

const BINARY_EXT = new Set(
  ('png jpg jpeg gif bmp ico icns webp avif tif tiff psd ai eps svgz pdf zip gz tgz bz2 xz 7z rar jar war ear class ' +
    'so dll exe bin dylib o a lib obj pyc pyo woff woff2 ttf otf eot mp3 mp4 m4a wav ogg flac avi mov mkv webm ' +
    'db sqlite sqlite3 phar dat iso dmg pkg deb rpm lock-bin wasm node').split(' '),
);

function makeEntry(p: string, rel: string, lib: boolean): FileEntry {
  const relN = rel.replace(/\\/g, '/');
  const slash = relN.lastIndexOf('/');
  const name = slash >= 0 ? relN.slice(slash + 1) : relN;
  const dir = slash >= 0 ? relN.slice(0, slash) : '';
  return {
    path: p,
    key: keyOf(p),
    rel: relN,
    relLower: relN.toLowerCase(),
    name,
    nameLower: name.toLowerCase(),
    dir,
    dirLower: dir.toLowerCase(),
    lib,
    mtime: 0,
    size: 0,
    state: St.Pending,
    docId: -1,
    symbols: null,
    mark: 0,
    queued: false,
  };
}

function killDoc(e: FileEntry) {
  if (e.docId >= 0) {
    docs[e.docId] = null;
    deadDocs++;
    e.docId = -1;
  }
}

function addEntry(p: string, rel: string, lib: boolean, priority = false) {
  const key = keyOf(p);
  const existing = entries.get(key);
  if (existing) {
    existing.lib = lib;
    if (existing.rel !== rel.replace(/\\/g, '/')) {
      const fresh = makeEntry(p, rel, lib);
      Object.assign(existing, { rel: fresh.rel, relLower: fresh.relLower, dir: fresh.dir, dirLower: fresh.dirLower });
      sortedCache = null;
    }
    return existing;
  }
  const e = makeEntry(p, rel, lib);
  entries.set(key, e);
  sortedCache = null;
  symbolCache = null;
  sortedKeys = null;
  queue.push(e, priority);
  return e;
}

function removeEntry(e: FileEntry) {
  killDoc(e);
  entries.delete(e.key);
  cache.delete(e.key);
  sortedKeys = null;
  e.state = St.Skipped;
  sortedCache = null;
  if (e.symbols?.length) symbolCache = null;
  dirty = true;
}

function markChanged(e: FileEntry, priority = true) {
  if (e.state === St.Pending && e.queued) return;
  killDoc(e);
  cache.delete(e.key);
  e.state = St.Pending;
  if (e.symbols?.length) symbolCache = null;
  queue.push(e, priority);
}

/** Removes every entry located under one of the given directories (one binary search per directory). */
function removeUnder(dirs: Set<string>) {
  if (!dirs.size || !entries.size) return;
  const keys = (sortedKeys ??= Array.from(entries.keys()).sort());
  const doomed: FileEntry[] = [];
  for (const d of dirs) {
    for (const sep of ['\\', '/']) {
      const prefix = d + sep;
      let lo = 0;
      let hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keys[mid] < prefix) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++) {
        const e = entries.get(keys[i]);
        if (e) doomed.push(e);
      }
    }
  }
  for (const e of doomed) if (entries.get(e.key) === e) removeEntry(e);
}

function sortedEntries(): FileEntry[] {
  if (!sortedCache) {
    sortedCache = Array.from(entries.values()).sort((a, b) => (a.relLower < b.relLower ? -1 : a.relLower > b.relLower ? 1 : 0));
  }
  return sortedCache;
}

// ---------------------------------------------------------------------------
// Indexing

let pumping = false;
let lastStatus = 0;

interface ReadResult {
  text: string | null;
  mtime: number;
  size: number;
}

async function readForIndex(e: FileEntry): Promise<ReadResult | null> {
  const ov = overrides.get(e.key);
  if (ov !== undefined) return { text: ov, mtime: e.mtime, size: ov.length };
  let st: fs.Stats;
  try {
    st = await fsp.stat(e.path);
  } catch {
    return null; // vanished
  }
  if (!st.isFile()) return null;
  const ext = e.nameLower.slice(e.nameLower.lastIndexOf('.') + 1);
  if (st.size > settings.maxFileSize || BINARY_EXT.has(ext)) return { text: null, mtime: st.mtimeMs, size: st.size };
  // A search may already have read this (modified) file: the cache is dropped on every change, so it is fresh.
  const cached = cache.get(e.key);
  if (cached !== undefined) return { text: cached, mtime: st.mtimeMs, size: st.size };
  try {
    const buf = await fsp.readFile(e.path);
    const probe = Math.min(buf.length, 8000);
    for (let i = 0; i < probe; i++) if (buf[i] === 0) return { text: null, mtime: st.mtimeMs, size: st.size };
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, mtime: st.mtimeMs, size: st.size };
  } catch {
    return { text: null, mtime: st.mtimeMs, size: st.size };
  }
}

function applyIndex(e: FileEntry, r: ReadResult) {
  e.mtime = r.mtime;
  e.size = r.size;
  killDoc(e);
  if (r.text === null) {
    e.state = St.Skipped;
    if (e.symbols?.length) symbolCache = null;
    e.symbols = null;
    return;
  }
  const id = docs.length;
  docs.push(e);
  e.docId = id;
  const tris = trigramsOf(r.text);
  postings.addDoc(id, tris);
  docsSinceRebuild++;
  const syms = extractSymbols(e.name, r.text);
  if (syms.length || e.symbols?.length) symbolCache = null;
  e.symbols = syms.length ? syms : null;
  e.state = St.Indexed;
  if (!overrides.has(e.key)) cache.set(e.key, r.text);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const batch: FileEntry[] = [];
      while (queue.length && batch.length < 48) {
        const e = queue.shift()!;
        if (e.state === St.Pending && entries.get(e.key) === e && !batch.includes(e)) batch.push(e);
      }
      if (!batch.length) continue;
      const results = await Promise.all(batch.map(readForIndex));
      for (let i = 0; i < batch.length; i++) {
        const e = batch[i];
        if (entries.get(e.key) !== e || e.state !== St.Pending) continue;
        const r = results[i];
        if (r === null) removeEntry(e);
        else applyIndex(e, r);
      }
      dirty = true;
      // Keep the mutable part small: merge it into the compact base every few thousand files.
      // Geometric: merge once the recent part is as large as the base (amortised O(n) overall).
      if (docsSinceRebuild >= Math.max(4000, docs.length - docsSinceRebuild) || postings.pendingBytes > 96 << 20) compact();
      maybeStatus();
      await yieldNow();
    }
  } finally {
    pumping = false;
  }
  maybeCompact();
  sendStatus();
  schedulePersist();
  scheduleWarmup();
}

function counts() {
  let indexed = 0;
  let pending = 0;
  for (const e of entries.values()) {
    if (e.state === St.Pending) pending++;
    else indexed++;
  }
  return { indexed, pending };
}

function sendStatus() {
  lastStatus = Date.now();
  const { indexed, pending } = counts();
  let symbols = 0;
  for (const e of entries.values()) symbols += e.symbols?.length ?? 0;
  post({
    type: 'status',
    status: {
      state: !scanned ? 'scanning' : pending > 0 ? 'indexing' : 'ready',
      totalFiles: entries.size,
      indexedFiles: indexed,
      pendingFiles: pending,
      trigrams: postings.trigramCount,
      symbols,
    },
  });
}

function maybeStatus() {
  if (Date.now() - lastStatus > 300) sendStatus();
}

function maybeCompact() {
  // A few recently (re)indexed files stay in the small mutable part: merging costs a full pass.
  // At the end of an indexing run, also merge when the recent part is at least as large as the base (e.g. a first index).
  if ((docsSinceRebuild > 0 && docsSinceRebuild >= docs.length - docsSinceRebuild) || postings.pendingBytes > 96 << 20 || (deadDocs >= 2000 && deadDocs >= docs.length * 0.3)) compact();
}

/** Merges recent lists into the compact base, drops deleted / outdated files and renumbers the others. */
function compact() {
  const remap = new Int32Array(docs.length).fill(-1);
  const newDocs: FileEntry[] = [];
  for (let d = 0; d < docs.length; d++) {
    const e = docs[d];
    if (e && e.docId === d) {
      remap[d] = newDocs.length;
      newDocs.push(e);
    }
  }
  postings.rebuild(remap);
  for (let d = 0; d < newDocs.length; d++) newDocs[d].docId = d;
  docs = newDocs;
  deadDocs = 0;
  docsSinceRebuild = 0;
}

// Warm the content cache in the background so that short queries (that cannot
// use the trigram index) are answered from memory as well.
let warmTimer: NodeJS.Timeout | null = null;
function scheduleWarmup() {
  if (warmTimer) return;
  warmTimer = setTimeout(async () => {
    warmTimer = null;
    let reads = 0;
    for (const e of sortedEntries()) {
      if (queue.length) return; // indexing has priority, will reschedule
      if (cache.bytes > settings.contentCacheBytes * 0.9) return;
      if (e.state !== St.Indexed || cache.has(e.key) || overrides.has(e.key) || e.lib) continue;
      await getContent(e);
      if (++reads % 32 === 0) await yieldNow();
    }
  }, 1500);
}

// ---------------------------------------------------------------------------
// Persistence
//
// Layout: "STRM" | u32 version | u32 jsonLength | zlib(json) | padding to 4 | postings base segment
// (see PostingStore.serialize: count, sorted keys, offsets, counts, gap/varint encoded ids)

const MAGIC = 0x4d525453; // "STRM" little endian
const VERSION = 4;
const KINDS: SymbolKind[] = ['class', 'interface', 'trait', 'enum', 'struct', 'type', 'module', 'namespace', 'function', 'method', 'field', 'constant', 'property'];

let persistTimer: NodeJS.Timeout | null = null;
function schedulePersist(delay = 15000) {
  if (!settings.persist || !settings.storageFile || !dirty) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (queue.length) {
      schedulePersist(delay);
      return;
    }
    persistNow().catch((e) => post({ type: 'log', message: `persist failed: ${e}` }));
  }, delay);
}

async function persistNow() {
  if (!settings.persist || !settings.storageFile || !dirty) return;
  // Merge everything into the base segment: ids become 0..n-1 and the delta is empty.
  compact();
  const list = Array.from(entries.values());
  const files = list.map((e) => [
    e.path, e.rel, e.lib ? 1 : 0, e.mtime, e.size, e.state === St.Indexed && e.docId >= 0 ? St.Indexed : e.state === St.Skipped ? St.Skipped : St.Pending,
    e.docId,
  ]);
  const syms = list.map((e) => (e.symbols ? e.symbols.map((s) => [s.name, KINDS.indexOf(s.kind), s.line, s.col, s.container]) : 0));
  // File list and symbols: JSON compressed with zlib (fast level, ~5x smaller).
  const json = zlib.deflateSync(Buffer.from(JSON.stringify({ v: VERSION, files, syms }), 'utf8'), { level: 3 });
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(VERSION, 4);
  header.writeUInt32LE(json.length, 8);
  const pad = Buffer.alloc((4 - ((12 + json.length) % 4)) % 4);
  const file = settings.storageFile!;
  const data = Buffer.concat([header, json, pad, ...postings.serialize()]);
  // The snapshot is taken: changes made while writing set dirty again and are saved next time.
  dirty = false;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (e) {
    dirty = true;
    throw e;
  }
}

function loadPersisted(): boolean {
  const file = settings.storageFile;
  if (!settings.persist || !file || !fs.existsSync(file)) return false;
  try {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== VERSION) return false;
    const jsonLen = buf.readUInt32LE(8);
    const data = JSON.parse(zlib.inflateSync(buf.subarray(12, 12 + jsonLen)).toString('utf8')) as {
      files: Array<[string, string, number, number, number, number, number]>;
      syms: Array<0 | Array<[string, number, number, number, string]>>;
    };
    const off = 12 + jsonLen + ((4 - ((12 + jsonLen) % 4)) % 4);
    postings.load(buf, off);
    const maxDoc = data.files.reduce((m, f) => Math.max(m, f[6]), -1);
    docs = new Array(maxDoc + 1).fill(null);
    data.files.forEach((f, i) => {
      const e = makeEntry(f[0], f[1], !!f[2]);
      e.mtime = f[3];
      e.size = f[4];
      e.state = f[5] as St;
      e.docId = f[6];
      const s = data.syms[i];
      if (s) e.symbols = s.map((x) => ({ name: x[0], kind: KINDS[x[1]], line: x[2], col: x[3], container: x[4] }));
      if (e.state === St.Indexed && e.docId >= 0) docs[e.docId] = e;
      else e.docId = -1;
      entries.set(e.key, e);
    });
    docsSinceRebuild = 0;
    for (const e of entries.values()) if (e.state === St.Pending) queue.push(e);
    sortedKeys = null;
    sortedCache = null;
    symbolCache = null;
    return true;
  } catch (e) {
    post({ type: 'log', message: `could not load persisted index: ${e}` });
    entries.clear();
    docs = [];
    postings.clear();
    return false;
  }
}

/** After loading a persisted index, check every file for modifications made while VS Code was closed. */
async function revalidate() {
  const list = Array.from(entries.values()).filter((e) => e.state !== St.Pending);
  const CONC = 64;
  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const e = list[idx++];
      if (entries.get(e.key) !== e || e.state === St.Pending) continue;
      try {
        const st = await fsp.stat(e.path);
        if (Math.abs(st.mtimeMs - e.mtime) > 1 || st.size !== e.size) markChanged(e, false);
      } catch {
        removeEntry(e);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  pump();
}

// ---------------------------------------------------------------------------
// Content access

async function getContent(e: FileEntry): Promise<string | null> {
  const ov = overrides.get(e.key);
  if (ov !== undefined) return ov;
  const c = cache.get(e.key);
  if (c !== undefined) return c;
  if (e.state === St.Skipped) return null;
  const r = await readForIndex(e);
  if (!r || r.text === null) return null;
  // For a pending (new / modified) file this also lets the indexing queue reuse the content.
  // Files outside the index (ignored by git) are not cached: they would evict indexed ones.
  if (entries.get(e.key) === e) cache.set(e.key, r.text);
  return r.text;
}

// ---------------------------------------------------------------------------
// Text search

function scopeFilter(scope: ResolvedScope): (e: FileEntry) => boolean {
  const mask: MaskMatcher | undefined = scope.mask ? compileMask(scope.mask) : undefined;
  const prefix = scope.dirPrefix ? keyOf(scope.dirPrefix.replace(/[\\/]+$/, '')) : undefined;
  const paths = scope.paths ? new Set(scope.paths.map(keyOf)) : undefined;
  return (e) => {
    if (!scope.includeLibraries && e.lib && !paths) return false;
    if (paths && !paths.has(e.key)) return false;
    if (prefix) {
      if (!(e.key.startsWith(prefix) && (e.key.length === prefix.length || e.key[prefix.length] === '\\' || e.key[prefix.length] === '/'))) return false;
    }
    if (mask && !mask(e.rel, e.name)) return false;
    return true;
  };
}

function candidates(q: TextQuery, scope: ResolvedScope): FileEntry[] {
  const filter = scopeFilter(scope);
  const lits = requiredLiterals(q);
  const gen = ++searchGen;
  const all = sortedEntries();
  if (lits.length === 0) {
    return withExtraFiles(all.filter((e) => e.state !== St.Skipped && filter(e)), scope, filter);
  }
  const lists: Uint32Array[] = [];
  const seen = new Set<number>();
  for (const lit of lits) {
    for (const t of queryTrigrams(lit)) {
      if (seen.has(t)) continue;
      seen.add(t);
      const ids = postings.ids(t);
      lists.push(ids);
      if (!ids.length) break; // a missing trigram: no indexed file can match
    }
  }
  const ids = lists.length ? intersect(lists) : new Uint32Array(0);
  for (let i = 0; i < ids.length; i++) {
    const e = docs[ids[i]];
    if (e && e.docId === ids[i]) e.mark = gen;
  }
  // Pending (not yet indexed or modified) files are always candidates.
  return withExtraFiles(all.filter((e) => (e.mark === gen || e.state === St.Pending) && filter(e)), scope, filter);
}

/** Appends the files ignored by git that the scope asks for: not indexed, they are read directly. */
function withExtraFiles(list: FileEntry[], scope: ResolvedScope, filter: (e: FileEntry) => boolean): FileEntry[] {
  if (!scope.extraFiles?.length) return list;
  const extra: FileEntry[] = [];
  for (const [p, rel, lib] of scope.extraFiles) {
    if (entries.has(keyOf(p))) continue;
    const e = makeEntry(p, rel, lib);
    if (filter(e)) extra.push(e);
  }
  extra.sort((a, b) => (a.relLower < b.relLower ? -1 : a.relLower > b.relLower ? 1 : 0));
  return list.concat(extra);
}

const MAX_LINE_DISPLAY = 400;

/** Finds the matches of `re` in `text`, merged per line. */
function matchText(re: RegExp, text: string, e: FileEntry, maxLines: number, out: LineMatch[]): number {
  re.lastIndex = 0;
  let lineNo = 0;
  let lineStart = 0;
  let scan = 0;
  let current: LineMatch | null = null;
  let currentLineEnd = 0;
  let occurrences = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text))) {
    const s = m.index;
    const len = m[0].length;
    if (len === 0) {
      re.lastIndex = s + 1;
      if (s >= text.length || ++guard > 100000) break;
      continue;
    }
    while (true) {
      const nl = text.indexOf('\n', scan);
      if (nl === -1 || nl >= s) break;
      lineNo++;
      lineStart = nl + 1;
      scan = nl + 1;
    }
    const col = s - lineStart;
    const nlInMatch = countNl(m[0]);
    const endLine = lineNo + nlInMatch;
    const endCol = nlInMatch ? len - m[0].lastIndexOf('\n') - 1 : col + len;
    occurrences++;
    if (current && current.line === lineNo) {
      current.count++;
      const rs = col - current.textOffset;
      const re2 = Math.min(col + len, currentLineEnd - lineStart) - current.textOffset;
      if (rs >= 0 && rs < current.text.length) current.ranges.push(rs, Math.min(re2, current.text.length));
      continue;
    }
    if (out.length >= maxLines) return occurrences - 1;
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    currentLineEnd = lineEnd;
    let from = lineStart;
    let to = lineEnd;
    if (to - from > MAX_LINE_DISPLAY) {
      from = Math.max(lineStart, s - 120);
      to = Math.min(lineEnd, from + MAX_LINE_DISPLAY);
    }
    // trim leading whitespace like PhpStorm does in the usage list
    while (from < s && (text.charCodeAt(from) === 32 || text.charCodeAt(from) === 9)) from++;
    const lineText = text.slice(from, to);
    const offset = from - lineStart;
    current = {
      path: e.path,
      rel: e.rel,
      lib: e.lib,
      line: lineNo,
      text: lineText,
      textOffset: offset,
      ranges: [col - offset, Math.min(col + len, lineEnd - lineStart) - offset],
      col,
      endLine,
      endCol,
      count: 1,
    };
    out.push(current);
  }
  return occurrences;
}

function countNl(s: string) {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

async function searchText(msg: Extract<WorkerRequest, { type: 'searchText' }>) {
  const t0 = Date.now();
  const id = msg.id;
  let re: RegExp;
  try {
    re = buildRegExp(msg.query);
  } catch (e) {
    post({ type: 'textBatch', id, items: [], done: true, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const stats: TextSearchStats = { matches: 0, lines: 0, files: 0, truncated: false, searchedFiles: 0, durationMs: 0 };
  if (!msg.query.query) {
    post({ type: 'textBatch', id, items: [], done: true, stats });
    return;
  }
  const cands = candidates(msg.query, msg.scope);
  let batch: LineMatch[] = [];
  let lastPost = Date.now();
  let lastYield = Date.now();
  // Read ahead: files that are not in memory (e.g. just modified) are read in parallel.
  const READ_AHEAD = 32;
  const reads = new Map<number, Promise<string | null>>();
  let nextRead = 0;
  for (let idx = 0; idx < cands.length; idx++) {
    const e = cands[idx];
    if (cancelled.has(id)) {
      cancelled.delete(id);
      return;
    }
    while (nextRead < cands.length && nextRead < idx + READ_AHEAD) {
      reads.set(nextRead, getContent(cands[nextRead]));
      nextRead++;
    }
    const text = await reads.get(idx)!;
    reads.delete(idx);
    if (text === null) continue;
    stats.searchedFiles++;
    const before = batch.length;
    const occ = matchText(re, text, e, before + (msg.limit - stats.lines), batch);
    const added = batch.length - before;
    if (added > 0) {
      stats.files++;
      stats.lines += added;
      stats.matches += occ;
    }
    if (stats.lines >= msg.limit) {
      stats.truncated = true;
      break;
    }
    const now = Date.now();
    if (now - lastYield > 8) {
      await yieldNow();
      lastYield = Date.now();
    }
    if (batch.length && now - lastPost > 50) {
      post({ type: 'textBatch', id, items: batch, done: false });
      batch = [];
      lastPost = now;
    }
  }
  if (cancelled.has(id)) {
    cancelled.delete(id);
    return;
  }
  stats.durationMs = Date.now() - t0;
  post({ type: 'textBatch', id, items: batch, done: true, stats });
}


async function computeReplace(msg: Extract<WorkerRequest, { type: 'computeReplace' }>) {
  const re = buildRegExp(msg.query);
  let cands = candidates(msg.query, msg.scope);
  if (msg.onlyPath) {
    const k = keyOf(msg.onlyPath);
    cands = cands.filter((e) => e.key === k);
  }
  const result: Array<{ path: string; edits: ReplaceEdit[] }> = [];
  let lastYield = Date.now();
  for (const e of cands) {
    if (cancelled.has(msg.id)) {
      cancelled.delete(msg.id);
      return;
    }
    const text = await getContent(e);
    if (text === null) continue;
    const edits: ReplaceEdit[] = [];
    re.lastIndex = 0;
    let lineNo = 0;
    let lineStart = 0;
    let scan = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const s = m.index;
      if (m[0].length === 0) {
        re.lastIndex = s + 1;
        if (s >= text.length) break;
        continue;
      }
      while (true) {
        const nl = text.indexOf('\n', scan);
        if (nl === -1 || nl >= s) break;
        lineNo++;
        lineStart = nl + 1;
        scan = nl + 1;
      }
      if (msg.onlyLine !== undefined && lineNo !== msg.onlyLine) {
        if (lineNo > msg.onlyLine) break;
        continue;
      }
      const col = s - lineStart;
      const nlc = countNl(m[0]);
      const endCol = nlc ? m[0].length - m[0].lastIndexOf('\n') - 1 : col + m[0].length;
      const replacement = msg.query.regex ? expandReplacement(msg.replacement, m) : msg.replacement;
      edits.push({ line: lineNo, col, endLine: lineNo + nlc, endCol, text: replacement });
    }
    if (edits.length) result.push({ path: e.path, edits });
    // Same time-based yielding as searchText, so that cancel and other messages get through.
    if (Date.now() - lastYield > 8) {
      await yieldNow();
      lastYield = Date.now();
    }
  }
  post({ type: 'result', id: msg.id, payload: result });
}

// ---------------------------------------------------------------------------
// File & symbol search

function parseLineSuffix(pattern: string): { pattern: string; line?: number; col?: number } {
  const m = /^(.*?)(?::(\d+))(?::(\d+))?\s*$/.exec(pattern);
  if (m && m[1]) return { pattern: m[1], line: Number(m[2]) - 1, col: m[3] ? Number(m[3]) - 1 : undefined };
  return { pattern };
}

function searchFiles(msg: Extract<WorkerRequest, { type: 'searchFiles' }>, includeLib = msg.includeLib): FileHit[] {
  const parsed = parseLineSuffix(msg.pattern);
  const raw = parsed.pattern.replace(/\\/g, '/');
  const slash = raw.lastIndexOf('/');
  const namePat = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dirPat = slash >= 0 ? raw.slice(0, slash).replace(/^\/+/, '') : '';
  if (!namePat.trim() && !dirPat) return [];
  const cp = compilePattern(namePat);
  const dp = dirPat ? compilePattern(dirPat) : null;
  const recentRank = new Map<string, number>();
  msg.recent.forEach((p, i) => recentRank.set(keyOf(p), i));
  const hits: FileHit[] = [];
  for (const e of entries.values()) {
    if (!includeLib && e.lib) continue;
    let score = 0;
    let hl: number[] = [];
    if (cp.chars) {
      const r = fuzzyMatch(cp, e.name, e.nameLower);
      if (!r) continue;
      score = r.score;
      hl = r.ranges;
    }
    let dirHl: number[] | undefined;
    if (dp) {
      const d = fuzzyMatch(dp, e.dir, e.dirLower);
      if (!d) continue;
      score += d.score * 0.3;
      dirHl = d.ranges;
    }
    const rr = recentRank.get(e.key);
    if (rr !== undefined) score += 25 - Math.min(20, rr);
    if (e.lib) score -= 5;
    hits.push({ path: e.path, rel: e.rel, name: e.name, dir: e.dir, lib: e.lib, score, hl, dirHl, line: parsed.line, col: parsed.col });
  }
  hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
  if (hits.length === 0 && !includeLib) return searchFiles(msg, true);
  return hits.slice(0, msg.limit);
}

function allSymbols() {
  if (!symbolCache) {
    symbolCache = [];
    for (const e of sortedEntries()) {
      if (!e.symbols) continue;
      for (const s of e.symbols) symbolCache.push({ s, e, lower: s.name.toLowerCase() });
    }
  }
  return symbolCache;
}

const KIND_ORDER: Partial<Record<SymbolKind, number>> = { class: 0, interface: 1, trait: 2, enum: 3, struct: 4, type: 5, module: 6, function: 7, method: 8, constant: 9, field: 10 };

function searchSymbols(msg: Extract<WorkerRequest, { type: 'searchSymbols' }>, includeLib = msg.includeLib): SymbolHit[] {
  let pattern = msg.pattern.trim() ? msg.pattern : '';
  if (!pattern) return [];
  pattern = pattern.replace(/\(\)$/, '');
  // "Class::method", "Class.method", "Class#method", "Ns\Class", "Class->method"
  const m = /^(.*?)(::|->|#|\.|\\)([^:.#\\>]*)$/.exec(pattern);
  let namePat = pattern;
  let contPat: CompiledPattern | null = null;
  if (m && m[1]) {
    namePat = m[3];
    contPat = compilePattern(m[1].replace(/\\/g, '*'));
  }
  const cp = compilePattern(namePat);
  const hits: SymbolHit[] = [];
  for (const { s, e, lower } of allSymbols()) {
    if (!includeLib && e.lib) continue;
    if (msg.classesOnly && !CLASS_KINDS.has(s.kind)) continue;
    let score = 0;
    let hl: number[] = [];
    if (cp.chars) {
      const r = fuzzyMatch(cp, s.name, lower);
      if (!r) continue;
      score = r.score;
      hl = r.ranges;
    }
    if (contPat) {
      const c = s.container ? fuzzyMatch(contPat, s.container) : null;
      if (!c) continue;
      score += c.score * 0.3;
    }
    if (e.lib) score -= 5;
    score -= (KIND_ORDER[s.kind] ?? 11) * 0.05;
    hits.push({ name: s.name, kind: s.kind, container: s.container, path: e.path, rel: e.rel, lib: e.lib, line: s.line, col: s.col, score, hl });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.rel < b.rel ? -1 : 1));
  if (hits.length === 0 && !includeLib) return searchSymbols(msg, true);
  return hits.slice(0, msg.limit);
}

function recentFiles(msg: Extract<WorkerRequest, { type: 'recentFiles' }>): FileHit[] {
  const out: FileHit[] = [];
  const ex = msg.exclude ? keyOf(msg.exclude) : undefined;
  for (const p of msg.recent) {
    const k = keyOf(p);
    if (k === ex) continue;
    const e = entries.get(k);
    if (!e) continue;
    out.push({ path: e.path, rel: e.rel, name: e.name, dir: e.dir, lib: e.lib, score: 0, hl: [] });
    if (out.length >= msg.limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message loop

function respond(id: number, fn: () => unknown) {
  try {
    post({ type: 'result', id, payload: fn() });
  } catch (e) {
    post({ type: 'result', id, payload: null, error: e instanceof Error ? e.message : String(e) });
  }
}

function setFiles(files: FileTuple[]) {
  const seen = new Set<string>();
  for (const [p, rel, lib] of files) {
    seen.add(keyOf(p));
    addEntry(p, rel, lib);
  }
  for (const e of Array.from(entries.values())) if (!seen.has(e.key)) removeEntry(e);
  scanned = true;
  sortedCache = null;
  symbolCache = null;
  dirty = true;
  sendStatus();
  pump();
  revalidate().catch((err) => post({ type: 'log', message: String(err) }));
}

parentPort!.on('message', (msg: WorkerRequest) => {
  switch (msg.type) {
    case 'init':
      settings = msg.settings;
      loadPersisted();
      sendStatus();
      break;
    case 'settings':
      settings = msg.settings;
      break;
    case 'setFiles':
      setFiles(msg.files);
      break;
    case 'addFiles':
      for (const [p, rel, lib] of msg.files) {
        const e = addEntry(p, rel, lib, true);
        if (e.state !== St.Pending) markChanged(e);
      }
      pump();
      break;
    case 'changed':
      for (const p of msg.paths) {
        const e = entries.get(keyOf(p));
        if (e && !overrides.has(e.key)) markChanged(e);
      }
      pump();
      break;
    case 'deleted': {
      const dirs = new Set<string>();
      for (const p of msg.paths) {
        const k = keyOf(p);
        const e = entries.get(k);
        if (e) removeEntry(e);
        else dirs.add(k.replace(/[\\/]+$/, '')); // maybe a directory: remove everything below it
      }
      removeUnder(dirs);
      maybeStatus();
      break;
    }
    case 'override': {
      const k = keyOf(msg.path);
      if (msg.content === null) overrides.delete(k);
      else overrides.set(k, msg.content);
      const e = entries.get(k);
      if (e) {
        markChanged(e);
        pump();
      }
      break;
    }
    case 'rebuild':
      entries.clear();
      docs = [];
      deadDocs = 0;
      docsSinceRebuild = 0;
      postings.clear();
      queue.clear();
      sortedKeys = null;
      cache.clear();
      sortedCache = null;
      symbolCache = null;
      scanned = false;
      dirty = true;
      sendStatus();
      break;
    case 'flush':
      persistNow()
        .catch(() => undefined)
        .finally(() => post({ type: 'result', id: msg.id, payload: true }));
      break;
    case 'cancel':
      cancelled.add(msg.id);
      setTimeout(() => cancelled.delete(msg.id), 10000);
      break;
    case 'searchText':
      searchText(msg).catch((e) => post({ type: 'textBatch', id: msg.id, items: [], done: true, error: String(e) }));
      break;
    case 'computeReplace':
      computeReplace(msg).catch((e) => post({ type: 'result', id: msg.id, payload: null, error: String(e) }));
      break;
    case 'searchFiles':
      respond(msg.id, () => searchFiles(msg));
      break;
    case 'searchSymbols':
      respond(msg.id, () => searchSymbols(msg));
      break;
    case 'recentFiles':
      respond(msg.id, () => recentFiles(msg));
      break;
  }
});
