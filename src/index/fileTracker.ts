import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IndexClient } from './indexClient';
import { IgnoreMatcher } from './gitignore';
import { globToRegExp } from '../shared/query';
import type { FileTuple } from './worker';

/**
 * Lists the workspace files, keeps the worker informed about file system
 * changes and pushes the content of unsaved documents (PhpStorm searches the
 * in-memory content of modified documents, not the stale file on disk).
 */
export class FileTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private excludeRes: RegExp[] = [];
  private libraryRes: RegExp[] = [];
  private excludeGlob = '';
  private alwaysIndexRes: RegExp[] = [];
  /** Git ignore rules per workspace folder (empty when storm.useIgnoreFiles is off). */
  private ignoreRoots: Array<{ folder: string; root: string; repos: Map<string, { root: string; matcher: IgnoreMatcher }> }> = [];
  /** Directory → root of the git repository it belongs to (nested repositories included). */
  private repoCache = new Map<string, string>();
  /** Files ignored by git, searchable on demand ("Including Ignored Files" scope, directory scope). */
  private ignored: FileTuple[] = [];
  private ignoredStale = false;
  private ignoredListing: Promise<FileTuple[]> | null = null;
  private changeTimers = new Map<string, NodeJS.Timeout>();
  private fsBatch = { changed: new Set<string>(), deleted: new Set<string>(), created: new Set<string>() };
  private fsTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(private readonly client: IndexClient, private readonly log: vscode.OutputChannel) {
    this.computeExcludes();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.queueFs('created', u)),
      watcher.onDidChange((u) => this.queueFs('changed', u)),
      watcher.onDidDelete((u) => this.queueFs('deleted', u)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChanged(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.clearOverride(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.clearOverride(d)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRescan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('storm.exclude') || e.affectsConfiguration('storm.libraryFolders') ||
          e.affectsConfiguration('storm.useIgnoreFiles') || e.affectsConfiguration('storm.alwaysIndex') ||
          e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude') ||
          e.affectsConfiguration('storm.respectSearchExclude') || e.affectsConfiguration('storm.maxFiles')) {
          this.computeExcludes();
          this.scheduleRescan();
        }
      }),
    );
  }

  private computeExcludes() {
    const cfg = vscode.workspace.getConfiguration('storm');
    const globs = new Set<string>(cfg.get<string[]>('exclude', []));
    const fromSetting = (section: string) => {
      const obj = vscode.workspace.getConfiguration(undefined, null).get<Record<string, unknown>>(section) ?? {};
      for (const [g, v] of Object.entries(obj)) if (v === true) globs.add(g);
    };
    fromSetting('files.exclude');
    if (cfg.get<boolean>('respectSearchExclude', true)) fromSetting('search.exclude');
    const all = Array.from(globs).map((g) => (g.startsWith('**/') || g.startsWith('/') ? g : `**/${g}`));
    // Patterns that already contain braces cannot be nested in a {a,b} union: filter them in JS.
    this.excludeGlob = `{${all.filter((g) => !g.includes('{')).join(',')}}`;
    this.excludeRes = all.map((g) => globToRegExp(g.replace(/^\//, '')));
    this.libraryRes = (cfg.get<string[]>('libraryFolders', []) ?? []).map((g) => globToRegExp(g));
    this.alwaysIndexRes = (cfg.get<string[]>('alwaysIndex', []) ?? []).map((g) => globToRegExp(g.startsWith('**/') ? g : `**/${g}`));
  }

  /**
   * Loads the git ignore rules of every workspace folder: .git/info/exclude, the .gitignore
   * files of the folders between the repository root and the workspace folder, and every
   * .gitignore inside the workspace folder (except in excluded locations).
   *
   * A folder with its own ".git" inside the workspace is a separate repository (e.g. a workspace
   * repository whose .gitignore ignores "com_*", each com_* folder being a repository of its own):
   * as in git, only its own rules apply to its files, never those of the enclosing repository.
   */
  private async loadIgnoreRules() {
    const roots: FileTracker['ignoreRoots'] = [];
    this.repoCache.clear();
    if (vscode.workspace.getConfiguration('storm').get<boolean>('useIgnoreFiles', true)) {
      const ignoreCase = process.platform === 'win32' || process.platform === 'darwin';
      for (const wf of vscode.workspace.workspaceFolders ?? []) {
        if (wf.uri.scheme !== 'file') continue;
        const folder = wf.uri.fsPath;
        const gitPath = findGitPath(folder);
        const root = gitPath ? path.dirname(gitPath) : folder;
        const repos = new Map<string, { root: string; matcher: IgnoreMatcher }>();
        /** Matcher of a repository, created with its .git/info/exclude rules. */
        const repoMatcher = (repoRoot: string) => {
          let r = repos.get(normKey(repoRoot));
          if (!r) {
            r = { root: repoRoot, matcher: new IgnoreMatcher(ignoreCase) };
            const exclude = gitInfoExclude(path.join(repoRoot, '.git'));
            if (exclude) r.matcher.add('', readText(exclude));
            repos.set(normKey(repoRoot), r);
          }
          return r;
        };
        const outer = repoMatcher(root);
        // .gitignore files above the workspace folder, up to the repository root
        if (root !== folder) {
          for (let d = path.dirname(folder); ; d = path.dirname(d)) {
            outer.matcher.add(path.relative(root, d), readText(path.join(d, '.gitignore')));
            if (d === root || path.dirname(d) === d) break;
          }
        }
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(wf, '**/.gitignore'), this.excludeGlob, 5000);
        for (const u of files) {
          const dir = path.dirname(u.fsPath);
          const repo = repoMatcher(this.repoRootOf(dir, root));
          repo.matcher.add(path.relative(repo.root, dir), readText(u.fsPath));
        }
        if ([...repos.values()].some((r) => r.matcher.size)) roots.push({ folder: normKey(folder), root, repos });
      }
      // nested workspace folders: the most specific one first
      roots.sort((a, b) => b.folder.length - a.folder.length);
    }
    this.ignoreRoots = roots;
  }

  /** Nearest directory containing ".git" from `dir` up to `outerRoot` (the enclosing repository). */
  private repoRootOf(dir: string, outerRoot: string): string {
    const key = normKey(dir);
    const cached = this.repoCache.get(key);
    if (cached !== undefined) return cached;
    let root: string;
    if (key === normKey(outerRoot) || !key.startsWith(normKey(outerRoot) + '/')) root = outerRoot;
    else if (fs.existsSync(path.join(dir, '.git'))) root = dir;
    else root = this.repoRootOf(path.dirname(dir), outerRoot);
    this.repoCache.set(key, root);
    return root;
  }

  /** Is the file ignored by git (and not kept by storm.libraryFolders / storm.alwaysIndex)? */
  private isIgnored(fsPath: string, rel: string): boolean {
    if (!this.ignoreRoots.length) return false;
    const key = normKey(fsPath);
    const r = this.ignoreRoots.find((x) => key === x.folder || key.startsWith(x.folder + '/'));
    if (!r) return false;
    const repo = r.repos.get(normKey(this.repoRootOf(path.dirname(fsPath), r.root)));
    if (!repo || !repo.matcher.ignores(path.relative(repo.root, fsPath))) return false;
    // Libraries (vendor…) and helper files stay indexed even when git ignores them.
    return !this.isLibrary(rel) && !this.alwaysIndexRes.some((re) => re.test(rel));
  }

  private rel(uri: vscode.Uri): string {
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return vscode.workspace.asRelativePath(uri, multi).replace(/\\/g, '/');
  }

  private isExcluded(rel: string) {
    return this.excludeRes.some((r) => r.test(rel) || r.test(rel + '/'));
  }

  private isLibrary(rel: string) {
    return this.libraryRes.some((r) => r.test(rel));
  }

  /** Indexable file, 'ignored' (by git) or null (excluded / not a local file). */
  private classify(uri: vscode.Uri): FileTuple | 'ignored' | null {
    if (uri.scheme !== 'file') return null;
    const rel = this.rel(uri);
    if (this.isExcluded(rel)) return null;
    if (this.isIgnored(uri.fsPath, rel)) return 'ignored';
    return [uri.fsPath, rel, this.isLibrary(rel)];
  }

  /** Lists the workspace: indexable files and files ignored by git. */
  private async list(): Promise<{ files: FileTuple[]; ignored: FileTuple[] }> {
    const max = vscode.workspace.getConfiguration('storm').get<number>('maxFiles', 300000);
    const uris = await vscode.workspace.findFiles('**/*', this.excludeGlob, max);
    const files: FileTuple[] = [];
    const ignored: FileTuple[] = [];
    for (const u of uris) {
      const c = this.classify(u);
      if (c === 'ignored') ignored.push([u.fsPath, this.rel(u), false]);
      else if (c) files.push(c);
    }
    return { files, ignored };
  }

  async scan() {
    const t0 = Date.now();
    await this.loadIgnoreRules();
    const { files, ignored } = await this.list();
    this.ignored = ignored;
    this.ignoredStale = false;
    this.client.setFiles(files);
    let rules = 0;
    for (const r of this.ignoreRoots) for (const repo of r.repos.values()) rules += repo.matcher.size;
    this.log.appendLine(`Listed ${files.length} files in ${Date.now() - t0} ms` + (rules ? ` (${ignored.length} more ignored by ${rules} git ignore rules)` : ''));
    // Unsaved documents
    for (const d of vscode.workspace.textDocuments) if (d.isDirty) this.pushOverride(d);
  }

  /** Files ignored by git, listed again if some changed since the last listing. */
  ignoredFiles(): Promise<FileTuple[]> {
    if (!this.ignoredStale) return this.ignoredListing ?? Promise.resolve(this.ignored);
    // One listing at a time: concurrent searches (one per keystroke) share it.
    if (!this.ignoredListing) {
      this.ignoredStale = false;
      this.ignoredListing = this.list()
        .then((r) => (this.ignored = r.ignored))
        .finally(() => (this.ignoredListing = null));
    }
    return this.ignoredListing;
  }

  private scheduleRescan() {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.scan().catch((e) => this.log.appendLine(`scan failed: ${e}`)), 1000);
  }

  private queueFs(kind: 'created' | 'changed' | 'deleted', uri: vscode.Uri) {
    if (uri.scheme !== 'file') return;
    const p = uri.fsPath;
    const rel = this.rel(uri);
    // A changed ignore file changes what is indexed: list the workspace again. .git/info/exclude
    // lives in an excluded location; the other .gitignore files there are never read.
    if (/[\\/]\.git[\\/]info[\\/]exclude$/i.test(p)) this.scheduleRescan();
    // Excluded locations (worktrees, .git, caches, node_modules…) can churn thousands of
    // events per second during builds: drop them here, nothing below them is indexed.
    if (this.isExcluded(rel)) return;
    if (/[\\/]\.gitignore$/i.test(p)) this.scheduleRescan();
    // Ignored files are not indexed either: only remember that their listing is out of date.
    if (this.isIgnored(p, rel)) {
      this.ignoredStale = true;
      return;
    }
    if (kind === 'deleted') {
      this.fsBatch.created.delete(p);
      this.fsBatch.changed.delete(p);
    }
    this.fsBatch[kind].add(p);
    if (!this.fsTimer) this.fsTimer = setTimeout(() => this.flushFs(), 200);
  }

  private async flushFs() {
    this.fsTimer = null;
    const { changed, deleted, created } = this.fsBatch;
    this.fsBatch = { changed: new Set(), deleted: new Set(), created: new Set() };
    if (deleted.size) this.client.send({ type: 'deleted', paths: Array.from(deleted) });
    if (changed.size) this.client.send({ type: 'changed', paths: Array.from(changed) });
    if (!created.size) return;
    const files: FileTuple[] = [];
    const add = (u: vscode.Uri) => {
      const c = this.classify(u);
      // e.g. build/ recreated with a "build/" rule: the directory event is not matched as a file
      if (c === 'ignored') this.ignoredStale = true;
      else if (c) files.push(c);
    };
    const handle = async (p: string) => {
      const uri = vscode.Uri.file(p);
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.type & vscode.FileType.Directory) {
          // A directory was created / moved in: list its content.
          if (!vscode.workspace.getWorkspaceFolder(uri)) return;
          const inside = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'), this.excludeGlob, 50000);
          for (const u of inside) add(u);
        } else add(uri);
      } catch {
        /* vanished already */
      }
    };
    // stat in parallel (bounded) instead of one file at a time
    const list = Array.from(created);
    for (let i = 0; i < list.length; i += 64) await Promise.all(list.slice(i, i + 64).map(handle));
    if (files.length) this.client.send({ type: 'addFiles', files });
  }

  private onDocChanged(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    const key = doc.uri.fsPath;
    const t = this.changeTimers.get(key);
    if (t) clearTimeout(t);
    this.changeTimers.set(
      key,
      setTimeout(() => {
        this.changeTimers.delete(key);
        if (doc.isDirty) this.pushOverride(doc);
        else this.clearOverride(doc);
      }, 250),
    );
  }

  private pushOverride(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    this.client.send({ type: 'override', path: doc.uri.fsPath, content: doc.getText() });
  }

  private clearOverride(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    const t = this.changeTimers.get(doc.uri.fsPath);
    if (t) {
      clearTimeout(t);
      this.changeTimers.delete(doc.uri.fsPath);
    }
    this.client.send({ type: 'override', path: doc.uri.fsPath, content: null });
  }

  dispose() {
    for (const t of this.changeTimers.values()) clearTimeout(t);
    if (this.fsTimer) clearTimeout(this.fsTimer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Lower-cased (case-insensitive file systems) path with "/" separators, used as a lookup key. */
export function normKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The ".git" entry (directory, or file of a worktree / submodule) of the repository containing dir. */
function findGitPath(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    if (fs.existsSync(g)) return g;
    if (path.dirname(d) === d) return undefined;
  }
}

/** Path of info/exclude for a ".git" directory or a ".git" file ("gitdir: ..." of worktrees). */
function gitInfoExclude(gitPath: string): string | undefined {
  try {
    let dir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(gitPath));
      if (!m) return undefined;
      dir = path.resolve(path.dirname(gitPath), m[1].trim());
      // linked worktrees keep info/exclude in the common directory
      const common = readText(path.join(dir, 'commondir')).trim();
      if (common) dir = path.resolve(dir, common);
    }
    return path.join(dir, 'info', 'exclude');
  } catch {
    return undefined;
  }
}
