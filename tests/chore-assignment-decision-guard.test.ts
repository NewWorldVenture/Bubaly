import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-07 chore-assignment decision-status guard (sibling of the 0222 submission
// guard). chore_assignments shipped (0043) with `is_family_member` FOR ALL, so a
// child could `update chore_assignments set status='approved'` directly via
// PostgREST and forge the COMPLETION of their own chore (the assignment status is
// what the dashboard reads as done/approved). No money is minted (the reward is
// credited imperatively in finalizeApproval under the manager-only wallet RLS,
// 0217) — it is an accountability forgery. Migration 0223 adds a BEFORE INSERT OR
// UPDATE trigger that only lets a manager or the trusted server transition an
// assignment INTO 'approved'/'rejected'; members keep todo/in_progress/submitted/
// done. Proven live on the PG16 harness: child approved/rejected blocked; child
// in_progress allowed; manager + service-role approved allowed.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_chore_assignment_decision_guard.sql'));
  expect(files.length, 'chore_assignment_decision_guard migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0223 chore assignment decision guard', () => {
  const sql = migration();

  it('guards only the manager-decision statuses (approved/rejected)', () => {
    expect(sql).toContain("new.status in ('approved','rejected')");
  });

  it('guards both INSERT and UPDATE transitions', () => {
    expect(sql).toContain("(tg_op = 'INSERT' or new.status is distinct from old.status)");
    expect(sql).toContain('before insert or update on public.chore_assignments');
  });

  it('allows managers and the trusted server, blocks plain members', () => {
    expect(sql).toContain("current_user = 'service_role'");
    expect(sql).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(sql).toContain('auth.uid() is null');
    expect(sql).toContain('public.can_manage_family(new.family_id)');
    expect(sql).toContain('may only be set by a family manager');
    expect(sql).toContain("errcode = '42501'");
  });

  it('runs as security invoker and is idempotent', () => {
    expect(sql).toContain('security invoker');
    expect(sql).toContain("to_regclass('public.chore_assignments') is null");
    expect(sql).toContain('drop trigger if exists trg_chore_assignment_decision_guard');
  });
});
