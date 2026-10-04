# Family Vault — Wi-Fi & Passwords

Shared family credentials store: Wi-Fi networks, streaming/website/app logins,
door PINs, membership numbers, cards. Backs the Family hub's **"Wi-Fi &
Passwords"** card.

## Where
- **Route:** `/dashboard/passwords` → `components/modules/passwords-module.tsx`
- **Entry point:** Family hub (`/dashboard/family`) → "Wi-Fi & Passwords" card
  (shows a live count, links here). Not added to the global sidebar (per the
  `/memory.md` nav rule).

## Data
- **Table:** `public.family_credentials` (migration `0119_family_credentials.sql`).
  Columns: `category` (wifi/website/app/streaming/email/card/pin/membership/other),
  `label`, `username`, `secret`, `url`, `notes`, `member_id` (owner, nullable),
  `is_favorite`, `created_by`, timestamps, `deleted_at` (soft delete).
- **RLS:** family-scoped for SELECT/INSERT/UPDATE/DELETE via
  `public.is_family_member(family_id)`. `updated_at` trigger via
  `public.set_updated_at()`.
- **Types:** `Tables<'family_credentials'>` in `lib/database.types.ts`.

## Behavior (100% wired)
- Realtime read (`useRealtimeQuery`), create/update, **soft-delete** (sets
  `deleted_at`) with a confirm dialog, search, category filter chips (with
  counts), favorite pin-to-top, per-item **reveal / copy** for the secret and
  username. Loading skeleton, empty, and error states; toasts throughout.

## Seed
- `supabase/seed_credentials_all_families.sql` is a legacy-named **local demo
  fixture only**. It seeds only the exact synthetic `The Patel Family` row from
  `supabase/seed.sql` and refuses to proceed unless that fixture's ID and name
  both match. It performs data-only operations on that fixture's credentials;
  it does not create tables or change RLS policies. Do not run it against a
  hosted Supabase project or production SQL Editor.

## Security notes / limitations
- Secrets are stored as text behind family RLS and **masked in the UI by
  default** (revealed on demand; copy never requires a reveal).
- **Future hardening:** client-side / at-rest encryption of `secret` (e.g. a
  per-family key) so plaintext is never at rest. Tracked as a follow-up.
