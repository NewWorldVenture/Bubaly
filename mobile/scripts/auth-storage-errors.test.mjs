import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { patchAuthStorageErrors } from './patch-auth-storage-errors.mjs';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// This override is read-only: local worktrees can copy an existing install,
// while CI uses its own npm ci output. The patch never writes to this source.
const sourceModules = resolve(process.env.BUBALY_AUTH_TEST_DEPENDENCIES ?? join(mobileRoot, 'node_modules'));
const patch = JSON.parse(readFileSync(new URL('./auth-storage-errors.patch.json', import.meta.url), 'utf8'));
const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bubaly-auth-storage-patch-')));
const fixtures = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const authPath = (root, path) => join(root, 'node_modules/@supabase/auth-js', path);

after(() => {
  // Delete only the exact temporary tree created by this process.
  const resolved = realpathSync(temporaryRoot);
  assert.equal(resolved, temporaryRoot);
  assert.ok(resolved.startsWith(realpathSync(tmpdir()) + sep));
  rmSync(resolved, { recursive: true, force: true });
});

function copyPackage(source, root, copied = new Map()) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (copied.has(manifest.name)) {
    assert.equal(copied.get(manifest.name), manifest.version, 'Fixture contains mixed dependency versions');
    return;
  }
  copied.set(manifest.name, manifest.version);
  cpSync(source, join(root, 'node_modules', manifest.name), { recursive: true, dereference: true });
  const requireFromPackage = createRequire(join(source, 'package.json'));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    let location = dirname(requireFromPackage.resolve(name));
    while (true) {
      const candidate = join(location, 'package.json');
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === name) break;
      const parent = dirname(location);
      assert.notEqual(parent, location, `Cannot find fixture dependency ${name}`);
      location = parent;
    }
    copyPackage(location, root, copied);
  }
}

function fixture({ runtime = false } = {}) {
  const root = join(temporaryRoot, `fixture-${fixtures.length}`);
  fixtures.push(root);
  mkdirSync(root, { recursive: true });
  cpSync(join(mobileRoot, 'package-lock.json'), join(root, 'package-lock.json'));
  if (runtime) {
    copyPackage(join(sourceModules, '@supabase/supabase-js'), root);
  } else {
    for (const name of ['auth-js', 'supabase-js']) {
      const destination = join(root, 'node_modules/@supabase', name);
      mkdirSync(destination, { recursive: true });
      cpSync(join(sourceModules, '@supabase', name, 'package.json'), join(destination, 'package.json'));
    }
    mkdirSync(authPath(root, 'dist/main'), { recursive: true });
    mkdirSync(authPath(root, 'dist/module'), { recursive: true });
    cpSync(join(sourceModules, '@supabase/auth-js/dist/main/index.js'), authPath(root, 'dist/main/index.js'));
    for (const entry of patch.files) cpSync(join(sourceModules, '@supabase/auth-js', entry.path), authPath(root, entry.path));
  }
  // CI's source install is already patched. Reconstruct the authenticated npm
  // preimage in the private fixture so tests exercise application and refusal.
  for (const entry of patch.files) {
    const path = authPath(root, entry.path);
    const bytes = readFileSync(path);
    if (hash(bytes) === entry.afterSha256) {
      const original = bytes.toString('utf8').replace(entry.after, entry.before);
      assert.equal(hash(original), entry.beforeSha256);
      writeFileSync(path, original);
    } else assert.equal(hash(bytes), entry.beforeSha256);
  }
  return root;
}

test('patches both official runtime files and is idempotent', () => {
  const root = fixture();
  assert.throws(() => patchAuthStorageErrors({ projectRoot: root, checkOnly: true }), /has not been applied/);
  assert.deepEqual(patchAuthStorageErrors({ projectRoot: root }), { version: '2.115.0', applied: 2, verified: 2 });
  for (const entry of patch.files) assert.equal(hash(readFileSync(authPath(root, entry.path))), entry.afterSha256);
  assert.equal(patchAuthStorageErrors({ projectRoot: root }).applied, 0);
  assert.equal(patchAuthStorageErrors({ projectRoot: root, checkOnly: true }).verified, 2);
});

