import * as vscode from 'vscode';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { WorkerEvent, WorkerRequest, WorkerSettings, FileTuple, ReplaceEdit } from './worker';
import type { FileHit, IndexStatus, LineMatch, ResolvedScope, SymbolHit, TextQuery, TextSearchStats } from '../shared/protocol';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onBatch?: (items: LineMatch[], done: boolean, stats?: TextSearchStats, error?: string) => void;
};

const DEAD_MESSAGE = 'The index worker keeps crashing and was stopped. See the "Storm" output channel, then reload the window.';

// Distributive Omit so that discriminated unions keep working.
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface TextSearchHandle {
  cancel(): void;
  done: Promise<void>;
}

/** Thin RPC wrapper around the index worker thread. */
export class IndexClient implements vscode.Disposable {
  private worker!: Worker;
  private nextId = 1;
  private disposed = false;
  /** The worker crashed too often and was not restarted. */
  private dead = false;
  private settings: WorkerSettings | undefined;
  private restarts: number[] = [];
  private readonly restartEmitter = new vscode.EventEmitter<void>();
  /** Fired after the worker crashed and was restarted: the file list must be sent again. */
  readonly onRestart = this.restartEmitter.event;
  private pending = new Map<number, Pending>();
  private readonly statusEmitter = new vscode.EventEmitter<IndexStatus>();
  readonly onStatus = this.statusEmitter.event;
  status: IndexStatus = { state: 'starting', totalFiles: 0, indexedFiles: 0, pendingFiles: 0, trigrams: 0, symbols: 0 };

  constructor(private readonly extensionPath: string, private readonly log: vscode.OutputChannel) {
    this.spawn();
  }

  private spawn() {
    const w = new Worker(path.join(this.extensionPath, 'dist', 'worker.js'));
    this.worker = w;
    w.on('message', (e: WorkerEvent) => this.onMessage(e));
    w.on('error', (e) => this.log.appendLine(`[worker] error: ${e.stack ?? e}`));
    w.on('exit', (code) => {
      if (this.disposed || w !== this.worker) return;
      this.log.appendLine(`[worker] exited unexpectedly with code ${code}`);
      // Never leave a search spinning: complete or reject everything that was in flight.
      for (const p of this.pending.values()) {
        if (p.onBatch) {
          p.onBatch([], true, undefined, 'The index worker stopped unexpectedly and is restarting. Please search again.');
          p.resolve(undefined);
        } else p.reject(new Error('index worker stopped'));
      }
      this.pending.clear();
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60000);
      if (this.restarts.length >= 3) {
        // Given up: later requests fail at once instead of waiting for a worker that is gone.
        this.dead = true;
        vscode.window.showErrorMessage('Storm: the index worker keeps crashing. See the "Storm" output channel.');
        return;
      }
      this.restarts.push(now);
      this.spawn();
      if (this.settings) this.worker.postMessage({ type: 'init', settings: this.settings } satisfies WorkerRequest);
      this.restartEmitter.fire();
    });
  }

  private onMessage(e: WorkerEvent) {
    switch (e.type) {
      case 'status':
        this.status = e.status;
        this.statusEmitter.fire(e.status);
        break;
      case 'log':
        this.log.appendLine(`[worker] ${e.message}`);
        break;
      case 'result': {
        const p = this.pending.get(e.id);
        if (!p) return;
        this.pending.delete(e.id);
        if (e.error) p.reject(new Error(e.error));
        else p.resolve(e.payload);
        break;
      }
      case 'textBatch': {
        const p = this.pending.get(e.id);
        if (!p) return;
        p.onBatch?.(e.items, e.done, e.stats, e.error);
        if (e.done) {
          this.pending.delete(e.id);
          p.resolve(undefined);
        }
        break;
      }
    }
  }

  send(msg: WorkerRequest) {
    this.worker.postMessage(msg);
  }

  private request<T>(msg: WithoutId<WorkerRequest>): Promise<T> {
    const id = this.nextId++;
    if (this.dead) return Promise.reject(new Error(DEAD_MESSAGE));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  init(settings: WorkerSettings) {
    this.settings = settings;
    this.send({ type: 'init', settings });
  }

  updateSettings(settings: WorkerSettings) {
    this.settings = settings;
    this.send({ type: 'settings', settings });
  }

  setFiles(files: FileTuple[]) {
    this.send({ type: 'setFiles', files });
  }

  searchFiles(pattern: string, includeLib: boolean, limit: number, recent: string[]) {
    return this.request<FileHit[]>({ type: 'searchFiles', pattern, includeLib, limit, recent });
  }

  searchSymbols(pattern: string, classesOnly: boolean, includeLib: boolean, limit: number) {
    return this.request<SymbolHit[]>({ type: 'searchSymbols', pattern, classesOnly, includeLib, limit });
  }

  recentFiles(recent: string[], limit: number, exclude?: string) {
    return this.request<FileHit[]>({ type: 'recentFiles', recent, limit, exclude });
  }

  computeReplace(query: TextQuery, scope: ResolvedScope, replacement: string, onlyPath?: string, onlyLine?: number) {
    return this.request<Array<{ path: string; edits: ReplaceEdit[] }>>({ type: 'computeReplace', query, scope, replacement, onlyPath, onlyLine });
  }

  /** Streams text matches. Cancelling stops the worker loop as soon as it yields. */
  searchText(
    query: TextQuery,
    scope: ResolvedScope,
    limit: number,
    onBatch: (items: LineMatch[], done: boolean, stats?: TextSearchStats, error?: string) => void,
  ): TextSearchHandle {
    const id = this.nextId++;
    if (this.dead) {
      queueMicrotask(() => onBatch([], true, undefined, DEAD_MESSAGE));
      return { done: Promise.resolve(), cancel: () => undefined };
    }
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject, onBatch });
    });
    this.worker.postMessage({ type: 'searchText', id, query, scope, limit } satisfies WorkerRequest);
    return {
      done,
      cancel: () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
        p.resolve(undefined);
      },
    };
  }

  async flush(timeoutMs = 3000) {
    if (this.dead) return;
    const id = this.nextId++;
    await Promise.race([
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'flush', id } satisfies WorkerRequest);
      }),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    this.statusEmitter.dispose();
    this.restartEmitter.dispose();
  }
}
