# Supabase Audit

## Current Project

- Configured host: live Supabase project loaded from `.env.local` (secret values omitted).
- Migration files at audit start: 193, through `0177_remove_synthetic_auth_users.sql`.
- Current migration files: 219, through `0203_service_descriptions.sql`.
- New migrations: `0178_marketplace_circles_rls_recursion.sql`,
  `0179_harden_rate_limit_rpc_grants.sql`, `0180_resend_webhook_dedup.sql`, and
  `0181_guardian_callback_replay.sql`, `0182_stripe_webhook_claims.sql`,
  `0183_marketplace_auctions.sql`, `0184_marketplace_auction_authorization.sql`, and
  `0185_marketplace_auction_close_transaction.sql`, `0186_marketplace_negotiations.sql`, and
  `0187_harden_marketplace_negotiations.sql`, and
  `0188_harden_trigger_function_security.sql`,
  `0189_reconcile_stripe_webhook_claims.sql`, and
  `0190_marketplace_handoffs.sql`, `0191_marketplace_price_history.sql`, `0192_marketplace_returns.sql`,
  `0193_marketplace_reports.sql`, `0194_marketplace_photos_bucket.sql`, and
  `0195_dashboard_layout_upsert_constraint.sql`,
  `0196_atomic_economy_and_invest_decisions.sql`, and
  `0197_feedback_ideas.sql`, `0198_guardian_suggestion_review_transaction.sql`, and
  `0199_marketplace_handoff_completion.sql`, `0200_display_settings.sql`, `0201_blog_engagement.sql`,
  `0202_blog_articles.sql`, and `0203_service_descriptions.sql`.
- SQL files: 338.
- Static counts: 1,190 policy declarations, 642 RLS enable statements, 100 function declarations,
  417 trigger declarations, and 65 `storage.objects` references. Counts are source-text counts,
  not a claim that every object exists in the live database.

### Onboarding write-path audit

The guided onboarding finalize action uses a server-side service-role client after authenticating the
caller with the cookie-bound session. The required writes to `families`, `family_members`,
`subscriptions`, `user_preferences`, `family_onboarding`, `invites`, `calendar_events`, and
`onboarding_imports` now check errors and return sanitized failures. `onboarding_progress` records a
`wizard/in_progress` marker before provisioning so retries can resume an incomplete run. Welcome email,
CRM contact, and automation writes remain best-effort by product decision and are not used as proof that
core family state was committed. The action still performs sequential writes rather than a database
transaction; launch verification should exercise retry behavior and inspect for any duplicate imported
rows in an isolated environment.

### Privileged marketing write-path audit

Marketing administration authenticates the caller through `requireMarketingAdmin()` and then uses a
server-only service-role client for cross-family administration. The audited segment, campaign, content,
email, SMS, social, advertising, automation, funnel, landing-page, form, settings, affiliate, payout,
and survey mutations now check every Supabase insert, update, delete, and upsert before recording the
marketing audit event or telling Next.js to revalidate/redirect. Unclassified provider details are logged
under `[marketing-action]` and replaced with stable action failures. `logMarketingAudit` remains
best-effort by design because audit-write loss must not turn a successful business mutation into a false
failure; operational monitoring should still alert on those log failures.

### Account and device-security write-path audit

Account closure/reopen uses the authenticated active-family context and now sanitizes service-role
mutation failures. Family switching checks both the membership read and the preference upsert before
revalidating the dashboard. Dashboard preference writes and App Lock settings use sanitized failures;
App Lock refuses to overwrite `notification_prefs` when the existing-preferences read fails. The shared
profile writer also checks the linked `family_members` display-name synchronization, so a partial profile
save cannot be reported as successful. These actions remain server-side and do not expose raw Postgres
messages to the browser.

### Economy and simulated-investing transaction audit

Migration `0196_atomic_economy_and_invest_decisions.sql` adds authenticated, manager-checked RPCs
for redemption decisions and simulated-investment fills. Each locks the pending request and its
ledger/stock/holding rows before checking the balance, then commits the debit or wallet movement,
redemption/order state, holding/stock changes, and wallet audit record in one transaction. The action
layer uses the RPCs for approvals and checks errors on all remaining economy/invest reads and writes.
The functions are revoked from `public` and `anon` and granted only to `authenticated`; isolated
production verification must still exercise concurrent approvals after applying the migration.

### Guardian suggestion review transaction audit

Migration `0198_guardian_suggestion_review_transaction.sql` adds a manager-authorized RPC for
approving or dismissing AI Guardian suggestions. It locks the suggestion, applies the proposed trust
or routing change, updates review metadata, and writes the Guardian audit record in one transaction.
The RPC is revoked from `public` and `anon` and granted only to `authenticated`; malformed proposed
rule data is normalized to bounded, known routing fields. Isolated production verification must still
exercise parent/child authorization and concurrent reviews after applying the migration.

