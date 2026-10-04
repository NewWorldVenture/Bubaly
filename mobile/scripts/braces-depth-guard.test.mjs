import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const braces = require(process.env.BRACES_MODULE_PATH || 'braces');
const micromatch = require('micromatch');
const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..');
const nest = (depth) => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);
const nestedAst = (depth) => {
  let node = { type: 'text', value: 'x' };
  for (let i = 0; i < depth; i += 1) node = { type: 'brace', nodes: [node] };
  return { type: 'root', nodes: [node] };
};
const assertGuardError = (fn, prefix) => assert.throws(fn, (error) =>
  error instanceof RangeError && error.message.startsWith(prefix));

test('the installed braces dependency resolves to the pinned local source', async () => {
  const resolved = require.resolve('braces');
  const lock = JSON.parse(await readFile(join(mobileRoot, 'package-lock.json'), 'utf8'));
  const lockEntry = lock.packages['node_modules/braces'];
  assert.equal(resolve(resolved), resolve(mobileRoot, 'node_modules', 'braces', 'index.js'));
  assert.equal(require.resolve('braces', { paths: [require.resolve('micromatch')] }), resolved);
  assert.equal(lockEntry.version, '3.0.3');
  assert.equal(lockEntry.resolved, 'file:vendor/braces-3.0.3-depth-guard.tgz');
  assert.equal(require('braces/package.json').version, '3.0.3');
  const archive = await readFile(join(mobileRoot, 'vendor', 'braces-3.0.3-depth-guard.tgz'));
  assert.equal(lockEntry.integrity, `sha512-${createHash('sha512').update(archive).digest('base64')}`);
  for (const file of ['LICENSE', 'package.json', 'index.js', 'lib/parse.js', 'lib/compile.js', 'lib/expand.js', 'lib/stringify.js']) {
    assert.deepEqual(await readFile(join(mobileRoot, 'node_modules', 'braces', file)), await readFile(join(mobileRoot, 'vendor', 'braces', file)),
      `installed ${file} differs from the reviewed vendored source`);
  }
});

test('ordinary brace compile and expansion outputs remain compatible', () => {
  assert.deepEqual(braces('{a,b}'), ['(a|b)']);
  assert.deepEqual(braces('{a,b}', { expand: true }), ['a', 'b']);
  assert.deepEqual(braces('src/{foo,bar}/**/*.{js,ts}', { expand: true }).sort(), [
    'src/bar/**/*.js', 'src/bar/**/*.ts', 'src/foo/**/*.js', 'src/foo/**/*.ts'
  ]);
});

test('stringify preserves 3.0.3 escapeInvalid output for nested brace ASTs', () => {
  for (const input of ['{{a}}', '{1..8}', '{{{a,b}}}', '{a,{b,c}}']) {
    for (const escapeInvalid of [false, true]) {
      assert.equal(braces.stringify(braces.parse(input), { escapeInvalid }), input);
    }
  }
});

test('the exact 100-depth boundary is accepted and the next level is rejected', () => {
  const ast = nestedAst(100);
  const parsed = braces.parse(nest(100), { maxDepth: 100 });
  assert.equal(parsed.type, 'root');
  assert.doesNotThrow(() => braces.compile(parsed, { maxDepth: 100 }));
  assert.doesNotThrow(() => braces.expand(parsed, { maxDepth: 100 }));
  assert.doesNotThrow(() => braces.stringify(parsed, { maxDepth: 100 }));
  assert.equal(ast.type, 'root');
  assert.doesNotThrow(() => braces.compile(ast, { maxDepth: 100 }));
  assert.doesNotThrow(() => braces.expand(ast, { maxDepth: 100 }));
  assert.doesNotThrow(() => braces.stringify(ast, { maxDepth: 100 }));
  assertGuardError(() => braces.parse(nest(101), { maxDepth: 100 }), 'Input nesting exceeds max depth');
  assertGuardError(() => braces.parse(nest(101)), 'Input nesting exceeds max depth');
  for (const method of ['compile', 'expand', 'stringify']) {
    assertGuardError(() => braces[method](nestedAst(101)), 'AST nesting exceeds max depth');
  }
});

