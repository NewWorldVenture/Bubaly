-- Family media is private. (SEC-001)
--
-- `family-media` was created public (0216) so the `getPublicUrl` links the app
-- stored would keep working. A public bucket is served at
-- /storage/v1/object/public/family-media/<path> to ANY request, and the
-- storage.objects policies are never consulted. The family-scoped SELECT
-- policy ("Family members can read their media") was correct and decorative.
-- Measured on the local stack, one object uploaded by the service role:
--
--   unauthenticated GET of its stored public URL   -> HTTP 200, the bytes
--
-- Family photos, videos, message attachments, reminder images and closet and
-- inventory pictures: readable by anyone who ever saw a URL, for ever, with
-- no way to revoke it short of deleting the object.
--
-- Every reader now resolves a stored value through signFamilyMediaRefs
-- (lib/storage/family-media-ref.ts), which asks Storage for a short-lived
-- signed URL with the viewer's own session. That request IS authorized by the
-- SELECT policy, so it works for a member and returns nothing for anyone else
-- whether the bucket is public or private. Stored values are not rewritten: a
-- stored public URL is read as a reference to the object it names.
--
-- DEPLOY-COUPLED. Apply this AFTER the deploy that carries the signed-URL
-- readers is live. Applied first, every photo, attachment and cover in the
-- product goes blank until that deploy lands, because the old code draws the
-- stored public URLs directly. The reverse order is safe: the new code reads
-- through signed URLs while the bucket is still public.
--
-- Measured on the local stack after this migration, the same object:
--
--   unauthenticated GET of its stored public URL   -> refused
--   member, stored public URL via the app helper   -> HTTP 200, the bytes
--   signed-in non-member, same helper              -> nothing (null)

update storage.buckets set public = false where id = 'family-media';

do $check$
declare
  missing text;
begin
  if exists (select 1 from storage.buckets where id = 'family-media' and public) then
    raise exception '0338: family-media is still public';
  end if;

  -- With the bucket private, these four policies are the whole of the access
  -- model: members read, upload, update and delete their own family's media.
  -- `want.op`, qualified: an unqualified `cmd` in the subquery would resolve to
  -- pg_policies.cmd and match every row.
  select string_agg(want.op, ', ') into missing
    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as want(op)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects' and p.cmd = want.op
        and (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%family-media%'
        and (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%is_family_member%'
   );
  if missing is not null then
    raise exception '0338: family-media has no family-scoped storage policy for: %', missing;
  end if;
end
$check$;
