# Supabase Audit

## Current Project

- Configured host: live Supabase project loaded from `.env.local` (secret values omitted).
- Migration files at audit start: 193, through `0177_remove_synthetic_auth_users.sql`.
- Current migration files: 209, through `0193_marketplace_reports.sql`.
- New migrations: `0178_marketplace_circles_rls_recursion.sql`,
  `0179_harden_rate_limit_rpc_grants.sql`, `0180_resend_webhook_dedup.sql`, and
  `0181_guardian_callback_replay.sql`, `0182_stripe_webhook_claims.sql`,
  `0183_marketplace_auctions.sql`, `0184_marketplace_auction_authorization.sql`, and
  `0185_marketplace_auction_close_transaction.sql`, `0186_marketplace_negotiations.sql`, and
  `0187_harden_marketplace_negotiations.sql`, and
  `0188_harden_trigger_function_security.sql`,
  `0189_reconcile_stripe_webhook_claims.sql`, and
  `0190_marketplace_handoffs.sql`, `0191_marketplace_price_history.sql`, `0192_marketplace_returns.sql`,
  and `0193_marketplace_reports.sql`.
- SQL files: 332.
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

### SECURITY DEFINER trigger hardening

The migration audit found two legacy trigger functions in `0014_core_platform.sql` without a pinned
`search_path`: `sync_album_photo_count()` and `update_conversation_last_message()`. Migration `0188`
replaces both definitions with `SET search_path = public` and revokes direct execution from `PUBLIC`,
`anon`, and `authenticated`. PostgreSQL triggers continue to invoke them; clients do not need RPC access.
The contract is covered by `tests/sql-security-contract.test.ts`.

### Stripe claim-column reconciliation

The live schema probe found that `stripe_webhook_events` existed but did not expose the
`processing_started_at` and `claim_token` columns used by the replay-safe webhook path. Migration
`0189_reconcile_stripe_webhook_claims.sql` reapplies both columns and the processing index with
idempotent DDL, covering environments where `0182` was recorded but its ALTER did not complete.

## Live Probe Results

- Required schema probes passed for all live tables and replay ledgers introduced through `0181`.
- The `stripe_webhook_events` table is reachable, but the combined `processing_started_at,claim_token`
  column probe returns HTTP 400 until migration `0189` is applied.
- `marketplace_circles` failed before `0178` with the recursion error above.
- Public Supabase Auth health passed.
- Supabase Auth Admin user listing still fails with HTTP 500 `Database error finding users`.

## Storage, Functions, Triggers, and Realtime

The repository contains storage policy references and extensive function/trigger migrations. A live
object-by-object verification was not completed because local Docker Supabase was unavailable and the
live Admin Auth/schema probes are unhealthy. No service-role key was exposed to the browser in the audit.
The complete migration/source inventory remains in `database-map.md` and `security-review.md`.

## Required Follow-up

1. Start an isolated Supabase instance with Docker Desktop.
2. Apply the remaining migrations through `0193` and run `npm run db:audit:schema` and
   `npm run db:audit:auth`.
3. Test circle-owner, circle-member, non-member, cross-family listing, share insert, and share-delete
   allow/deny cases using separate authenticated users.
4. Inspect the live Auth Admin 500 in Supabase logs before any production launch decision.

### Current probe follow-up - 2026-07-13

- `npm.cmd run db:audit:schema` passed all 11 required live schema checks, including the
  `stripe_webhook_events` claim columns previously missing from the live response.
- `npm.cmd run db:audit:auth` still passes public Auth health but returns HTTP 500 from the Admin users
  endpoint (`Database error finding users`, error id `019f5de7-9b16-78cc-9e87-d74ac923eb08`).
- The schema result confirms object availability only; migration-history verification and authenticated
  RLS allow/deny tests still require an authorized isolated environment.
## Audit Update - 2026-07-13

