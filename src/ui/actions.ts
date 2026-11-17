import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { compilePattern, fuzzyMatch } from '../shared/fuzzy';
import type { ActionHit } from '../shared/protocol';

interface ActionEntry {
  id: string;
  title: string;
  category: string;
  lower: string;
}

// Core workbench commands have no contributed title: a curated list of the most useful ones.
const CORE: Array<[string, string, string]> = [
  ['workbench.action.showCommands', 'Show All Commands', 'View'],
  ['workbench.action.openSettings', 'Settings', 'Preferences'],
  ['workbench.action.openSettingsJson', 'Open User Settings (JSON)', 'Preferences'],
  ['workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts (Keymap)', 'Preferences'],
  ['workbench.action.selectTheme', 'Color Theme', 'Preferences'],
  ['workbench.action.selectIconTheme', 'File Icon Theme', 'Preferences'],
  ['workbench.action.toggleSidebarVisibility', 'Toggle Primary Side Bar', 'View'],
  ['workbench.action.togglePanel', 'Toggle Panel', 'View'],
  ['workbench.action.toggleZenMode', 'Toggle Zen Mode (Distraction Free)', 'View'],
  ['workbench.action.toggleFullScreen', 'Toggle Full Screen', 'View'],
  ['workbench.action.splitEditor', 'Split Editor Right', 'Window'],
  ['workbench.action.splitEditorDown', 'Split Editor Down', 'Window'],
  ['workbench.action.closeActiveEditor', 'Close Editor', 'Window'],
  ['workbench.action.closeAllEditors', 'Close All Editors', 'Window'],
  ['workbench.action.closeOtherEditors', 'Close Other Editors', 'Window'],
  ['workbench.action.reopenClosedEditor', 'Reopen Closed Editor', 'Window'],
  ['workbench.action.files.save', 'Save', 'File'],
  ['workbench.action.files.saveAll', 'Save All', 'File'],
  ['workbench.action.files.newUntitledFile', 'New File', 'File'],
  ['workbench.action.files.openFile', 'Open File…', 'File'],
  ['workbench.action.files.openFolder', 'Open Folder…', 'File'],
  ['workbench.action.openRecent', 'Open Recent Project', 'File'],
  ['workbench.action.newWindow', 'New Window', 'File'],
  ['workbench.action.reloadWindow', 'Reload Window', 'Developer'],
  ['workbench.action.gotoLine', 'Go to Line:Column…', 'Navigate'],
  ['workbench.action.gotoSymbol', 'File Structure (Go to Symbol in Editor)', 'Navigate'],
  ['workbench.action.navigateBack', 'Back', 'Navigate'],
  ['workbench.action.navigateForward', 'Forward', 'Navigate'],
  ['workbench.action.navigateToLastEditLocation', 'Last Edit Location', 'Navigate'],
  ['editor.action.revealDefinition', 'Go to Declaration', 'Navigate'],
  ['editor.action.goToImplementation', 'Go to Implementation', 'Navigate'],
  ['editor.action.goToReferences', 'Find Usages', 'Navigate'],
  ['editor.action.goToTypeDefinition', 'Go to Type Declaration', 'Navigate'],
  ['editor.action.rename', 'Rename…', 'Refactor'],
  ['editor.action.refactor', 'Refactor This…', 'Refactor'],
  ['editor.action.quickFix', 'Show Context Actions', 'Code'],
  ['editor.action.formatDocument', 'Reformat Code', 'Code'],
  ['editor.action.organizeImports', 'Optimize Imports', 'Code'],
  ['editor.action.commentLine', 'Comment with Line Comment', 'Code'],
  ['editor.action.blockComment', 'Comment with Block Comment', 'Code'],
  ['editor.action.copyLinesDownAction', 'Duplicate Line', 'Edit'],
  ['editor.action.deleteLines', 'Delete Line', 'Edit'],
  ['editor.action.moveLinesUpAction', 'Move Line Up', 'Edit'],
  ['editor.action.moveLinesDownAction', 'Move Line Down', 'Edit'],
  ['editor.action.transformToUppercase', 'To Uppercase', 'Edit'],
  ['editor.action.transformToLowercase', 'To Lowercase', 'Edit'],
  ['editor.action.selectHighlights', 'Select All Occurrences', 'Edit'],
  ['editor.action.addSelectionToNextFindMatch', 'Add Selection for Next Occurrence', 'Edit'],
  ['editor.action.startFindReplaceAction', 'Replace…', 'Edit'],
  ['actions.find', 'Find…', 'Edit'],
  ['editor.foldAll', 'Collapse All', 'Folding'],
  ['editor.unfoldAll', 'Expand All', 'Folding'],
  ['workbench.action.terminal.new', 'New Terminal', 'Terminal'],
  ['workbench.action.terminal.toggleTerminal', 'Terminal', 'Terminal'],
  ['workbench.view.explorer', 'Project (Explorer)', 'View'],
  ['workbench.view.scm', 'Commit / Source Control', 'View'],
  ['workbench.view.debug', 'Debug', 'View'],
  ['workbench.view.extensions', 'Plugins (Extensions)', 'View'],
  ['workbench.action.problems.focus', 'Problems', 'View'],
  ['workbench.action.output.toggleOutput', 'Output', 'View'],
  ['workbench.action.debug.start', 'Debug', 'Run'],
  ['workbench.action.debug.run', 'Run', 'Run'],
  ['workbench.action.tasks.runTask', 'Run Task…', 'Run'],
  ['editor.debug.action.toggleBreakpoint', 'Toggle Line Breakpoint', 'Run'],
  ['git.commit', 'Commit', 'Git'],
  ['git.pull', 'Pull', 'Git'],
  ['git.push', 'Push', 'Git'],
  ['git.checkout', 'Branches… (Checkout)', 'Git'],
  ['workbench.action.zoomIn', 'Zoom In', 'View'],
  ['workbench.action.zoomOut', 'Zoom Out', 'View'],
  ['workbench.action.zoomReset', 'Reset Zoom', 'View'],
  ['editor.action.toggleWordWrap', 'Soft-Wrap', 'View'],
  ['editor.action.toggleMinimap', 'Toggle Minimap', 'View'],
  ['workbench.action.toggleMaximizedPanel', 'Maximize Panel', 'View'],
];

