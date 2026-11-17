// Kept apart from analyze.ts so that the extension host does not bundle the TypeScript compiler.

/** Does the source start with the 'use client' directive (after a BOM, a shebang and comments)? */
export function hasUseClient(source: string): boolean {
  const s = source.replace(/^﻿/, '').replace(/^#![^\n]*\n/, '');
  return /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(['"])use client\1/.test(s);
}