### Marketplace and Feedback action boundary audit

The user-facing Marketplace and Feedback server actions now use sanitized action failures with
server-side diagnostics. Required reads for saved listings, followed stores, orders, offers, votes,
and marketplace hand-offs are checked before dependent mutations; ignored read failures can no longer
be mistaken for an absent row. Expected duplicate votes/shares/reviews and explicit circle/domain
messages remain intentionally user-facing. The hand-off calendar insert remains best-effort by design,
while required order and hand-off reads and state writes fail closed.

### Marketplace hand-off completion transaction audit

Migration `0199_marketplace_handoff_completion.sql` adds an authenticated RPC that locks the
marketplace order and hand-off, verifies family membership and the normalized confirmation code, and
updates both completion states in one transaction. Public and anonymous execution is revoked; only
authenticated callers can execute it. Isolated verification must still exercise concurrent completion,
wrong-code rejection, and cross-family denial after applying the migration.

### Wallet and Stripe Money action boundary audit

Wallet hub mutations and Stripe Money actions now log unexpected Supabase/provider details on the
server and return stable user-facing failures. Required connected-account, card, wallet, and member
reads are checked before dependent money mutations, so an unreadable prerequisite cannot be treated as
absent or safe to overwrite. Audit inserts after successful external effects remain observable
best-effort; their failure is logged without replaying or falsely failing the completed money operation.

### AI assistant action boundary audit

The AI provider now catches tool executor exceptions, logs the diagnostic server-side, and returns a
stable action failure instead of passing raw exception messages into the model or persisted tool results.
The assistant chat route checks conversation initialization and every required family-context read before
invoking tools. It checks the core message insert before emitting completion, while title metadata failures
are logged separately as non-core presentation metadata. Super Admin AI configuration saves also sanitize
unexpected persistence failures.

### Admin Management action boundary audit

The privileged Admin Management actions now independently verify Super Admin access, validate invite
email and role input, check update/delete/upsert results, and require a target row for deactivate,
activate, and revoke operations. Unexpected Supabase failures are logged server-side and converted to
stable messages. The admin-row client now keeps the menu open on failure and shows a toast rather than
assuming that an ignored mutation succeeded.

### Support Ticket action boundary audit

Support Ticket status transitions now re-check Super Admin access, validate the target identifier, check
the update result and returned row, and return a stable failure before revalidation when the write fails.
Ticket creation validates the subject, requester email, category, and priority, checks the insert result,
and uses a collision-resistant ticket number rather than a concurrent count-derived sequence. The admin
row client keeps its menu open and shows a toast when a transition fails.

### Tier & Features action boundary audit

Tier overrides now distinguish safe public fallback reads from privileged mutation reads. A failed
`app_settings` read aborts the read-modify-write instead of allowing an empty override map to overwrite
existing configuration; upsert failures are checked and propagated to the sanitized admin action result.
Feature keys and tier values are allowlisted before writes, and authorization failures are returned as
stable messages.

### Marketplace report moderation action boundary audit

Super-admin report moderation now checks report reads, report target rows, listing reads, listing withdrawal
writes, and stale report statuses. Requested safety withdrawal happens before report resolution, so a
failed withdrawal leaves the report available for retry rather than recording an apparently complete
moderation action. Unexpected Supabase details are logged server-side and sanitized for the UI.

### Admin read-path integrity audit

Marketplace Reports and both Support Ticket admin views now check their required service-role reads and
log diagnostics server-side before rendering a retryable, stable error state. A transient Supabase outage
can no longer be presented as an empty moderation or support queue, which could otherwise lead an admin to
miss safety reports or customer requests.

### Competitive, CRM, and Proposals action boundary audit

The Competitive Intelligence, CRM, and Proposals Super Admin actions now check every insert, update, and
delete result and require a returned target row for existing-record mutations. Unexpected Supabase errors
are routed through `marketingActionFailure`, which logs server-side diagnostics and exposes only a stable
message before audit logging or path revalidation can run.

### Marketing asset and content publication action boundary audit

Marketing asset uploads now check both storage and database results, remove failed uploads on row-write
failure, and use the stored server-side path when deleting an asset. Content edits and blog publication
now fail closed on required reads, blog upserts, content state updates, and unpublishing. All unexpected
failures use `marketingActionFailure` before audit logging or cache revalidation.

### Loyalty administration action boundary audit

Super Admin loyalty settings and reward mutations now check write results and affected rows. Redemption
fulfillment and cancellation require a pending target row, prerequisite redemption reads fail closed, and
points-engine exceptions are sanitized through `marketingActionFailure` before audit logging or cache
revalidation.