Seed tooling no longer embeds a fixed household or creator identity. All six legacy service-role
seed scripts require a validated, explicitly confirmed non-production target before creating or
deleting family-scoped rows. Missing named members fail closed instead of using stale UUID fallbacks.
This is a client/tooling safety repair; live RLS and migration verification remain blocked until the
pending migration is applied in an authorized Supabase environment.
### Live Probe Follow-up - 2026-07-13

- `npm.cmd run db:audit:schema` passed for all 8 required live tables.
- Anonymous REST probes for the three marketplace circle relations returned HTTP 200.
- Authenticated cross-family allow/deny tests and migration-history verification remain outstanding.

Public gift-link reads now guard child and family lookups with `gift_links.is_active`; revoked
capabilities do not disclose identifying names through service-role reads.

### Audit Update - 2026-07-13 (expired auction settlement)

Expired auction settlement now calls the service-role-only `marketplace_close_auction()` RPC.
The RPC locks the listing and commits the listing transition, winner order, and bid status updates
together; order failures leave the auction available for a later retry. Notifications remain
best-effort after the transaction commits. Migration `0185` is still pending in production.

Guardian callbacks now enforce bounded provider input and durable event claims before mutating
`guardian_screening_sessions`, `guardian_communications`, or `notifications`. The service-only
`guardian_callback_events` ledger makes Twilio retries idempotent and allows stale crashed claims to be
reclaimed.

The public A/B event path now validates `variant_key` against `ab_experiments.variants` before writing
to `ab_events` with the service-role client.

API and assistant error responses now keep provider and database exception details in server logs rather
than exposing them to authenticated callers or passing them into model-visible tool results. This is an
application-layer repair and does not change the live migration requirements below.

The public consent path now bounds requests and accepts only known boolean categories before writing
append-only rows to `mkt_consent_events`.

The authenticated agentic chat path now uses the shared `rate_limit_hit` RPC (with its in-memory
fallback) per user before invoking model tools; its conversation and message inputs are bounded in
application code. Durable enforcement still depends on migration `0156` being applied in production.

Voice transcription and speech synthesis use the same per-user durable limiter before paid provider
calls. The limiter intentionally falls back to the local guard when `0156` is unavailable, so deployment
must apply that migration before relying on cross-instance enforcement.

The generic family AI insights endpoint is also guarded before its broad context queries and provider
call, using a distinct per-user bucket.

The public calendar feed now validates the URL-safe capability shape and rate-limits by client IP before
the service-role `sync_calendars` and `sync_calendar_events` reads. Durable enforcement depends on `0156`.

Billing side-effect routes use the generic shared rate-limit guard keyed by family before Stripe calls;
the parent-role authorization remains the primary access control.

Calendar sync entry points use provider-specific family/user buckets before external token refresh or
two-way/import work, reducing duplicate provider calls while preserving authenticated sync behavior.

Notification generation and test-push dispatch use family/user buckets before service-role device reads
and push delivery, limiting repeated fan-out work.

- Current live schema audit: all 10 table/ledger probes through `0181` pass; both
  `stripe_webhook_events` claim columns are missing until migration `0189` is applied. The live Auth
  Admin users probe still returns HTTP 500 and remains a
  launch blocker.

Public service-role ingestion now uses `rate_limit_hit` through the shared request guard for contact,
marketing forms, exit-intent, landing-page, visitor-intelligence, and A/B writes. Durable enforcement
still depends on migration `0156` being applied in the target environment.

The audited model-backed and external-provider routes now use shared per-user durable request budgets
before provider calls or broad context reads. This includes the `/api/ai` route inventory plus vacation
AI/weather, recipe AI, and weekend discovery. The guards preserve feature-specific plan/day caps and
return `Retry-After`; durable enforcement depends on migration `0156` being applied in production.

The follow-up provider inventory added the same durable guards to marketing-admin AI, behavior coaching,
and the authenticated Giphy proxy. Marketing AI input is bounded before prompt construction; the
route contract now includes all three paths and requires a `Retry-After` response on rejection.

The durable limiter privilege audit found that `0156_rate_limits.sql` granted `rate_limit_hit` to
`anon` and inherited a public execute path for `rate_limit_prune`. Forward migration `0179` revokes
anonymous/public execution, binds authenticated calls to a key containing `auth.uid()`, and restricts
pruning to `service_role`. Billing and notification keys now include the authenticated user ID so their
existing server-side calls satisfy the new scope check.

