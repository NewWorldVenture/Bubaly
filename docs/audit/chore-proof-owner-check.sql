-- Chore proof is the submitter's (0349).
--
-- Child B's proof waits for review. As SIBLING A: swapping B's photos and
-- note, filing a submission in B's name, and deleting B's must be refused.
-- Controls: A files A's own; the PARENT updates B's.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ef01';
  uPar uuid := '00000000-0000-4000-8000-00000000ef0a';
  uA uuid := '00000000-0000-4000-8000-00000000ef0b';
  uB uuid := '00000000-0000-4000-8000-00000000ef0c';
  mA uuid; mB uuid; chore uuid; asgA uuid; asgB uuid; subB uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'cp-parent@example.com'), (uA, 'cp-a@example.com'), (uB, 'cp-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Proof family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'child', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into public.chores (family_id, title) values (fam, 'Dishes') returning id into chore;
  insert into public.chore_assignments (family_id, chore_id, member_id, status) values (fam, chore, mA, 'todo') returning id into asgA;
  insert into public.chore_assignments (family_id, chore_id, member_id, status) values (fam, chore, mB, 'submitted') returning id into asgB;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, note, media_paths, status)
    values (fam, asgB, chore, mB, 'All clean', array['f/b/clean.jpg'], 'pending') returning id into subB;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.chore_submissions set media_paths = array['f/b/messy.jpg'], note = 'did nothing' where id = subB;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling swapped someone''s chore proof (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, note, status)
      values (fam, asgB, chore, mB, 'forged', 'pending');
    raise warning 'BREACH: a sibling filed proof in someone''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  delete from public.chore_submissions where id = subB;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling deleted someone''s proof (rows: %)', n; failures := failures + 1; end if;
  insert into public.chore_submissions (family_id, assignment_id, chore_id, member_id, note, status)
    values (fam, asgA, chore, mA, 'done', 'pending');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not file their own proof (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.chore_submissions set note = 'Reviewed' where id = subB;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not update proof (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'chore-proof-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
