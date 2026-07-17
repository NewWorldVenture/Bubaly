-- 0215_family_media_bucket.sql
-- Bring the `family-media` Storage bucket into version control (audit LB-009 / PLA-0461).
--
-- Four features upload here — Photos, Create-Memory, Message attachments, and
-- Reminder attachments — via lib/storage/family-media.ts, but the bucket was
-- created out-of-band in the Supabase dashboard, so a fresh project / the PG16
-- audit harness had NO bucket and every upload failed, and its policies lived
-- outside git. This migration defines the bucket + its family-folder write RLS.
--
-- Read visibility is intentionally left PUBLIC here: the consumers resolve
-- attachments with getPublicUrl and existing rows in family_photos /
-- family_messages already store public URLs, so flipping to private would break
-- every stored link. Hardening reads to signed URLs is tracked separately
-- (LB-009 follow-up) because it needs a data migration of the stored URLs.
--
-- Path convention (see buildFamilyPath-style callers): {family_id}/{...}/{file}.
-- The first path segment is the family id, which the write policies check via
-- storage.foldername(name)[1], mirroring the private `documents` bucket (0007).
-- Idempotent: safe to re-run and safe against an already-provisioned prod bucket
-- (insert ... on conflict do nothing never mutates the existing row).

insert into storage.buckets (id, name, public, file_size_limit)
values ('family-media', 'family-media', true, 26214400)
on conflict (id) do nothing;

-- Writes are family-scoped: a member may only create/modify/delete objects inside
-- their own family's folder. Reads stay public (bucket.public = true) to preserve
-- the getPublicUrl contract the app + stored URLs depend on; the family-scoped
-- SELECT policy below still governs authenticated Storage-API reads (defense in
-- depth) without affecting public-URL delivery.

drop policy if exists "Family members can read their media" on storage.objects;
create policy "Family members can read their media" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'family-media'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "Family members can upload their media" on storage.objects;
create policy "Family members can upload their media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'family-media'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "Family members can update their media" on storage.objects;
create policy "Family members can update their media" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'family-media'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'family-media'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "Family members can delete their media" on storage.objects;
create policy "Family members can delete their media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'family-media'
    and public.is_family_member(((storage.foldername(name))[1])::uuid)
  );
