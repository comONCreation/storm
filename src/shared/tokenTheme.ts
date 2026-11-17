// Resolves the colours of the preview highlighter's token categories from a
// VS Code colour theme (TextMate "tokenColors" rules), so that the Find in
// Files preview looks like the editor. Pure module: no vscode import.

export type TokenCategory = 'k' | 'kc' | 's' | 'c' | 'n' | 'v' | 'f' | 'y' | 't' | 'a';

export interface TokenStyle {
  fg?: string;
  italic?: boolean;
  bold?: boolean;
}

export type TokenColors = Partial<Record<TokenCategory, TokenStyle>>;

export interface TextMateRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

/**
 * Representative TextMate scopes of each category, most specific first.
 * The first scope that a rule of the theme matches gives the colour.
 */
export const CATEGORY_SCOPES: Record<TokenCategory, string[]> = {
  kc: ['keyword.control.php', 'keyword.control'],
  k: ['storage.type.function.php', 'storage.modifier', 'storage.type', 'keyword.other', 'keyword'],
  s: ['string.quoted.single.php', 'string.quoted', 'string'],
  c: ['comment.line.double-slash', 'comment.block', 'comment'],
  n: ['constant.numeric'],
  v: ['variable.other.php', 'variable.other', 'variable'],
  f: ['entity.name.function', 'support.function'],
  y: ['entity.name.type.class', 'support.class', 'entity.name.type'],
  t: ['entity.name.tag'],
  a: ['entity.other.attribute-name', 'support.type.property-name.json', 'support.type.property-name'],
};

/** editor.tokenColorCustomizations shortcuts → categories. */
const SHORTCUTS: Record<string, TokenCategory[]> = {
  comments: ['c'],
  strings: ['s'],
  keywords: ['k', 'kc'],
  numbers: ['n'],
  types: ['y'],
  functions: ['f'],
  variables: ['v'],
};

/** Specificity of `selector` for `scope` (number of matched segments), 0 if it does not match. */
function score(selector: string, scope: string): number {
  const sel = selector.trim();
  // Descendant ("source.php variable") and exclusion ("a - b") selectors need the
  // parent scopes of a real tokenisation: they are ignored here.
  if (!sel || /\s/.test(sel)) return 0;
  if (scope === sel || scope.startsWith(sel + '.')) return sel.split('.').length;
  return 0;
}

function selectors(rule: TextMateRule): string[] {
  if (!rule.scope) return [];
  return (Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',')).map((s) => s.trim()).filter(Boolean);
}

/** Like VS Code: the most specific selector wins, later rules win ties. */
export function resolveScope(rules: TextMateRule[], scope: string): TokenStyle | undefined {
  let best: TextMateRule | undefined;
  let bestScore = 0;
  let fontRule: TextMateRule | undefined;
  let fontScore = 0;
  for (const r of rules) {
    if (!r.settings) continue;
    let s = 0;
    for (const sel of selectors(r)) s = Math.max(s, score(sel, scope));
    if (!s) continue;
    if (r.settings.foreground && s >= bestScore) {
      best = r;
      bestScore = s;
    }
    if (r.settings.fontStyle !== undefined && s >= fontScore) {
      fontRule = r;
      fontScore = s;
    }
  }
  if (!best && !fontRule) return undefined;
  const fs = fontRule?.settings?.fontStyle ?? '';
  return { fg: best?.settings?.foreground, italic: /italic/.test(fs), bold: /bold/.test(fs) };
}

export function resolveTokenColors(rules: TextMateRule[]): TokenColors {
  const out: TokenColors = {};
  for (const cat of Object.keys(CATEGORY_SCOPES) as TokenCategory[]) {
    for (const scope of CATEGORY_SCOPES[cat]) {
      const st = resolveScope(rules, scope);
      if (st?.fg) {
        out[cat] = st;
        break;
      }
    }
  }
  return out;
}

type Customization = string | { foreground?: string; fontStyle?: string };

/**
 * Applies `editor.tokenColorCustomizations` (global part and the block of the
 * current theme, e.g. "[Default Dark Modern]") on top of the theme rules.
 */
export function applyCustomizations(rules: TextMateRule[], custom: Record<string, unknown> | undefined, themeNames: string[]): { rules: TextMateRule[]; overrides: TokenColors } {
  const overrides: TokenColors = {};
  const all = [...rules];
  const blocks: Array<Record<string, unknown>> = [];
  if (custom) {
    blocks.push(custom);
    for (const name of themeNames) {
      const b = custom[`[${name}]`];
      if (b && typeof b === 'object') blocks.push(b as Record<string, unknown>);
    }
  }
  for (const b of blocks) {
    const tm = b.textMateRules;
    if (Array.isArray(tm)) all.push(...(tm as TextMateRule[]));
    for (const [key, cats] of Object.entries(SHORTCUTS)) {
      const v = b[key] as Customization | undefined;
      if (!v) continue;
      const style: TokenStyle = typeof v === 'string' ? { fg: v } : { fg: v.foreground, italic: /italic/.test(v.fontStyle ?? ''), bold: /bold/.test(v.fontStyle ?? '') };
      for (const c of cats) overrides[c] = { ...overrides[c], ...style };
    }
  }
  return { rules: all, overrides };
}
