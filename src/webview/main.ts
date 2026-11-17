// Webview UI: "Search Everywhere" and "Find in Files / Replace in Files" popups.

import { buildRegExp, tryBuildRegExp } from '../shared/query';
import { tokenize, langFor, Seg } from './highlight';
import type {
  ActionHit, EverywhereGroup, EverywhereTab, FileHit, FindOptions, IndexStatus, LineMatch, SymbolHit, TextSearchStats, ToHost, ToWebview, TokenColors,
} from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const send = (m: ToHost) => vscode.postMessage(m);

const app = document.getElementById('app')!;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

let mode: 'everywhere' | 'find' | null = null;
let isMac = false;
let modules: string[] = [];
let pinned = false;
let status: IndexStatus | null = null;
let seq = 0;
let findKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let maskHistory: string[] = [];
/** Closes an open dropdown; returns true if one was open (Escape then must not close the popup). */
let closeDropdown: (() => boolean) | null = null;

const COMMON_MASKS = ['*.php', '*.blade.php', '*.twig', '*.js', '*.ts', '*.vue', '*.css, *.scss', '*.json', '*.yml, *.yaml', '*.xml', '*.md', '*.py', '!*.min.js'];
const persisted = (vscode.getState() as { previewHeight?: number } | undefined) ?? {};

// ------------------------------------------------------------------ helpers

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** Renders text with highlighted ranges (flat [start, end) list). */
function hl(text: string, ranges: number[] | undefined, cls = 'hl'): string {
  if (!ranges || !ranges.length) return esc(text);
  let out = '';
  let pos = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const s = Math.max(pos, ranges[i]);
    const e = Math.min(text.length, ranges[i + 1]);
    if (e <= s) continue;
    out += esc(text.slice(pos, s)) + `<span class="${cls}">` + esc(text.slice(s, e)) + '</span>';
    pos = e;
  }
  return out + esc(text.slice(pos));
}

const key = (k: string) => (isMac ? k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧').replace(/Enter/g, '⏎') : k);

const FILE_COLORS: Record<string, [string, string]> = {
  php: ['#7a86b8', 'php'], phtml: ['#7a86b8', 'php'], js: ['#d4b106', 'js'], mjs: ['#d4b106', 'js'], cjs: ['#d4b106', 'js'], jsx: ['#d4b106', 'jsx'],
  ts: ['#3178c6', 'ts'], tsx: ['#3178c6', 'tsx'], json: ['#cb9d4b', '{}'], css: ['#2965f1', 'css'], scss: ['#c6538c', 'scs'], less: ['#1d365d', 'les'],
  html: ['#e34c26', '<>'], htm: ['#e34c26', '<>'], vue: ['#41b883', 'vue'], twig: ['#8fb534', 'twg'], md: ['#6e7781', 'md'], py: ['#3572a5', 'py'],
  java: ['#b07219', 'jav'], kt: ['#a97bff', 'kt'], go: ['#00add8', 'go'], rs: ['#dea584', 'rs'], rb: ['#cc342d', 'rb'], xml: ['#e37933', 'xml'],
  yml: ['#cb171e', 'yml'], yaml: ['#cb171e', 'yml'], sql: ['#e38c00', 'sql'], sh: ['#4eaa25', 'sh'], env: ['#4eaa25', 'env'], svg: ['#ffb13b', 'svg'],
  png: ['#26a269', 'img'], jpg: ['#26a269', 'img'], jpeg: ['#26a269', 'img'], gif: ['#26a269', 'img'], lock: ['#888', 'lck'], txt: ['#888', 'txt'],
  cs: ['#68217a', 'c#'], c: ['#555599', 'c'], cpp: ['#f34b7d', 'c++'], h: ['#555599', 'h'], xlf: ['#e37933', 'xlf'], neon: ['#cb171e', 'neo'],
};

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.blade.php')) return `<span class="ficon" style="--c:#f05340">bl</span>`;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const [color, label] = FILE_COLORS[ext] ?? ['#8c8c8c', ext.slice(0, 3) || '·'];
  return `<span class="ficon" style="--c:${color}">${esc(label)}</span>`;
}

const SYMBOL_ICONS: Record<string, [string, string]> = {
  class: ['c', 'C'], interface: ['i', 'I'], trait: ['t', 'T'], enum: ['e', 'E'], struct: ['c', 'S'], type: ['i', 'T'], module: ['n', 'M'],
  namespace: ['n', 'N'], function: ['f', 'ƒ'], method: ['m', 'm'], field: ['p', 'f'], property: ['p', 'p'], constant: ['k', 'c'],
};

function symbolIcon(kind: string): string {
  const [cls, letter] = SYMBOL_ICONS[kind] ?? ['p', '?'];
  return `<span class="sicon s-${cls}" title="${esc(kind)}">${letter}</span>`;
}

