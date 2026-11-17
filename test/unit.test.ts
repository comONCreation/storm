import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, fuzzyMatch } from '../src/shared/fuzzy';
import { requiredLiterals, buildRegExp, compileMask, globToRegExp, expandReplacement } from '../src/shared/query';
import { trigramsOf, queryTrigrams } from '../src/index/trigram';
import { intersect, PostingStore } from '../src/index/postings';
import { extractSymbols } from '../src/index/symbols';
import { resolveTokenColors, applyCustomizations } from '../src/shared/tokenTheme';
import { IgnoreMatcher } from '../src/index/gitignore';
import { analyze } from '../src/jsColors/analyze';
import { hasUseClient } from '../src/jsColors/directive';

const rank = (pattern: string, names: string[]) => {
  const cp = compilePattern(pattern);
  return names
    .map((n) => ({ n, r: fuzzyMatch(cp, n) }))
    .filter((x) => x.r)
    .sort((a, b) => b.r!.score - a.r!.score)
    .map((x) => x.n);
};

test('fuzzy: camel humps', () => {
  assert.ok(fuzzyMatch(compilePattern('UsCo'), 'UserController'));
  assert.ok(fuzzyMatch(compilePattern('uco'), 'UserController'));
  assert.ok(fuzzyMatch(compilePattern('user con'), 'UserController'));
  assert.ok(fuzzyMatch(compilePattern('HTTPS'), 'HTTPServer'));
  assert.equal(fuzzyMatch(compilePattern('xyz'), 'UserController'), null);
});

test('fuzzy: ranking prefers exact / prefix / word starts', () => {
  const names = ['AbstractUserControllerTest', 'UserController', 'UserControllerTest', 'SuperUseCase', 'UsersController'];
  const r = rank('UserController', names);
  assert.equal(r[0], 'UserController');
  const r2 = rank('UsCo', ['ConsumerScope', 'UserController', 'UseCase']);
  assert.equal(r2[0], 'UserController');
});

test('fuzzy: wildcard and ranges', () => {
  const m = fuzzyMatch(compilePattern('*troller'), 'UserController');
  assert.ok(m);
  assert.deepEqual(m!.ranges, [7, 14]);
  const m2 = fuzzyMatch(compilePattern('UC'), 'UserController');
  assert.deepEqual(m2!.ranges, [0, 1, 4, 5]);
  assert.equal(fuzzyMatch(compilePattern('User '), 'UserController'), null);
  assert.ok(fuzzyMatch(compilePattern('Controller '), 'UserController'));
});

test('regex literal extraction', () => {
  assert.deepEqual(requiredLiterals({ query: 'function\\s+index', matchCase: false, words: false, regex: true }), ['function', 'index']);
  assert.deepEqual(requiredLiterals({ query: 'foo|bar', matchCase: false, words: false, regex: true }), []);
  assert.deepEqual(requiredLiterals({ query: 'colou?r', matchCase: false, words: false, regex: true }), ['colo']);
  assert.deepEqual(requiredLiterals({ query: '(get|set)Value\\(', matchCase: false, words: false, regex: true }), ['Value(']);
  assert.deepEqual(requiredLiterals({ query: 'a[bc]+defg', matchCase: false, words: false, regex: true }), ['defg']);
  assert.deepEqual(requiredLiterals({ query: '\\$this->user', matchCase: false, words: false, regex: true }), ['$this->user']);
  assert.deepEqual(requiredLiterals({ query: 'ab', matchCase: false, words: false, regex: false }), []);
});

test('buildRegExp: words, case, multiline literal', () => {
  const re = buildRegExp({ query: 'user', matchCase: false, words: true, regex: false });
  assert.equal('$user = new User(); username'.match(re)?.length, 2);
  const cs = buildRegExp({ query: 'User', matchCase: true, words: false, regex: false });
  assert.equal('user User'.match(cs)?.length, 1);
  const ml = buildRegExp({ query: 'a\nb', matchCase: false, words: false, regex: false });
  assert.ok(ml.test('x a\r\nb y'));
  const dot = buildRegExp({ query: 'a.b(', matchCase: false, words: false, regex: false });
  assert.ok(dot.test('a.b('));
  assert.ok(!buildRegExp({ query: 'a.b(', matchCase: false, words: false, regex: false }).test('axb('));
});

