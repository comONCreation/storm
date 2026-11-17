import * as vscode from 'vscode';

const KEY = 'storm.recentFiles';
const MAX = 50;

/** Tracks recently opened files (used for ranking, "Recent Files" and empty-query popups). */
export class RecentFiles implements vscode.Disposable {
  private list: string[];
  private disposable: vscode.Disposable;

  constructor(private readonly state: vscode.Memento) {
    this.list = state.get<string[]>(KEY, []);
    this.disposable = vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document.uri.scheme === 'file') this.touch(ed.document.uri.fsPath);
    });
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file') this.touch(ed.document.uri.fsPath);
  }

  touch(p: string) {
    const i = this.list.indexOf(p);
    if (i === 0) return;
    if (i > 0) this.list.splice(i, 1);
    this.list.unshift(p);
    if (this.list.length > MAX) this.list.length = MAX;
    this.state.update(KEY, this.list);
  }

  get(): string[] {
    return this.list.slice();
  }

  dispose() {
    this.disposable.dispose();
  }
}
