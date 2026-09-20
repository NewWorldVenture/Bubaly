-- A feedback screenshot answers to its owner and to the admin. (F-E05)
--
-- `feedback-attachments` was `public = true` AND carried an unscoped read
-- policy, so every object was readable twice over: by the public path, which
-- does not consult storage.objects RLS at all, and by the authenticated path,
-- whose policy asked only which bucket the object was in.
--
--   objects | Feedback attachments are publicly readable | SELECT | (bucket_id = 'feedback-attachments')
--
-- Measured against the running stack, the same object at the same path, with no
-- credentials of any kind:
--
--   unauthenticated GET, bucket public   -> HTTP 200, 67 bytes
--   unauthenticated GET, bucket private  -> HTTP 400, "Bucket not found"
--   unauthenticated GET of a signed URL  -> HTTP 200, 67 bytes
--
-- The flag half of that is held by bucket-visibility-is-declared-check.sql,
-- which reported DECLARATION STALE the moment 0325 flipped it. This probe holds
-- the policy half, which is what governs the authenticated API once the public
-- path is closed — and which a flag flip alone would leave wide open.
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Wrapped in a transaction that is rolled back, rather than cleaned up at the
-- end. `storage.protect_delete()` refuses a direct DELETE from storage.objects
-- — "Use the Storage API instead" — so a probe that needs an object cannot
-- remove the one it made. A rollback leaves nothing behind either way, and on a
-- failed assertion the abort does it for us.
begin;

do $probe$
declare
  owner_id uuid := '7f000000-0000-4000-8000-00000000fe11';
  other_id uuid := '7f000000-0000-4000-8000-00000000fe12';
  obj      uuid := '7f000000-0000-4000-8000-00000000fe13';
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (owner_id, 'fe05-owner@example.test'), (other_id, 'fe05-other@example.test')
  on conflict (id) do nothing;

  -- The object the uploader owns, at {userId}/{unguessable}.png — the path
  -- shape the INSERT policy already enforces.
  insert into storage.objects (id, bucket_id, name, owner)
    values (obj, 'feedback-attachments', owner_id::text || '/probe-fe05.png', owner_id);

  -- 1. The flag. Without this the policy below governs nothing: the public path
  --    walks past storage.objects entirely.
  if (select public from storage.buckets where id = 'feedback-attachments') then
    raise warning 'BREACH: feedback-attachments is public, so the SELECT policy below is not the control';
    failures := failures + 1;
  end if;

  -- 2. The blanket policy is gone. Its qual named only the bucket, so it
  --    admitted every signed-in user on the authenticated path.
  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and cmd = 'SELECT'
       and coalesce(qual, '') like '%feedback-attachments%'
       and coalesce(qual, '') not like '%foldername%'
  ) then
    raise warning 'BREACH: an unscoped SELECT policy on feedback-attachments is back';
    failures := failures + 1;
  end if;

  -- 3. Another signed-in user cannot read it. This is the assertion the flag
  --    cannot make: a private bucket still serves the authenticated path.
  perform set_config('request.jwt.claim.sub', other_id::text, true);
  set local role authenticated;
  if auth.uid() is distinct from other_id then
    raise exception 'CONTROL FAILED: impersonation did not take — auth.uid() is %', auth.uid();
  end if;
  select count(*) into n from storage.objects where id = obj;
  if n > 0 then
    raise warning 'BREACH: a signed-in user read another person''s feedback screenshot (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 4. The uploader still can, or the fix has taken their own attachment away
  --    from them. This is the control that stops "nobody can read it" passing
  --    as a boundary.
  reset role;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where id = obj;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the uploader cannot read their OWN attachment (rows: %) — the fix went too far', n;
    failures := failures + 1;
  end if;

  -- 5. The writes were already scoped, and must stay that way.
  reset role;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and cmd = 'INSERT'
       and coalesce(with_check, '') like '%feedback-attachments%'
       and coalesce(with_check, '') like '%foldername%'
  ) then
    raise warning 'BREACH: the INSERT policy on feedback-attachments no longer scopes to the uploader''s folder';
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'feedback-attachments is readable beyond its owner: % finding(s)', failures;
  end if;
  raise notice 'OK: a feedback screenshot answers to its uploader and the admin, and to nobody else.';
end
$probe$;

rollback;