### Marketing delivery and personalization action boundary audit

Push campaign creation, claiming, prerequisite reads, delivery failure recovery, final persistence, and
soft deletion now check Supabase results. The claim is restricted to the current draft/failed status so
concurrent administrators cannot reserve the same campaign. Personalization rule inserts, status changes,
and soft deletes now require returned target rows and route unexpected failures through the sanitized
marketing action boundary.

### Reputation, video, and review action boundary audit

Testimonials, case studies, marketing videos, review moderation/replies, and reputation settings now
check inserts, updates, deletes, prerequisite asset reads, singleton upserts, and returned target rows.
Unexpected failures use `marketingActionFailure` before audit logging or cache revalidation; a missing
video asset remains an explicit invalid-input no-op rather than a database failure.

### Experiments, exit-intent, and survey action boundary audit

A/B experiment inserts, status transitions, and winner changes now check required reads, configured
variant membership, and affected target rows. Exit-intent offer creation/toggles/deletion and survey
status/deletion controls now check Supabase results before audit logging or cache revalidation, and
unexpected failures use the sanitized marketing action boundary.

### Core marketing, referral, and lead-score action boundary audit

Shared marketing segment, campaign, automation, landing-page, form, SEO, AEO, and settings writes now
check Supabase errors and affected/returned rows before audit logging or cache revalidation. Referral
configuration upserts fail closed, public referral application no longer returns raw database messages,
and lead-score recomputation checks source reads and score upserts before reporting success; the admin
recompute path records a sanitized audit event.

### Payment and webhook persistence boundary audit

Stripe subscription, billing-customer, checkout, and event-ledger transitions now require successful
Supabase results; a lost finalization or handler-error update produces a retryable response instead of
acknowledging the event. Resend counter, suppression, and final ledger writes follow the same fail-closed
pattern. Referral conversion now checks both its prerequisite read and status-guarded update.

### Sync account and token persistence boundary audit

Sync account upserts, encrypted token writes, and connection-row upserts now require returned rows and
fail closed on Supabase errors. Reconnects no longer replace a missing refresh token after an unreadable
prerequisite row, and refreshed access tokens are not returned until their encrypted persistence succeeds.

### Sync job lifecycle persistence boundary audit

The provider-agnostic and Google engines now require durable job/run creation before provider work and
check returned rows for run, job, connection, and account success finalization. Generic-provider token
refresh also fails closed when the encrypted token update is not persisted.

### Generic sync item persistence boundary audit

The provider-agnostic calendar/task engine now checks local-row, mapping, conflict, deletion, update,
creation, and cursor writes before incrementing imported/exported counters. Mapping and local lookup
failures also abort the run instead of being treated as an absent mapping and creating duplicate state.

### Google sync item persistence boundary audit

Google Calendar and Tasks pulls and pushes now use the shared fail-closed persistence guard for local
rows, mappings, conflicts, deletes, updates, creations, and cursors. Mapping/local lookup failures no
longer become absent-state branches that can create duplicate rows or advance imported/exported counts.

### AI assistant persistence boundary audit

AI assistant action tools use the family-scoped Supabase client and now fail closed when list lookups,
secondary reads, assignments, or dependent reminder writes fail. Multi-step chore and recurring-reminder
actions roll back their first write when the dependent row cannot be persisted, preventing the model from
reporting a completed action while durable family state is incomplete.

### Family media storage persistence boundary audit

Create Memory and Photos uploads now prefer browser UUIDs for their storage paths with a deterministic
fallback. The upload count and success path advance only after the corresponding `family_photos` row is
persisted; when that metadata write fails, the newly uploaded `family-media` object is removed and cleanup
failure is surfaced separately. Marketplace photo uploads use the same stable, non-sensitive storage error
message rather than exposing raw provider details.

### Family Autopilot persistence boundary audit

The Autopilot scan now checks every required family-context read before building or reconciling
suggestions; a transient Supabase read failure aborts the scan before any writes or stale-suggestion
deletions. Shopping-list lookup/creation and stale-suggestion deletion are checked. Auto-created
reminders and grocery rows are captured by ID, and are removed when the corresponding suggestion cannot
be persisted, preventing a hidden side effect without an undoable suggestion. Digital Twin trait writes
remain explicitly best-effort enhancement metadata and are now logged when Supabase rejects them.

### Chore reward persistence boundary audit

Chore progress lookup and updates are now family-scoped and checked, approved-history reads fail closed,
and badge reads no longer treat Supabase errors as an empty award set. Badge writes use the unique
`member_id,badge_id` key with an idempotent upsert and return only rows actually inserted. If history or
badge persistence fails after XP changes, the prior progress values are restored. The approval finalizer
checks the assignment update and restores its original reward/status fields when gamification fails;
approval audit events remain best-effort by design and log rejected writes server-side.

