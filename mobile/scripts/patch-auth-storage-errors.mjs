import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), '..');
const patch = JSON.parse(readFileSync(new URL('./auth-storage-errors.patch.json', import.meta.url), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fail(message) {
  throw new Error(`Supabase auth storage patch: ${message}`);
}

function ownedFile(projectRoot, relativePath) {
  const expected = join(projectRoot, relativePath);
  if (realpathSync(expected) !== expected) {
    fail(`refusing linked or external dependency path ${relativePath}; install dependencies in this checkout`);
  }
  return expected;
}

/** Apply a reviewed change only to the exact SDK bytes installed by npm ci. */
export function patchAuthStorageErrors({ projectRoot = defaultProjectRoot, checkOnly = false } = {}) {
  const root = realpathSync(resolve(projectRoot));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const manifests = {};
  for (const name of ['auth-js', 'supabase-js']) {
    const packageName = `@supabase/${name}`;
    const relativePath = `node_modules/${packageName}/package.json`;
    const manifestPath = ownedFile(root, relativePath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== packageName || manifest.version !== patch.version
      || lock.packages?.[`node_modules/${packageName}`]?.version !== patch.version) {
      fail(`expected installed and locked ${packageName}@${patch.version}; review the patch before changing the SDK version`);
    }
    manifests[name] = manifest;
  }
  if (manifests['supabase-js'].dependencies?.['@supabase/auth-js'] !== patch.version
    || manifests['auth-js'].main !== 'dist/main/index.js'
    || manifests['auth-js'].module !== 'dist/module/index.js') {
    fail('unexpected SDK dependency or runtime entry points');
  }
  const requireFromClient = createRequire(join(root, 'node_modules/@supabase/supabase-js/package.json'));
  if (realpathSync(requireFromClient.resolve('@supabase/auth-js'))
    !== ownedFile(root, 'node_modules/@supabase/auth-js/dist/main/index.js')) {
    fail('SupabaseClient resolves a different auth package');
  }

  // Preflight every file before changing any file. An unknown version or local
  // modification must fail installation, rather than silently ship unpatched.
  const changes = patch.files.map((entry) => {
    const path = ownedFile(root, `node_modules/@supabase/auth-js/${entry.path}`);
    const original = readFileSync(path);
    const digest = hash(original);
    if (digest === entry.afterSha256) return { path, original, updated: null };
    if (digest !== entry.beforeSha256) fail(`unexpected contents in ${entry.path}`);
    if (checkOnly) fail(`patch has not been applied to ${entry.path}; run npm ci with install scripts enabled`);
    const text = original.toString('utf8');
    if (text.split(entry.before).length !== 2) fail(`patch context does not match ${entry.path}`);
    const updated = Buffer.from(text.replace(entry.before, entry.after), 'utf8');
    if (hash(updated) !== entry.afterSha256) fail(`patched contents do not match ${entry.path}`);
    return { path, original, updated };
  });
  let applied = 0;
  for (const { path, original, updated } of changes) {
    if (!updated) continue;
    // Avoid overwriting a dependency that changed after the preflight.
    if (!readFileSync(path).equals(original)) fail('SDK changed during patch application');
    const temporary = `${path}.bubaly-auth-storage-${process.pid}.tmp`;
    let created = false;
    try {
      writeFileSync(temporary, updated, { flag: 'wx' });
      created = true;
      renameSync(temporary, path);
      applied += 1;
    } finally {
      if (created) rmSync(temporary, { force: true });
    }
  }
  return { version: patch.version, applied, verified: changes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) fail('only --check is supported');
    const result = patchAuthStorageErrors({ checkOnly: args[0] === '--check' });
    console.log(`Supabase auth ${result.version}: verified ${result.verified} runtime entries; patched ${result.applied}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Supabase auth storage patch failed');
    process.exitCode = 1;
  }
}
