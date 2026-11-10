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

// 0223 is no longer the definition that runs. 0305 and 0331 each
// `create or replace function public.chore_assignment_decision_guard()`, so the
// cases above pin a superseded body: the live guard could lose its status rule
// and they would stay green. These read the LAST migration that defines the
// function, and only that function's own body.
const DEFINES = 'create or replace function public.chore_assignment_decision_guard()';

function liveGuard(): { file: string; head: string; body: string; rest: string } {
  const defining = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(`supabase/migrations/${f}`, 'utf8').includes(DEFINES));
  expect(defining.length, 'a migration must define chore_assignment_decision_guard').toBeGreaterThan(0);
  const file = defining[defining.length - 1];
  const text = readFileSync(`supabase/migrations/${file}`, 'utf8');
  const start = text.lastIndexOf(DEFINES);
  const opened = /\bas (\$[a-z_]*\$)/.exec(text.slice(start));
  expect(opened, `${file}: the guard's body must be dollar-quoted`).not.toBeNull();
  const tag = opened?.[1] ?? '';
  const bodyStart = start + (opened?.index ?? 0) + (opened?.[0].length ?? 0);
  const bodyEnd = text.indexOf(`${tag};`, bodyStart);
  expect(bodyEnd, `${file}: the guard's body must be closed`).toBeGreaterThan(bodyStart);
  const squeeze = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  return {
    file,
    head: squeeze(text.slice(start, bodyStart)),
    body: squeeze(text.slice(bodyStart, bodyEnd)),
    rest: squeeze(text.slice(bodyEnd)),
  };
}

describe('the chore assignment decision guard as it is defined today', () => {
  const live = liveGuard();

  it('is a later migration than 0223, which the cases above read', () => {
    expect(live.file).not.toBe('0223_chore_assignment_decision_guard.sql');
    expect(live.file > '0223_chore_assignment_decision_guard.sql').toBe(true);
  });

  it('still guards a transition into approved/rejected, on INSERT and on UPDATE', () => {
    expect(live.body).toContain(
      "deciding := new.status in ('approved','rejected') and (tg_op = 'INSERT' or new.status is distinct from old.status);",
    );
    // The flag has to reach the gate: computing `deciding` and never testing it guards nothing.
    expect(live.body).toMatch(/\bif deciding or [^;]*\bthen\b/);
    expect(live.rest).toContain('before insert or update on public.chore_assignments for each row execute function public.chore_assignment_decision_guard();');
  });

  it('still allows managers and the trusted server, and refuses a plain member with 42501', () => {
    const gate = live.body.slice(live.body.search(/\bif deciding or /));
    expect(gate).toContain(
      "if current_user = 'service_role' or coalesce(auth.role(), '') = 'service_role' or auth.uid() is null or public.can_manage_family(new.family_id) then return new; end if;",
    );
    expect(gate).toContain(
      "if deciding then raise exception 'chore assignment status % may only be set by a family manager', new.status using errcode = '42501'; end if;",
    );
  });

  it('pins its search_path, since it no longer runs as security invoker', () => {
    expect(live.head).toContain('security definer');
    expect(live.head).toMatch(/set search_path = public, pg_temp\b/);
    expect(live.rest).toContain('drop trigger if exists trg_chore_assignment_decision_guard on public.chore_assignments;');
  });
});
