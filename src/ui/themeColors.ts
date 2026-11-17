// Loads the active VS Code colour theme from its extension and resolves the
// colours used by the preview highlighter.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import { applyCustomizations, resolveTokenColors, TextMateRule, TokenColors } from '../shared/tokenTheme';

interface ThemeContribution {
  id?: string;
  label?: string;
  uiTheme?: string;
  path: string;
}

/** Name of the active theme, honouring "window.autoDetectColorScheme". */
export function activeThemeName(): string | undefined {
  const cfg = vscode.workspace.getConfiguration();
  if (cfg.get<boolean>('window.autoDetectColorScheme')) {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const key = kind === vscode.ColorThemeKind.HighContrast
      ? 'workbench.preferredHighContrastColorTheme'
      : kind === vscode.ColorThemeKind.HighContrastLight
        ? 'workbench.preferredHighContrastLightColorTheme'
        : dark
          ? 'workbench.preferredDarkColorTheme'
          : 'workbench.preferredLightColorTheme';
    const pref = cfg.get<string>(key);
    if (pref) return pref;
  }
  return cfg.get<string>('workbench.colorTheme');
}

function findTheme(name: string): { file: string; names: string[] } | undefined {
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { themes?: ThemeContribution[] } }).contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const t of themes) {
      if (t.id === name || t.label === name) {
        return { file: path.join(ext.extensionPath, t.path), names: [t.id, t.label].filter((x): x is string => !!x) };
      }
    }
  }
  return undefined;
}

/** Reads a theme file and its "include" chain; returns the tokenColors rules, base first. */
function readRules(file: string, depth = 0): TextMateRule[] {
  if (depth > 8) return [];
  let json: { include?: string; tokenColors?: TextMateRule[] | string };
  try {
    json = parse(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true }) ?? {};
  } catch {
    return [];
  }
  const dir = path.dirname(file);
  const rules: TextMateRule[] = [];
  if (typeof json.include === 'string') rules.push(...readRules(path.join(dir, json.include), depth + 1));
  if (Array.isArray(json.tokenColors)) rules.push(...json.tokenColors);
  else if (typeof json.tokenColors === 'string' && json.tokenColors.toLowerCase().endsWith('.json')) {
    // tokenColors may point to another JSON file holding the rules
    try {
      const other = parse(fs.readFileSync(path.join(dir, json.tokenColors), 'utf8'), [], { allowTrailingComma: true });
      if (Array.isArray(other)) rules.push(...other);
      else if (Array.isArray(other?.tokenColors)) rules.push(...other.tokenColors);
    } catch {
      /* ignore */
    }
  }
  // (.tmTheme plist files are not supported: the preview then keeps its default palette)
  return rules;
}

/**
 * Token colours of the active theme, or undefined when the JetBrains palette
 * is requested or the theme cannot be read.
 */
export function currentTokenColors(): TokenColors | undefined {
  if (vscode.workspace.getConfiguration('storm').get<string>('previewColors', 'theme') !== 'theme') return undefined;
  let name = activeThemeName();
  let theme = name ? findTheme(name) : undefined;
  if (!theme) {
    // Unknown / uninstalled theme: VS Code falls back to its default theme, so do we.
    const def = vscode.workspace.getConfiguration().inspect<string>('workbench.colorTheme')?.defaultValue;
    if (def && def !== name) {
      name = def;
      theme = findTheme(def);
    }
  }
  const base = theme ? readRules(theme.file) : [];
  const custom = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations');
  const { rules, overrides } = applyCustomizations(base, custom, theme?.names ?? (name ? [name] : []));
  if (!rules.length && !Object.keys(overrides).length) return undefined;
  const colors = resolveTokenColors(rules);
  for (const [k, v] of Object.entries(overrides)) colors[k as keyof TokenColors] = { ...colors[k as keyof TokenColors], ...v };
  return colors;
}

/** Fires when the colours may have changed (theme switch, customisations, our setting). */
export function onTokenColorsChange(listener: () => void): vscode.Disposable {
  const a = vscode.window.onDidChangeActiveColorTheme(() => listener());
  const b = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('storm.previewColors') || e.affectsConfiguration('window.autoDetectColorScheme')) listener();
  });
  return vscode.Disposable.from(a, b);
}
