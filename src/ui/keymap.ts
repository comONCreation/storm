// Keymap conflict handling.
//
// When two extensions bind the same key, VS Code applies the one registered
// last, and an extension cannot change that order. Only user keybindings
// (keybindings.json) always win. Keymap extensions such as "JetBrains
// Keybindings" bind Ctrl+Shift+F, Ctrl+N… to the native commands, so with them
// installed our shortcuts are silently shadowed. This module detects such
// conflicts and, with the user's consent, writes our bindings into the user
// keybindings.json.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse, modify, applyEdits } from 'jsonc-parser';

const DISMISSED = 'storm.keymapConflictsDismissed';

interface Binding {
  key?: string;
  mac?: string;
  linux?: string;
  win?: string;
  command: string;
  when?: string;
}

export interface Conflict {
  key: string; // normalised key for the current platform
  ours: Binding;
  theirs: Array<{ source: string; command: string }>;
}

function platformKey(b: Binding): string | undefined {
  const k = process.platform === 'darwin' ? b.mac ?? b.key : process.platform === 'win32' ? b.win ?? b.key : b.linux ?? b.key;
  return k ? normalise(k) : undefined;
}

/** "Shift+Ctrl+F" → "ctrl+shift+f" (chords are normalised part by part). */
function normalise(key: string): string {
  const order = ['ctrl', 'shift', 'alt', 'cmd', 'meta', 'win'];
  return key
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((part) => {
      const tokens = part.split('+');
      const main = tokens.pop()!;
      tokens.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return [...tokens, main].join('+');
    })
    .join(' ');
}

function platformMatches(when: string): boolean {
  const current = process.platform === 'darwin' ? 'isMac' : process.platform === 'win32' ? 'isWindows' : 'isLinux';
  for (const p of ['isMac', 'isWindows', 'isLinux']) {
    // a positive "isX" requirement for another platform excludes the rule
    if (p !== current && new RegExp(`(^|[^!\\w])${p}\\b`).test(when) && !when.includes('||')) return false;
  }
  return true;
}

function bindingsOf(ext: vscode.Extension<unknown>): Binding[] {
  const kb = (ext.packageJSON as { contributes?: { keybindings?: Binding | Binding[] } }).contributes?.keybindings;
  if (!kb) return [];
  return Array.isArray(kb) ? kb : [kb];
}

export function userKeybindingsPath(ctx: vscode.ExtensionContext): string {
  // globalStorage lives in <User>/globalStorage/<extension id>
  return path.join(path.dirname(path.dirname(ctx.globalStorageUri.fsPath)), 'keybindings.json');
}

function readUserBindings(file: string): Binding[] {
  try {
    const parsed = parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Binding[]) : [];
  } catch {
    return [];
  }
}

export function findConflicts(ctx: vscode.ExtensionContext): Conflict[] {
  const self = ctx.extension;
  const ours = bindingsOf(self).filter((b) => b.command.startsWith('storm.'));
  const userBindings = readUserBindings(userKeybindingsPath(ctx));
  const conflicts: Conflict[] = [];
  for (const b of ours) {
    const key = platformKey(b);
    if (!key || !key.includes('+')) continue; // "shift shift" is never contributed by keymaps
    // A user rule for our own command already wins: nothing to do.
    const userLast = [...userBindings].reverse().find((u) => u.key && normalise(u.key) === key && !u.command.startsWith('-'));
    if (userLast?.command === b.command) continue;
    const theirs: Conflict['theirs'] = [];
    for (const ext of vscode.extensions.all) {
      if (ext.id === self.id) continue;
      for (const o of bindingsOf(ext)) {
        if (!o.command || o.command.startsWith('-') || platformKey(o) !== key) continue;
        // Bindings restricted to a very specific context (e.g. inside Quick Open) do not shadow ours in practice.
        if (o.when && /\b(inQuickOpen|suggestWidgetVisible|inSnippetMode|findWidgetVisible|notebookEditorFocused|terminalFocus|activeCustomEditorId)\b/.test(o.when) && !/!\s*(inQuickOpen|terminalFocus)/.test(o.when)) continue;
        // Rules restricted to another platform ("... && isMac" on Windows) never apply here.
        if (o.when && !platformMatches(o.when)) continue;
        theirs.push({ source: (ext.packageJSON as { displayName?: string }).displayName ?? ext.id, command: o.command });
      }
    }
    if (userLast && userLast.command !== b.command) theirs.push({ source: 'keybindings.json', command: userLast.command });
    if (theirs.length) conflicts.push({ key, ours: b, theirs });
  }
  return conflicts;
}

function prettyKey(k: string) {
  return k
    .split(' ')
    .map((p) => p.split('+').map((t) => (t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1))).join('+'))
    .join(' ');
}

/** Adds our conflicting bindings to the user keybindings.json (user rules always win). */
export async function applyKeymap(ctx: vscode.ExtensionContext, conflicts = findConflicts(ctx)): Promise<number> {
  if (!conflicts.length) {
    vscode.window.showInformationMessage('Storm: no shortcut conflict detected, all Storm shortcuts are active.');
    return 0;
  }
  const file = userKeybindingsPath(ctx);
  let text = '[\n]';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  if (!Array.isArray(parse(text))) {
    vscode.window.showErrorMessage(`Storm: ${file} could not be parsed, please fix it first.`);
    return 0;
  }
  const opts = { formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' } };
  for (const c of conflicts) {
    const entry: Binding = { key: c.key, command: c.ours.command };
    if (c.ours.when) entry.when = c.ours.when;
    text = applyEdits(text, modify(text, [-1], entry, { ...opts, isArrayInsertion: true }));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  const open = await vscode.window.showInformationMessage(
    `Storm: ${conflicts.length} shortcut(s) added to your keybindings.json (${conflicts.map((c) => prettyKey(c.key)).join(', ')}).`,
    'Open keybindings.json',
  );
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(file));
  return conflicts.length;
}

/** At startup: warn once per set of conflicts and offer to fix them. */
export async function promptKeymapConflicts(ctx: vscode.ExtensionContext) {
  const conflicts = findConflicts(ctx);
  if (!conflicts.length) return;
  const signature = conflicts.map((c) => `${c.key}=${c.theirs.map((t) => t.command).join(',')}`).join('|');
  if (ctx.globalState.get<string>(DISMISSED) === signature) return;
  const sources = Array.from(new Set(conflicts.flatMap((c) => c.theirs.map((t) => t.source))));
  const keys = conflicts.map((c) => prettyKey(c.key)).join(', ');
  const answer = await vscode.window.showWarningMessage(
    `Storm: ${keys} ${conflicts.length > 1 ? 'are' : 'is'} also bound by ${sources.map((s) => `"${s}"`).join(', ')}, which take${sources.length > 1 ? '' : 's'} precedence. Use the Storm shortcuts?`,
    { detail: 'The Storm bindings will be added to your user keybindings.json, which always wins over extensions. You can remove them there at any time.' },
    'Use Storm shortcuts',
    'Not now',
    "Don't ask again",
  );
  if (answer === 'Use Storm shortcuts') await applyKeymap(ctx, conflicts);
  else if (answer === "Don't ask again") await ctx.globalState.update(DISMISSED, signature);
}
