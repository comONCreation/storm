import * as vscode from 'vscode';
import * as path from 'path';
import { SearchService, DEFAULT_FIND, openLocation } from './searchService';
import { ActionCatalog } from './actions';
import { currentTokenColors, onTokenColorsChange } from './themeColors';
import { compilePattern, fuzzyMatch } from '../shared/fuzzy';
import { CLASS_KINDS } from '../shared/protocol';
import type { TextSearchHandle } from '../index/indexClient';
import type {
  EverywhereGroup, EverywhereTab, FindOptions, LineMatch, SymbolHit, SymbolKind, ToHost, ToWebview,
} from '../shared/protocol';

const STATE_FIND = 'storm.lastFind';
const STATE_EVERYWHERE = 'storm.lastEverywhere';
const STATE_MASKS = 'storm.maskHistory';

export interface PopupOpenOptions {
  mode: 'everywhere' | 'find';
  tab?: EverywhereTab;
  query?: string;
  replace?: boolean;
  directory?: string;
  find?: Partial<FindOptions>;
}

/**
 * The PhpStorm-like popup, rendered in a webview panel opened in the active
 * editor group. It behaves like a popup: Escape, opening a result or focusing
 * another editor closes it (unless pinned).
 */
export class Popup implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private originColumn: vscode.ViewColumn = vscode.ViewColumn.One;
  private pinned = false;
  private mode: 'everywhere' | 'find' = 'everywhere';
  private ready = false;
  private pendingInit: ToWebview | undefined;
  private textSearch: TextSearchHandle | undefined;
  private everywhereText: TextSearchHandle | undefined;
  private lastFindOptions: FindOptions;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly search: SearchService,
    private readonly actions: ActionCatalog,
    private readonly openInFindWindow: (o: FindOptions) => void,
  ) {
    this.lastFindOptions = { ...DEFAULT_FIND, ...ctx.workspaceState.get<Partial<FindOptions>>(STATE_FIND, {}) };
    this.disposables.push(search.client.onStatus((status) => this.post({ type: 'status', status })));
    this.disposables.push(onTokenColorsChange(() => this.post({ type: 'tokenColors', colors: currentTokenColors() ?? null })));
  }

  get isOpen() {
    return !!this.panel;
  }

  show(opts: PopupOpenOptions) {
    this.search.rememberOrigin();
    const active = vscode.window.activeTextEditor;
    const selection = active && !active.selection.isEmpty && active.selection.isSingleLine ? active.document.getText(active.selection) : undefined;

    let init: ToWebview;
    const modules = (vscode.workspace.workspaceFolders ?? []).length > 1 ? vscode.workspace.workspaceFolders!.map((f) => f.uri.fsPath) : [];
    if (opts.mode === 'find') {
      const find: FindOptions = { ...this.lastFindOptions, ...opts.find };
      find.replaceMode = !!opts.replace;
      if (selection) find.query = selection;
      if (opts.query !== undefined) find.query = opts.query;
      if (opts.directory) {
        find.scope = 'directory';
        find.directory = opts.directory;
      }
      if (find.scope === 'module' && !modules.includes(find.module)) find.module = modules[0] ?? '';
      init = { type: 'init', mode: 'find', find, modules, platform: process.platform, pinned: this.pinned, status: this.search.client.status, maskHistory: this.maskHistory(), tokenColors: currentTokenColors() ?? null };
    } else {
      const last = this.ctx.workspaceState.get<{ tab: EverywhereTab; query: string; includeNonProject: boolean }>(STATE_EVERYWHERE);
      init = {
        type: 'init',
        mode: 'everywhere',
        tab: opts.tab ?? 'all',
        query: opts.query ?? selection ?? (opts.tab === undefined || opts.tab === last?.tab ? last?.query ?? '' : ''),
        includeNonProject: last?.includeNonProject ?? false,
        modules,
        platform: process.platform,
        pinned: this.pinned,
        status: this.search.client.status,
        tokenColors: currentTokenColors() ?? null,
      };
    }

    this.mode = opts.mode;
    if (this.panel) {
      this.panel.title = this.titleFor(init);
      this.panel.reveal(undefined, false);
      this.post(init);
      return;
    }

    this.originColumn = active?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn ?? vscode.ViewColumn.One;
    this.ready = false;
    this.pendingInit = init;
    const panel = vscode.window.createWebviewPanel('storm.popup', this.titleFor(init), { viewColumn: this.originColumn, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'find.svg');
    panel.webview.html = this.html(panel.webview);
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      if (this.mode === 'find') this.recordMask();
      this.cancelSearches();
    });
    panel.onDidChangeViewState((e) => {
      const close = vscode.workspace.getConfiguration('storm').get<boolean>('closeOnFocusLoss', true);
      if (!e.webviewPanel.active && !this.pinned && close) {
        // Let a click in the explorer or a modal dialog settle before deciding.
        setTimeout(() => {
          if (this.panel === panel && !panel.active && !this.pinned) panel.dispose();
        }, 150);
      }
    });
    panel.webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m).catch((e) => console.error(e)));
  }

  private titleFor(init: ToWebview) {
    if (init.type !== 'init') return 'Search';
    if (init.mode === 'find') return init.find?.replaceMode ? 'Replace in Files' : 'Find in Files';
    return 'Search Everywhere';
  }

  close() {
    this.panel?.dispose();
  }

  private post(m: ToWebview) {
    if (!this.panel) return;
    if (!this.ready && m.type !== 'init') return;
    this.panel.webview.postMessage(m);
  }

  private cancelSearches() {
    this.textSearch?.cancel();
    this.textSearch = undefined;
    this.everywhereText?.cancel();
    this.everywhereText = undefined;
  }

  private cfg() {
    return vscode.workspace.getConfiguration('storm');
  }

  private async onMessage(m: ToHost) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.pendingInit) this.panel?.webview.postMessage(this.pendingInit);
        this.pendingInit = undefined;
        break;
      case 'everywhere':
        await this.everywhere(m.seq, m.tab, m.query, m.includeNonProject);
        break;
      case 'find':
        this.find(m.seq, m.options);
        break;
      case 'preview':
        await this.preview(m.path);
        break;
      case 'openFile':
        if (this.mode === 'find') this.recordMask();
        await this.openFile(m.path, m, m.split);
        break;
      case 'runAction':
        this.close();
        await vscode.commands.executeCommand(m.id);
        break;
      case 'openInFindWindow':
        this.lastFindOptions = m.options;
        this.recordMask();
        this.saveFind(m.options);
        this.close();
        this.openInFindWindow(m.options);
        break;
      case 'replaceAll': {
        this.lastFindOptions = m.options;
        this.recordMask();
        this.saveFind(m.options);
        const n = await this.search.replace(m.options);
        if (n && this.panel && !this.pinned) this.close();
        break;
      }
      case 'replaceOne':
        await this.search.replace(m.options, m.match);
        break;
      case 'pickDirectory': {
        const def = m.current ? vscode.Uri.file(this.search.resolveDirectory(m.current)) : vscode.workspace.workspaceFolders?.[0]?.uri;
        const res = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: def, openLabel: 'Select Directory' });
        this.panel?.reveal(undefined, false);
        if (res?.[0]) this.post({ type: 'directoryPicked', directory: res[0].fsPath });
        break;
      }
      case 'pin':
        this.pinned = m.pinned;
        break;
      case 'state':
        if (m.find) this.saveFind(m.find);
        if (m.everywhere) this.ctx.workspaceState.update(STATE_EVERYWHERE, m.everywhere);
        break;
      case 'close':
        this.close();
        break;
    }
  }

  private maskHistory(): string[] {
    return this.ctx.workspaceState.get<string[]>(STATE_MASKS, []);
  }

  /** Remembers the mask of a search that was actually used (most recent first, 10 max). */
  private recordMask() {
    const o = this.lastFindOptions;
    if (!o.maskEnabled || !o.mask.trim()) return;
    const norm = (m: string) => m.replace(/\s*([,;])\s*/g, ', ').trim();
    const mask = norm(o.mask);
    const list = [mask, ...this.maskHistory().filter((m) => norm(m) !== mask)].slice(0, 10);
    this.ctx.workspaceState.update(STATE_MASKS, list);
  }

  private saveFind(o: FindOptions) {
    this.lastFindOptions = { ...o };
    this.ctx.workspaceState.update(STATE_FIND, { ...o, replaceMode: false });
  }

  // ---------------------------------------------------------------- Find in Files

  private find(seq: number, o: FindOptions) {
    this.textSearch?.cancel();
    this.lastFindOptions = o;
    if (!o.query) {
      this.post({ type: 'findResults', seq, items: [], reset: true, done: true, stats: { matches: 0, lines: 0, files: 0, truncated: false, searchedFiles: 0, durationMs: 0 } });
      return;
    }
    let first = true;
    const limit = this.cfg().get<number>('popupResultLimit', 1000);
    this.textSearch = this.search.runText(o, limit, (items, done, stats, error) => {
      this.post({ type: 'findResults', seq, items, reset: first, done, stats, error });
      first = false;
    });
  }

  // ---------------------------------------------------------------- Search Everywhere

  private async everywhere(seq: number, tab: EverywhereTab, query: string, includeLib: boolean) {
    const recent = this.search.recent.get();
    const client = this.search.client;
    const send = (groups: EverywhereGroup[], done = true) => this.post({ type: 'everywhereResults', seq, tab, groups, done });
    this.everywhereText?.cancel();

    if (!query.trim()) {
      if (tab === 'all' || tab === 'files') {
        const items = await client.recentFiles(recent, 30, this.search.originPath);
        send([{ kind: 'recent', items, more: false }]);
      } else send([]);
      return;
    }

    switch (tab) {
      case 'all': {
        const [classes, files, symbols] = await Promise.all([
          client.searchSymbols(query, true, includeLib, 9),
          client.searchFiles(query, includeLib, 9, recent),
          client.searchSymbols(query, false, includeLib, 9 + 9),
        ]);
        const classKeys = new Set(classes.map((c) => `${c.path}:${c.line}`));
        const otherSymbols = symbols.filter((s) => !CLASS_KINDS.has(s.kind) && !classKeys.has(`${s.path}:${s.line}`)).slice(0, 9);
        const acts = this.actions.search(query, 6);
        const groups: EverywhereGroup[] = [];
        if (classes.length) groups.push({ kind: 'classes', items: classes.slice(0, 8), more: classes.length > 8 });
        if (files.length) groups.push({ kind: 'files', items: files.slice(0, 8), more: files.length > 8 });
        if (otherSymbols.length) groups.push({ kind: 'symbols', items: otherSymbols.slice(0, 8), more: otherSymbols.length > 8 });
        if (acts.length) groups.push({ kind: 'actions', items: acts.slice(0, 5), more: acts.length > 5 });
        send(groups);
        return;
      }
      case 'classes':
      case 'symbols': {
        const classesOnly = tab === 'classes';
        const hits = await client.searchSymbols(query, classesOnly, includeLib, 150);
        const useLsp = this.cfg().get<boolean>('useLanguageServerSymbols', false);
        send([{ kind: tab, items: hits, more: false }], !useLsp);
        if (useLsp) {
          const extra = await this.lspSymbols(query, classesOnly, hits);
          send([{ kind: tab, items: [...hits, ...extra].sort((a, b) => b.score - a.score).slice(0, 150), more: false }]);
        }
        return;
      }
      case 'files': {
        const hits = await client.searchFiles(query, includeLib, 150, recent);
        send([{ kind: 'files', items: hits, more: false }]);
        return;
      }
      case 'actions':
        send([{ kind: 'actions', items: this.actions.search(query, 150), more: false }]);
        return;
      case 'text': {
        const items: LineMatch[] = [];
        const opts: FindOptions = { ...DEFAULT_FIND, query, scope: includeLib ? 'scope' : 'project', namedScope: 'all' };
        this.everywhereText = this.search.runText(opts, 200, (batch, done) => {
          items.push(...batch);
          send([{ kind: 'text', items: items.slice(), more: false }], done);
        });
        return;
      }
    }
  }

  private async lspSymbols(query: string, classesOnly: boolean, existing: SymbolHit[]): Promise<SymbolHit[]> {
    try {
      const res = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
      const seen = new Set(existing.map((h) => `${h.path.toLowerCase()}:${h.line}`));
      const cp = compilePattern(query);
      const out: SymbolHit[] = [];
      for (const s of res ?? []) {
        if (s.location.uri.scheme !== 'file') continue;
        const kind = mapKind(s.kind);
        if (classesOnly && !CLASS_KINDS.has(kind)) continue;
        const key = `${s.location.uri.fsPath.toLowerCase()}:${s.location.range.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = fuzzyMatch(cp, s.name);
        if (!r) continue;
        out.push({
          name: s.name,
          kind,
          container: s.containerName,
          path: s.location.uri.fsPath,
          rel: vscode.workspace.asRelativePath(s.location.uri),
          lib: false,
          line: s.location.range.start.line,
          col: s.location.range.start.character,
          score: r.score - 1,
          hl: r.ranges,
        });
        if (out.length > 200) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- Preview & navigation

  private async preview(p: string) {
    const uri = vscode.Uri.file(p);
    const rel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
      let content: string;
      let languageId = '';
      if (open) {
        content = open.getText();
        languageId = open.languageId;
      } else {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.size > 5 * 1024 * 1024) throw new Error('File too large to preview');
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(bytes).toString('utf8');
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      }
      this.post({ type: 'preview', path: p, rel, content, languageId: languageId || path.extname(p).slice(1).toLowerCase() });
    } catch (e) {
      this.post({ type: 'preview', path: p, rel, content: '', languageId: '', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async openFile(p: string, pos: { line?: number; col?: number; endLine?: number; endCol?: number }, split?: boolean) {
    this.search.recent.touch(p);
    if (this.pinned) {
      await openLocation(p, pos, { column: split ? vscode.ViewColumn.Beside : this.otherColumn(), preserveFocus: true });
      return;
    }
    const column = this.panel?.viewColumn ?? this.originColumn;
    this.close();
    await openLocation(p, pos, { column: split ? vscode.ViewColumn.Beside : column });
  }

  /** When pinned, results are opened next to the popup so that it stays visible. */
  private otherColumn(): vscode.ViewColumn {
    const mine = this.panel?.viewColumn;
    const other = vscode.window.tabGroups.all.find((g) => g.viewColumn !== mine);
    return other?.viewColumn ?? vscode.ViewColumn.Beside;
  }

  // ---------------------------------------------------------------- HTML

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Storm</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose() {
    this.cancelSearches();
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function mapKind(k: vscode.SymbolKind): SymbolKind {
  switch (k) {
    case vscode.SymbolKind.Class:
      return 'class';
    case vscode.SymbolKind.Interface:
      return 'interface';
    case vscode.SymbolKind.Enum:
      return 'enum';
    case vscode.SymbolKind.Struct:
      return 'struct';
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
    case vscode.SymbolKind.Package:
      return 'namespace';
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return 'method';
    case vscode.SymbolKind.Function:
      return 'function';
    case vscode.SymbolKind.Constant:
    case vscode.SymbolKind.EnumMember:
      return 'constant';
    case vscode.SymbolKind.Property:
      return 'property';
    default:
      return 'field';
  }
}
