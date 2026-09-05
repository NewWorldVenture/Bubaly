import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planMigrationDedupe } from '../scripts/ci-dedupe-migration-versions.mjs';
import { KNOWN_DUPLICATE_MIGRATIONS } from '../scripts/audit-migration-versions.mjs';

const REAL = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'));
const version = (f: string) => /^(\d+)_/.exec(f)?.[1];

describe('CI migration version de-duplication', () => {
  it('renames only duplicated groups, keeping the CLI apply order and making versions unique', () => {
    const renames = planMigrationDedupe(REAL);
    const map = new Map(renames.map((r) => [r.from, r.to]));
    const before = [...REAL].sort();
    const after = REAL.map((f) => map.get(f) ?? f).sort();
    expect(after).toEqual(before.map((f) => map.get(f) ?? f));
    const versions = after.map(version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const f of REAL) if (!map.has(f)) expect(after).toContain(f);
  });

  it('covers every known historical duplicate and nothing else', () => {
    const renamed = new Set(planMigrationDedupe(REAL).map((r) => r.from));
    const known = new Set(Object.values(KNOWN_DUPLICATE_MIGRATIONS).flat());
    for (const f of known) expect(renamed, `${f} should be renamed`).toContain(f);
    for (const f of renamed) expect(known, `${f} is not a known duplicate`).toContain(f);
  });

  it('produces the documented suffix scheme', () => {
    const renames = planMigrationDedupe(['0009_a.sql', '0010_blog_posts.sql', '0010_support_tickets_admin_users.sql', '0011_b.sql', 'README.md']);
    expect(renames).toEqual([
      { from: '0010_blog_posts.sql', to: '00100_blog_posts.sql' },
      { from: '0010_support_tickets_admin_users.sql', to: '00101_support_tickets_admin_users.sql' },
    ]);
  });

  it('is a no-op when versions are already unique', () => {
    expect(planMigrationDedupe(['0001_a.sql', '0002_b.sql'])).toEqual([]);
  });

  it('refuses to rename more than ten files sharing a version', () => {
    const many = Array.from({ length: 11 }, (_, i) => `0500_file${i}.sql`);
    expect(() => planMigrationDedupe(many)).toThrow(/single suffix digit/);
  });
});