### Chore proof submission persistence boundary audit

Proof uploads use server-generated UUID paths and never expose raw storage-provider messages. Uploads are
removed when the submission row fails; if validation throws or its row/assignment persistence fails, the
submission row is deleted (cascading its validation row) and all uploaded paths are removed. Required AI
validation and assignment updates are checked before the action proceeds to approval or parent review,
preventing a successful response from hiding an incomplete proof record.

### Child login throttle and provisioning persistence boundary audit

Public child PIN login now returns a temporary-unavailable response if failed-attempt counter persistence
fails, so a degraded throttle table cannot silently remove brute-force protection. Parent child-login
creation treats active-family preference persistence as required and compensates by deleting the mapping,
unlinking the member, and deleting the new Auth user on failure; optional throttle reset remains non-core.

### Social publishing persistence boundary audit

Social publish jobs now fail closed when target/account reads, variant reads, job transitions, target state,
publish-result rows, or final post state cannot be persisted. The action cleans up pre-publish post rows and
cascade children when draft/variant/target/schedule setup fails, while preserving a post after a connector
has started so an uncertain external side effect is visible for review rather than silently retried. Provider
exception details are logged server-side and replaced with a stable client message; usage events are checked
and logged as best-effort operational telemetry after the core publish state is durable.

### Migration filename history

Static inspection found 17 duplicate numeric prefixes across the historical migration folder:
`0010`, `0026`, `0042`, `0043`, `0073`, `0080`, `0089`, `0090`, `0095`, `0098`, `0105`, `0108`,
`0109`, `0110`, `0137`, `0138`, and `0142`. These files were not renamed because the checkout is
not linked to the production project and the applied migration ledger cannot be compared safely.
`npm run db:audit:migrations` now makes the complete known set explicit, and `npm run db:push`
plus CI fail before contacting Supabase if a new or changed collision appears. A production owner
must reconcile the historical filenames against `supabase_migrations.schema_migrations` before
declaring automated migration deployment fully verified.

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
2. Apply the remaining migrations through `0199` and run `npm run db:audit:schema` and
   `npm run db:audit:auth`.
3. Test circle-owner, circle-member, non-member, cross-family listing, share insert, and share-delete
   allow/deny cases using separate authenticated users.
4. Inspect the live Auth Admin 500 in Supabase logs before any production launch decision.

### Current probe follow-up - 2026-07-14

- `npm.cmd run db:audit:schema` passed all 11 required live schema checks, including the
  `stripe_webhook_events` claim columns previously missing from the live response.
- `npm.cmd run db:audit:auth` still passes public Auth health but returns HTTP 500 from the Admin users
endpoint (`Database error finding users`, latest error id `019f617e-363b-77ea-9e8a-db390083d810`).
- The schema result confirms object availability only; migration-history verification and authenticated
  RLS allow/deny tests still require an authorized isolated environment.

### Migration filename follow-up - 2026-07-13

- Static migration inspection found 17 duplicate numeric prefixes, from `0010` through `0142`.
- These historical files remain unchanged pending comparison with the target environment's migration
  ledger. `npm.cmd run db:audit:migrations` passed with the complete known set explicit and next
  available version `0200`.

### Marketplace photo storage follow-up - 2026-07-13

- Migration `0194_marketplace_photos_bucket.sql` creates a public-read, authenticated-write bucket
  with a 10 MB image allowlist and UUID-owned folder policies.
- Application cleanup now targets only same-project public bucket URLs and relies on the Storage RLS
  policy for the final caller ownership check. External pasted URLs are left untouched.
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

## Audit Update - 2026-07-14 (server-action boundaries and signal integrity)

Several authenticated server actions returned raw Supabase messages, which could expose relation
names, policy details, or provider diagnostics to a browser or model. The shared `describeActionError`
boundary now preserves actionable permission/conflict/network categories and replaces unclassified
details with stable fallbacks; callers log diagnostics server-side only. The AI meal action also fails
before creating a plan row when its prerequisite meal insert fails.

Family Intelligence previously checked only the reminders read. It now checks all six source reads, the
existing-signal read, and the signal upsert, returning a sanitized failure rather than deriving or
reporting results from incomplete data. Regression coverage is in
`tests/server-action-error-boundaries.test.ts` and `tests/db-errors.test.ts`.

The same boundary now covers privileged super-admin mutations, marketplace report moderation, Trust
Engine decisions, and Family Wallet ledger actions. Financial helpers retain intentional balance and
duplicate-handle messages while unexpected Supabase/provider details are logged only on the server and
replaced with stable fallbacks. No migration is required for this application-layer repair.
