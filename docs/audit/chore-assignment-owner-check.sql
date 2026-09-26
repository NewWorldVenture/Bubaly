-- A chore, and its points, stay with the child who did it (0348).
--
-- Sibling B has an APPROVED assignment worth 50 points; child A has an open
-- one. As A: re-pointing B's approved assignment at A, deleting it, and
-- handing A's open chore to B must be refused. As B: reopening B's own
-- approved assignment must be refused. Controls: A starts A's own chore; the
-- PARENT moves A's chore to B.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eef1';
  uPar uuid := '00000000-0000-4000-8000-00000000eefa';
  uA uuid := '00000000-0000-4000-8000-00000000eefb';
  uB uuid := '00000000-0000-4000-8000-00000000eefc';
  mA uuid; mB uuid; chore uuid; bDone uuid; aOpen uuid;
  n int; failures int := 0; blocked boolean;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'ca-parent@example.com'), (uA, 'ca-a@example.com'), (uB, 'ca-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'child', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into public.chores (family_id, title, points) values (fam, 'Dishes', 50) returning id into chore;
  insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded)
    values (fam, chore, mB, 'approved', 50) returning id into bDone;
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
    values (fam, chore, mA, 'todo') returning id into aOpen;

  -- ── as A ──────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.chore_assignments set member_id = mA where id = bDone;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child took a sibling''s approved chore and its points (rows: %)', n; failures := failures + 1; end if;
  delete from public.chore_assignments where id = bDone;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a sibling''s approved chore (rows: %)', n; failures := failures + 1; end if;
  blocked := false;
  begin
    update public.chore_assignments set member_id = mB where id = aOpen;
    get diagnostics n = row_count;
    blocked := (n = 0);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise warning 'BREACH: a child handed their open chore to a sibling'; failures := failures + 1; end if;
  update public.chore_assignments set status = 'in_progress' where id = aOpen;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not start their own chore (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── as B: an approved chore is settled ───────────────────────────────────
  perform set_config('request.jwt.claim.sub', uB::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uB, 'role', 'authenticated')::text, true);
  set local role authenticated;
  blocked := false;
  begin
    update public.chore_assignments set status = 'todo' where id = bDone;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise warning 'BREACH: a child reopened their own approved chore'; failures := failures + 1; end if;
  reset role;

  -- ── as the PARENT (control) ──────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.chore_assignments set member_id = mB where id = aOpen;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not rebalance a chore (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'chore-assignment-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
