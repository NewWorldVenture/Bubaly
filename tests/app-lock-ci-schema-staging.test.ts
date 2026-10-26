import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOCK_CI_FILENAME, stageAppLockForCi } from '../scripts/ci-stage-app-lock-private-storage.mjs';
import { readAppLockMigration } from '../scripts/apply-app-lock-private-storage.mjs';

const roots: string[] = [];
function checkout(job = 'database') {
  const root = mkdtempSync(join(tmpdir(), 'app-lock-ci-staging-'));
  roots.push(root);
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'supabase', 'reserved'), { recursive: true });
  writeFileSync(join(root, 'supabase', 'migrations', '0001_original.sql'), 'select 1;');
  writeFileSync(join(root, 'supabase', 'reserved', '0490_unrelated.sql'), 'select 2;');
  const env = { GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_WORKFLOW: 'CI', GITHUB_JOB: job,
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_WORKSPACE: root, BUBALY_DISPOSABLE_APP_LOCK_SCHEMA: '1',
    PGHOST: 'localhost', PGPORT: '5432', PGDATABASE: 'bubaly' };
  return { root, env, target: join(root, 'supabase', 'migrations', APP_LOCK_CI_FILENAME) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('App Lock disposable schema staging', () => {
  it.each(['database', 'e2e'])('stages and removes exactly the reviewed SQL for %s', (job) => {
    const { root, env, target } = checkout(job);
    expect(stageAppLockForCi(root, env).status).toBe('staged');
    expect(readFileSync(target, 'utf8')).toBe(readAppLockMigration().sql);
    expect(readdirSync(join(root, 'supabase', 'migrations')).sort()).toEqual(['0001_original.sql', APP_LOCK_CI_FILENAME]);
    expect(stageAppLockForCi(root, env).status).toBe('already_staged');
    expect(stageAppLockForCi(root, env, true).status).toBe('removed');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(root, 'supabase', 'reserved', '0490_unrelated.sql'), 'utf8')).toBe('select 2;');
  });

  it('refuses production workflows, remote configuration and unowned checkouts before copying', () => {
    const { root, env, target } = checkout();
    for (const change of [
      { GITHUB_WORKFLOW: 'App Lock private storage release' }, { GITHUB_JOB: 'production' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { BUBALY_DISPOSABLE_APP_LOCK_SCHEMA: '' },
      { GITHUB_ACTIONS: 'false' }, { PGHOST: 'remote.example' }, { PGDATABASE: 'postgres' },
      { SUPABASE_ACCESS_TOKEN: 'a-token' }, { SUPABASE_PROJECT_REF: 'ltcxlbipiihclxwioyqj' },
      { GITHUB_WORKSPACE: tmpdir() },
    ]) expect(() => stageAppLockForCi(root, { ...env, ...change })).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('never overwrites an unexpected migration or follows a symlink', () => {
    const { root, env, target } = checkout();
    writeFileSync(target, 'unexpected');
    expect(() => stageAppLockForCi(root, env)).toThrow(/unexpected/);
    expect(() => stageAppLockForCi(root, env, true)).toThrow(/unexpected/);
    rmSync(target);
    const other = join(root, 'untouched.sql');
    writeFileSync(other, readAppLockMigration().sql);
    symlinkSync(other, target);
    expect(() => stageAppLockForCi(root, env)).toThrow(/unexpected/);
    expect(() => stageAppLockForCi(root, env, true)).toThrow(/unexpected/);
    expect(readFileSync(other, 'utf8')).toBe(readAppLockMigration().sql);
  });

  it('stages only around disposable bootstrap/start and cleans up before generic replay stress', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci.match(/node scripts\/ci-stage-app-lock-private-storage\.mjs\n/g)).toHaveLength(2);
    expect(ci.match(/trap 'node scripts\/ci-stage-app-lock-private-storage\.mjs --remove' EXIT/g)).toHaveLength(2);
    for (const run of ['bash docs/audit/pg-bootstrap.sh', 'supabase start']) {
      expect(ci).toContain(`trap 'node scripts/ci-stage-app-lock-private-storage.mjs --remove' EXIT\n          ${run}`);
    }
    for (const file of readdirSync('.github/workflows').filter(file => /production|app-lock-private-storage/.test(file))) {
      expect(readFileSync(join('.github/workflows', file), 'utf8')).not.toContain('ci-stage-app-lock-private-storage');
    }
    expect(existsSync(join('supabase', 'migrations', APP_LOCK_CI_FILENAME))).toBe(false);
  });
});