test('default excludes: Laravel logs and debug dumps', () => {
  const defaults: string[] = require('../package.json').contributes.configuration.properties['storm.exclude'].default;
  const res = defaults.map((g) => globToRegExp(g));
  const excluded = (rel: string) => res.some((r) => r.test(rel));
  for (const rel of ['storage/logs/laravel.log', 'storage/logs/worker-2026-11-16.log', 'storage/debugbar/01J.json', 'storage/inertia-devtools/x.json', 'storage/clockwork/1.json', 'storage/framework/views/a.php']) {
    assert.ok(excluded(rel), rel);
  }
  for (const rel of ['storage/app/public/report.json', 'app/Logging/LogFormatter.php', 'config/logging.php']) assert.ok(!excluded(rel), rel);
});

test('default exclude: Claude Code worktrees', () => {
  const re = globToRegExp('**/.claude/worktrees/**');
  assert.ok(re.test('.claude/worktrees/confident-hodgkin-ec0bec/app/Actions/Mailbox/CreateArticleFromMailAttachment.php'));
  assert.ok(re.test('sub/.claude/worktrees/x/a.php'));
  assert.ok(!re.test('.claude/settings.json'));
  assert.ok(!re.test('app/worktrees/a.php'));
});

test('file mask', () => {
  const m = compileMask('*.php, !*.blade.php')!;
  assert.ok(m('app/User.php', 'User.php'));
  assert.ok(!m('resources/views/a.blade.php', 'a.blade.php'));
  assert.ok(!m('a.js', 'a.js'));
  const p = compileMask('src/**/*.ts')!;
  assert.ok(p('src/a/b/c.ts', 'c.ts'));
  assert.ok(p('src/c.ts', 'c.ts'));
  assert.ok(!p('test/c.ts', 'c.ts'));
});

test('trigrams: query trigrams are contained in text trigrams', () => {
  const text = 'public function indexAction(Request $request)';
  const set = new Set(trigramsOf(text));
  for (const t of queryTrigrams('INDEXACTION')) assert.ok(set.has(t));
  assert.ok(!set.has(queryTrigrams('zzz')[0]));
  assert.deepEqual(Array.from(intersect([Uint32Array.from([1, 3, 5, 7, 9]), Uint32Array.from([3, 4, 5, 9, 10])])), [3, 5, 9]);
});

test('symbols: php', () => {
  const src = `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;

#[Attribute]
final class UserController extends Controller implements HasMiddleware
{
    public const ROLE = 'admin';
    private ?string $name = null;
    protected static array $cache = [];

    public function index(Request $request): Response
    {
        $fn = function ($x) { return $x; };
        if ($request->has('q')) { return view('x'); }
    }

    private static function build() {}
}

interface Greeter
{
    public function greet(): string;
}
trait Loggable {
    protected function log($m) {}
}
enum Status: string {
    case Active = 'a';
    case Inactive = 'i';
}
function helper() {}
define('APP_VERSION', '1.0');
`;
  const syms = extractSymbols('UserController.php', src);
  const names = syms.map((s) => `${s.kind}:${s.name}${s.container ? '@' + s.container : ''}`);
  assert.deepEqual(names, [
    'class:UserController@App\\Http\\Controllers',
    'constant:ROLE@UserController',
    'field:name@UserController',
    'field:cache@UserController',
    'method:index@UserController',
    'method:build@UserController',
    'interface:Greeter@App\\Http\\Controllers',
    'method:greet@Greeter',
    'trait:Loggable@App\\Http\\Controllers',
    'method:log@Loggable',
    'enum:Status@App\\Http\\Controllers',
    'constant:Active@Status',
    'constant:Inactive@Status',
    'function:helper@App\\Http\\Controllers',
    'constant:APP_VERSION@App\\Http\\Controllers',
  ]);
});

