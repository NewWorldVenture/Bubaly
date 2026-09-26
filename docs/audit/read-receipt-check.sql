-- A read receipt is the reader's (0336).
--
-- As TEEN A: marking sibling B as having read an announcement, and erasing
-- B's receipt, must be refused. Control: A marks their own read.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee31';
  uPar uuid := '00000000-0000-4000-8000-00000000ee3a';
  uA uuid := '00000000-0000-4000-8000-00000000ee3b';
  uB uuid := '00000000-0000-4000-8000-00000000ee3c';
  mA uuid; mB uuid; ann uuid; ann2 uuid; bRead uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'read-parent@example.com'), (uA, 'read-a@example.com'), (uB, 'read-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Receipt family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into public.family_announcements (family_id, title) values (fam, 'House rules') returning id into ann;
  insert into public.family_announcements (family_id, title) values (fam, 'Curfew') returning id into ann2;
  insert into public.announcement_reads (announcement_id, family_id, member_id) values (ann2, fam, mB) returning id into bRead;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.announcement_reads (announcement_id, family_id, member_id) values (ann, fam, mB);
    raise warning 'BREACH: a member marked a sibling as having read an announcement'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  delete from public.announcement_reads where id = bRead;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member erased a sibling''s read receipt (rows: %)', n; failures := failures + 1; end if;
  insert into public.announcement_reads (announcement_id, family_id, member_id) values (ann, fam, mA);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not mark their own read (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'read-receipt-check: % failure(s)', failures;
  end if;
end
$probe$;