function baseName(p: string) {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

function statusHtml(): string {
  if (!status || status.state === 'ready') return '';
  const pct = status.totalFiles ? Math.floor((status.indexedFiles / status.totalFiles) * 100) : 0;
  return `<span class="indexing"><span class="spin"></span>${status.state === 'indexing' ? `Indexing… ${pct}%` : 'Scanning files…'} — results may be incomplete</span>`;
}

// ------------------------------------------------------------------ syntax colours

const TOKEN_CATEGORIES = ['k', 'kc', 's', 'c', 'n', 'v', 'f', 'y', 't', 'a'] as const;

/**
 * Applies the token colours of the user's VS Code theme (resolved by the extension host),
 * or falls back to the JetBrains palette of webview.css when `colors` is null.
 */
function applyTokenColors(colors: TokenColors | null) {
  const root = document.documentElement.style;
  document.body.classList.toggle('palette-theme', !!colors);
  document.body.classList.toggle('palette-jetbrains', !colors);
  for (const c of TOKEN_CATEGORIES) {
    const st = colors?.[c];
    if (st?.fg) root.setProperty(`--tt-${c}`, st.fg);
    else root.removeProperty(`--tt-${c}`);
    root.setProperty(`--tt-${c}-fs`, st?.italic ? 'italic' : 'normal');
    root.setProperty(`--tt-${c}-fw`, st?.bold ? 'bold' : 'normal');
  }
}

// ------------------------------------------------------------------ messages

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      isMac = m.platform === 'darwin';
      modules = m.modules;
      pinned = m.pinned;
      status = m.status;
      maskHistory = m.maskHistory ?? [];
      applyTokenColors(m.tokenColors ?? null);
      if (m.mode === 'everywhere') initEverywhere(m.tab ?? 'all', m.query ?? '', m.includeNonProject ?? false);
      else initFind(m.find!);
      break;
    case 'everywhereResults':
      if (mode === 'everywhere') se.onResults(m.seq, m.tab, m.groups);
      break;
    case 'findResults':
      if (mode === 'find') fif.onResults(m.seq, m.items, m.reset, m.done, m.stats, m.error);
      break;
    case 'preview':
      if (mode === 'find') fif.onPreview(m.path, m.rel, m.content, m.languageId, m.error);
      break;
    case 'directoryPicked':
      if (mode === 'find') fif.setDirectory(m.directory);
      break;
    case 'tokenColors':
      applyTokenColors(m.colors);
      break;
    case 'status':
      status = m.status;
      document.querySelectorAll('.status-slot').forEach((el) => (el.innerHTML = statusHtml()));
      break;
    case 'focus':
      ($('#q') as HTMLElement | null)?.focus();
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (closeDropdown?.()) return;
    send({ type: 'close' });
  }
});

// ================================================================== Search Everywhere

const TABS: Array<[EverywhereTab, string]> = [
  ['all', 'All'],
  ['classes', 'Classes'],
  ['files', 'Files'],
  ['symbols', 'Symbols'],
  ['actions', 'Actions'],
  ['text', 'Text'],
];

type Row =
  | { type: 'header'; label: string }
  | { type: 'more'; tab: EverywhereTab }
  | { type: 'file'; item: FileHit }
  | { type: 'symbol'; item: SymbolHit }
  | { type: 'action'; item: ActionHit }
  | { type: 'text'; item: LineMatch };

const se = {
  tab: 'all' as EverywhereTab,
  query: '',
  includeNonProject: false,
  rows: [] as Row[],
  selected: -1,
  lastSeq: 0,
  timer: 0 as unknown as number,

  onResults(s: number, tab: EverywhereTab, groups: EverywhereGroup[]) {
    if (s !== this.lastSeq || tab !== this.tab) return;
    const rows: Row[] = [];
    const showHeaders = this.tab === 'all' || groups.some((g) => g.kind === 'recent');
    for (const g of groups) {
      if (!g.items.length) continue;
      if (showHeaders) rows.push({ type: 'header', label: g.kind === 'recent' ? 'Recent Files' : g.kind[0].toUpperCase() + g.kind.slice(1) });
      for (const it of g.items) {
        if (g.kind === 'files' || g.kind === 'recent') rows.push({ type: 'file', item: it as FileHit });
        else if (g.kind === 'classes' || g.kind === 'symbols') rows.push({ type: 'symbol', item: it as SymbolHit });
        else if (g.kind === 'actions') rows.push({ type: 'action', item: it as ActionHit });
        else rows.push({ type: 'text', item: it as LineMatch });
      }
      if (g.more && g.kind !== 'recent') rows.push({ type: 'more', tab: g.kind as EverywhereTab });
    }
    const prevKey = this.selected >= 0 ? rowKey(this.rows[this.selected]) : null;
    this.rows = rows;
    const keep = prevKey ? rows.findIndex((r) => rowKey(r) === prevKey) : -1;
    this.selected = keep >= 0 && this.query === this.lastRenderedQuery ? keep : rows.findIndex(selectable);
    this.lastRenderedQuery = this.query;
    this.render();
  },
  lastRenderedQuery: '',

  render() {
    const list = $('#list');
    if (!this.rows.length) {
      list.innerHTML = this.query.trim()
        ? `<div class="empty">Nothing found${this.includeNonProject ? '' : '. <a href="#" id="incl">Include non-project items</a>?'}</div>`
        : `<div class="empty">${this.tab === 'all' || this.tab === 'files' ? 'No recent files' : 'Type to search'}</div>`;
      $('#incl')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.setInclude(true);
      });
      return;
    }
    list.innerHTML = this.rows.map((r, i) => renderRow(r, i, i === this.selected)).join('');
    this.scrollToSelected();
  },

  scrollToSelected() {
    const el = document.querySelector(`#list [data-i="${this.selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  },

  select(i: number) {
    if (i < 0 || i >= this.rows.length) return;
    document.querySelector('#list .row.sel')?.classList.remove('sel');
    this.selected = i;
    document.querySelector(`#list [data-i="${i}"]`)?.classList.add('sel');
    this.scrollToSelected();
  },

  move(delta: number) {
    if (!this.rows.length) return;
    let i = this.selected;
    for (let k = 0; k < this.rows.length; k++) {
      i = (i + delta + this.rows.length) % this.rows.length;
      if (selectable(this.rows[i])) break;
    }
    this.select(i);
  },

  activate(i: number, split = false) {
    const r = this.rows[i];
    if (!r) return;
    switch (r.type) {
      case 'more':
        this.setTab(r.tab);
        return;
      case 'file':
        send({ type: 'openFile', path: r.item.path, line: r.item.line, col: r.item.col, split });
        return;
      case 'symbol':
        send({ type: 'openFile', path: r.item.path, line: r.item.line, col: r.item.col, endLine: r.item.line, endCol: r.item.col + r.item.name.length, split });
        return;
      case 'action':
        send({ type: 'runAction', id: r.item.id });
        return;
      case 'text':
        send({ type: 'openFile', path: r.item.path, line: r.item.line, col: r.item.col, endLine: r.item.endLine, endCol: r.item.endCol, split });
        return;
    }
  },

  setTab(tab: EverywhereTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === tab));
    this.rows = [];
    this.selected = -1;
    this.query_changed(true);
  },

  setInclude(v: boolean) {
    this.includeNonProject = v;
    ($('#nonproj') as HTMLInputElement).checked = v;
    this.query_changed(true);
  },

  query_changed(immediate = false) {
    clearTimeout(this.timer);
    const run = () => {
      this.lastSeq = ++seq;
      send({ type: 'everywhere', seq: this.lastSeq, tab: this.tab, query: this.query, includeNonProject: this.includeNonProject });
      send({ type: 'state', everywhere: { tab: this.tab, query: this.query, includeNonProject: this.includeNonProject } });
    };
    if (immediate) run();
    else this.timer = setTimeout(run, this.tab === 'text' ? 60 : 15) as unknown as number;
  },
};