The Resend/Svix webhook now enforces a five-minute timestamp window, a 256 KB body bound, and durable
Svix-id deduplication through `resend_webhook_events` before marketing side effects. RLS is enabled with
no client policies; only the service-role webhook path can read or write the event ledger.

The public unsubscribe endpoint now uses `rate_limit_hit` before its service-role suppression upsert,
bounds the signed email/token inputs, escapes HTML output, and fails closed in production if no signing
secret is configured. The existing HMAC token tests now cover the missing-production-secret case.

Stripe webhook claims now distinguish active concurrent deliveries from failed or stale abandoned rows.
Migration `0182_stripe_webhook_claims.sql` adds the processing timestamp and index required for that
conditional recovery. Each worker also carries an ownership token so an older worker cannot overwrite a
newer reclaimed claim; payload and configuration boundaries are enforced before signature processing.

Provider-sync OAuth callbacks now use provider-scoped, opaque, httpOnly state cookies with constant-time
comparison and session-derived identity. This closes the CSRF gap in both static Google and generic
provider sync routes without adding any database dependency.

Calendar feed URLs are now treated as untrusted server-side fetch targets. Both legacy imports and stored
feed syncs validate DNS answers against public address ranges, reject credentials and unsafe hostnames,
manually revalidate up to three redirects, and cap calendar response bodies at 1 MiB. This is an application
fetch-boundary repair and does not require a database migration.

Push device registration now validates web endpoint URLs, native provider/platform pairs, token and key
lengths, and user-agent bounds before writing `push_devices`. Registration/removal requests also use the
shared per-user limiter. The existing `push_devices` RLS and schema remain the authorization boundary;
no migration is required.

Marketplace auctions now require the authenticated user's active family member to match every bid RPC
identity. Migration `0184_marketplace_auction_authorization.sql` removes the direct authenticated bid
insert policy, hides the original bid implementation behind an authorization wrapper, and adds the
locked `marketplace_buy_now` RPC so listing claims and order creation commit together. Apply `0184` with
the auction code before enabling the feature in production.

Generic provider sync now reads a bounded 4 KiB request body and validates the provider field before
adapter lookup or service-role database work. This is an application request-boundary repair and does
not require a database migration.

The 600-record production-readiness seed now requires the configured anchored account to resolve to a
family. It no longer falls back to the first family in the database, preventing accidental fixture writes
to an unrelated household. The seed remains idempotent and does not write Auth users.

The `SEED_ALL.sql` master entrypoint now performs the same anchored-account preflight before executing
its legacy sections. This protects the one-paste production fixture workflow even where individual
operator-scoped seed files retain their own historical resolution logic.

## Audit Update - 2026-07-13 (authenticated context failure boundary)

`getUserContext()` now checks errors from the `family_members`, `families`, and `user_preferences`
queries. A failed read raises a generic temporary-unavailable error and logs the diagnostic server-side;
it is never treated as an empty membership result that could trigger service-role family provisioning.

Public review, survey, and gift server actions now call the shared `rate_limit_hit` guard through
`enforceRequestRateLimit` before their service-role writes. Runtime payload extraction accepts only
expected string/number shapes, so server-action calls cannot trigger unchecked `.trim()` failures.

The public child username/PIN action now uses the same durable IP guard before reading
`child_login_throttle` or `child_logins`; either lookup error returns a generic temporary-unavailable
result rather than treating the missing data as an authentication miss.

## Audit Update - 2026-07-13 (marketplace returns seed safety)

The new returns fixture pack now fails closed when migration `0192` or the required `returned_at`
column is unavailable. It resolves the anchored account and two existing active members, uses
deterministic listing and order IDs with `ON CONFLICT DO NOTHING`, and performs no cleanup deletes or
synthetic-member inserts. The standalone seed and its embedded `SEED_ALL.sql` section are covered by
the seed safety contract tests.
