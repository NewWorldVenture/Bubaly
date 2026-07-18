import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// PLA-0815: the independent production-readiness seed pack. Structure guard
// (the SQL itself is validated by execution against a PG16 schema DB — 768 rows,
// idempotent; see the PLA entry). This test pins the invariants the pack must
// keep so an edit can't silently break independence / idempotency / coverage.
const sql = fs.readFileSync('supabase/seed_audit_pack_500.sql', 'utf8');

describe('seed_audit_pack_500 structure', () => {
  it('is namespaced + idempotent (never cascade-deletes families)', () => {
    expect(sql).toContain("name LIKE 'AUDIT500::%'");
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');            // families upserted, not deleted
    expect(sql).not.toMatch(/DELETE FROM public\.families/);         // family cascade-delete is the trigger trap
    expect(sql).toContain('DELETE FROM public.chore_assignments');   // children cleared in FK-safe order
    expect(sql).toContain('DELETE FROM public.subscriptions');
    expect(sql).toContain('md5('); // deterministic uuids → stable re-runs
  });

  it('covers every member role and subscription tier/status', () => {
    for (const role of ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest']) {
      expect(sql, `role ${role}`).toContain(`'${role}'`);
    }
    for (const plan of ['free', 'family', 'family_plus']) {
      expect(sql, `plan ${plan}`).toContain(`'${plan}'`);
    }
    for (const status of ['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid']) {
      expect(sql, `status ${status}`).toContain(`'${status}'`);
    }
  });

  it('seeds across the core services (≥500 relational records)', () => {
    for (const table of [
      'public.families', 'public.subscriptions', 'public.family_members',
      'public.chores', 'public.chore_assignments', 'public.calendar_events',
      'public.reminders', 'public.meal_plans', 'public.grocery_lists', 'public.grocery_items',
    ]) {
      expect(sql, `inserts into ${table}`).toContain(`INSERT INTO ${table}`);
    }
    // Documented volume: 12 fam + 12 sub + 96 mem + 72 chore + 216 assign +
    // 120 event + 72 remind + 60 meal + 12 list + 96 item = 768 ≥ 500.
    // (Validated by execution against a PG16 schema DB — see the PLA entry.)
    expect(sql).toContain("SELECT 'families'          AS entity"); // self-verification block
    expect(sql).toContain('managed'); // members have NULL user_id — no auth.users dependency
  });

  it('is guarded against production use', () => {
    expect(sql).toMatch(/NEVER run against production/i);
  });
});
