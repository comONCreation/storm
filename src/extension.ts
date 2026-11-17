import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { IndexClient } from './index/indexClient';
import { FileTracker } from './index/fileTracker';
import { RecentFiles } from './ui/recent';
import { ActionCatalog } from './ui/actions';
import { SearchService } from './ui/searchService';
import { Popup } from './ui/popup';
import { FindResults } from './ui/findResults';
import { currentTokenColors } from './ui/themeColors';
import { applyKeymap, findConflicts, promptKeymapConflicts, userKeybindingsPath } from './ui/keymap';
import type { WorkerSettings } from './index/worker';
import type { FindOptions, IndexStatus, LineMatch } from './shared/protocol';

let client: IndexClient | undefined;

function workerSettings(ctx: vscode.ExtensionContext): WorkerSettings {
  const cfg = vscode.workspace.getConfiguration('storm');
  // One index file per workspace (storageUri is already workspace specific).
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()).join('|');
  const hash = crypto.createHash('sha1').update(folders).digest('hex').slice(0, 12);
  const base = ctx.storageUri ?? ctx.globalStorageUri;
  return {
    maxFileSize: Math.max(16, cfg.get<number>('maxFileSizeKB', 2560)) * 1024,
    contentCacheBytes: Math.max(16, cfg.get<number>('contentCacheMB', 256)) * 1024 * 1024,
    persist: cfg.get<boolean>('persistIndex', true) && base.scheme === 'file',
    storageFile: base.scheme === 'file' ? path.join(base.fsPath, `index-${hash}.bin`) : undefined,
  };
}

