# LB-001 runbook — Supabase Auth Admin returns HTTP 500 "Database error finding users"

**Owner-actionable. P0 launch blocker.** Prepared by `agent-03` from the codebase; the actual fix
happens in the Supabase project dashboard / SQL editor (no prod credentials in the build sandbox).

## Exact symptom

`npm run db:audit:auth` (`scripts/audit-supabase-auth.mjs`) probes two GoTrue endpoints:

| Probe | Endpoint | Key | Observed |
|-------|----------|-----|----------|
| public auth health | `GET /auth/v1/health` | anon | **OK (200)** |
| admin users query | `GET /auth/v1/admin/users?page=1&per_page=1` | service-role | **HTTP 500 `Database error finding users`** |

The app hits the same failing path in `lib/server/health.ts` (`supabase.auth.admin.listUsers`),
`lib/server/notification-emails.ts` (digest email lookup), and `lib/demo/session.ts`.

## What the error actually means (narrows it fast)

- `/auth/v1/admin/users` is a **read** on `auth.users` (with a join to `auth.identities`). So this is
  **not** the `handle_new_user` trigger (`0003_functions_triggers.sql`) — that only fires `AFTER
  INSERT` on sign-up. A broken trigger would fail sign-*ups*, not this read. (Still worth ruling out
  separately — see step 5 — because a broken profile/prefs insert also blocks new users.)
- Public health is 200, so **GoTrue is up and the URL is correct.**
- The failure is a **`Database error`, not `401/403`** → the **service-role key is valid** (it
  authenticated); the underlying SQL query against `auth.users` is what failed. Do **not** start by
  rotating keys — that's LB-003, a different issue.

So: GoTrue authenticated fine, then its `SELECT ... FROM auth.users [JOIN auth.identities]` raised a
Postgres error. The cause is almost always one of (most→least common for this exact string):

1. **Auth-schema ↔ GoTrue version drift** — GoTrue's query references an `auth` column/table that the
   database doesn't have (or has with a different type). Classic after a Postgres major-version
   upgrade/restore, a point-in-time restore, or a manual edit to the `auth` schema.
2. **A corrupt / malformed row** in `auth.users` or `auth.identities` (e.g. `NULL` in a column GoTrue
   expects non-null, invalid JSON in `raw_user_meta_data`/`raw_app_meta_data`, an orphaned identity).
3. **A permission/ownership change** on the `auth` schema so the `supabase_auth_admin` role can't read
   it (rare unless someone ran manual `REVOKE`/`ALTER`).

## Diagnose (in order — stop when you find the real Postgres error)

**Step 1 — get the REAL error (do this first).** The 500 body is generic; the actual SQL error is in
the logs.
- Supabase Dashboard → **Logs → Postgres** (and **Logs → Auth**), filter to the time of a failed
  `db:audit:auth` run. Look for the statement behind the 500 — e.g. `column auth.users.<x> does not
  exist`, `invalid input syntax for type ...`, `permission denied for schema auth`, or a specific
  bad row. **That line names the root cause**; the rest of this runbook maps it to a fix.

**Step 2 — confirm it's the admin read, not the whole auth stack.** In the SQL editor:
```sql
-- Does GoTrue's own admin read work at the DB level?
select id, email, created_at from auth.users order by created_at desc limit 1;
select count(*) from auth.users;
-- The join GoTrue uses:
select u.id, i.provider from auth.users u
  left join auth.identities i on i.user_id = u.id
  order by u.created_at desc limit 5;
```
If any of these throw, the error message is your root cause (jump to the matching fix below). If they
all succeed as the SQL-editor (postgres) role but GoTrue still 500s, it's a **role/permission** issue
(cause 3) — check `supabase_auth_admin`'s grants on the `auth` schema.

**Step 3 — check for schema drift (cause 1).** Compare the deployed `auth.users` columns against what
your GoTrue version expects:
```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='auth' and table_name='users' order by ordinal_position;
```
Missing modern columns (`is_anonymous`, `is_sso_user`, `deleted_at`, `banned_until`, `phone`,
`confirmation_token`, …) → the auth schema is behind GoTrue. **Fix:** in the Dashboard, ensure the
project is on a current Postgres/GoTrue and let Supabase re-apply its managed auth migrations
(Dashboard → Database → **upgrade/restart**, or open a Supabase support ticket — the `auth` schema is
platform-managed, not one of THIS repo's `supabase/migrations/`). Never hand-edit `auth.users`.

**Step 4 — check for a corrupt row (cause 2).**
```sql
-- bad JSON metadata
select id from auth.users
  where raw_user_meta_data is not null and jsonb_typeof(raw_user_meta_data) is null;
-- orphaned identities
select i.* from auth.identities i left join auth.users u on u.id=i.user_id where u.id is null;
```
Repair/delete the offending row (via the Auth UI or a scoped `update`/`delete` as the postgres role);
re-run the audit.

**Step 5 — rule out the sign-up trigger (separate but also launch-blocking).** `handle_new_user`
inserts into `public.profiles` + `public.user_preferences`. If those tables/columns don't exist in
prod (e.g. a migration wasn't applied), **new sign-ups 500** even though listUsers is unrelated. Verify:
```sql
select to_regclass('public.profiles'), to_regclass('public.user_preferences');
-- smoke the trigger fn shape (won't insert): both tables must exist with (id/email/full_name) & (user_id)
```
If either is missing, apply the pending migrations (see `docs/PENDING_PROD_MIGRATIONS.md`).

## Verify the fix

```bash
npm run db:audit:auth        # expect: "OK public auth health" AND "OK admin users query"
```
Then in the app: Admin → Users page loads, and `lib/server/health.ts` `checkAuth` returns ok. Flip
LB-001 to Resolved in `docs/LAUNCH_BLOCKERS.md` only after the audit shows both probes OK.

## What NOT to do

- Don't rotate the service-role key first — a 500 "Database error" means the key already
  authenticated (key rotation is LB-003, a separate task).
- Don't hand-edit the `auth` schema or run this repo's migrations against the `auth` schema — it's
  Supabase-managed.
- Don't mark LB-001 resolved off a green *public* health check alone; the admin-users probe is the one
  that must go green.