function selectable(r: Row) {
  return r.type !== 'header';
}

function rowKey(r: Row | undefined): string | null {
  if (!r) return null;
  switch (r.type) {
    case 'file':
      return 'f' + r.item.path;
    case 'symbol':
      return `s${r.item.path}:${r.item.line}:${r.item.name}`;
    case 'action':
      return 'a' + r.item.id;
    case 'text':
      return `t${r.item.path}:${r.item.line}`;
    case 'more':
      return 'm' + r.tab;
    default:
      return null;
  }
}

function renderRow(r: Row, i: number, sel: boolean): string {
  const cls = `row${sel ? ' sel' : ''}`;
  switch (r.type) {
    case 'header':
      return `<div class="group-hdr" data-i="${i}"><span>${esc(r.label)}</span></div>`;
    case 'more':
      return `<div class="${cls} more" data-i="${i}"><span class="name">… more</span></div>`;
    case 'file': {
      const f = r.item;
      const loc = f.line !== undefined ? `<span class="lineno">:${f.line + 1}${f.col !== undefined ? ':' + (f.col + 1) : ''}</span>` : '';
      return `<div class="${cls}${f.lib ? ' lib' : ''}" data-i="${i}">${fileIcon(f.name)}<span class="name">${hl(f.name, f.hl)}${loc}</span><span class="extra">${hl(f.dir, f.dirHl)}</span>${f.lib ? '<span class="right">library</span>' : ''}</div>`;
    }
    case 'symbol': {
      const s = r.item;
      const paren = s.kind === 'method' || s.kind === 'function' ? '()' : '';
      const container = s.container ? esc(s.container) : '';
      return `<div class="${cls}${s.lib ? ' lib' : ''}" data-i="${i}">${symbolIcon(s.kind)}<span class="name">${s.kind === 'field' && /\.php$/i.test(s.rel) ? '$' : ''}${hl(s.name, s.hl)}${paren}</span><span class="extra">${container}</span><span class="right">${fileIcon(baseName(s.rel))}${esc(baseName(s.rel))}:${s.line + 1}</span></div>`;
    }
    case 'action': {
      const a = r.item;
      return `<div class="${cls}" data-i="${i}"><span class="aicon">⌘</span><span class="name">${hl(a.title, a.hl)}</span><span class="extra"></span><span class="right">${esc(a.category)}</span></div>`;
    }
    case 'text': {
      const t = r.item;
      return `<div class="${cls}" data-i="${i}"><span class="name code-text">${codeLineHtml(t.text, t.rel, t.ranges)}</span><span class="extra"></span><span class="right">${fileIcon(baseName(t.rel))}${esc(baseName(t.rel))} <span class="lineno">${t.line + 1}</span></span></div>`;
    }
  }
}

function initEverywhere(tab: EverywhereTab, query: string, includeNonProject: boolean) {
  if (mode === 'everywhere') {
    // Same shortcut pressed again while open: PhpStorm toggles "Include non-project items".
    if (tab === se.tab) {
      se.setInclude(!se.includeNonProject);
    } else se.setTab(tab);
    ($('#q') as HTMLInputElement).focus();
    return;
  }
  mode = 'everywhere';
  if (findKeyHandler) document.removeEventListener('keydown', findKeyHandler);
  findKeyHandler = null;
  se.tab = tab;
  se.query = query;
  se.includeNonProject = includeNonProject;
  se.rows = [];
  se.selected = -1;
  document.body.className = document.body.className.replace(/\bmode-\w+/g, '') + ' mode-everywhere';
  app.innerHTML = `
  <div class="popup se">
    <div class="se-top">
      <div class="tabs">${TABS.map(([t, l]) => `<div class="tab${t === tab ? ' active' : ''}" data-tab="${t}">${l}</div>`).join('')}</div>
      <label class="chk"><input type="checkbox" id="nonproj" ${includeNonProject ? 'checked' : ''}> Include non-project items</label>
    </div>
    <div class="field se-field">
      ${SEARCH_SVG}
      <input id="q" type="text" spellcheck="false" autocomplete="off" value="${esc(query)}" placeholder="Type / to search in path, :42 to go to line, Class::method">
    </div>
    <div id="list" class="list"></div>
    <div class="footer">
      <span class="status-slot">${statusHtml()}</span>
      <span class="spacer"></span>
      <span class="hint">${key('Tab')} switch tabs · ${key('Shift+Enter')} open in split · press the shortcut again to include non-project items</span>
    </div>
  </div>`;
  const q = $<HTMLInputElement>('#q');
  q.focus();
  q.select();
  q.addEventListener('input', () => {
    se.query = q.value;
    se.query_changed();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      se.move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      se.move(-1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      se.move(10);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      se.move(-10);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (se.selected >= 0) se.activate(se.selected, e.shiftKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const idx = TABS.findIndex(([t]) => t === se.tab);
      se.setTab(TABS[(idx + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length][0]);
    }
  });
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      se.setTab((t as HTMLElement).dataset.tab as EverywhereTab);
      q.focus();
    }),
  );
  $<HTMLInputElement>('#nonproj').addEventListener('change', (e) => {
    se.setInclude((e.target as HTMLInputElement).checked);
    q.focus();
  });
  const list = $('#list');
  list.addEventListener('mousemove', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (row && Number(row.dataset.i) !== se.selected) se.select(Number(row.dataset.i));
  });
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (row) se.activate(Number(row.dataset.i), e.shiftKey);
    q.focus();
  });
  se.query_changed(true);
}

