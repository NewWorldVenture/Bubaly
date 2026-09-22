-- A chore proof belongs to whose chore it is. (F-F07, the AUTHZ half)
--
-- `chore_submissions` and `chore_disputes` were each governed by a single
-- `is_family_member(family_id)` policy FOR ALL, which answers "is this user in
-- the family" and nothing about WHICH member the row names. So a sibling could
-- insert a submission against another child's chore assignment, or open a
-- dispute the row said that child had raised.
--
-- The three cases below are the whole rule, and the two CONTROLS are the half
-- that matters: a guard that refused everyone would pass the breach test and
-- take the kids page away from the children it exists for.
--
--   the assignee, their own chore   -> allowed  (this IS the product)
--   a sibling, someone else's chore -> REFUSED
--   a manager, any child's chore    -> allowed  (a parent helps)
--
-- Rolled back rather than cleaned up: a refused INSERT under a restrictive
-- policy raises, and an aborted assertion must not leave a fixture behind.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000f701';
  par    uuid := '00000000-0000-4000-8000-00000000f7a1';
  kidA   uuid := '00000000-0000-4000-8000-00000000f7a2';
  kidB   uuid := '00000000-0000-4000-8000-00000000f7a3';
  mem_a  uuid;
  mem_b  uuid;
  chore  uuid := '00000000-0000-4000-8000-00000000f7c1';
  asg    uuid := '00000000-0000-4000-8000-00000000f7d1';
  sub    uuid := '00000000-0000-4000-8000-00000000f7e1';
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (par, 'proof-parent@example.test'), (kidA, 'proof-kid-a@example.test'), (kidB, 'proof-kid-b@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Proof', par)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par,  'Parent', 'parent', true),
    (fam, kidA, 'Kid A',  'child',  true),
    (fam, kidB, 'Kid B',  'child',  true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into mem_a from public.family_members where family_id = fam and user_id = kidA;
  select id into mem_b from public.family_members where family_id = fam and user_id = kidB;

  insert into public.chores (id, family_id, title, created_by) values (chore, fam, 'Dishes', par);
  insert into public.chore_assignments (id, family_id, chore_id, member_id, status)
    values (asg, fam, chore, mem_a, 'todo');

  -- ── 1. the assignee submits their own proof: this IS the product ─────────
  perform set_config('request.jwt.claims', json_build_object('sub', kidA::text)::text, true);
  set local role authenticated;
  if not public.is_self_member(mem_a) then
    raise exception 'CONTROL FAILED: not acting as Kid A, so nothing below is a restriction';
  end if;
  begin
    insert into public.chore_submissions (id, family_id, assignment_id, chore_id, member_id, kind, status)
      values (sub, fam, asg, chore, mem_a, 'none', 'pending');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: the assignee could not submit their own proof (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: the assignee was refused their own submission — the fix took the kids page away';
    failures := failures + 1;
  end;

  -- ── 2. a sibling submits against that chore ─────────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', kidB::text)::text, true);
  set local role authenticated;
  if not public.is_family_member(fam) then
    raise warning 'CONTROL FAILED: the sibling is not a member, so their refusal proves nothing';
    failures := failures + 1;
  end if;
  begin
    insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, kind, status)
      values (fam, asg, chore, mem_a, 'none', 'pending');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a sibling submitted proof against another child''s chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;
  -- …and cannot dispute it in that child's name.
  begin
    insert into public.chore_disputes (family_id, submission_id, member_id, reason, status)
      values (fam, sub, mem_a, 'not done properly', 'open');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a sibling opened a dispute attributed to another child (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;
  -- …nor re-point an existing submission at themselves.
  begin
    update public.chore_submissions set member_id = mem_b where id = sub;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a sibling re-attributed an existing submission (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 3. a manager, on a child's behalf: kept deliberately ────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', par::text)::text, true);
  set local role authenticated;
  if not public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: the parent is not a manager, so the control below proves nothing';
  end if;
  begin
    insert into public.chore_disputes (family_id, submission_id, member_id, reason, status)
      values (fam, sub, mem_a, 'parent raising it', 'open');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a parent could not raise a dispute for their child (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: a parent was refused a dispute on their child''s submission';
    failures := failures + 1;
  end;

  reset role;
  if failures > 0 then
    raise exception 'a chore proof does not belong to whose chore it is: % finding(s)', failures;
  end if;
  raise notice 'OK: the assignee and a manager may submit and dispute; a sibling may not, and cannot re-attribute one.';
end
$probe$;

rollback;
