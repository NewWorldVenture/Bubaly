import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-12 defense-in-depth. Migration 0215 restricts WRITES on the safety-critical
// shared tables (family_places geofences, guardian_routing_rules screening) to
// family managers via can_manage_family(), while keeping SELECT open to all
// members. This complements the app-level gates (PLA-0470/0520) so a missed gate
// or a direct PostgREST call by a signed-in child still cannot tamper. Proven
// live on the PG16 harness for family_places (child denied insert/update/delete,
// manager allowed). This test pins the policy shape so it can't silently regress.
function migration(): string {
  // Resolve the migration regardless of a later renumber.
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_safety_write_rls_hardening.sql'));
  expect(files.length, 'safety_write_rls_hardening migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0215 safety write-RLS hardening', () => {
  const sql = migration();

  for (const table of ['family_places', 'guardian_routing_rules']) {
    it(`${table}: writes require can_manage_family`, () => {
      const scope = sql.slice(sql.indexOf(table));
      expect(scope).toContain(`for insert to authenticated with check (public.can_manage_family(family_id))`.replace(table, table));
      expect(sql).toContain(`create policy ${table}_insert on public.${table}`);
      expect(sql).toContain(`create policy ${table}_update on public.${table}`);
      expect(sql).toContain(`create policy ${table}_delete on public.${table}`);
    });
  }

  it('family_places keeps SELECT open to all family members', () => {
    expect(sql).toMatch(/create policy family_places_select[\s\S]*using \(public\.is_family_member\(family_id\)\)/);
  });

  it('every write policy gates on can_manage_family (managers only)', () => {
    const writes = sql.match(/for (insert|update|delete)[\s\S]*?can_manage_family/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(6); // 3 ops × 2 tables
  });

  it('does not create/alter policies on self-owned member_locations or child chore_submissions', () => {
    // (They may be mentioned in comments explaining what is intentionally left alone,
    // but no policy/table statement should target them.)
    expect(sql).not.toMatch(/(create policy|alter table|drop policy)[\s\S]*?member_locations/);
    expect(sql).not.toMatch(/(create policy|alter table|drop policy)[\s\S]*?chore_submissions/);
  });
});
