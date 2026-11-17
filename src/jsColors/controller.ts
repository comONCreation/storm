// Applies the JetBrains-accurate JS/TS colours (see analyze.ts) as editor decorations, on top of
// the theme and of the TypeScript semantic tokens. Only while Storm Dark is the active theme:
// the colours are those of its palette. The analyzer (TypeScript compiler) is loaded on demand.

import * as vscode from 'vscode';
import * as path from 'path';
import type { JsColorRanges } from './analyze';
import { ModuleResolver } from './resolver';
import { activeThemeName } from '../ui/themeColors';

const LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
const THEME = 'Storm Dark';
const MAX_SIZE = 1 << 20;

type Analyzer = (text: string, fileName: string) => JsColorRanges;

export class JsColorController implements vscode.Disposable {
  private readonly param = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('storm.parameterForeground') });
  private readonly field = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('storm.fieldForeground') });
  private readonly client = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('storm.jsxClientComponentForeground') });
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly resolver = new ModuleResolver();
  private analyzer: Analyzer | null | undefined;
  private enabled = false;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.disposables.push(
      this.param,
      this.field,
      this.client,
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeActiveColorTheme(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('storm.jetbrainsHighlighting') || e.affectsConfiguration('workbench.colorTheme') ||
          e.affectsConfiguration('window.autoDetectColorScheme') || e.affectsConfiguration('workbench.preferredDarkColorTheme')) this.refreshAll();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      // a module gained or lost 'use client', or files were created / renamed: other files may change colour
      vscode.workspace.onDidSaveTextDocument(() => {
        this.resolver.forgetResolutions();
        this.refreshAll();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.analyses.delete(d.uri.toString());
        this.last.delete(d.uri.fsPath);
      }),
    );
    // tsconfig / jsconfig created, changed or deleted, also outside VS Code (git checkout, scaffolding)
    const configs = vscode.workspace.createFileSystemWatcher('**/{tsconfig,jsconfig}*.json');
    const onConfig = () => {
      this.resolver.clear();
      this.refreshAll();
    };
    this.disposables.push(configs, configs.onDidCreate(onConfig), configs.onDidChange(onConfig), configs.onDidDelete(onConfig));
    this.refreshAll();
  }

  /** Last analysis per document, reused while the document version does not change. */
  private readonly analyses = new Map<string, { version: number; ranges: JsColorRanges }>();

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('storm').get<boolean>('jetbrainsHighlighting', true) && activeThemeName() === THEME;
  }

  private refreshAll() {
    const was = this.enabled;
    this.enabled = this.isEnabled();
    for (const ed of vscode.window.visibleTextEditors) {
      if (this.enabled) this.update(ed);
      else if (was) this.clear(ed);
    }
  }

  private schedule(doc: vscode.TextDocument) {
    if (!this.enabled || !LANGUAGES.has(doc.languageId)) return;
    const key = doc.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) this.update(ed);
      }, 150),
    );
  }

  private clear(ed: vscode.TextEditor) {
    ed.setDecorations(this.param, []);
    ed.setDecorations(this.field, []);
    ed.setDecorations(this.client, []);
  }

  private loadAnalyzer(): Analyzer | null {
    if (this.analyzer === undefined) {
      try {
        // separate bundle (it contains the TypeScript compiler): loaded only when needed
        this.analyzer = (require(path.join(this.ctx.extensionPath, 'dist', 'jsColors.js')) as { analyze: Analyzer }).analyze;
      } catch (e) {
        this.log.appendLine(`JS colours unavailable: ${e}`);
        this.analyzer = null;
      }
    }
    return this.analyzer;
  }

  private update(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!LANGUAGES.has(doc.languageId)) return;
    const key = doc.uri.toString();
    let r = this.analyses.get(key)?.version === doc.version ? this.analyses.get(key)!.ranges : undefined;
    if (!r) {
      const text = doc.getText();
      const analyze = text.length <= MAX_SIZE ? this.loadAnalyzer() : null;
      if (!analyze) {
        this.clear(ed);
        return;
      }
      try {
        r = analyze(text, doc.fileName);
      } catch (e) {
        this.log.appendLine(`JS colours failed for ${doc.fileName}: ${e}`);
        return;
      }
      this.analyses.set(key, { version: doc.version, ranges: r });
    }
    const ranges = (flat: number[]) => {
      const out: vscode.Range[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) out.push(new vscode.Range(doc.positionAt(flat[i]), doc.positionAt(flat[i + 1])));
      return out;
    };
    // imports can only be resolved for files on disk
    const client: vscode.Range[] = [];
    if (doc.uri.scheme === 'file') {
      const known = new Map<string, boolean>();
      for (const t of r.jsxTags) {
        let c = known.get(t.module);
        if (c === undefined) {
          c = this.resolver.isClientModule(doc.fileName, t.module);
          known.set(t.module, c);
        }
        if (c) client.push(new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)));
      }
    }
    const params = ranges(r.params);
    const fields = ranges(r.fields);
    ed.setDecorations(this.param, params);
    ed.setDecorations(this.field, fields);
    ed.setDecorations(this.client, client);
    const text = (rs: vscode.Range[]) => rs.map((x) => `${doc.getText(x)}@${x.start.line + 1}`);
    this.last.set(doc.uri.fsPath, { params: text(params), fields: text(fields), client: text(client) });
  }

  /** Decorated texts of the last update per file ("name@line"), for the integration tests. */
  readonly last = new Map<string, { params: string[]; fields: string[]; client: string[] }>();

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
  }
}