test('symbols: typescript', () => {
  const src = `export interface Options {
  name: string;
}
export type Id = string | number;
export class Service {
  private readonly cache = new Map();
  constructor(private http: Http) {}
  async fetchAll(): Promise<void> {
    if (x) { call(); }
  }
  get size() { return 1; }
}
export function helper(a: number) {}
export const handler = async (req) => {};
const MAX = 10;
`;
  const syms = extractSymbols('service.ts', src).map((s) => `${s.kind}:${s.name}`);
  assert.deepEqual(syms, [
    'interface:Options',
    'field:name',
    'type:Id',
    'class:Service',
    'field:cache',
    'method:constructor',
    'method:fetchAll',
    'method:size',
    'function:helper',
    'function:handler',
    'constant:MAX',
  ]);
});

test('symbols: python', () => {
  const src = `MAX_SIZE = 3
class Foo(Base):
    def bar(self):
        def inner(): pass
    async def baz(self): ...
def top(): pass
`;
  assert.deepEqual(
    extractSymbols('a.py', src).map((s) => `${s.kind}:${s.name}@${s.container}`),
    ['constant:MAX_SIZE@', 'class:Foo@', 'method:bar@Foo', 'method:inner@bar', 'method:baz@Foo', 'function:top@'],
  );
});

test('postings: compressed store, rebuild and serialisation', () => {
  const st = new PostingStore();
  const add = (id: number, ...tris: number[]) => st.addDoc(id, Uint32Array.from(tris));
  // base: trigram 1 in every file, trigram 2 in every 7th file, trigram 0xFFFFFF in file 3
  for (let id = 0; id < 1000; id++) add(id, ...(id % 7 === 0 ? [1, 2] : [1]), ...(id === 3 ? [0xffffff] : []));
  assert.equal(st.ids(2).length, 143, 'lookups work before any rebuild (delta only)');
  st.rebuild(Int32Array.from({ length: 1000 }, (_, i) => i));
  assert.equal(st.pendingDocs, 0);
  assert.deepEqual(Array.from(st.ids(0xffffff)), [3]);
  // delta: new files 1000..1009 containing trigram 2, one of them a brand new trigram 5
  for (let id = 1000; id < 1010; id++) add(id, 2, ...(id === 1005 ? [5] : []));
  assert.deepEqual(Array.from(st.ids(2)).slice(-12), [987, 994, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009]);
  assert.deepEqual(Array.from(st.ids(5)), [1005]);
  assert.equal(st.ids(1).length, 1000);
  assert.equal(st.ids(3).length, 0);
  // drop every even file of the base, keep the delta
  const remap = new Int32Array(1010).fill(-1);
  let k = 0;
  for (let id = 0; id < 1010; id++) if (id % 2 === 1 || id >= 1000) remap[id] = k++;
  st.rebuild(remap);
  assert.equal(st.ids(1).length, 500);
  assert.deepEqual(Array.from(st.ids(5)), [remap[1005]]);
  assert.deepEqual(Array.from(st.ids(0xffffff)), [remap[3]]);
  const ids2 = Array.from(st.ids(2));
  assert.equal(ids2.length, 71 + 10);
  assert.ok(ids2.every((v, i) => i === 0 || v > ids2[i - 1]), 'sorted');
  // round-trip through a buffer with a non-aligned header in front
  const buf = Buffer.concat([Buffer.alloc(3), ...st.serialize()]);
  const st2 = new PostingStore();
  st2.load(buf, 3);
  assert.deepEqual(Array.from(st2.ids(2)), ids2);
  assert.deepEqual(Array.from(st2.ids(1)), Array.from(st.ids(1)));
  assert.equal(st2.trigramCount, st.trigramCount);
  // large ids (multi-byte varints) survive a rebuild
  const st3 = new PostingStore();
  const big = [5, 300000, 2 ** 21];
  for (const id of big) st3.addDoc(id, Uint32Array.of(9));
  const ident = new Int32Array(2 ** 21 + 1).fill(-1);
  for (const id of big) ident[id] = id;
  st3.rebuild(ident);
  assert.deepEqual(Array.from(st3.ids(9)), big);
});

