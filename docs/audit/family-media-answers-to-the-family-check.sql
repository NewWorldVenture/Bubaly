-- A family's photos answer to the family, and to nobody else. (SEC-001)
--
-- `family-media` was `public = true` from 0216 until 0459, so the public path
--   /storage/v1/object/public/family-media/<family id>/<folder>/<name>
-- served every object to any request, and 0216's member-scoped SELECT policy
-- governed only the authenticated API. With 0459 the public path is closed and
-- that policy is the whole read control: every reader signs through
-- `signFamilyMediaRefs` with the viewer's session, and Storage consults this
-- policy before it signs.
--
-- bucket-visibility-is-declared-check.sql holds the flag. This probe holds the
-- policy, which is what a flag flip alone would leave unproved: that a member
-- of the photo's family can read it (or every photo in the product is blank),
-- and that a signed-in member of ANOTHER family cannot (or the flip bought
-- nothing on the authenticated path).
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Rolled back rather than cleaned up: storage.protect_delete() refuses a direct
-- DELETE from storage.objects, so a probe cannot remove the object it made.
begin;

do $probe$
declare
  parent_a uuid := '7f000000-0000-4000-8000-0000000f0e01';
  member_a uuid := '7f000000-0000-4000-8000-0000000f0e02';
  parent_b uuid := '7f000000-0000-4000-8000-0000000f0e03';
  family_a uuid := '7f000000-0000-4000-8000-0000000f0e04';
  family_b uuid := '7f000000-0000-4000-8000-0000000f0e05';
  obj      uuid := '7f000000-0000-4000-8000-0000000f0e06';
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (parent_a, 'sec001-parent-a@example.test'),
    (member_a, 'sec001-member-a@example.test'),
    (parent_b, 'sec001-parent-b@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (family_a, 'Family A', parent_a),
    (family_b, 'Family B', parent_b)
  on conflict do nothing;
  -- on_family_created files each creator as a parent; the second member of A
  -- is added the way the app adds one.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (family_a, member_a, 'Grandma', 'adult', true)
  on conflict do nothing;

  -- One of family A's photos, at the path shape the INSERT policy enforces.
  insert into storage.objects (id, bucket_id, name, owner)
    values (obj, 'family-media', family_a::text || '/photos/probe-sec001.jpg', parent_a);

  -- 1. The flag. Without it the policy below governs nothing: the public path
  --    walks past storage.objects entirely.
  if coalesce((select public from storage.buckets where id = 'family-media'), true) then
    raise warning 'BREACH: family-media is public, so any request with a photo''s URL reads it';
    failures := failures + 1;
  end if;

  -- 2. A signed-in member of another family cannot read it. This is the
  --    assertion the flag cannot make.
  perform set_config('request.jwt.claim.sub', parent_b::text, true);
  set local role authenticated;
  if auth.uid() is distinct from parent_b then
    raise exception 'CONTROL FAILED: impersonation did not take — auth.uid() is %', auth.uid();
  end if;
  select count(*) into n from storage.objects where id = obj;
  if n > 0 then
    raise warning 'BREACH: a member of another family read family A''s photo (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 3. The photo's own family can, both the uploader and another member, or
  --    the fix has blanked every photo in the product. This is the control
  --    that stops "nobody can read it" passing as a boundary.
  foreach n in array array[1, 2] loop
    reset role;
    perform set_config('request.jwt.claim.sub', (case n when 1 then parent_a else member_a end)::text, true);
    set local role authenticated;
    if not exists (select 1 from storage.objects where id = obj) then
      raise warning 'CONTROL FAILED: % of family A cannot read the family''s own photo — the fix went too far',
        case n when 1 then 'the uploader' else 'another member' end;
      failures := failures + 1;
    end if;
  end loop;

  -- 4. Anonymous callers read nothing on the authenticated path either.
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  select count(*) into n from storage.objects where id = obj;
  if n > 0 then
    raise warning 'BREACH: an anonymous caller read family A''s photo through the API (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 5. Writes were already family-scoped, and must stay that way. Exercise
  -- the policy instead of requiring the membership helper's name inline:
  -- 0475 now delegates family + conversation authorization to a private helper.
  -- The successful own-family INSERT ensures a denial is not a missing grant.
  reset role;
  perform set_config('request.jwt.claim.sub', parent_a::text, true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('family-media', family_a::text || '/photos/probe-sec001-own-upload.jpg', parent_a);
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a member cannot upload into their own family';
    failures := failures + 1;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', parent_b::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner)
      values ('family-media', family_a::text || '/photos/probe-sec001-foreign-upload.jpg', parent_b);
    raise warning 'BREACH: a member uploaded into another family';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;
  -- Teardown: clear the simulated member so nothing after this runs as them.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  if failures > 0 then
    raise exception 'family-media is readable beyond the family: % finding(s)', failures;
  end if;
  raise notice 'OK: a family''s photos answer to its members, and to nobody else.';
end
$probe$;

rollback;