export async function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Storm');
  ctx.subscriptions.push(log);

  client = new IndexClient(ctx.extensionPath, log);
  client.init(workerSettings(ctx));
  const recent = new RecentFiles(ctx.workspaceState);
  const tracker = new FileTracker(client, log);
  const actions = new ActionCatalog();
  const search = new SearchService(client, recent, tracker);

  let findResults: FindResults;
  const popup = new Popup(ctx, search, actions, (o) => findResults.run(o));
  findResults = new FindResults(ctx, search, (o: FindOptions) => popup.show({ mode: 'find', find: o, query: o.query }));

  ctx.subscriptions.push(client, recent, tracker, popup, findResults);
  client.onRestart(() => {
    log.appendLine('Index worker restarted, re-scanning the workspace');
    tracker.scan().catch((e) => log.appendLine(`scan failed: ${e}`));
  });

  // Status bar: PhpStorm shows indexing progress at the bottom ("dumb mode").
  // The spinner lives in its own item: VS Code re-renders an item (and restarts its ~spin
  // animation) whenever its text is assigned, so the item whose percentage keeps changing must
  // not hold the spinner. Properties are only assigned when they actually change.
  const spinner = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100.001);
  spinner.text = '$(sync~spin)';
  spinner.command = status.command = 'storm.searchEverywhere';
  ctx.subscriptions.push(spinner, status);
  status.show();
  let readyShown = false;
  let spinnerVisible = false;
  const set = (text: string, tooltip: string, spinning: boolean) => {
    if (status.text !== text) status.text = text;
    if (status.tooltip !== tooltip) status.tooltip = tooltip;
    if (spinner.tooltip !== tooltip) spinner.tooltip = tooltip;
    if (spinning !== spinnerVisible) {
      spinnerVisible = spinning;
      if (spinning) spinner.show();
      else spinner.hide();
    }
  };
  const renderStatus = (s: IndexStatus) => {
    if (s.state === 'ready') {
      set(
        '$(search) Storm',
        `Storm — ${s.totalFiles.toLocaleString()} files, ${s.symbols.toLocaleString()} symbols, ${s.trigrams.toLocaleString()} trigrams indexed.\nClick or press Shift Shift to Search Everywhere.`,
        false,
      );
      if (!readyShown) {
        readyShown = true;
        log.appendLine(`Index ready: ${s.totalFiles} files, ${s.symbols} symbols, ${s.trigrams} trigrams`);
      }
    } else if (s.state === 'indexing') {
      const pct = s.totalFiles ? Math.floor((s.indexedFiles / s.totalFiles) * 100) : 0;
      set(`Indexing… ${pct}%`, 'Storm is indexing the workspace. Search works meanwhile (unindexed files are scanned directly).', true);
    } else {
      set('Scanning files…', 'Storm is listing the workspace files.', true);
    }
  };
  renderStatus(client.status);
  client.onStatus(renderStatus);

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('storm.searchEverywhere', () => popup.show({ mode: 'everywhere', tab: 'all' }));
  reg('storm.gotoClass', () => popup.show({ mode: 'everywhere', tab: 'classes' }));
  reg('storm.gotoFile', () => popup.show({ mode: 'everywhere', tab: 'files' }));
  reg('storm.gotoSymbol', () => popup.show({ mode: 'everywhere', tab: 'symbols' }));
  reg('storm.findAction', () => popup.show({ mode: 'everywhere', tab: 'actions' }));
  reg('storm.searchText', () => popup.show({ mode: 'everywhere', tab: 'text' }));
  reg('storm.recentFiles', () => popup.show({ mode: 'everywhere', tab: 'files', query: '' }));
  reg('storm.findInFiles', () => popup.show({ mode: 'find' }));
  reg('storm.replaceInFiles', () => popup.show({ mode: 'find', replace: true }));
  reg('storm.findInDirectory', (uri?: vscode.Uri) => {
    let dir = uri?.fsPath;
    if (uri) {
      vscode.workspace.fs.stat(uri).then(
        (st) => {
          if (!(st.type & vscode.FileType.Directory)) dir = path.dirname(uri.fsPath);
          popup.show({ mode: 'find', directory: dir });
        },
        () => popup.show({ mode: 'find' }),
      );
    } else popup.show({ mode: 'find' });
  });
  reg('storm.applyKeymap', () => applyKeymap(ctx));
  reg('storm.rebuildIndex', async () => {
    client!.send({ type: 'rebuild' });
    await tracker.scan();
    vscode.window.setStatusBarMessage('$(sync) Storm: rebuilding index…', 4000);
  });
  reg('storm.nextOccurrence', () => findResults.step(1));
  reg('storm.previousOccurrence', () => findResults.step(-1));
  reg('storm.rerunFind', () => findResults.rerun());
  reg('storm.editFind', () => findResults.edit());
  reg('storm.groupByDirectory', () => findResults.setGroupByDirectory(true));
  reg('storm.ungroupByDirectory', () => findResults.setGroupByDirectory(false));
  reg('storm.clearFindResults', () => findResults.clear());
  reg('storm.excludeFromResults', (node) => node && findResults.exclude(node));
  reg('storm.openFindMatch', (m: LineMatch) => findResults.openLine(m, true));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('storm.maxFileSizeKB') || e.affectsConfiguration('storm.contentCacheMB') || e.affectsConfiguration('storm.persistIndex')) {
        client?.updateSettings(workerSettings(ctx));
        // The size limit decides which files are indexed at all: re-index with the new limit.
        if (e.affectsConfiguration('storm.maxFileSizeKB')) {
          client?.send({ type: 'rebuild' });
          tracker.scan().catch((err) => log.appendLine(`scan failed: ${err}`));
        }
      }
    }),
  );

  // List the files after startup work has settled.
  tracker.scan().catch((e) => log.appendLine(`scan failed: ${e}`));

  // Keymap extensions (e.g. "JetBrains Keybindings") shadow our shortcuts: offer to fix it.
  setTimeout(() => promptKeymapConflicts(ctx).catch((e) => log.appendLine(`keymap check failed: ${e}`)), 2000);

  // Exposed for integration tests.
  return { client, popup, findResults, search, tokenColors: currentTokenColors, keymap: { findConflicts: () => findConflicts(ctx), applyKeymap: () => applyKeymap(ctx), userKeybindingsPath: () => userKeybindingsPath(ctx) } };
}

export async function deactivate() {
  if (client) await client.flush();
}
