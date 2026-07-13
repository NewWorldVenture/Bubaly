import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const supabaseDir = resolve(process.cwd(), 'supabase');

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '');
}

describe('seed Auth safety', () => {
  it('never mutates Supabase-managed auth.users from seed SQL', () => {
    const files = readdirSync(supabaseDir)
      .filter((name) => name === 'SEED_ALL.sql' || /^seed.*\.sql$/i.test(name));

    const violations = files.filter((name) => {
      const sql = executableSql(readFileSync(resolve(supabaseDir, name), 'utf8'));
      return /\b(?:insert\s+into|update|delete\s+from)\s+auth\.users\b/i.test(sql);
    });

    expect(violations).toEqual([]);
  });

  it('retires destructive Auth fixtures and bounds the cleanup migration', () => {
    expect(existsSync(resolve(supabaseDir, 'seed_onboarding_progress.sql'))).toBe(false);
    expect(existsSync(resolve(supabaseDir, 'seed_full.sql'))).toBe(false);

    const master = readFileSync(resolve(supabaseDir, 'SEED_ALL.sql'), 'utf8');
    expect(master).toContain('Runs all 61 paste-ready');
    expect(master).toContain('RETIRED: this historical block wrote incomplete records');

    const migration = readFileSync(
      resolve(supabaseDir, 'migrations', '0177_remove_synthetic_auth_users.sql'),
      'utf8',
    );
    expect(migration).toContain("onb[0-9]+@seed-onb\\.bubaly\\.test");
    expect(migration).toContain("person[0-9]+@seed\\.bubaly\\.test");
    expect(migration).toContain('if synthetic_count > 1000 then');
    expect(migration.match(/delete from auth\.users/gi)).toHaveLength(1);
  });
});