/** Equivalent of PhpStorm's "Find Action": every contributed command with a title. */
export class ActionCatalog {
  private entries: ActionEntry[] | null = null;

  constructor() {
    vscode.extensions.onDidChange(() => (this.entries = null));
  }

  private build(): ActionEntry[] {
    const seen = new Set<string>();
    const out: ActionEntry[] = [];
    const add = (id: string, title: string, category: string) => {
      if (!id || !title || seen.has(id)) return;
      seen.add(id);
      out.push({ id, title, category, lower: title.toLowerCase() });
    };
    for (const [id, title, cat] of CORE) add(id, title, cat);
    for (const ext of vscode.extensions.all) {
      const pkg = ext.packageJSON as {
        contributes?: { commands?: unknown; menus?: { commandPalette?: Array<{ command: string; when?: string }> } };
        displayName?: string;
      };
      const cmds = pkg.contributes?.commands;
      if (!cmds) continue;
      const list = (Array.isArray(cmds) ? cmds : [cmds]) as Array<{ command: string; title: unknown; category?: unknown }>;
      const hidden = new Set((pkg.contributes?.menus?.commandPalette ?? []).filter((m) => m.when === 'false').map((m) => m.command));
      let nls: Record<string, unknown> | null | undefined;
      const resolve = (v: unknown): string => {
        let s = typeof v === 'string' ? v : v && typeof v === 'object' && 'value' in v ? String((v as { value: string }).value) : '';
        const m = /^%(.+)%$/.exec(s);
        if (m) {
          if (nls === undefined) {
            try {
              nls = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.nls.json'), 'utf8'));
            } catch {
              nls = null;
            }
          }
          const val = nls?.[m[1]];
          s = typeof val === 'string' ? val : val && typeof val === 'object' && 'message' in val ? String((val as { message: string }).message) : '';
        }
        return s;
      };
      for (const c of list) {
        if (!c || hidden.has(c.command)) continue;
        const title = resolve(c.title);
        const category = resolve(c.category) || (ext.packageJSON.isBuiltin ? '' : pkg.displayName ?? '');
        add(c.command, title, category);
      }
    }
    return out;
  }

  search(pattern: string, limit: number): ActionHit[] {
    if (!this.entries) this.entries = this.build();
    if (!pattern.trim()) return [];
    const cp = compilePattern(pattern);
    const hits: ActionHit[] = [];
    for (const e of this.entries) {
      let r = fuzzyMatch(cp, e.title, e.lower);
      let score = r?.score ?? 0;
      if (!r && e.category) {
        // "git push" → category + title
        const full = `${e.category} ${e.title}`;
        const r2 = fuzzyMatch(cp, full);
        if (r2) {
          const off = e.category.length + 1;
          r = { score: r2.score - 5, ranges: r2.ranges.map((x) => x - off) };
          score = r.score;
        }
      }
      if (!r) continue;
      hits.push({ id: e.id, title: e.title, category: e.category, score, hl: sanitize(r.ranges, e.title.length) });
    }
    hits.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
    return hits.slice(0, limit);
  }
}

function sanitize(ranges: number[], len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const s = Math.max(0, ranges[i]);
    const e = Math.min(len, ranges[i + 1]);
    if (e > s) out.push(s, e);
  }
  return out;
}
