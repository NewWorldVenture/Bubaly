-- A public bucket is not a public listing (0343).
--
-- With one object per public bucket in user U's folder: the ANON role and
-- another signed-in user must see none of them through storage.objects (which
-- is what the LIST endpoint queries). Control: U sees their own.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  uU uuid := '00000000-0000-4000-8000-00000000eea1';
  uV uuid := '00000000-0000-4000-8000-00000000eea2';
  b text;
  n int; failures int := 0;
begin
  delete from storage.objects where name like uU::text || '/probe-0343-%';
  insert into auth.users (id, email) values (uU, 'bucket-u@example.com'), (uV, 'bucket-v@example.com') on conflict (id) do nothing;
  foreach b in array array['avatars', 'feedback-attachments', 'marketplace-photos'] loop
    insert into storage.buckets (id, name, public) values (b, b, true) on conflict (id) do nothing;
    insert into storage.objects (bucket_id, name, owner) values (b, uU::text || '/probe-0343-' || b || '.png', uU);
  end loop;

  set local role anon;
  select count(*) into n from storage.objects where name like uU::text || '/probe-0343-%';
  if n <> 0 then raise warning 'BREACH: the anon key can list public buckets (% objects)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uV::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uV, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where name like uU::text || '/probe-0343-%';
  if n <> 0 then raise warning 'BREACH: another user can list U''s public-bucket objects (%)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uU::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uU, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where name like uU::text || '/probe-0343-%';
  if n <> 3 then raise warning 'CONTROL FAILED: U cannot see their own objects (%)', n; failures := failures + 1; end if;
  reset role;

  delete from storage.objects where name like uU::text || '/probe-0343-%';
  delete from auth.users where id in (uU, uV);

  if failures > 0 then
    raise exception 'public-bucket-listing-check: % failure(s)', failures;
  end if;
end
$probe$;