// ================================================================== Find in Files

const fif = {
  o: null as unknown as FindOptions,
  items: [] as LineMatch[],
  stats: null as TextSearchStats | null,
  done: true,
  selected: -1,
  lastSeq: 0,
  timer: 0 as unknown as number,
  previewCache: new Map<string, { rel: string; content: string; languageId: string; lines?: Seg[][]; error?: string }>(),
  previewTimer: 0 as unknown as number,
  previewPath: '',
  regexError: '',

  search(immediate = false) {
    clearTimeout(this.timer);
    const run = () => {
      const err = this.o.query ? tryBuildRegExp(this.o) : null;
      this.regexError = typeof err === 'string' ? err : '';
      this.renderFieldError();
      this.lastSeq = ++seq;
      this.done = false;
      this.renderStats();
      send({ type: 'find', seq: this.lastSeq, options: this.o });
      send({ type: 'state', find: this.o });
    };
    if (immediate) run();
    else this.timer = setTimeout(run, 40) as unknown as number;
  },

  onResults(s: number, items: LineMatch[], reset: boolean, done: boolean, stats?: TextSearchStats, error?: string) {
    if (s !== this.lastSeq) return;
    if (error) {
      this.regexError = error;
      this.renderFieldError();
    }
    const list = $('#results');
    if (reset) {
      const prev = this.selected >= 0 ? this.items[this.selected] : undefined;
      this.items = [];
      this.previewCache.clear();
      list.innerHTML = '';
      this.selected = -1;
      this.appendRows(items);
      // keep the selection on the same line if it still matches
      let idx = prev ? this.items.findIndex((m) => m.path === prev.path && m.line === prev.line) : -1;
      if (idx < 0 && this.items.length) idx = 0;
      if (idx >= 0) this.select(idx);
      else this.clearPreview();
    } else {
      this.appendRows(items);
      if (this.selected < 0 && this.items.length) this.select(0);
    }
    if (done) {
      this.done = true;
      this.stats = stats ?? null;
      if (!this.items.length) {
        list.innerHTML = this.o.query && !this.regexError ? `<div class="empty">No matches found ${scopeText(this.o)}</div>` : '';
        this.clearPreview();
      }
    }
    this.renderStats();
  },

  appendRows(items: LineMatch[]) {
    if (!items.length) return;
    const start = this.items.length;
    this.items.push(...items);
    const html = items.map((m, k) => this.rowHtml(m, start + k)).join('');
    $('#results').insertAdjacentHTML('beforeend', html);
  },

  rowHtml(m: LineMatch, i: number): string {
    let text: string;
    if (this.o.replaceMode) text = this.replacePreview(m);
    else text = codeLineHtml(m.text, m.rel, m.ranges);
    return `<div class="row frow${m.lib ? ' lib' : ''}${i === this.selected ? ' sel' : ''}" data-i="${i}"><span class="ftext code-text">${text}</span><span class="floc">${esc(baseName(m.rel))} <span class="lineno">${m.line + 1}</span></span></div>`;
  },

  replacePreview(m: LineMatch): string {
    let single: RegExp | null = null;
    if (this.o.regex) {
      try {
        single = buildRegExp(this.o, false);
      } catch {
        single = null;
      }
    }
    let out = '';
    let pos = 0;
    for (let i = 0; i + 1 < m.ranges.length; i += 2) {
      const s = Math.max(pos, m.ranges[i]);
      const e = Math.min(m.text.length, m.ranges[i + 1]);
      if (e < s) continue;
      const matched = m.text.slice(s, e);
      let repl = this.o.replace;
      if (single) {
        try {
          repl = matched.replace(single, this.o.replace.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
        } catch {
          /* keep raw */
        }
      }
      out += esc(m.text.slice(pos, s)) + `<span class="del">${esc(matched)}</span><span class="ins">${esc(repl)}</span>`;
      pos = e;
    }
    return out + esc(m.text.slice(pos));
  },

  rerenderRows() {
    $('#results').innerHTML = this.items.map((m, i) => this.rowHtml(m, i)).join('');
    this.scrollToSelected();
  },

  select(i: number, scroll = true) {
    if (i < 0 || i >= this.items.length) return;
    document.querySelector('#results .row.sel')?.classList.remove('sel');
    this.selected = i;
    document.querySelector(`#results [data-i="${i}"]`)?.classList.add('sel');
    if (scroll) this.scrollToSelected();
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.requestPreview(), 30) as unknown as number;
  },

  scrollToSelected() {
    document.querySelector(`#results [data-i="${this.selected}"]`)?.scrollIntoView({ block: 'nearest' });
  },

  move(delta: number) {
    if (!this.items.length) return;
    let i = this.selected + delta;
    if (i < 0) i = delta === -1 ? this.items.length - 1 : 0;
    if (i >= this.items.length) i = delta === 1 ? 0 : this.items.length - 1;
    this.select(i);
  },

  open(i: number, split = false) {
    const m = this.items[i];
    if (!m) return;
    send({ type: 'openFile', path: m.path, line: m.line, col: m.col, endLine: m.endLine, endCol: m.endCol, split });
  },

  requestPreview() {
    const m = this.items[this.selected];
    if (!m) return;
    const cached = this.previewCache.get(m.path);
    if (cached) this.renderPreview(m.path, cached);
    else send({ type: 'preview', path: m.path });
  },

  onPreview(path: string, rel: string, content: string, languageId: string, error?: string) {
    const entry = { rel, content, languageId, error };
    this.previewCache.set(path, entry);
    const m = this.items[this.selected];
    if (m && m.path === path) this.renderPreview(path, entry);
  },

  clearPreview() {
    this.previewPath = '';
    $('#previewHdr').innerHTML = '';
    $('#code').innerHTML = '';
  },

  renderPreview(path: string, entry: { rel: string; content: string; languageId: string; lines?: Seg[][]; error?: string }) {
    const m = this.items[this.selected];
    if (!m) return;
    const hdr = $('#previewHdr');
    hdr.innerHTML = `${fileIcon(baseName(entry.rel))}<span class="ppath">${esc(entry.rel)}</span><span class="pline">line ${m.line + 1}</span>`;
    const code = $('#code');
    if (entry.error) {
      code.innerHTML = `<div class="empty">${esc(entry.error)}</div>`;
      return;
    }
    const text = entry.content;
    if (!entry.lines) entry.lines = tokenize(text, langFor(entry.languageId, path));
    const lineStarts: number[] = [0];
    for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) lineStarts.push(k + 1);
    const total = lineStarts.length;
    // Render a window around the match for huge files.
    const WINDOW = 1500;
    const from = total > 2 * WINDOW + 500 ? Math.max(0, m.line - WINDOW) : 0;
    const to = total > 2 * WINDOW + 500 ? Math.min(total, m.line + WINDOW) : total;
    // Occurrences of the query in the rendered window.
    const marks = new Map<number, number[]>();
    try {
      const re = buildRegExp(this.o);
      const startOff = lineStarts[from];
      const endOff = to < total ? lineStarts[to] : text.length;
      re.lastIndex = startOff;
      let mm: RegExpExecArray | null;
      let lineIdx = from;
      let guard = 0;
      while ((mm = re.exec(text)) && mm.index < endOff && guard++ < 20000) {
        if (!mm[0].length) {
          re.lastIndex++;
          continue;
        }
        let s = mm.index;
        const e = s + mm[0].length;
        while (lineIdx + 1 < total && lineStarts[lineIdx + 1] <= s) lineIdx++;
        let li = lineIdx;
        while (s < e && li < total) {
          const ls = lineStarts[li];
          const le = li + 1 < total ? lineStarts[li + 1] - 1 : text.length;
          const arr = marks.get(li) ?? [];
          arr.push(s - ls, Math.min(e, le) - ls);
          marks.set(li, arr);
          s = le + 1;
          li++;
        }
      }
    } catch {
      /* invalid regex: no marks */
    }
    const gutterW = String(to).length;
    let html = '';
    for (let li = from; li < to; li++) {
      const ls = lineStarts[li];
      let le = li + 1 < total ? lineStarts[li + 1] - 1 : text.length;
      if (le > ls && text.charCodeAt(le - 1) === 13) le--;
      const lineText = text.slice(ls, le);
      const isCur = li >= m.line && li <= m.endLine;
      html += `<div class="cl${isCur ? ' cur' : ''}" data-l="${li}"><span class="gut">${String(li + 1).padStart(gutterW, ' ')}</span><span class="src">${renderCodeLine(lineText, entry.lines[li] ?? [], marks.get(li), isCur ? 'mk cur-mk' : 'mk')}</span></div>`;
    }
    code.innerHTML = html;
    this.previewPath = path;
    const cur = code.querySelector('.cl.cur') as HTMLElement | null;
    if (cur) {
      const top = cur.getBoundingClientRect().top - code.getBoundingClientRect().top + code.scrollTop;
      code.scrollTop = Math.max(0, top - code.clientHeight / 2 + cur.offsetHeight / 2);
    }
  },

  renderStats() {
    const el = $('#stats');
    if (!el) return;
    if (!this.o.query) {
      el.innerHTML = '';
      return;
    }
    if (!this.done && !this.items.length) {
      el.innerHTML = `<span class="spin"></span>`;
      return;
    }
    const st = this.stats;
    const occ = st ? st.matches : this.items.reduce((n, m) => n + m.count, 0);
    const files = st ? st.files : new Set(this.items.map((m) => m.path)).size;
    const plus = st?.truncated ? '+' : '';
    const spin = this.done ? '' : `<span class="spin"></span>`;
    const time = this.done && st ? `<span class="time">${st.durationMs} ms</span>` : '';
    el.innerHTML = `${spin}${occ}${plus} match${occ === 1 ? '' : 'es'} in ${files}${plus} file${files === 1 ? '' : 's'}${time}`;
  },

  renderFieldError() {
    const f = $('#qfield');
    f?.classList.toggle('error', !!this.regexError);
    const e = $('#qerror');
    if (e) e.textContent = this.regexError ? this.regexError : '';
  },

  setDirectory(dir: string) {
    this.o.scope = 'directory';
    this.o.directory = dir;
    renderScope();
    this.search(true);
  },
};