test('maxDepth zero permits flat strings but rejects structural nesting consistently', () => {
  assert.equal(braces.parse('plain', { maxDepth: 0 }).type, 'root');
  assert.doesNotThrow(() => braces.compile('plain', { maxDepth: 0 }));
  assert.doesNotThrow(() => braces.expand('plain', { maxDepth: 0 }));
  assert.doesNotThrow(() => braces.stringify(braces.parse('plain'), { maxDepth: 0 }));
  assertGuardError(() => braces.parse('{a,b}', { maxDepth: 0 }), 'Input nesting exceeds max depth');
});

test('parse and all recursive public AST walkers reject invalid maxDepth values consistently', () => {
  const ast = { type: 'root', nodes: [{ type: 'text', value: 'ok' }] };
  for (const maxDepth of [1.5, -1, NaN, Infinity, '3']) {
    assert.throws(() => braces.parse('x', { maxDepth }), TypeError);
    assert.throws(() => braces.compile(ast, { maxDepth }), TypeError);
    assert.throws(() => braces.expand(ast, { maxDepth }), TypeError);
    assert.throws(() => braces.stringify(ast, { maxDepth }), TypeError);
  }
});

test('public recursive walkers guard caller-supplied 5,000-level ASTs', () => {
  const ast = nestedAst(5000);
  assertGuardError(() => braces.compile(ast), 'AST nesting exceeds max depth');
  assertGuardError(() => braces.expand(ast), 'AST nesting exceeds max depth');
  assertGuardError(() => braces.stringify(ast), 'AST nesting exceeds max depth');
});

test('3,500-level inputs fail safely in child processes instead of exhausting the process stack', () => {
  for (const method of ['parse', 'compile', 'expand']) {
    const guardPrefix = 'Input nesting exceeds max depth';
    const moduleSpecifier = process.env.BRACES_MODULE_PATH
      ? JSON.stringify(process.env.BRACES_MODULE_PATH)
      : "'braces'";
    const source = `const b=require(${moduleSpecifier}); const s='{' .repeat(3500)+'a,b'+'}'.repeat(3500); try { b.${method}(s); process.exit(9); } catch (e) { if (e instanceof RangeError && e.message.startsWith(${JSON.stringify(guardPrefix)})) process.exit(0); process.exit(8); }`;
    const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 2000, cwd: mobileRoot });
    assert.equal(result.status, 0, `${method}: status=${result.status}; stderr=${result.stderr}`);
  }
});

test('micromatch preserves ordinary patterns and Expo Metro rejects deep synthetic globs safely', () => {
  assert.deepEqual(micromatch(['src/a.js', 'src/a.ts', 'src/a.css', 'src/foo/bar.ts'], 'src/**/*.{js,ts}').sort(), [
    'src/a.js', 'src/a.ts', 'src/foo/bar.ts'
  ]);
  const deepGlob = `src/${'{'.repeat(3500)}a,b${'}'.repeat(3500)}/**/*`;
  const metroEntry = require.resolve('metro-file-map', { paths: [mobileRoot] });
  const metros = [
    ['@expo/metro-file-map/build/watchers/common', require.resolve('@expo/metro-file-map/build/watchers/common', { paths: [mobileRoot] })],
    ['metro-file-map/src/watchers/common.js', join(dirname(metroEntry), 'watchers', 'common.js')]
  ];
  for (const [moduleName, commonPath] of metros) {
    const { includedByGlob } = require(commonPath);
    const resolvedMicromatch = require.resolve('micromatch', { paths: [dirname(commonPath)] });
    assert.equal(require.resolve('braces', { paths: [resolvedMicromatch] }), require.resolve('braces'));
    assert.equal(includedByGlob('f', ['src/**/*.{js,ts}'], false, 'src/a.ts'), true, moduleName);
    assert.equal(includedByGlob('f', ['src/**/*.{js,ts}'], false, 'src/a.css'), false, moduleName);
    assert.equal(includedByGlob('f', [deepGlob], false, 'src/a'), false, moduleName);
  }
});
