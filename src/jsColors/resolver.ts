// Resolves JS/TS import specifiers to files and tells whether they are 'use client' modules.
// Relative paths, tsconfig/jsconfig "paths" (with "baseUrl", "extends" and "references", as in
// Vite projects) and packages in node_modules. Results are cached by file modification time.

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import { hasUseClient } from './directive';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];

interface PathsConfig {
  /** Directory the "paths" targets are relative to. */
  base: string;
  paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }>;
}

function statMtime(file: string): number | undefined {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, any> | undefined {
  try {
    return parse(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true }) ?? undefined;
  } catch {
    return undefined;
  }
}

export class ModuleResolver {
  private configCache = new Map<string, { mtime: number; config: PathsConfig | null }>();
  private dirConfig = new Map<string, string | null>();
  private clientCache = new Map<string, { mtime: number; client: boolean }>();
  /** "directory|specifier" → resolved file (undefined: not found). */
  private resolveCache = new Map<string, string | undefined>();

  /** Forgets everything (a tsconfig / jsconfig was created, changed or deleted). */
  clear() {
    this.configCache.clear();
    this.dirConfig.clear();
    this.clientCache.clear();
    this.resolveCache.clear();
  }

  /** Forgets the resolved paths only (files may have been created, renamed or deleted). */
  forgetResolutions() {
    this.resolveCache.clear();
  }

  /** Is `spec`, imported from `fromFile`, a module starting with 'use client'? */
  isClientModule(fromFile: string, spec: string): boolean {
    const file = this.resolve(fromFile, spec);
    if (!file) return false;
    const mtime = statMtime(file);
    if (mtime === undefined) return false;
    const cached = this.clientCache.get(file);
    if (cached && cached.mtime === mtime) return cached.client;
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      /* unreadable: not a client module */
    }
    const client = hasUseClient(head);
    this.clientCache.set(file, { mtime, client });
    return client;
  }

  resolve(fromFile: string, spec: string): string | undefined {
    const dir = path.dirname(fromFile);
    const key = dir + '|' + spec;
    if (this.resolveCache.has(key)) return this.resolveCache.get(key);
    const file = this.resolveUncached(dir, spec);
    this.resolveCache.set(key, file);
    return file;
  }

  private resolveUncached(dir: string, spec: string): string | undefined {
    if (spec.startsWith('.') || path.isAbsolute(spec)) return this.asFile(path.resolve(dir, spec));
    const cfg = this.pathsConfig(dir);
    if (cfg) {
      for (const p of cfg.paths) {
        let star: string | undefined;
        if (p.wildcard) {
          if (spec.length < p.prefix.length + p.suffix.length || !spec.startsWith(p.prefix) || !spec.endsWith(p.suffix)) continue;
          star = spec.slice(p.prefix.length, spec.length - p.suffix.length);
        } else if (spec !== p.prefix) continue;
        for (const t of p.targets) {
          const f = this.asFile(path.resolve(cfg.base, star === undefined ? t : t.replace('*', star)));
          if (f) return f;
        }
      }
    }
    return this.fromNodeModules(dir, spec);
  }

  /** `file`, `file.tsx`…, `file/index.tsx`… */
  private asFile(p: string): string | undefined {
    if (statMtime(p) !== undefined) return p;
    for (const ext of EXTENSIONS) if (statMtime(p + ext) !== undefined) return p + ext;
    for (const ext of EXTENSIONS) {
      const f = path.join(p, 'index' + ext);
      if (statMtime(f) !== undefined) return f;
    }
    return undefined;
  }

  private fromNodeModules(dir: string, spec: string): string | undefined {
    const parts = spec.split('/');
    const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = spec.slice(pkg.length + 1);
    for (let d = dir; ; d = path.dirname(d)) {
      const root = path.join(d, 'node_modules', pkg);
      if (fs.existsSync(root)) {
        if (sub) return this.asFile(path.join(root, sub));
        const pj = readJson(path.join(root, 'package.json'));
        const entry = typeof pj?.module === 'string' ? pj.module : typeof pj?.main === 'string' ? pj.main : 'index';
        return this.asFile(path.join(root, entry));
      }
      if (path.dirname(d) === d) return undefined;
    }
  }

  /** "paths" of the nearest tsconfig.json / jsconfig.json above `dir`. */
  private pathsConfig(dir: string): PathsConfig | null {
    let file = this.dirConfig.get(dir);
    if (file === undefined) {
      file = null;
      for (let d = dir; ; d = path.dirname(d)) {
        const ts = path.join(d, 'tsconfig.json');
        const js = path.join(d, 'jsconfig.json');
        if (fs.existsSync(ts)) file = ts;
        else if (fs.existsSync(js)) file = js;
        if (file || path.dirname(d) === d || fs.existsSync(path.join(d, 'package.json'))) break;
      }
      this.dirConfig.set(dir, file);
    }
    return file ? this.loadConfig(file) : null;
  }

  private loadConfig(file: string, depth = 0): PathsConfig | null {
    const mtime = statMtime(file);
    if (mtime === undefined || depth > 5) return null;
    const cached = this.configCache.get(file);
    if (cached && cached.mtime === mtime) return cached.config;
    const json = readJson(file) ?? {};
    const dir = path.dirname(file);
    let config: PathsConfig | null = null;
    const opts = json.compilerOptions ?? {};
    if (opts.paths && typeof opts.paths === 'object') {
      const base = path.resolve(dir, typeof opts.baseUrl === 'string' ? opts.baseUrl : '.');
      config = { base, paths: [] };
      for (const [key, targets] of Object.entries(opts.paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const star = key.indexOf('*');
        config.paths.push({
          prefix: star >= 0 ? key.slice(0, star) : key,
          suffix: star >= 0 ? key.slice(star + 1) : '',
          wildcard: star >= 0,
          targets: targets.filter((t): t is string => typeof t === 'string'),
        });
      }
      // longest prefix first, as TypeScript does
      config.paths.sort((a, b) => b.prefix.length - a.prefix.length);
    }
    // Vite / solution-style configs keep "paths" in an extended or referenced config.
    if (!config && typeof json.extends === 'string' && json.extends.startsWith('.')) {
      config = this.loadConfig(path.resolve(dir, json.extends.endsWith('.json') ? json.extends : json.extends + '.json'), depth + 1);
    }
    if (!config && Array.isArray(json.references)) {
      for (const r of json.references) {
        if (typeof r?.path !== 'string') continue;
        let ref = path.resolve(dir, r.path);
        if (!ref.endsWith('.json')) ref = path.join(ref, 'tsconfig.json');
        config = this.loadConfig(ref, depth + 1);
        if (config) break;
      }
    }
    this.configCache.set(file, { mtime, config });
    return config;
  }
}