function scopeText(o: FindOptions): string {
  switch (o.scope) {
    case 'project':
      return 'in Project';
    case 'module':
      return 'in Module';
    case 'directory':
      return `in '${o.directory}'`;
    default:
      return { all: 'in All Places', ignored: 'in All Places, Including Ignored Files', project: 'in Project Files', open: 'in Open Files', current: 'in Current File', recent: 'in Recently Viewed Files' }[o.namedScope];
  }
}

/** A single result line, syntax-highlighted with the language of its file, with the matches marked. */
function codeLineHtml(text: string, rel: string, ranges: number[]): string {
  if (text.length > 2000) return hl(text, ranges, 'mhl');
  const segs = tokenize(text, langFor('', rel))[0] ?? [];
  return renderCodeLine(text, segs, ranges, 'mhl');
}

/** Merges syntax segments and match marks into the HTML of a code line. */
function renderCodeLine(text: string, segs: Seg[], marks: number[] | undefined, markCls: string): string {
  if (!text) return '';
  const cuts = new Set<number>([0, text.length]);
  for (const [s, e] of segs) {
    cuts.add(Math.min(s, text.length));
    cuts.add(Math.min(e, text.length));
  }
  if (marks) for (const x of marks) cuts.add(Math.max(0, Math.min(x, text.length)));
  const pts = Array.from(cuts).sort((a, b) => a - b);
  let out = '';
  let si = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (b <= a) continue;
    while (si < segs.length && segs[si][1] <= a) si++;
    const tok = si < segs.length && segs[si][0] <= a ? segs[si][2] : '';
    let inMark = false;
    if (marks) for (let j = 0; j + 1 < marks.length; j += 2) if (marks[j] <= a && b <= marks[j + 1]) inMark = true;
    const cls = [tok ? `t-${tok}` : '', inMark ? markCls : ''].filter(Boolean).join(' ');
    const chunk = esc(text.slice(a, b)).replace(/\t/g, '    ');
    out += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
  }
  return out;
}

