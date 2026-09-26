-- A chore is taken off the board by a manager. (MAIN-F20, migration 0341)
--
-- chore_assignments let any family member delete any row, so a child could
-- clear a sibling's chores (or their own) through PostgREST while the app's
-- only delete path refused them. The cases below are the rule, and the
-- control is the half that matters: a guard that refused everyone would pass
-- the breach tests and take the parent's Remove button away.
--
--   a child deletes a sibling's chore      -> 0 rows (REFUSED)
--   a child deletes their own chore        -> 0 rows (REFUSED)
--   the child can still SEE both rows      -> the refusal is not just invisibility
--   a parent deletes a child's chore       -> 1 row  (allowed, control)
--
-- An RLS-filtered DELETE changes nothing and raises nothing, so each case is
-- judged on rows changed. Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000f801';
  par   uuid := '00000000-0000-4000-8000-00000000f8a1';
  kidA  uuid := '00000000-0000-4000-8000-00000000f8a2';
  kidB  uuid := '00000000-0000-4000-8000-00000000f8a3';
  mem_a uuid;
  mem_b uuid;
  chore uuid := '00000000-0000-4000-8000-00000000f8c1';
  asg_a uuid := '00000000-0000-4000-8000-00000000f8d1';
  asg_b uuid := '00000000-0000-4000-8000-00000000f8d2';
  asg_c uuid := '00000000-0000-4000-8000-00000000f8d3';  -- the parent's own target, untouched by the child
  n     int;
  seen  int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (par, 'board-parent@example.test'), (kidA, 'board-kid-a@example.test'), (kidB, 'board-kid-b@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Board', par)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par,  'Parent', 'parent', true),
    (fam, kidA, 'Kid A',  'child',  true),
    (fam, kidB, 'Kid B',  'child',  true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into mem_a from public.family_members where family_id = fam and user_id = kidA;
  select id into mem_b from public.family_members where family_id = fam and user_id = kidB;

  insert into public.chores (id, family_id, title, created_by) values (chore, fam, 'Dishes', par);
  insert into public.chore_assignments (id, family_id, chore_id, member_id, status) values
    (asg_a, fam, chore, mem_a, 'todo'),
    (asg_b, fam, chore, mem_b, 'todo'),
    (asg_c, fam, chore, mem_b, 'todo');

  -- ── as Kid A ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', kidA::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family, so nothing below is a restriction';
  end if;

  select count(*) into seen from public.chore_assignments where id in (asg_a, asg_b);
  if seen <> 2 then
    raise warning 'SETUP: Kid A should see both assignments (saw %), or a refused delete below proves only invisibility', seen;
    failures := failures + 1;
  end if;

  delete from public.chore_assignments where id = asg_b;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a child deleted a sibling''s chore (% row)', n;
    failures := failures + 1;
  end if;

  delete from public.chore_assignments where id = asg_a;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a child deleted their own chore off the board (% row)', n;
    failures := failures + 1;
  end if;

  -- ── as the parent: the control ──────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', par::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.chore_assignments where id = asg_c;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the parent could not remove a child''s chore (% rows) — the guard refuses everyone', n;
    failures := failures + 1;
  end if;
  reset role;

  if failures > 0 then
    raise exception 'chore-assignment-delete: % failure(s) above', failures;
  end if;
end
$probe$;

rollback;