test('token colours: theme rules, specificity and customisations', () => {
  const rules = [
    { scope: ['keyword', 'storage.type'], settings: { foreground: '#111111' } },
    { scope: 'keyword.control', settings: { foreground: '#222222' } },
    { scope: 'comment', settings: { foreground: '#333333', fontStyle: 'italic' } },
    { scope: 'string, string.quoted', settings: { foreground: '#444444' } },
    { scope: 'source.php variable', settings: { foreground: '#ff0000' } }, // descendant selector: ignored
    { scope: 'variable', settings: { foreground: '#555555' } },
    { scope: 'string', settings: { foreground: '#666666' } }, // later rule wins a tie on "string"…
  ];
  const c = resolveTokenColors(rules);
  assert.equal(c.kc?.fg, '#222222');
  assert.equal(c.k?.fg, '#111111');
  assert.equal(c.c?.fg, '#333333');
  assert.equal(c.c?.italic, true);
  assert.equal(c.s?.fg, '#444444', '…but "string.quoted" is more specific for quoted strings');
  assert.equal(c.v?.fg, '#555555');
  assert.equal(c.f, undefined, 'no rule: falls back to the editor foreground');
  const { rules: all, overrides } = applyCustomizations(rules, {
    comments: '#abcdef',
    '[My Theme]': { keywords: { foreground: '#00ff00', fontStyle: 'bold' }, textMateRules: [{ scope: 'entity.name.function', settings: { foreground: '#0000ff' } }] },
    '[Other Theme]': { strings: '#999999' },
  }, ['My Theme']);
  assert.equal(resolveTokenColors(all).f?.fg, '#0000ff');
  assert.deepEqual(overrides.c, { fg: '#abcdef' });
  assert.equal(overrides.k?.fg, '#00ff00');
  assert.equal(overrides.kc?.bold, true);
  assert.equal(overrides.s, undefined, 'blocks of other themes are ignored');
});

test('gitignore: patterns, anchoring, directories, negation and nested files', () => {
  const m = new IgnoreMatcher(false);
  m.add('', [
    '# comment',
    '/build',
    'node_modules/',
    '*.log',
    '!keep.log',
    'docs/**/*.tmp',
    'cache/',
    '!cache/keep.txt',
    '\\#hash',
    'trailing   ',
    'out/**',
    '**/gen/*.php',
    'Thumbs.db',
    'a?c.txt',
    '[Dd]ebug/',
  ].join('\n'));
  m.add('sub', '*.cache\n/local.txt\n!important.log\n');
  const yes = (p: string) => assert.equal(m.ignores(p), true, p);
  const no = (p: string) => assert.equal(m.ignores(p), false, p);
  yes('build/app.js');
  yes('build/deep/x.css');
  no('src/build/app.js'); // "/build" is anchored to the root
  yes('node_modules/x/index.js');
  yes('src/node_modules/x/index.js'); // no slash: any depth
  yes('error.log');
  yes('src/deep/error.log');
  no('keep.log');
  no('src/keep.log');
  yes('docs/a/b/c.tmp');
  yes('docs/c.tmp');
  no('other/c.tmp');
  yes('cache/keep.txt'); // inside an ignored directory: "!" cannot re-include it
  yes('#hash');
  yes('trailing');
  yes('out/a/b.txt');
  yes('x/gen/A.php');
  yes('gen/A.php');
  no('x/gen/sub/A.php');
  yes('src/Thumbs.db');
  yes('abc.txt');
  no('abbc.txt');
  yes('Debug/x.dll');
  yes('src/debug/x.dll');
  no('debug'); // "[Dd]ebug/" only matches directories
  yes('sub/a/b.cache');
  no('b.cache');
  yes('sub/local.txt');
  no('sub/a/local.txt');
  no('sub/important.log'); // the deeper file re-includes it
  yes('sub/other.log');
  assert.equal(m.ignores('build', true), true);
  assert.equal(m.ignores('src', true), false);
  const ci = new IgnoreMatcher(true);
  ci.add('', '/Build\n');
  assert.equal(ci.ignores('build/x.js'), true, 'case-insensitive on Windows');
  assert.equal(new IgnoreMatcher(false).ignores('anything'), false);
});