function renderScope() {
  const o = fif.o;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.scope === o.scope));
  const extra = $('#scopeExtra');
  if (o.scope === 'directory') {
    extra.innerHTML = `<input id="dir" class="dir" type="text" spellcheck="false" value="${esc(o.directory)}" placeholder="Directory"><button id="browse" class="btn small" title="Browse…">…</button>`;
    const dir = $<HTMLInputElement>('#dir');
    dir.addEventListener('change', () => {
      o.directory = dir.value.trim();
      fif.search(true);
    });
    $('#browse').addEventListener('click', () => send({ type: 'pickDirectory', current: o.directory }));
  } else if (o.scope === 'module') {
    extra.innerHTML = `<select id="module">${modules.map((m) => `<option value="${esc(m)}" ${m === o.module ? 'selected' : ''}>${esc(baseName(m))}</option>`).join('')}</select>`;
    $<HTMLSelectElement>('#module').addEventListener('change', (e) => {
      o.module = (e.target as HTMLSelectElement).value;
      fif.search(true);
    });
  } else if (o.scope === 'scope') {
    const opts: Array<[string, string]> = [
      ['all', 'All Places'],
      ['ignored', 'All Places, Including Ignored Files'],
      ['project', 'Project Files'],
      ['open', 'Open Files'],
      ['current', 'Current File'],
      ['recent', 'Recently Viewed Files'],
    ];
    extra.innerHTML = `<select id="named">${opts.map(([v, l]) => `<option value="${v}" ${v === o.namedScope ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $<HTMLSelectElement>('#named').addEventListener('change', (e) => {
      o.namedScope = (e.target as HTMLSelectElement).value as FindOptions['namedScope'];
      fif.search(true);
    });
  } else extra.innerHTML = '';
}

function renderToggles() {
  const o = fif.o;
  $('#cc').classList.toggle('on', o.matchCase);
  $('#ww').classList.toggle('on', o.words);
  $('#rx').classList.toggle('on', o.regex);
  $('#pin').classList.toggle('on', pinned);
  $<HTMLInputElement>('#maskOn').checked = o.maskEnabled;
  $<HTMLInputElement>('#mask').disabled = !o.maskEnabled;
}

function autoGrow(t: HTMLTextAreaElement) {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 110) + 'px';
}

