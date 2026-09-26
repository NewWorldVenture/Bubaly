-- Bubaly :: 0343 - a public bucket is not a public listing
--
-- avatars, feedback-attachments and marketplace-photos are public buckets:
-- their objects are served at /storage/v1/object/public/<bucket>/<name>
-- without consulting RLS. Each ALSO carried "… are publicly readable":
-- FOR SELECT USING (bucket_id = '…') to PUBLIC. RLS SELECT on storage.objects
-- is what the storage LIST endpoint runs, so that policy let anyone - the anon
-- key is in every page - list the whole bucket: every user id (the first path
-- segment) and every object name. Pass N made those names unguessable
-- (crypto.randomUUID) precisely because, for a public bucket, the name is the
-- boundary; a listable bucket has no boundary at all. feedback-attachments
-- holds screenshots of the product - names, schedules, balances (F-E05).
--
-- Public URLs keep working without a SELECT policy. What the application does
-- through the API is always in the caller's own folder (upload, upsert for
-- avatars, remove), so SELECT becomes "your own folder".
--
-- Pinned by docs/audit/public-bucket-listing-check.sql.

do $$
declare
  b text;
begin
  foreach b in array array['avatars', 'feedback-attachments', 'marketplace-photos'] loop
    execute format('drop policy if exists %I on storage.objects',
      case b when 'avatars' then 'Avatars are publicly readable'
             when 'feedback-attachments' then 'Feedback attachments are publicly readable'
             else 'Marketplace photos are publicly readable' end);
    execute format('drop policy if exists %I on storage.objects', 'Users read their own ' || b);
    execute format(
      'create policy %I on storage.objects for select to authenticated using (bucket_id = %L and (auth.uid())::text = (storage.foldername(name))[1])',
      'Users read their own ' || b, b);
  end loop;
end
$$;
