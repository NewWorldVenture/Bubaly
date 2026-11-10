# Family Vault — Wi-Fi & Passwords

Shared family credentials store: Wi-Fi networks, streaming/website/app logins,
door PINs, membership numbers, cards. Backs the Family hub's **"Wi-Fi &
Passwords"** card.

## Where
- **Route:** `/dashboard/passwords` → `components/modules/passwords-module.tsx`
- **Entry point:** Family hub (`/dashboard/family`) → "Wi-Fi & Passwords" card
  (shows a live count, links here). Not added to the global sidebar (per the
  `/memory.md` nav rule).
- **Gate:** `app/(app)/dashboard/passwords/page.tsx` treats the vault as part
  of the Documents area: `requireFeature('/dashboard/documents')`, then
  `requireAal2(ctx, 'documents', '/dashboard/passwords')` (step-up for a
  parent or adult who has a verified authenticator).

## Data
- **Table:** `public.family_credentials` (migration `0119_family_credentials.sql`).
  Columns: `category` (wifi/website/app/streaming/email/card/pin/membership/other),
  `label`, `username`, `secret`, `url`, `notes`, `member_id` (owner, nullable),
  `is_favorite`, `created_by`, timestamps, `deleted_at` (legacy soft-delete
  column: the screen no longer stamps it, see Behavior, but reads still filter
  on `deleted_at is null`).
- **RLS:** managers only (parent or adult), not every family member.
  `0296_family_credentials_manager_only.sql` replaced the original
  `public.is_family_member(family_id)` policies with
  `public.can_manage_family(family_id)` for SELECT/INSERT/UPDATE/DELETE, so a
  child's session reads and writes nothing here.
  `0391_a_password_alone_does_not_open_the_familys_vault.sql` adds restrictive
  step-up guards on all four operations: a manager who has a verified
  authenticator needs an aal2 session. `updated_at` trigger via
  `public.set_updated_at()`.
- **Types:** `Tables<'family_credentials'>` in `lib/database.types.ts`.

## Behavior (100% wired)
- Realtime read (`useRealtimeQuery`), create/update, **hard delete** (a real
  `DELETE` of the row, not a `deleted_at` stamp) with a confirm dialog, search,
  category filter chips (with counts), favorite pin-to-top, per-item
  **reveal / copy** for the secret and username. Loading skeleton, empty, and
  error states; toasts throughout.
- Delete used to stamp `deleted_at`. Nothing ever purged a stamped row, so the
  plaintext secret stayed readable through the table after the screen said it
  was gone; `remove()` in `components/modules/passwords-module.tsx` now deletes
  the row and reads the result back, so a refused delete is reported as not
  saved rather than as success.

## Seed
- `supabase/seed_credentials_all_families.sql` is a legacy-named **local demo
  fixture only**. It seeds only the exact synthetic `The Patel Family` row from
  `supabase/seed.sql` and refuses to proceed unless that fixture's ID and name
  both match. It performs data-only operations on that fixture's credentials;
  it does not create tables or change RLS policies. Do not run it against a
  hosted Supabase project or production SQL Editor.

## Security notes / limitations
- Secrets are stored as plain text behind the manager-only RLS and step-up
  guards above, and **masked in the UI by default** (revealed on demand; copy
  never requires a reveal).
- **Future hardening:** client-side / at-rest encryption of `secret` (e.g. a
  per-family key) so plaintext is never at rest. Tracked as a follow-up.
