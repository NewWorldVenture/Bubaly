-- ── 0330: a public bucket serves what you put in it ────────────────────────
--
-- Four buckets in this project are `public = true`, so their objects are served
-- from /storage/v1/object/public/… with no session. Three pinned
-- `allowed_mime_types` from the day they were created. `family-media` — the one
-- that takes the widest range of uploads — did not, and 0216's header reasons
-- carefully about read visibility without ever mentioning content type.
--
-- Measured before 0330:
--   NOTICE: public bucket family-media has NO allowed_mime_types
--
-- This asserts the general rule rather than the one bucket, so the next public
-- bucket is covered on the day it is added.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/public-bucket-mime-check.sql
--
-- Audit C1-S8-10.
do $$
declare
  r record;
  n int;
  holes text[] := '{}';
  -- What a browser executes when it is served from an origin.
  executable text[] := array['image/svg+xml', 'text/html', 'application/xhtml+xml',
                             'text/xml', 'application/xml', 'text/javascript',
                             'application/javascript'];
begin
  select count(*) into n from storage.buckets where public;
  if n < 4 then
    raise exception '0330: only % public bucket(s) found — this probe is not looking at what it claims', n;
  end if;

  for r in select id, allowed_mime_types from storage.buckets where public loop
    if r.allowed_mime_types is null or cardinality(r.allowed_mime_types) = 0 then
      holes := holes || format('public bucket %s has NO allowed_mime_types', r.id);
      raise notice 'public bucket % has NO allowed_mime_types', r.id;
    elsif r.allowed_mime_types && executable then
      holes := holes || format('public bucket %s allows an executable type: %s', r.id,
        array_to_string(array(select unnest(r.allowed_mime_types) intersect select unnest(executable)), ', '));
      raise notice 'public bucket % allows an executable type', r.id;
    end if;
  end loop;

  -- The types the product's own file pickers offer must still be storable, or
  -- the fix has broken the feature it was protecting.
  select count(*) into n from storage.buckets
   where id = 'family-media'
     and allowed_mime_types @> array['image/jpeg', 'image/heic', 'video/mp4',
                                     'application/pdf', 'text/plain'];
  if n <> 1 then
    raise exception '0330: family-media no longer accepts a type the UI offers';
  end if;

  -- A PRIVATE bucket is a different question: `documents` and `chore-proof` are
  -- reached through RLS and signed URLs, so an unrestricted type list there is
  -- not this rule's business. Asserted so the rule is not quietly widened.
  select count(*) into n from storage.buckets where not public and allowed_mime_types is null;
  if n = 0 then
    raise notice '0330 note: every private bucket now pins types too — harmless, but this rule never required it';
  end if;

  if array_length(holes, 1) is not null then
    raise exception '0330: %', array_to_string(holes, '; ');
  end if;
  raise notice '0330 OK — every public bucket pins its types, and none of them serves an executable one';
end $$;
