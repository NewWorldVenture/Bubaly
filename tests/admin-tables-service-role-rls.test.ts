import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PLA-0600 / LB-011 tenant-isolation guard. `support_tickets` (cross-tenant PII:
// requester name/email + issue text) and `admin_users` (admin roster: emails,
// roles, permissions) must be reachable ONLY via the service-role client (the
// admin console), never by a signed-in family member through PostgREST. Migration
// 0010 mis-scoped both policies (`using(true)` with no `to service_role` → applied
// TO public); 0219 restores service-role-only. This test locks the fix so the
// policies can't silently regress back to a public-readable state.
const MIG = 'supabase/migrations/0219_admin_tables_service_role_rls_lockdown.sql';

describe('admin_users + support_tickets RLS is service-role-only (0219)', () => {
  const sql = readFileSync(MIG, 'utf8');

  for (const table of ['support_tickets', 'admin_users'] as const) {
    it(`${table}: service_role_all policy is scoped TO service_role`, () => {
      // The create policy block for this table must carry `to service_role`.
      const re = new RegExp(
        `create policy\\s+"service_role_all"\\s+on\\s+public\\.${table}\\s+to service_role`,
        'i',
      );
      expect(sql, `${table} policy must be scoped TO service_role`).toMatch(re);
    });

    it(`${table}: drops the old policy first (idempotent)`, () => {
      expect(sql).toMatch(new RegExp(`drop policy if exists\\s+"service_role_all"\\s+on\\s+public\\.${table}`, 'i'));
    });
  }

  it('does not re-introduce a TO public / bare using(true) grant', () => {
    // No create-policy line may grant to public here (that is the exact 0010 bug).
    expect(sql).not.toMatch(/create policy[^;]*\bto public\b/i);
  });
});
