import * as vscode from 'vscode';
import * as path from 'path';
import { IndexClient, TextSearchHandle } from '../index/indexClient';
import { RecentFiles } from './recent';
import { normKey, type FileTracker } from '../index/fileTracker';
import type { FindOptions, LineMatch, ResolvedScope, TextSearchStats } from '../shared/protocol';

export const DEFAULT_FIND: FindOptions = {
  query: '',
  matchCase: false,
  words: false,
  regex: false,
  replace: '',
  replaceMode: false,
  maskEnabled: false,
  mask: '*.php',
  scope: 'project',
  directory: '',
  module: '',
  namedScope: 'all',
};

export class SearchService {
  /** File that was active when the popup was opened ("Current File" scope). */
  originPath: string | undefined;

  constructor(readonly client: IndexClient, readonly recent: RecentFiles, private readonly tracker?: FileTracker) {}

  rememberOrigin() {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file') this.originPath = ed.document.uri.fsPath;
  }

  resolveDirectory(dir: string): string {
    if (!dir) return dir;
    if (path.isAbsolute(dir)) return dir;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, dir) : dir;
  }

  /**
   * Scope sent to the worker. Files ignored by git are not indexed: they are added explicitly
   * for the "All Places, Including Ignored Files" scope and for a directory chosen explicitly.
   */
  async resolveScope(o: FindOptions): Promise<ResolvedScope> {
    const scope = this.baseScope(o);
    if (!this.tracker) return scope;
    if (o.scope === 'scope' && o.namedScope === 'ignored') {
      scope.extraFiles = await this.tracker.ignoredFiles();
    } else if (o.scope === 'directory' && scope.dirPrefix) {
      const dir = normKey(scope.dirPrefix) + '/';
      scope.extraFiles = (await this.tracker.ignoredFiles()).filter((f) => normKey(f[0]).startsWith(dir));
    }
    return scope;
  }

  private baseScope(o: FindOptions): ResolvedScope {
    const mask = o.maskEnabled && o.mask.trim() ? o.mask : undefined;
    switch (o.scope) {
      case 'project':
        return { includeLibraries: false, mask };
      case 'module':
        return { includeLibraries: true, dirPrefix: o.module || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, mask };
      case 'directory':
        return o.directory ? { includeLibraries: true, dirPrefix: this.resolveDirectory(o.directory), mask } : { includeLibraries: false, mask };
      case 'scope':
        switch (o.namedScope) {
          case 'all':
          case 'ignored':
            return { includeLibraries: true, mask };
          case 'project':
            return { includeLibraries: false, mask };
          case 'open':
            return { includeLibraries: true, paths: openFilePaths(), mask };
          case 'current':
            return { includeLibraries: true, paths: this.originPath ? [this.originPath] : [], mask };
          case 'recent':
            return { includeLibraries: true, paths: this.recent.get(), mask };
        }
    }
    return { includeLibraries: false, mask };
  }

  scopeLabel(o: FindOptions): string {
    switch (o.scope) {
      case 'project':
        return 'in Project';
      case 'module':
        return `in Module '${vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === o.module)?.name ?? path.basename(o.module)}'`;
      case 'directory':
        return o.directory ? `in Directory '${o.directory}'` : 'in Project';
      case 'scope':
        return (
          {
            all: 'in All Places',
            ignored: 'in All Places, Including Ignored Files',
            project: 'in Project Files',
            open: 'in Open Files',
            current: 'in Current File',
            recent: 'in Recently Viewed Files',
          } as const
        )[o.namedScope];
    }
    return '';
  }

  runText(o: FindOptions, limit: number, onBatch: (items: LineMatch[], done: boolean, stats?: TextSearchStats, error?: string) => void): TextSearchHandle {
    let inner: TextSearchHandle | undefined;
    let cancelled = false;
    // Resolving the scope may list the ignored files (asynchronous): the handle can be cancelled meanwhile.
    const done = this.resolveScope(o).then(
      (scope) => {
        if (cancelled) return;
        inner = this.client.searchText({ query: o.query, matchCase: o.matchCase, words: o.words, regex: o.regex }, scope, limit, onBatch);
        return inner.done;
      },
      // e.g. listing the ignored files failed: end the search instead of spinning forever
      (err) => {
        if (!cancelled) onBatch([], true, undefined, err instanceof Error ? err.message : String(err));
      },
    );
    return {
      done,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
      },
    };
  }

  /** Replace every occurrence (or the occurrences of a single line). Returns the number of replacements. */
  async replace(o: FindOptions, only?: LineMatch): Promise<number> {
    const files = await this.client.computeReplace(
      { query: o.query, matchCase: o.matchCase, words: o.words, regex: o.regex },
      await this.resolveScope(o),
      o.replace,
      only?.path,
      only?.line,
    );
    const total = files.reduce((n, f) => n + f.edits.length, 0);
    if (!total) {
      vscode.window.showInformationMessage('Nothing to replace.');
      return 0;
    }
    if (!only) {
      const answer = await vscode.window.showWarningMessage(
        `Replace ${total} occurrence${total > 1 ? 's' : ''} in ${files.length} file${files.length > 1 ? 's' : ''} with '${o.replace}'?`,
        { modal: true, detail: 'The change can be undone (Ctrl+Z in each file).' },
        'Replace',
      );
      if (answer !== 'Replace') return 0;
    }
    const dirtyBefore = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
    const edit = new vscode.WorkspaceEdit();
    const uris: vscode.Uri[] = [];
    for (const f of files) {
      const uri = vscode.Uri.file(f.path);
      uris.push(uri);
      for (const e of f.edits) edit.replace(uri, new vscode.Range(e.line, e.col, e.endLine, e.endCol), e.text);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      vscode.window.showErrorMessage('Replace failed: the files may have been modified meanwhile. Please search again.');
      return 0;
    }
    // Like PhpStorm, documents that were not modified before are saved right away.
    await Promise.all(
      uris
        .filter((u) => !dirtyBefore.has(u.toString()))
        .map(async (u) => {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === u.toString());
          if (doc?.isDirty) await doc.save();
        }),
    );
    if (!only) vscode.window.setStatusBarMessage(`$(replace-all) ${total} occurrence(s) replaced in ${files.length} file(s)`, 5000);
    return total;
  }
}

export function openFilePaths(): string[] {
  const out: string[] = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input;
      if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') out.push(input.uri.fsPath);
      else if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file') out.push(input.modified.fsPath);
    }
  }
  return out;
}

export async function openLocation(
  p: string,
  pos: { line?: number; col?: number; endLine?: number; endCol?: number },
  opts: { column?: vscode.ViewColumn; preview?: boolean; preserveFocus?: boolean } = {},
) {
  const uri = vscode.Uri.file(p);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    let selection: vscode.Range | undefined;
    if (pos.line !== undefined) {
      const start = new vscode.Position(pos.line, pos.col ?? 0);
      const end = pos.endLine !== undefined ? new vscode.Position(pos.endLine, pos.endCol ?? 0) : start;
      selection = doc.validateRange(new vscode.Range(start, end));
    }
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: opts.column,
      preview: opts.preview ?? false,
      preserveFocus: opts.preserveFocus,
      selection,
    });
    if (selection) editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // binary file (image, pdf, ...): let VS Code pick the right editor
    await vscode.commands.executeCommand('vscode.open', uri, opts.column);
  }
}