function initFind(o: FindOptions) {
  const wasFind = mode === 'find';
  mode = 'find';
  fif.o = { ...o };
  if (wasFind) {
    // Popup already open: refresh options and re-run.
    $<HTMLTextAreaElement>('#q').value = o.query;
    $<HTMLTextAreaElement>('#r').value = o.replace;
    $<HTMLInputElement>('#mask').value = o.mask;
    applyReplaceMode();
    renderScope();
    renderToggles();
    const q = $<HTMLTextAreaElement>('#q');
    q.focus();
    q.select();
    fif.search(true);
    return;
  }
  fif.items = [];
  fif.selected = -1;
  document.body.className = document.body.className.replace(/\bmode-\w+/g, '') + ' mode-find';
  const scopes: Array<[string, string, string]> = [['project', 'In Project', 'Alt+P']];
  if (modules.length) scopes.push(['module', 'Module', 'Alt+M']);
  scopes.push(['directory', 'Directory', 'Alt+D'], ['scope', 'Scope', 'Alt+S']);
  app.innerHTML = `
  <div class="popup find">
    <div class="hdr">
      <span class="title" id="title"></span>
      <span class="stats" id="stats"></span>
      <span class="spacer"></span>
      <label class="chk" title="${key('Alt+F')}"><input type="checkbox" id="maskOn"> File mask:</label>
      <div class="combo" id="maskCombo">
        <input id="mask" class="mask" spellcheck="false" autocomplete="off" value="${esc(o.mask)}" title="Comma separated globs, ! to exclude (${key('Alt+Down')} for the list)">
        <button id="maskDrop" class="combo-btn" tabindex="-1" title="Recent and common masks (${key('Alt+Down')})">${CHEVRON_SVG}</button>
        <div id="maskList" class="combo-list" hidden></div>
      </div>
      <button id="pin" class="icon-btn" title="Pin Window (keep open after navigating)">${PIN_SVG}</button>
    </div>
    <div class="scope">
      <div class="seg">${scopes.map(([v, l, k]) => `<button data-scope="${v}" title="${key(k)}">${l}</button>`).join('')}</div>
      <div id="scopeExtra" class="scope-extra"></div>
    </div>
    <div class="field" id="qfield">
      ${SEARCH_SVG}
      <textarea id="q" rows="1" spellcheck="false" placeholder="Text to find"></textarea>
      <div class="toggles">
        <button id="cc" class="tgl" title="Match Case (${key('Alt+C')})">Cc</button>
        <button id="ww" class="tgl" title="Words (${key('Alt+W')})">W</button>
        <button id="rx" class="tgl" title="Regex (${key('Alt+X')})">.*</button>
      </div>
      <span id="qerror" class="qerror"></span>
    </div>
    <div class="field replace-field" id="rfield">
      ${REPLACE_SVG}
      <textarea id="r" rows="1" spellcheck="false" placeholder="Replace with"></textarea>
    </div>
    <div id="results" class="list results" tabindex="-1"></div>
    <div id="splitter" class="splitter"></div>
    <div id="preview" class="preview">
      <div id="previewHdr" class="preview-hdr"></div>
      <div id="code" class="code"></div>
    </div>
    <div class="footer">
      <span class="status-slot">${statusHtml()}</span>
      <span class="hint"><b>${key('Ctrl+Enter')}</b> Open in Find Window · <b>${key('Shift+Enter')}</b> new line · <b>${key('Alt+Enter')}</b> open in split</span>
      <span class="spacer"></span>
      <span id="replaceBtns"><button id="replaceOne" class="btn" title="${key('Alt+R')}">Replace</button><button id="replaceAll" class="btn primary" title="${key('Alt+A')}">Replace All</button></span>
      <button id="openFind" class="btn">Open in Find Window</button>
    </div>
  </div>`;

  const q = $<HTMLTextAreaElement>('#q');
  const r = $<HTMLTextAreaElement>('#r');
  q.value = o.query;
  r.value = o.replace;
  autoGrow(q);
  autoGrow(r);
  applyReplaceMode();
  renderScope();
  renderToggles();
  if (persisted.previewHeight) $('#preview').style.height = persisted.previewHeight + 'px';

  q.addEventListener('input', () => {
    fif.o.query = q.value;
    autoGrow(q);
    fif.search();
  });
  r.addEventListener('input', () => {
    fif.o.replace = r.value;
    autoGrow(r);
    fif.rerenderRows();
    send({ type: 'state', find: fif.o });
  });
  const toggle = (k: 'matchCase' | 'words' | 'regex') => {
    fif.o[k] = !fif.o[k];
    renderToggles();
    fif.search(true);
  };
  $('#cc').addEventListener('click', () => toggle('matchCase'));
  $('#ww').addEventListener('click', () => toggle('words'));
  $('#rx').addEventListener('click', () => toggle('regex'));
  $('#pin').addEventListener('click', () => {
    pinned = !pinned;
    renderToggles();
    send({ type: 'pin', pinned });
  });
  $<HTMLInputElement>('#maskOn').addEventListener('change', (e) => {
    fif.o.maskEnabled = (e.target as HTMLInputElement).checked;
    renderToggles();
    fif.search(true);
  });
  const mask = $<HTMLInputElement>('#mask');
  mask.addEventListener('input', () => {
    fif.o.mask = mask.value;
    if (fif.o.maskEnabled) fif.search();
  });
  setupMaskCombo();
  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      setScope((b as HTMLElement).dataset.scope as FindOptions['scope']);
    }),
  );
  $('#openFind').addEventListener('click', () => send({ type: 'openInFindWindow', options: fif.o }));
  $('#replaceAll').addEventListener('click', () => send({ type: 'replaceAll', options: fif.o }));
  $('#replaceOne').addEventListener('click', () => replaceSelected());

  const results = $('#results');
  results.addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (row) fif.select(Number(row.dataset.i), false);
  });
  results.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (row) fif.open(Number(row.dataset.i), e.altKey);
  });
  $('#code').addEventListener('dblclick', (e) => {
    const line = (e.target as HTMLElement).closest('.cl') as HTMLElement | null;
    const m = fif.items[fif.selected];
    if (line && m) send({ type: 'openFile', path: m.path, line: Number(line.dataset.l), col: 0 });
  });

  // Splitter between the result list and the preview.
  const splitter = $('#splitter');
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const preview = $('#preview');
    const startY = e.clientY;
    const startH = preview.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(60, Math.min(window.innerHeight - 220, startH - (ev.clientY - startY)));
      preview.style.height = h + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persisted.previewHeight = preview.getBoundingClientRect().height;
      vscode.setState(persisted);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map: Record<string, () => void> = {
        c: () => toggle('matchCase'),
        w: () => toggle('words'),
        x: () => toggle('regex'),
        f: () => {
          fif.o.maskEnabled = !fif.o.maskEnabled;
          renderToggles();
          fif.search(true);
        },
        p: () => setScope('project'),
        m: () => modules.length && setScope('module'),
        d: () => setScope('directory'),
        s: () => setScope('scope'),
        a: () => fif.o.replaceMode && send({ type: 'replaceAll', options: fif.o }),
        r: () => fif.o.replaceMode && replaceSelected(),
      };
      const code = (e.code || '').replace(/^Key/, '').toLowerCase();
      const fn = map[code] ?? map[k];
      if (fn) {
        e.preventDefault();
        fn();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        fif.open(fif.selected, true);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send({ type: 'openInFindWindow', options: fif.o });
      return;
    }
    const target = e.target as HTMLElement;
    const inField = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT';
    if (e.key === 'ArrowDown' && (!inField || target.tagName === 'TEXTAREA')) {
      e.preventDefault();
      fif.move(1);
    } else if (e.key === 'ArrowUp' && (!inField || target.tagName === 'TEXTAREA')) {
      e.preventDefault();
      fif.move(-1);
    } else if (e.key === 'PageDown' && target.tagName !== 'SELECT') {
      e.preventDefault();
      fif.move(15);
    } else if (e.key === 'PageUp' && target.tagName !== 'SELECT') {
      e.preventDefault();
      fif.move(-15);
    } else if (e.key === 'Enter' && !e.shiftKey && target.tagName !== 'BUTTON' && target.tagName !== 'SELECT' && target.id !== 'dir' && target.id !== 'mask') {
      e.preventDefault();
      fif.open(fif.selected);
    }
  };
  if (findKeyHandler) document.removeEventListener('keydown', findKeyHandler);
  findKeyHandler = onKey;
  document.addEventListener('keydown', onKey);

  q.focus();
  q.select();
  fif.search(true);
}

