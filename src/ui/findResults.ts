import * as vscode from 'vscode';
import { SearchService, openLocation } from './searchService';
import type { TextSearchHandle } from '../index/indexClient';
import type { FindOptions, LineMatch, TextSearchStats } from '../shared/protocol';

type Node = DirNode | FileNode | LineNode;

interface DirNode {
  kind: 'dir';
  id: string;
  dir: string;
  files: FileNode[];
}
interface FileNode {
  kind: 'file';
  id: string;
  path: string;
  rel: string;
  name: string;
  dir: string;
  lib: boolean;
  lines: LineNode[];
  parent?: DirNode;
}
interface LineNode {
  kind: 'line';
  id: string;
  match: LineMatch;
  parent: FileNode;
}

/** The "Find" tool window: every occurrence, grouped by directory and file. */
export class FindResults implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  readonly view: vscode.TreeView<Node>;
  private options: FindOptions | undefined;
  private matches: LineMatch[] = [];
  private stats: TextSearchStats | undefined;
  private running: TextSearchHandle | undefined;
  private groupByDir: boolean;
  private roots: Node[] = [];
  private flatLines: LineNode[] = [];
  private cursor = -1;
  private refreshTimer: NodeJS.Timeout | null = null;
  private excluded = new Set<string>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly search: SearchService, private readonly editFind: (o: FindOptions) => void) {
    this.groupByDir = ctx.globalState.get<boolean>('storm.groupByDirectory', true);
    this.view = vscode.window.createTreeView('storm.findResults', { treeDataProvider: this, showCollapseAll: true });
    vscode.commands.executeCommand('setContext', 'storm.groupByDirectory', this.groupByDir);
    vscode.commands.executeCommand('setContext', 'storm.hasFindResults', false);
  }

  // ------------------------------------------------------------ running

  run(o: FindOptions) {
    this.running?.cancel();
    this.options = { ...o };
    this.matches = [];
    this.stats = undefined;
    this.excluded.clear();
    this.cursor = -1;
    this.rebuild();
    this.view.message = `Searching for '${o.query}' ${this.search.scopeLabel(o)}…`;
    vscode.commands.executeCommand('storm.findResults.focus');
    const limit = vscode.workspace.getConfiguration('storm').get<number>('findWindowResultLimit', 50000);
    this.running = this.search.runText(o, limit, (items, done, stats, error) => {
      this.matches.push(...items);
      if (error) {
        this.view.message = `Error: ${error}`;
        return;
      }
      if (done) {
        this.stats = stats;
        this.running = undefined;
        this.flushRefresh();
        this.revealFirst();
      } else this.scheduleRefresh();
    });
  }

  rerun() {
    if (this.options) this.run(this.options);
  }

  edit() {
    if (this.options) this.editFind(this.options);
  }

  clear() {
    this.running?.cancel();
    this.options = undefined;
    this.matches = [];
    this.stats = undefined;
    this.rebuild();
    this.view.message = undefined;
    this.view.description = undefined;
  }

  setGroupByDirectory(v: boolean) {
    this.groupByDir = v;
    this.ctx.globalState.update('storm.groupByDirectory', v);
    vscode.commands.executeCommand('setContext', 'storm.groupByDirectory', v);
    this.rebuild();
  }

  exclude(node: Node) {
    if (node.kind === 'line') this.excluded.add(node.id);
    else if (node.kind === 'file') this.excluded.add(node.id);
    else node.files.forEach((f) => this.excluded.add(f.id));
    this.rebuild();
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => this.flushRefresh(), 250);
  }

  private flushRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.rebuild();
  }

  private rebuild() {
    const files = new Map<string, FileNode>();
    const order: FileNode[] = [];
    for (const m of this.matches) {
      const fid = `f:${m.path}`;
      if (this.excluded.has(fid)) continue;
      let f = files.get(fid);
      if (!f) {
        const slash = m.rel.lastIndexOf('/');
        f = { kind: 'file', id: fid, path: m.path, rel: m.rel, name: m.rel.slice(slash + 1), dir: slash >= 0 ? m.rel.slice(0, slash) : '', lib: m.lib, lines: [] };
        files.set(fid, f);
        order.push(f);
      }
      const lid = `l:${m.path}:${m.line}`;
      if (this.excluded.has(lid)) continue;
      f.lines.push({ kind: 'line', id: lid, match: m, parent: f });
    }
    const nonEmpty = order.filter((f) => f.lines.length);
    if (this.groupByDir) {
      const dirs = new Map<string, DirNode>();
      for (const f of nonEmpty) {
        let d = dirs.get(f.dir);
        if (!d) {
          d = { kind: 'dir', id: `d:${f.dir}`, dir: f.dir, files: [] };
          dirs.set(f.dir, d);
        }
        f.parent = d;
        d.files.push(f);
      }
      this.roots = Array.from(dirs.values());
    } else {
      nonEmpty.forEach((f) => (f.parent = undefined));
      this.roots = nonEmpty;
    }
    this.flatLines = nonEmpty.flatMap((f) => f.lines);
    const occurrences = this.flatLines.reduce((n, l) => n + l.match.count, 0);
    vscode.commands.executeCommand('setContext', 'storm.hasFindResults', this.flatLines.length > 0);
    if (this.options) {
      const more = this.stats?.truncated ? '+' : '';
      const time = this.stats ? ` · ${this.stats.durationMs} ms` : '';
      this.view.message = `Occurrences of '${this.options.query}' ${this.search.scopeLabel(this.options)}${this.options.maskEnabled && this.options.mask ? `, mask '${this.options.mask}'` : ''}`;
      this.view.description = `${occurrences}${more} match${occurrences === 1 ? '' : 'es'} in ${nonEmpty.length}${more} file${nonEmpty.length === 1 ? '' : 's'}${this.running ? ' (searching…)' : time}`;
    }
    this.changeEmitter.fire();
  }

  private revealFirst() {
    const first = this.roots[0];
    if (first) this.view.reveal(first, { expand: 2, select: false, focus: false }).then(undefined, () => undefined);
  }

  // ------------------------------------------------------------ navigation

  async step(delta: 1 | -1) {
    if (!this.flatLines.length) return;
    const sel = this.view.selection[0];
    if (sel && sel.kind === 'line') {
      const i = this.flatLines.findIndex((l) => l.id === sel.id);
      if (i >= 0) this.cursor = i;
    }
    this.cursor = (this.cursor + delta + this.flatLines.length) % this.flatLines.length;
    if (this.cursor < 0) this.cursor = 0;
    const node = this.flatLines[this.cursor];
    await this.view.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
    await this.openLine(node.match, true);
  }

  async openLine(m: LineMatch, preserveFocus = false) {
    this.search.recent.touch(m.path);
    await openLocation(m.path, { line: m.line, col: m.col, endLine: m.endLine, endCol: m.endCol }, { preview: true, preserveFocus });
  }

  // ------------------------------------------------------------ TreeDataProvider

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots;
    if (node.kind === 'dir') return node.files;
    if (node.kind === 'file') return node.lines;
    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'line') return node.parent;
    if (node.kind === 'file') return node.parent;
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'dir') {
      const count = node.files.reduce((n, f) => n + f.lines.reduce((k, l) => k + l.match.count, 0), 0);
      const item = new vscode.TreeItem(node.dir || '<root>', vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = `${count} match${count === 1 ? '' : 'es'}`;
      item.contextValue = 'stormDir';
      return item;
    }
    if (node.kind === 'file') {
      const count = node.lines.reduce((k, l) => k + l.match.count, 0);
      const item = new vscode.TreeItem(vscode.Uri.file(node.path), vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.label = node.name;
      item.description = `${this.groupByDir ? '' : node.dir + '  '}${count} match${count === 1 ? '' : 'es'}${node.lib ? '  (library)' : ''}`;
      item.tooltip = node.rel;
      item.contextValue = 'stormFile';
      return item;
    }
    const m = node.match;
    const prefix = `${m.line + 1}  `;
    const lead = m.textOffset > 0 && m.text.length >= 400 ? '…' : '';
    const label = prefix + lead + m.text;
    const highlights: [number, number][] = [];
    for (let i = 0; i + 1 < m.ranges.length; i += 2) {
      highlights.push([prefix.length + lead.length + m.ranges[i], prefix.length + lead.length + m.ranges[i + 1]]);
    }
    const item = new vscode.TreeItem({ label, highlights }, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = 'stormLine';
    item.tooltip = `${m.rel}:${m.line + 1}:${m.col + 1}`;
    item.command = { command: 'storm.openFindMatch', title: 'Open', arguments: [m] };
    return item;
  }

  dispose() {
    this.running?.cancel();
    this.view.dispose();
    this.changeEmitter.dispose();
  }
}
