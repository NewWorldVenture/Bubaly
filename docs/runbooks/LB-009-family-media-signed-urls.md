# LB-009 / SEC-001 — make `family-media` private

`family-media` is the one bucket created `public = true` (migration `0216`), so every family photo,
message attachment, reminder image, closet and inventory photo is readable by anyone who holds its URL.
Writes are already family-scoped by `0216`; this runbook is about **reads**.

Out of scope, public by design: `avatars`, `marketplace-photos`. Already private and signed:
`documents`, `chore-proof`. (`feedback-attachments` is public and admin-facing; it is filed separately.)

## Where it stands

**Phase 1 — every consumer reads through a signed URL: DONE in the repository (SEC-001, Q59).**
Phase 2 of the earlier plan (a `storage_path` backfill for messages and reminders) is **no longer
needed**, and Phase 3 below is the only remaining step.

- `lib/storage/family-media-ref.ts` classifies any stored value — the public URL `getPublicUrl` built,
  a signed or render URL, or a bare `{family_id}/…` path — and signs the lot in one
  `createSignedUrls` call with the **viewer's** session. Because the path is read out of the URL that
  is already stored, no row has to change: there is no data migration.
- A reference that cannot be signed renders **nothing**. There is no fallback to the stored URL —
  that fallback is the public read this removes, and it would hide a failure until the flip.
- `lib/storage/use-family-media.ts` caches signed URLs **in memory only**, for one session: it is
  cleared on sign-out or identity change, and a signing call that finishes after a sign-out is
  discarded. URLs are reused for most of their hour so the browser cache and the kiosk slideshow keep
  working. Signed URLs are never written to a row or to the offline cache.
- `components/media/family-media-img.tsx` is the one `<img>` for a stored reference.
- Consumers moved: Photos (grid, list, lightbox image/video/download, album covers, edit preview),
  Messages (image, file, voice note, shared-photo rail), Reminders (card, editor), Closet and
  Inventory (lists, recommendations, editors), On This Day, Family (cover, album highlights), and
  the server pages Home, Planning, Memories, Grandparent portal and Display. The optimised
  `next/image` path is no longer used for these: its output is marked `public`.
- Writers are unchanged and still store the public-URL shape (`family_photos.url`,
  `family_messages.attachment_url`, `family_reminders.image_url`) or a bare path
  (`photo_path`). The stored value is now a *reference*, not something rendered.
- Guards: `tests/a-family-photo-is-signed-not-public.test.ts` (parser, signer, cache) and
  `tests/a-family-media-reference-is-never-rendered-raw.test.ts` (no consumer renders a stored field
  raw; `getPublicUrl` on this bucket survives only in the four reference writers).

Authorisation happens at signing: Storage checks `0216`'s "Family members can read their media"
policy, `is_family_member((storage.foldername(name))[1])`. A grandparent in two households signs
both families' photos; nobody signs a family they are not in.

## Phase 3 — flip the bucket private (an operator, after Phase 1 is LIVE)

Not a migration file on purpose. `.github/workflows/supabase-production-migrations.yml` runs
`supabase db push` when migrations land on `main`, so a flip committed with the consumer change would
reach production **before** the new clients were deployed, and every open tab and installed PWA
still on the old build would lose every image. The order is the whole safety argument:

1. The release carrying Phase 1 is deployed to production, and has been live long enough for open
   clients to update (the service worker `bubaly-v5` activates on next load).
2. Spot-check in production: Photos, Messages, Reminders, Memories, Home and the Display render, and
   the network tab shows `/storage/v1/object/sign/family-media/…` requests, not `/object/public/…`.
3. Then, once:
   ```sql
   update storage.buckets set public = false where id = 'family-media';
   ```
   Commit the same statement afterwards as the next free migration number so the repository and
   the ledger agree — applied by the operator, never by an agent.

### Verify
- A stored `…/object/public/family-media/<path>` URL now answers 400/403.
- A member of the family sees their photos, attachments and reminder images.
- A member of family A cannot sign a family-B object (expect a per-item error, and nothing renders).
- A grandparent in two households sees both households' photos in the portal.
- After sign-out, the next user on the same device is not shown the previous user's images.

### Rollback
`update storage.buckets set public = true where id = 'family-media';` — Phase 1 reads work either
way, so both the flip and its rollback are non-breaking for current clients.

## What a signed URL does and does not promise
A signed URL is a bearer credential until it expires (one hour). It is minted only for a member, but
it is not re-checked per request, so removing someone from a family or signing out does not revoke a
URL they already hold — it expires. That is the documented contract; shorten
`FAMILY_MEDIA_SIGNED_TTL_SECONDS` if the owner wants a tighter window.
