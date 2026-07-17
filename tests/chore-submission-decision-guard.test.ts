import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-07 chore-submission decision-status guard (DB-layer defense-in-depth on top
// of the app-layer isManager gate on approve/reject). chore_submissions shipped
// (0043) with a single `is_family_member` FOR ALL policy, so a child could
// `update chore_submissions set status='approved'` directly via PostgREST and
// forge an approval of their own proof (PLA-0450). Migration 0222 adds a
// BEFORE INSERT OR UPDATE trigger that only lets a family manager or the trusted
// server (service role / migration-seed context) transition a submission INTO a
// manager-decision status, while members may still submit (pending) and dispute
// (disputed). Proven live on the PG16 harness: child self-approve (UPDATE+INSERT)
// blocked; child dispute allowed; manager approve allowed; service-role
// auto-approve allowed.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_chore_submission_decision_guard.sql'));
  expect(files.length, 'chore_submission_decision_guard migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0222 chore submission decision guard', () => {
  const sql = migration();

  it('guards only the manager-decision statuses', () => {
    expect(sql).toContain("new.status in ('approved','rejected','needs_improvement','parent_review')");
  });

  it('guards both INSERT and UPDATE transitions', () => {
    expect(sql).toContain("(tg_op = 'INSERT' or new.status is distinct from old.status)");
    expect(sql).toContain('before insert or update on public.chore_submissions');
  });

  it('allows managers and the trusted server, blocks plain members', () => {
    expect(sql).toContain("current_user = 'service_role'");
    expect(sql).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(sql).toContain('auth.uid() is null');
    expect(sql).toContain('public.can_manage_family(new.family_id)');
    expect(sql).toContain('may only be set by a family manager');
    expect(sql).toContain("errcode = '42501'");
  });

  it('runs as security invoker so current_user reflects the caller', () => {
    expect(sql).toContain('security invoker');
  });

  it('is idempotent (guarded + drop-then-create trigger)', () => {
    expect(sql).toContain("to_regclass('public.chore_submissions') is null");
    expect(sql).toContain('drop trigger if exists trg_chore_submission_decision_guard');
  });
});
