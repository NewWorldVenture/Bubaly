-- A feedback screenshot is not world-readable. (F-E05)
--
-- `feedback-attachments` was `public = true` AND carried an unscoped read
-- policy:
--
--   objects | Feedback attachments are publicly readable | SELECT | (bucket_id = 'feedback-attachments')
--
-- So every object was readable twice over — by the public path, which does not
-- consult storage.objects RLS at all, and by the authenticated path, whose
-- policy asked only which bucket the object was in. Writes were already scoped
-- correctly (`auth.uid()::text = (storage.foldername(name))[1]`); reads were
-- not scoped at all.
--
-- These are screenshots taken at the moment something in the product went
-- wrong, which is to say screenshots of a real family's calendar, children's
-- names, balances or documents. Object names are UUID-based so they are not
-- enumerable, and that is the only thing that was limiting this — an
-- unguessable name is not an access control, and a URL leaks the ordinary
-- ways: a Referer header, a paste into a ticket, a CDN log.
--
-- The upstream note proposed `auth.uid() = foldername[1] OR is_super_admin()`.
-- That is what is installed here, and the reasoning needed checking first,
-- because the Idea Board is deliberately cross-user — `feedback_ideas_select`
-- is `auth.uid() IS NOT NULL`, every signed-in user sees every family's ideas
-- (see AUTHZ-006), so a reader-scoped policy would have broken the product if
-- the board drew these images. It does not. Exactly one surface renders them,
-- `components/admin/feedback-admin.tsx`, behind the super-admin gate, reading
-- through the service role — and the board's own query no longer selects the
-- column at all.
--
-- So reads now go: private bucket, no public path; admin console mints a
-- 10-minute signed URL through the service role; and the owner keeps the read
-- that matches the INSERT and DELETE policies they already had, so the
-- uploader can still see what they attached.
--
-- Held by docs/audit/feedback-attachment-is-not-world-readable-check.sql.

update storage.buckets set public = false where id = 'feedback-attachments';

drop policy if exists "Feedback attachments are publicly readable" on storage.objects;

drop policy if exists "Feedback attachments are owner or admin readable" on storage.objects;
create policy "Feedback attachments are owner or admin readable"
  on storage.objects for select
  using (
    bucket_id = 'feedback-attachments'
    and (
      (auth.uid())::text = (storage.foldername(name))[1]
      or public.is_super_admin()
    )
  );