test('validates all entries before writing when one entry has unknown contents', () => {
  const root = fixture();
  const original = readFileSync(authPath(root, patch.files[0].path));
  writeFileSync(authPath(root, patch.files[1].path), '// unknown SDK contents');
  assert.throws(() => patchAuthStorageErrors({ projectRoot: root }), /unexpected contents/);
  assert.deepEqual(readFileSync(authPath(root, patch.files[0].path)), original);
});

test('can finish a known partially applied patch without changing an already patched entry', () => {
  const root = fixture();
  const entry = patch.files[0];
  writeFileSync(authPath(root, entry.path), readFileSync(authPath(root, entry.path), 'utf8').replace(entry.before, entry.after));
  assert.equal(patchAuthStorageErrors({ projectRoot: root }).applied, 1);
  assert.equal(patchAuthStorageErrors({ projectRoot: root, checkOnly: true }).verified, 2);
});

for (const changed of ['installed auth', 'installed client', 'locked auth', 'locked client', 'client dependency']) {
  test(`rejects ${changed} version drift before writing`, () => {
    const root = fixture();
    const original = patch.files.map(entry => hash(readFileSync(authPath(root, entry.path))));
    const path = changed.startsWith('locked') ? join(root, 'package-lock.json')
      : join(root, 'node_modules/@supabase', changed === 'installed auth' ? 'auth-js' : 'supabase-js', 'package.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (changed.startsWith('locked')) data.packages[`node_modules/@supabase/${changed.endsWith('auth') ? 'auth-js' : 'supabase-js'}`].version = '2.116.0';
    else if (changed === 'client dependency') data.dependencies['@supabase/auth-js'] = '2.116.0';
    else data.version = '2.116.0';
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => patchAuthStorageErrors({ projectRoot: root }), /expected installed and locked|unexpected SDK dependency/);
    assert.deepEqual(patch.files.map(entry => hash(readFileSync(authPath(root, entry.path)))), original);
  });
}

test('refuses a shared node_modules junction without modifying its target', () => {
  const owner = fixture();
  const borrower = join(temporaryRoot, 'borrower');
  mkdirSync(borrower);
  cpSync(join(mobileRoot, 'package-lock.json'), join(borrower, 'package-lock.json'));
  symlinkSync(join(owner, 'node_modules'), join(borrower, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => patchAuthStorageErrors({ projectRoot: borrower }), /refusing linked or external dependency/);
  for (const entry of patch.files) assert.equal(hash(readFileSync(authPath(owner, entry.path))), entry.beforeSha256);
});

test('the install CLI applies the patch and its read-only check refuses an unpatched install', () => {
  const root = fixture();
  const scriptRoot = join(root, 'scripts');
  mkdirSync(scriptRoot);
  for (const name of ['patch-auth-storage-errors.mjs', 'auth-storage-errors.patch.json']) {
    cpSync(new URL(name, import.meta.url), join(scriptRoot, name));
  }
  const script = join(scriptRoot, 'patch-auth-storage-errors.mjs');
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(invoke('--check').status, 1);
  for (const entry of patch.files) assert.equal(hash(readFileSync(authPath(root, entry.path))), entry.beforeSha256);
  const applied = invoke();
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /patched 2/);
  assert.equal(invoke('--check').status, 0);
  assert.equal(invoke('--unknown-option').status, 1);
});

function runSdk(root, { patched, esm = false }) {
  if (patched) patchAuthStorageErrors({ projectRoot: root });
  cpSync(new URL('./auth-storage-errors.runtime.mjs', import.meta.url), join(root, 'runtime.mjs'));
  const args = ['--unhandled-rejections=strict'];
  if (esm) {
    cpSync(new URL('./auth-storage-errors.loader.mjs', import.meta.url), join(root, 'loader.mjs'));
    args.push('--loader', pathToFileURL(join(root, 'loader.mjs')).href);
  }
  args.push(join(root, 'runtime.mjs'));
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

test('the unpatched official SupabaseClient reproduces the cold-storage unhandled rejection', () => {
  const child = runSdk(fixture({ runtime: true }), { patched: false });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /SessionStorageUnavailableError/);
  assert.match(child.stderr, /_emitInitialSession/);
});

for (const esm of [false, true]) {
  test(`actual ${esm ? 'ESM' : 'CJS'} SupabaseClient recovers after cold and later locked storage without unhandled rejection`, () => {
    const child = runSdk(fixture({ runtime: true }), { patched: true, esm });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /cold recovery, later subscription, missing session and explicit sign-out passed/);
  });
}