/**
 * File mask combo box: like PhpStorm, the arrow always lists *every* entry
 * (your recent masks, then common ones), whatever is currently typed.
 */
function setupMaskCombo() {
  const input = $<HTMLInputElement>('#mask');
  const list = $('#maskList');
  const combo = $('#maskCombo');
  let entries: string[] = [];
  let active = -1;

  const norm = (m: string) => m.replace(/\s*([,;])\s*/g, ', ').trim();
  const isOpen = () => !list.hidden;
  const render = () => {
    const recent = maskHistory.filter((m) => m.trim());
    const recentSet = new Set(recent.map(norm));
    const common = COMMON_MASKS.filter((m) => !recentSet.has(norm(m)));
    entries = [...recent, ...common];
    const current = norm(fif.o.mask);
    const item = (m: string, i: number) =>
      `<div class="combo-item${i === active ? ' active' : ''}${norm(m) === current ? ' current' : ''}" data-i="${i}"><span class="check">${norm(m) === current ? '✓' : ''}</span>${esc(m)}</div>`;
    let html = '';
    if (recent.length) html += `<div class="combo-sep">Recent</div>` + recent.map((m, i) => item(m, i)).join('');
    html += `<div class="combo-sep">Common</div>` + common.map((m, k) => item(m, recent.length + k)).join('');
    list.innerHTML = html;
    list.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    active = -1;
    list.hidden = false;
    render();
    const cur = entries.findIndex((m) => norm(m) === norm(fif.o.mask));
    if (cur >= 0) {
      active = cur;
      render();
    }
  };
  const close = () => {
    if (!isOpen()) return false;
    list.hidden = true;
    return true;
  };
  const choose = (i: number) => {
    const m = entries[i];
    if (m === undefined) return;
    fif.o.mask = m;
    input.value = m;
    fif.o.maskEnabled = true; // picking a mask turns the filter on, as in PhpStorm
    renderToggles();
    close();
    fif.search(true);
    $<HTMLTextAreaElement>('#q').focus();
  };
  closeDropdown = close;

  $('#maskDrop').addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (isOpen()) close();
    else open();
  });
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const it = (e.target as HTMLElement).closest('.combo-item') as HTMLElement | null;
    if (it) choose(Number(it.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const it = (e.target as HTMLElement).closest('.combo-item') as HTMLElement | null;
    if (it && Number(it.dataset.i) !== active) {
      active = Number(it.dataset.i);
      render();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !combo.contains(e.target as Node)) close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!isOpen()) {
        open();
        return;
      }
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen() && active >= 0) choose(active);
      else {
        close();
        $<HTMLTextAreaElement>('#q').focus();
      }
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input) close();
  }, 100));
}

function setScope(scope: FindOptions['scope']) {
  fif.o.scope = scope;
  if (scope === 'module' && !fif.o.module) fif.o.module = modules[0] ?? '';
  renderScope();
  fif.search(true);
  if (scope === 'directory' && !fif.o.directory) $<HTMLInputElement>('#dir')?.focus();
}

function replaceSelected() {
  const m = fif.items[fif.selected];
  if (!m) return;
  send({ type: 'replaceOne', options: fif.o, match: m });
}

function applyReplaceMode() {
  const on = fif.o.replaceMode;
  $('#title').textContent = on ? 'Replace in Files' : 'Find in Files';
  $('#rfield').style.display = on ? '' : 'none';
  $('#replaceBtns').style.display = on ? '' : 'none';
}

// ------------------------------------------------------------------ icons

const SEARCH_SVG = `<svg class="ficon-svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 10l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const REPLACE_SVG = `<svg class="ficon-svg" viewBox="0 0 16 16" width="16" height="16"><path d="M3 5h8l-2.5-2.5M13 11H5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PIN_SVG = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M9.5 1.5l5 5-1.4.6-2.6 2.6.2 3.3-1.2 1.2-3-3-3.5 3.5-.8-.8L5.7 10.4l-3-3L3.9 6.2l3.3.2L9.8 3.8z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

send({ type: 'ready' });