test('replacement: $n, $&, named groups, escapes, and lookarounds in context', () => {
  const re = buildRegExp({ query: '(?<=\\$)(?<n>\\w+)', matchCase: true, words: false, regex: true });
  const line = 'echo $name;';
  re.lastIndex = 6;
  const m = re.exec(line)!;
  assert.equal(m.index, 6, 'the lookbehind sees the "$" before the match on the whole line');
  assert.equal(expandReplacement('get_$1', m), 'get_name');
  assert.equal(expandReplacement('[$&|$<n>|$$]', m), '[name|name|$]');
  assert.equal(expandReplacement('a\\nb\\\\c', m), 'a\nb\\c');
  assert.equal(expandReplacement('$12', m), 'name2', '"$12" with one group is "$1" then "2"');
});

test('js colours: parameters, function-typed properties and JSX components', () => {
  const src = [
    "import * as React from 'react';",
    "import { RotateCcw } from 'lucide-react';",
    "import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';",
    "import { Button } from '@/components/ui/button';",
    'interface Props { onClose?: () => void; label: string; render(): void }',
    'export function Header({',
    '  onReset,',
    '  resetting = false,',
    '}: {',
    '  onReset?: () => void;',
    '  resetting?: boolean;',
    '}) {',
    '  const [confirming, setConfirming] = React.useState(false);',
    '  const run = (onReset: number) => onReset + 1;',
    '  const other = { onReset, x: resetting };',
    '  return (',
    '    <div>',
    '      {onReset && <Button disabled={resetting} onClick={() => setConfirming(true)}><RotateCcw /></Button>}',
    '      <AlertDialog open={confirming}><AlertDialogContent /></AlertDialog>',
    '      <Ui.Card />',
    '    </div>',
    '  );',
    '}',
    'class A { handler = () => 1; count = 0; method(a: string) { return a.length + this.count; } }',
  ].join('\n');
  const r = analyze(src, 'header.tsx');
  const texts = (flat: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push(`${src.slice(flat[i], flat[i + 1])}@${src.slice(0, flat[i]).split('\n').length}`);
    return out.sort();
  };
  assert.deepEqual(texts(r.params), [
    'a@24', 'a@24', // declaration and reference in the class method
    'onReset@14', 'onReset@14', // the inner arrow's own parameter (shadows the outer one)
    'onReset@15', // shorthand { onReset } reads the parameter
    'onReset@18', // {onReset && …}
    'onReset@7',
    'resetting@15', 'resetting@18', 'resetting@8',
  ].sort());
  assert.deepEqual(texts(r.fields), ['handler@24', 'onClose@5', 'onReset@10'].sort());
  const tags = r.jsxTags.map((t) => `${src.slice(t.start, t.end)}<${t.module}`);
  assert.deepEqual(tags, [
    'Button<@/components/ui/button', 'RotateCcw<lucide-react', 'Button<@/components/ui/button',
    'AlertDialog<@/components/ui/alert-dialog', 'AlertDialogContent<@/components/ui/alert-dialog', 'AlertDialog<@/components/ui/alert-dialog',
  ]);
  assert.equal(hasUseClient("'use client';\nimport x from 'y';"), true);
  assert.equal(hasUseClient('/** doc */\n// note\n"use client"\n'), true);
  assert.equal(hasUseClient("import x from 'y';\n'use client';"), false);
  assert.equal(hasUseClient("'use server';"), false);
});
