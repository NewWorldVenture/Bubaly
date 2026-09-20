-- Which buckets are readable by the whole internet, and why.
--
-- `storage.buckets.public` is not a hint. When it is true the Storage API serves
--   /storage/v1/object/public/<bucket>/<path>
-- to any request at all, and the RLS policies on `storage.objects` are not
-- consulted. `family-media` carries a correct policy —
--
--   Family members can read their media  SELECT
--     bucket_id = 'family-media' AND is_family_member((storage.foldername(name))[1]::uuid)
--
-- — and that policy governs the authenticated API while the public URL walks
-- straight past it. Measured against the running stack, uploading one object as
-- the service role and then fetching it with NO credentials of any kind:
--
--   upload                              -> HTTP 200
--   unauthenticated GET of family-media -> HTTP 200, "secret family photo bytes"
--   unauthenticated GET of documents    -> HTTP 400, "Bucket not found"
--
-- Same bytes, same path shape, same request. The only difference is the flag.
-- That is SEC-001, and this probe exists so the shape of the exposure is
-- checked rather than remembered.
--
-- ── what this probe does and does not assert ───────────────────────────────
--
-- It does NOT assert that `family-media` should be public. It is public today,
-- the record says so, and closing it needs every consumer moved off
-- `getPublicUrl` onto signed URLs first — flipping the flag alone would blank
-- every photo, avatar, attachment and album cover in the product.
--
-- What it asserts is that the set of internet-readable buckets is exactly the
-- set somebody declared, with a reason. Two things follow. A NEW bucket created
-- public is caught on the next run rather than discovered later. And the SEC-001
-- rollout cannot land quietly: flipping `family-media` to private makes this
-- probe fail until the declaration below is updated to say so, which is the
-- moment to check that the consumers really did move.
--
-- `tests/public-bucket-objects-are-unguessable.test.ts` holds the other half —
-- that an object in a public bucket is named with 122 bits of randomness rather
-- than a clock, because an unguessable name is the only thing standing between
-- these objects and the internet until the flag changes. That test carries its
-- own hardcoded list of four bucket names; this probe is what would notice a
-- fifth, since the test cannot see the migrations that create them.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  r        record;
  -- `feedback-attachments` came off this list with 0325 (F-E05). It is the
  -- first of the four to make the trip, and the trip is the point: the probe
  -- reported DECLARATION STALE the moment the flag flipped, which is exactly
  -- the prompt to go and check that the consumers really had moved. They had
  -- — one surface renders these objects, the super-admin triage console, and
  -- it now mints a 10-minute signed URL through the service role. Measured
  -- against the running stack with the same object at the same path:
  --
  --   unauthenticated GET, bucket public   -> HTTP 200, 67 bytes
  --   unauthenticated GET, bucket private  -> HTTP 400, "Bucket not found"
  --   unauthenticated GET of a signed URL  -> HTTP 200, 67 bytes
  declared text[] := array['avatars', 'marketplace-photos', 'family-media'];
  seen     int := 0;
  failures int := 0;
begin
  for r in select id, public from storage.buckets order by id loop
    seen := seen + 1;
    if r.public and not (r.id = any(declared)) then
      raise warning 'BREACH: bucket % is readable by the whole internet and is not on the declared list', r.id;
      failures := failures + 1;
    elsif not r.public and r.id = any(declared) then
      raise warning 'DECLARATION STALE: bucket % is declared internet-readable but is private. If this is the SEC-001 rollout, remove it from the list here and confirm every consumer uses signed URLs.', r.id;
      failures := failures + 1;
    end if;
  end loop;

  -- A vacuous pass is the obvious risk: no buckets, nothing to check.
  if seen < 5 then
    raise exception 'bucket-visibility: only % bucket(s) found — the scan is wrong, not the schema', seen;
  end if;

  -- The policy on the private buckets is what protects them, so prove one is
  -- really there. `documents` is the vault; if its family scoping ever
  -- disappeared, the bucket being private would be the only thing left.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and cmd = 'SELECT'
       and coalesce(qual, '') like '%documents%'
       and coalesce(qual, '') like '%is_family_member%'
  ) then
    raise warning 'BREACH: the documents bucket has no family-scoped SELECT policy';
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'bucket-visibility: % assertion(s) failed', failures;
  end if;
  raise notice 'bucket-visibility: OK — % buckets, and the internet-readable ones are exactly the % declared', seen, array_length(declared, 1);
end
$probe$;
