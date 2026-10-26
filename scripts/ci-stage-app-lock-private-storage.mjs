// Copy one held migration into an owned CI checkout for its disposable replay.
// This helper never connects to a database and accepts no project/path options.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIGRATION_SHA256, NAME, VERSION, readAppLockMigration } from './apply-app-lock-private-storage.mjs';

export const APP_LOCK_CI_FILENAME = `${VERSION}_${NAME}.sql`;
const digest = value => createHash('sha256').update(value).digest('hex');

export function stageAppLockForCi(root, env, remove = false) {
  if (env.GITHUB_ACTIONS !== 'true' || !['true', '1'].includes(env.CI)
    || env.GITHUB_WORKFLOW !== 'CI' || !['database', 'e2e'].includes(env.GITHUB_JOB)
    || !['pull_request', 'push'].includes(env.GITHUB_EVENT_NAME)
    || env.BUBALY_DISPOSABLE_APP_LOCK_SCHEMA !== '1'
    || !env.GITHUB_WORKSPACE || realpathSync(env.GITHUB_WORKSPACE) !== realpathSync(root)) {
    throw new Error('App Lock staging requires the owned disposable Database or E2E CI checkout.');
  }
  if (['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_DB_URL', 'DATABASE_URL'].some(key => env[key])) {
    throw new Error('App Lock CI staging refuses remote database configuration.');
  }
  if (env.GITHUB_JOB === 'database' && (env.PGHOST !== 'localhost' || env.PGPORT !== '5432' || env.PGDATABASE !== 'bubaly')) {
    throw new Error('App Lock database replay must use the owned loopback CI service.');
  }
  for (const directory of [join(root, 'supabase'), join(root, 'supabase', 'migrations')]) {
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      throw new Error('App Lock CI migration directories must be real checkout directories.');
    }
  }
  const target = join(root, 'supabase', 'migrations', APP_LOCK_CI_FILENAME);
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || digest(readFileSync(target)) !== MIGRATION_SHA256) {
      throw new Error('Refusing to replace or remove an unexpected App Lock staging file.');
    }
    if (remove) unlinkSync(target);
    return { status: remove ? 'removed' : 'already_staged', file: APP_LOCK_CI_FILENAME };
  }
  if (remove) return { status: 'absent', file: APP_LOCK_CI_FILENAME };
  const migration = readAppLockMigration();
  writeFileSync(target, migration.sql, { flag: 'wx', mode: 0o600 });
  return { status: 'staged', file: APP_LOCK_CI_FILENAME };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--remove')) throw new Error('Only --remove, or no argument to stage, is accepted.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify(stageAppLockForCi(root, process.env, args.length === 1)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
