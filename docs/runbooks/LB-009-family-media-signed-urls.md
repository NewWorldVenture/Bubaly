# LB-009 plan — flip `family-media` from public URLs to private + signed URLs

**A-11 (agent-03). Owner/product decision + a bounded code+data migration.** The bucket already has
family-folder write-RLS (migration `0216`); LB-009 is only about the **read** side: object URLs are
currently unauthenticated (`getPublicUrl`). This is the concrete plan to make them private without
breaking existing media.

## Scope (what is and isn't in this)

- **In scope: the `family-media` bucket only** — private family Photos + Memories and Message/Reminder
  attachments. These are personal family content and should not be world-readable by anyone who learns
  the URL.
- **Out of scope (public by design, leave as-is):** `avatars` (public profile pics), `marketplace-photos`
  (public listings), `feedback-attachments` (admin feedback board). `documents` + `chore-proof` are
  already private + signed.

## Current state (grounded in the code)

`family-media` bucket is `public=true`. Four client upload sites write a **public** URL into a DB row:

| Consumer | Table + column written | Also stores path? |
|----------|------------------------|-------------------|
| `components/modules/photos-module.tsx:105` | `family_photos.url` | **YES — `family_photos.storage_path` is already written** |
| `components/memories/create-memory.tsx:103` | `family_photos.url` | YES (same table) |
| `components/modules/messages-module.tsx:389` | `family_messages.attachment_url` | **NO — only the URL** |
| `components/modules/reminders-module.tsx:624` | reminder `photo_url` | check the reminders insert for a path column |

The signing primitive already exists and is proven: `lib/storage/documents.ts` →
`getDocumentSignedUrl(supabase, path, expiresInSeconds)` = `storage.from(BUCKET).createSignedUrl(path, ...)`,
used by `files-hub-module`. `0216` already added a **family-scoped SELECT policy** on `storage.objects`
for `family-media`, so `createSignedUrl` works for members once the bucket is private.

**Key simplification:** `family_photos` already persists `storage_path`, so Photos/Memories need **no
data migration** — reads just sign `storage_path` instead of using `url`. Only `family_messages` (and
possibly reminders) needs a one-time path backfill.

## Migration — sequence matters (each phase is safe on its own; do them in order)

### Phase 1 — read-time signing (code; deploy FIRST, while bucket is still public)
Signed URLs resolve for objects in a public bucket too, so this phase is safe to ship before flipping
the bucket. No user-visible change yet.
1. Add `lib/storage/family-media.ts` → `getFamilyMediaSignedUrl(supabase, path, expiresIn=3600)` mirroring
   `getDocumentSignedUrl` (bucket `'family-media'`).
2. Change the **reads** that render family media to sign the path instead of using the stored public URL:
   - Photos/Memories: sign `family_photos.storage_path` (already present).
   - Messages: needs a path — see Phase 2 (add + backfill `storage_path`), then sign it.
3. Change the **writes** to stop depending on the public URL: keep storing `storage_path`; the stored
   `url`/`attachment_url` column can become nullable/legacy (reads no longer need it).

### Phase 2 — data migration for `family_messages` (+ reminders if applicable)
The public URL format is `…/storage/v1/object/public/family-media/<path>`. Backfill the path:
```sql
alter table public.family_messages add column if not exists storage_path text;
update public.family_messages
   set storage_path = split_part(attachment_url, '/family-media/', 2)
 where attachment_url like '%/family-media/%' and storage_path is null;
-- verify: every attachment row now has a path
select count(*) from public.family_messages where attachment_url is not null and storage_path is null; -- expect 0
```
(Repeat the pattern for the reminders media column if it also stores a public URL with no path.)

### Phase 3 — flip the bucket private (one line; only AFTER Phases 1–2 are deployed + verified)
```sql
update storage.buckets set public = false where id = 'family-media';
```
Now public URLs 403, and only members holding a signed URL (or generating one via the family-scoped
SELECT policy from `0216`) can read. Existing rows keep working because reads sign the path.

### Phase 4 — verify
- A raw `…/object/public/family-media/<path>` URL now returns **403/400**.
- A member loads Photos/Messages/Memories and images render (signed URLs).
- **Cross-family:** a member of family A cannot `createSignedUrl` for a family-B object (blocked by the
  `0216` `is_family_member(foldername[1])` SELECT policy) — this is the same isolation I proved for the
  write side in the PLA-0442/0216 work; confirm it live on the read side too.
- Flip LB-009 to Resolved once public URLs are dead and signed reads work.

## Rollback
`update storage.buckets set public = true where id='family-media';` — instantly restores public reads.
Because Phase 1 made reads use signed URLs (which also resolve public objects), the app works either way,
so the flip and its rollback are both non-breaking. Ship Phase 1 well before the flip to de-risk.

## Effort / risk
- Code: ~1 helper + read/write edits in 3–4 modules (photos, memories, messages, reminders) + 1 additive
  migration (messages `storage_path`) + the backfill. Small, well-patterned (documents already do this).
- Risk: LOW if sequenced as above (signing before flipping). The only real hazard is flipping the bucket
  private *before* reads sign — that would break every existing image; the ordering above prevents it.
- Decision needed from owner/product: signed-URL expiry window (default 1h is fine for in-app rendering;
  longer if links are shared externally, though external sharing argues for keeping some content public).
