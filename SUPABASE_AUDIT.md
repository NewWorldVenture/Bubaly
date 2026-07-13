# Supabase Audit

## Current Project

- Configured host: live Supabase project loaded from `.env.local` (secret values omitted).
- Migration files at audit start: 193, through `0177_remove_synthetic_auth_users.sql`.
- New migration: `0178_marketplace_circles_rls_recursion.sql`.
- SQL files: 309.
- Static counts: 1,180 policy declarations, 639 RLS enable statements, 95 function declarations,
  413 trigger declarations, and 59 `storage.objects` references. Counts are source-text counts,
  not a claim that every object exists in the live database.

## Schema and RLS

The repository uses family-scoped access helpers such as `public.is_family_member` defined as pinned
SECURITY DEFINER functions. Migrations broadly enable RLS and define family/member policies. Existing
database documentation in `database-map.md` and the migration history cover the full object inventory.

### Defect Found and Repaired

Migration `0176_marketplace_circles.sql` queried `marketplace_circle_members` from that table's own
SELECT policy. The live REST probe reproduced:

```text
HTTP 500
code: 42P17
message: infinite recursion detected in policy for relation "marketplace_circle_members"
```

Migration `0178_marketplace_circles_rls_recursion.sql` adds:

- `is_marketplace_circle_member(uuid)` for current-user circle membership.
- `is_marketplace_circle_family_member(uuid, uuid)` for caller-family membership.
- Rewritten circle, member, share, and cross-family listing policies using those helpers.
- Ownership checks on listing-share deletion.

The migration pins `search_path`, is additive/idempotent in the normal migration sequence, and does
not delete or rewrite application data.

## Live Probe Results

- Required schema probes passed for the earlier required tables.
- `marketplace_circles` failed before `0178` with the recursion error above.
- Public Supabase Auth health passed.
- Supabase Auth Admin user listing failed with HTTP 500 `Database error finding users` and error id
  `019f5b84-d42e-7354-9db9-89b9460d2921`.

## Storage, Functions, Triggers, and Realtime

The repository contains storage policy references and extensive function/trigger migrations. A live
object-by-object verification was not completed because local Docker Supabase was unavailable and the
live Admin Auth/schema probes are unhealthy. No service-role key was exposed to the browser in the audit.
The complete migration/source inventory remains in `database-map.md` and `security-review.md`.

## Required Follow-up

1. Start an isolated Supabase instance with Docker Desktop.
2. Apply the full migration chain through `0178` and run `npm run db:audit:schema` and
   `npm run db:audit:auth`.
3. Test circle-owner, circle-member, non-member, cross-family listing, share insert, and share-delete
   allow/deny cases using separate authenticated users.
4. Inspect the live Auth Admin 500 in Supabase logs before any production launch decision.
