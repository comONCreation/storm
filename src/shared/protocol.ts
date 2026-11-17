// Types shared between the extension host, the index worker and the webview.

import type { TokenColors } from './tokenTheme';
export type { TokenColors } from './tokenTheme';

export type SymbolKind =
  | 'class' | 'interface' | 'trait' | 'enum' | 'struct' | 'type' | 'module' | 'namespace'
  | 'function' | 'method' | 'field' | 'constant' | 'property';

export const CLASS_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['class', 'interface', 'trait', 'enum', 'struct', 'type', 'module']);

export interface TextQuery {
  query: string;
  matchCase: boolean;
  words: boolean;
  regex: boolean;
}

export type FindScopeKind = 'project' | 'module' | 'directory' | 'scope';
export type NamedScope = 'all' | 'ignored' | 'project' | 'open' | 'current' | 'recent';

export interface FindOptions extends TextQuery {
  replace: string;
  replaceMode: boolean;
  maskEnabled: boolean;
  mask: string;
  scope: FindScopeKind;
  directory: string;
  module: string;
  namedScope: NamedScope;
}

/** Scope resolved by the extension host before being sent to the worker. */
export interface ResolvedScope {
  includeLibraries: boolean;
  /** Absolute directory prefix (normalised with forward slashes, lower-cased on Windows). */
  dirPrefix?: string;
  /** Explicit list of absolute paths (open files, current file, recent files). */
  paths?: string[];
  mask?: string;
  /** Files ignored by git (not indexed) to search too: [absolute path, relative path, library]. */
  extraFiles?: Array<[string, string, boolean]>;
}

/** One matching line. Several occurrences on the same line are merged. */
export interface LineMatch {
  path: string;
  rel: string;
  lib: boolean;
  /** 0-based line of the first occurrence. */
  line: number;
  /** Displayed (possibly clipped) line text. */
  text: string;
  /** Offset of `text` in the real line (when clipped on the left). */
  textOffset: number;
  /** Flat list of [start, end) ranges in `text`. */
  ranges: number[];
  /** Real position of the first occurrence (for navigation). */
  col: number;
  endLine: number;
  endCol: number;
  /** Number of occurrences on this line. */
  count: number;
}

export interface TextSearchStats {
  matches: number;
  lines: number;
  files: number;
  truncated: boolean;
  searchedFiles: number;
  durationMs: number;
}

export interface FileHit {
  path: string;
  rel: string;
  name: string;
  dir: string;
  lib: boolean;
  score: number;
  /** Highlighted ranges in name. */
  hl: number[];
  /** Highlighted ranges in dir. */
  dirHl?: number[];
  line?: number;
  col?: number;
}

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  container: string;
  path: string;
  rel: string;
  lib: boolean;
  line: number;
  col: number;
  score: number;
  hl: number[];
}

export interface ActionHit {
  id: string;
  title: string;
  category: string;
  score: number;
  hl: number[];
}

export interface IndexStatus {
  state: 'starting' | 'scanning' | 'indexing' | 'ready';
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  trigrams: number;
  symbols: number;
}

export type EverywhereTab = 'all' | 'classes' | 'files' | 'symbols' | 'actions' | 'text';

export interface EverywhereGroup {
  kind: 'classes' | 'files' | 'symbols' | 'actions' | 'text' | 'recent';
  items: Array<FileHit | SymbolHit | ActionHit | LineMatch>;
  more: boolean;
}

// ---------- Webview <-> extension host messages ----------

export type ToHost =
  | { type: 'ready' }
  | { type: 'everywhere'; seq: number; tab: EverywhereTab; query: string; includeNonProject: boolean }
  | { type: 'find'; seq: number; options: FindOptions }
  | { type: 'preview'; path: string }
  | { type: 'openFile'; path: string; line?: number; col?: number; endLine?: number; endCol?: number; split?: boolean }
  | { type: 'runAction'; id: string }
  | { type: 'openInFindWindow'; options: FindOptions }
  | { type: 'replaceOne'; options: FindOptions; match: LineMatch }
  | { type: 'replaceAll'; options: FindOptions }
  | { type: 'pickDirectory'; current: string }
  | { type: 'pin'; pinned: boolean }
  | { type: 'state'; everywhere?: { tab: EverywhereTab; query: string; includeNonProject: boolean }; find?: FindOptions }
  | { type: 'close' };

export type ToWebview =
  | { type: 'init'; mode: 'everywhere' | 'find'; tab?: EverywhereTab; query?: string; includeNonProject?: boolean; find?: FindOptions; modules: string[]; platform: string; pinned: boolean; status: IndexStatus; maskHistory?: string[]; tokenColors?: TokenColors | null }
  | { type: 'everywhereResults'; seq: number; tab: EverywhereTab; groups: EverywhereGroup[]; done: boolean }
  | { type: 'findResults'; seq: number; items: LineMatch[]; reset: boolean; done: boolean; stats?: TextSearchStats; error?: string }
  | { type: 'preview'; path: string; rel: string; content: string; languageId: string; error?: string }
  | { type: 'directoryPicked'; directory: string }
  | { type: 'status'; status: IndexStatus }
  | { type: 'tokenColors'; colors: TokenColors | null }
  | { type: 'focus' };
