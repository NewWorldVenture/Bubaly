-- A child's chore-proof folder is theirs (0350).
--
-- Child B's proof photo sits at <fam>/<B>/.... As SIBLING A: deleting it, and
-- uploading into B's folder, must be refused. Controls: A uploads to A's own
-- folder; the family can still read B's; the PARENT deletes B's photo.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ef11';
  uPar uuid := '00000000-0000-4000-8000-00000000ef1a';
  uA uuid := '00000000-0000-4000-8000-00000000ef1b';
  uB uuid := '00000000-0000-4000-8000-00000000ef1c';
  mA uuid; mB uuid; bPath text;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'ps-parent@example.com'), (uA, 'ps-a@example.com'), (uB, 'ps-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Proof storage family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'child', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into storage.buckets (id, name, public) values ('chore-proof', 'chore-proof', false) on conflict (id) do nothing;
  bPath := fam::text || '/' || mB::text || '/probe-0350-clean.jpg';
  insert into storage.objects (bucket_id, name, owner) values ('chore-proof', bPath, uB);

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'chore-proof' and name = bPath;
  if n <> 1 then raise warning 'CONTROL FAILED: the family cannot see B''s proof (%)', n; failures := failures + 1; end if;
  delete from storage.objects where bucket_id = 'chore-proof' and name = bPath;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling deleted someone''s proof photo (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('chore-proof', fam::text || '/' || mB::text || '/probe-0350-fake.jpg', uA);
    raise warning 'BREACH: a sibling uploaded into someone''s proof folder'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  insert into storage.objects (bucket_id, name, owner) values ('chore-proof', fam::text || '/' || mA::text || '/probe-0350-mine.jpg', uA);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not upload their own proof (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from storage.objects where bucket_id = 'chore-proof' and name = bPath;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete proof (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from storage.objects where bucket_id = 'chore-proof' and name like fam::text || '/%probe-0350-%';
  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'chore-proof-storage-check: % failure(s)', failures;
  end if;
end
$probe$;
