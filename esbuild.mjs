import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = [
  // Extension host (Node)
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'],
    // jsonc-parser's UMD build uses dynamic requires that esbuild cannot follow: use its ESM build.
    mainFields: ['module', 'main'] },
  // Index worker thread (Node)
  { ...common, entryPoints: ['src/index/worker.ts'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs', target: 'node18' },
  // Webview (browser)
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2020' },
];

if (process.argv.includes('--tests')) {
  builds.push({ ...common, sourcemap: false, entryPoints: ['test/unit.test.ts', 'test/worker.test.ts'], outdir: 'out-test', platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning' });
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
