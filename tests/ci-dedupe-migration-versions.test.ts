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

  // The two cases above run on an inventory with no duplicate left in it, and
  // KNOWN_DUPLICATE_MIGRATIONS is empty, so their loops have nothing to visit
  // and the first compares a sorted list with itself. Said outright here, then
  // exercised: the real inventory with a duplicate put back into it.
  it('finds nothing to rename in the checked-in migrations, of which there are several hundred', () => {
    expect(REAL.length).toBeGreaterThan(400);
    expect(REAL.every((f) => version(f) !== undefined)).toBe(true);
    expect(Object.keys(KNOWN_DUPLICATE_MIGRATIONS)).toEqual([]);
    expect(planMigrationDedupe(REAL)).toEqual([]);
  });

  it('renames a duplicate reintroduced beside real migrations, of either version width, and nothing else', () => {
    const sorted = [...REAL].sort();
    const fourDigit = sorted.filter((f) => version(f)?.length === 4);
    const fiveDigit = sorted.filter((f) => version(f)?.length === 5);
    // Three real files get a sibling: the newest four-digit one, a de-duplicated
    // five-digit one, and the oldest, which gets two (a group of three).
    const hosts = [fourDigit[fourDigit.length - 1], fiveDigit[0], fourDigit[0]];
    expect(hosts.every((f) => typeof f === 'string')).toBe(true);
    const planted = [
      `${version(hosts[0])}_zz_reintroduced.sql`,
      `${version(hosts[1])}_zz_reintroduced.sql`,
      `${version(hosts[2])}_zy_reintroduced.sql`,
      `${version(hosts[2])}_zz_reintroduced.sql`,
    ];
    const files = [...REAL, ...planted];

    const renames = planMigrationDedupe(files);
    expect(renames.map((r) => r.from).sort()).toEqual([...hosts, ...planted].sort());

    const map = new Map(renames.map((r) => [r.from, r.to]));
    // Each group keeps its order and takes the next digit: host first, then the siblings.
    expect(map.get(hosts[0])).toBe(`${version(hosts[0])}0_${hosts[0].slice(5)}`);
    expect(map.get(planted[0])).toBe(`${version(hosts[0])}1_zz_reintroduced.sql`);
    expect(map.get(hosts[1])).toBe(`${version(hosts[1])}0_${hosts[1].slice(6)}`);
    expect(map.get(planted[1])).toBe(`${version(hosts[1])}1_zz_reintroduced.sql`);
    expect(map.get(planted[2])).toBe(`${version(hosts[2])}1_zy_reintroduced.sql`);
    expect(map.get(planted[3])).toBe(`${version(hosts[2])}2_zz_reintroduced.sql`);

    // The apply order is the one the CLI had before, and no version is shared after.
    const after = files.map((f) => map.get(f) ?? f);
    expect([...after].sort()).toEqual([...files].sort().map((f) => map.get(f) ?? f));
    expect(new Set(after.map(version)).size).toBe(files.length);
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
