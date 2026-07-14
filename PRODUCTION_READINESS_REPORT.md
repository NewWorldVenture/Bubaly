# Production Readiness Report

## Executive Summary

FamilyOS is in a strong local validation state, but it is not proven production-ready. The current
The tree compiles, passes lint and type checking, passes 2,915 unit tests, builds all 250 static Next.js
routes, and passes 51 public/mobile/accessibility E2E checks from 52 collected tests. The audit also found and repaired a
real RLS recursion defect in marketplace circles. The latest live schema audit now passes all 11
required probes, but authenticated RLS behavior and Auth Admin health remain unverified.

Recommended decision: **NO-GO until full migration history/RLS behavior is verified, the live Supabase
Auth Admin 500 is diagnosed, and the exposed historical Supabase credential is rotated.** After
those checks pass in an isolated environment, the posture can be reconsidered as Conditional Go.

Latest audit increment (2026-07-14): migration filenames now have a deterministic preflight. The
checkout contains 215 numbered migration files and 17 known historical duplicate prefixes; new or
changed collisions fail CI and `db:push` before any database connection is attempted. The remote
migration ledger remains unverified because this checkout is not linked to a Supabase project.

Latest repair increment (2026-07-13): marketplace photo uploads now have explicit storage cleanup
on replacement, failed listing saves, canceled drafts, quick-post resets, and listing deletion.
External pasted URLs are never treated as bucket deletion targets.

Latest repair increment (2026-07-14): audited server actions now replace unclassified database and
provider details with stable user-facing failures, and Family Intelligence fails closed when any source
read or persistence step fails instead of deriving results from incomplete data.

Latest repair increment (2026-07-14): extended the same boundary to super-admin mutations, marketplace
moderation, Trust Engine decisions, and wallet money movement. Expected domain messages remain intact;
unexpected Supabase/provider details are now logged server-side and replaced with stable fallbacks.

Latest repair increment (2026-07-14): Google Calendar and Tasks pulls and pushes now use the same
fail-closed local/mapping/conflict/cursor persistence guards before imported/exported counts advance.

Latest repair increment (2026-07-14): AI assistant list reads now fail closed on Supabase errors, and
multi-step chore and recurring-reminder actions roll back their first write when dependent persistence fails.

Latest repair increment (2026-07-14): family-media uploads now prefer collision-resistant UUID paths,
check the `family_photos` metadata write before reporting success, remove uploaded objects when metadata
persistence fails, and use stable client-facing upload errors.

Latest repair increment (2026-07-14): Family Autopilot now fails closed when any required family read
fails, checks stale-suggestion deletion and shopping-list provisioning, and compensates auto-created
reminders or grocery rows if the suggestion record cannot be persisted.

Latest repair increment (2026-07-14): onboarding finalization now fails closed on required provisioning
writes instead of returning success after partial family setup. Runtime action payloads are bounded and
validated, and an in-progress marker lets retries resume incomplete setup without re-running completed
or invite-accepted accounts. Email and marketing automation remain explicitly best-effort.

Latest repair increment (2026-07-14): privileged marketing mutations now fail closed before audit,
revalidation, or redirect. Segment, campaign, content, email, SMS, social, advertising, automation,
funnel, landing-page, form, settings, affiliate, payout, and survey writes all use sanitized failures.

Latest repair increment (2026-07-14): account closure, family switching, dashboard preferences,
profile updates, and App Lock now sanitize database failures and fail closed on required reads and
writes. Profile synchronization no longer reports success when the linked family display name fails.

Latest repair increment (2026-07-14): family-economy redemptions and simulated-investment approvals
now use authenticated, row-locking RPCs so ledger debits, stock/holding updates, order status, and
audit records commit atomically. Request and direct-write failures are sanitized and checked.

Latest repair increment (2026-07-14): Guardian suggestion approvals and dismissals now use a
manager-authorized transaction that applies the proposed trust/routing change, review state, and
audit record together. Guardian action failures are sanitized and phone-assignment reads are checked.

Latest repair increment (2026-07-14): Marketplace and Feedback actions now sanitize unexpected
database failures, check required reads before mutating saved listings, follows, offers, orders, votes,
and hand-offs, and preserve explicit duplicate/domain messages for normal user guidance.

Latest repair increment (2026-07-14): Wallet hub and Stripe Money actions now sanitize unexpected
database/provider failures, fail closed on required account, card, wallet, and member reads, and log
audit-write failures without replaying a successful external money operation.

Latest repair increment (2026-07-14): AI tool failures and Super Admin AI configuration errors now use
stable user-facing messages with server-side diagnostics. AI chat fails closed on required conversation
and family-context reads, checks message persistence, and reports when the response was not saved.

Latest repair increment (2026-07-14): Admin Management deactivate, activate, revoke, and invite actions
now validate inputs, check target-row and database results, sanitize failures, and show mutation errors
to the Super Admin instead of closing the control as if it succeeded.

Latest repair increment (2026-07-14): Support Ticket status transitions and creation now validate inputs,
check target and write results, sanitize failures, and show mutation errors in the admin client. Ticket
numbers use collision-resistant identifiers instead of a concurrent count-plus-one calculation.

Latest repair increment (2026-07-14): Tier & Features writes now fail closed on failed settings reads or
upserts and validate feature/tier identifiers. Marketplace report moderation checks every required read,
write, and target row, rejects stale transitions, and performs requested safety withdrawal before report
resolution.

Latest repair increment (2026-07-14): Marketplace Reports and both Support Ticket admin views now check
required Supabase reads and render retryable failure states instead of presenting an empty queue when the
database is unavailable.

Latest repair increment (2026-07-14): Competitive Intelligence, CRM, and Proposals marketing actions
now check every insert, update, and delete result, require affected target rows, and route unexpected
failures through the shared sanitized marketing boundary before audit logging or revalidation.

Latest repair increment (2026-07-14): marketing asset storage and content publication actions now fail
closed on storage/database errors, use server-derived storage paths for deletion, check required content
reads and target rows, and verify blog upserts and publish-state updates before audit logging or revalidation.

Latest repair increment (2026-07-14): loyalty administration settings, reward writes, fulfillment, and
cancellation now check Supabase results and pending target rows before audit logging or revalidation;
points-engine failures are sanitized at the Super Admin boundary.

Latest repair increment (2026-07-14): push campaigns now use an atomic draft/failed claim before
delivery, fail closed on device/profile/suppression reads, recover pre-delivery failures to `failed`,
and check final persistence. Personalization rule mutations now check affected rows and errors.

Latest repair increment (2026-07-14): testimonials, case studies, marketing videos, review moderation,
review replies, and reputation settings now check Supabase errors and returned target rows before audit
logging or revalidation; missing video assets remain validated input no-ops while asset read errors fail closed.

Latest repair increment (2026-07-14): A/B experiment creation, status transitions, and winner selection
now check returned rows, fail closed on reads, and reject winners not present in configured variants.
Exit-intent offers and survey status/deletion controls now check Supabase errors and affected rows before
audit logging or revalidation.

Latest repair increment (2026-07-14): shared marketing admin updates now require affected target rows,
SEO/AEO inserts and settings upserts require returned records, referral configuration failures are
sanitized, and public referral writes no longer return raw database messages. Lead-score recomputation
now fails closed on contact reads/upserts and records a sanitized admin audit event.

Latest repair increment (2026-07-14): Stripe subscription, billing-customer, checkout, and event-ledger
writes now fail closed and return retryable responses when persistence is lost. Resend campaign counters,
suppressions, and final event-ledger transitions now do the same, and referral conversion reads/writes are checked.

Latest repair increment (2026-07-14): sync account creation now checks account, token, and connection
writes; reconnects fail closed when the existing refresh-token read fails, and token refresh only succeeds
after encrypted persistence.

Latest repair increment (2026-07-14): provider-agnostic and Google sync now require job/run creation and
successful run, job, connection, and account finalization; generic-provider token refresh also checks
encrypted persistence before returning the new token.

Latest repair increment (2026-07-14): generic provider calendar/task pulls and pushes now fail closed
when local rows, mappings, conflicts, deletes, updates, creations, or cursors are not persisted before
sync counts are incremented.

Latest repair increment (2026-07-14): Marketplace hand-off completion now uses a member-authorized,
row-locked transaction so the confirmation code, hand-off status, and order status cannot diverge under
concurrent completion or a partial write failure.

## Scope and Inventory

- 352 `page.tsx` route files.
- 102 API route handlers.
- 219 migration files; additive repair migrations through `0203` are now present.
- 338 SQL files under `supabase`.
- 380 unit-test files and 2,919 passing tests.
- Existing detailed inventories: `route-inventory.md`, `database-map.md`, `feature-inventory.md`,
  `architecture.md`, `security-review.md`, `testing-plan.md`, and `user-journeys.md`.

## Fixes Completed

- Added `0178_marketplace_circles_rls_recursion.sql` to replace recursive circle policies with
  pinned SECURITY DEFINER membership helpers.
- Added `0179_harden_rate_limit_rpc_grants.sql` to remove anonymous/public access to durable limiter
  RPCs and bind authenticated limiter keys to the calling user.
- Added `0180_resend_webhook_dedup.sql` to persist signed Resend/Svix event IDs and make webhook
  processing replay-safe.
- Added `0181_guardian_callback_replay.sql` and callback claims so signed Twilio retries cannot repeat
  Guardian pipelines, AI screening, notifications, or telephony side effects.
- Added `0182_stripe_webhook_claims.sql` so concurrent Stripe deliveries cannot both process an active
  event claim; abandoned claims remain recoverable after ten minutes.
- Added `0185_marketplace_auction_close_transaction.sql` and moved expired-auction settlement into a
  service-role-only locked transaction, so listing claims cannot commit without their winner order.
- Added a streaming 4 KiB request-body bound and provider-shape validation to the generic provider-sync
  endpoint; malformed or unsupported requests now fail before adapter or database work.
- Hardened `supabase/seed_production_readiness.sql` to require its anchored account and fail closed
  instead of selecting an arbitrary family for the 600-record fixture pack.
- Added a master-scope preflight to `supabase/SEED_ALL.sql`, preventing any of its service-role seed
  sections from running when the anchored account is absent.
- Added a shared bounded JSON reader to financial, public service-role ingestion, and internal email
  routes; oversized request bodies now fail before parsing or database/provider work.
- Replaced fail-open scheduled-callback comparisons with a shared fail-closed secret guard across all
  cron routes and concierge placement; missing secrets can no longer authorize `Bearer undefined`.
- Added `0187_harden_marketplace_negotiations.sql` with cross-family, amount, message, and below-ask
  integrity guards that remain enforced for future RPC, seed, and service-role writes.
- Made the marketplace negotiation seed fail closed when the anchored account is absent, including its
  consolidated `SEED_ALL.sql` section, and added bounded note validation in the action layer.
- Extended streaming JSON request bounds to every provider-backed AI, recipe, vacation, social,
  consent, marketing-admin, and guardian route; optional-body routes preserve their empty-body behavior.
- Routed Weekend Planner family RSS/ICS feeds through the SSRF-safe public calendar fetcher, including
  DNS target checks, redirect validation, timeout handling, and a bounded response reader.
- Replaced post-read size checks with streaming raw-body bounds for Stripe, Resend, and money webhooks,
  push registration/removal, and calendar sync; signed webhook payloads remain byte-for-byte intact.
- Added a bounded byte/FormData reader for Twilio callbacks and multipart voice transcription, so platform
  parsing receives only a pre-limited buffer; Twilio URL-encoded signatures and audio upload validation
  remain intact.
- Replaced Social Feed URL unfurling's automatic redirects and post-read HTML slicing with public DNS
  validation, redirect revalidation, a 600 KiB response cap, and bounded text parsing.
- Added shared bounded response readers for audited provider error, JSON, and Graph API text responses;
  provider failures stop at 64 KiB, token responses at 64 KiB, and larger provider JSON/Graph responses
  stop at 512 KiB to 2 MiB before parsing or logging.
- Added explicit deadlines to fixed-provider server calls and browser weather/routing calls; the existing
  manually validated public-calendar/social fetch path retains its own redirect and timeout controls.
- Added migration `0188_harden_trigger_function_security.sql` to pin `search_path` and revoke direct
  client execution from two legacy SECURITY DEFINER trigger functions.
- Added migration `0189_reconcile_stripe_webhook_claims.sql` to restore both Stripe claim columns in
  environments where migration `0182` was recorded but its additive ALTER did not complete.
- Added migration `0190_marketplace_handoffs.sql` and the Orders hand-off coordinator for safe pickup
  proposals, confirmations, calendar placement, and code-based completion.
- Added migration `0191_marketplace_price_history.sql` and price-drop history/watch support for
  marketplace item pages.
- Added migration `0192_marketplace_returns.sql` and return-state tracking, overdue reminders, and
  rent/borrow return workflows for marketplace orders.
- Added strict marketplace photo storage path parsing and cleanup rollback hooks for abandoned or
  deleted listing media.
- Added a migration filename preflight that preserves the known historical duplicate-prefix set,
  fails on new or changed collisions, and runs before `db:push` and in CI. Historical files were not
  renamed because the remote migration ledger is not accessible from this unlinked checkout.
- Replaced raw Supabase error responses in public A/B, landing-page, and exit-intent metric routes with
  generic client messages and server-side diagnostics.
- Extended the same database-error boundary to authenticated calendar, meal, vacation, event, and
  concierge routes plus scheduled jobs; callers receive stable generic failures while logs retain detail.
- Hardened the remaining AI, Weekend Planner, marketing-email, and cron response boundaries so provider
  and database exception text stays in server logs; model-facing assistant tools now return safe operation
  failures instead of raw Supabase messages.
- Hardened authenticated context resolution so failed membership, family, or preference reads raise a
  generic temporary-unavailable error instead of being mistaken for a missing family and triggering
  service-role auto-provisioning.
- Added shared durable IP rate limits and runtime-safe payload normalization to public review, survey,
  and gift server actions before their service-role writes.
- Hardened child username/PIN sign-in with a durable IP-wide guard, hostile-input normalization, and
  fail-closed throttle and login lookup errors so degraded Supabase cannot remove brute-force controls.
- Added sanitized failure boundaries across privileged admin, Trust Engine, marketplace moderation, and
  wallet ledger actions, including card-spend, credit, and debit helpers.
- Hardened the durable rate-limit boundary to fail closed on RPC errors, empty or malformed responses,
  and invalid retry windows; availability-first behavior now requires an explicit opt-in.
- Bounded the local limiter's in-memory bucket map, normalized invalid limiter parameters, and accepted
  only validated IPv4/IPv6 proxy identities before constructing local or durable rate-limit keys.
- Added a scoped npm override for Next's nested PostCSS dependency, moving it to patched `8.5.10`
  without downgrading or replacing the supported Next.js 15 runtime.
- Repaired the remote marketplace hand-off seed to be fail-closed and additive: it now requires the
  anchored account and two existing members, uses deterministic IDs, and never deletes or creates users.
- Repaired the marketplace returns seed in both standalone and `SEED_ALL.sql` forms: it now requires
  the anchored account plus two existing active members, fails closed when `0192` is absent, uses
  deterministic IDs with conflict-safe inserts, and never deletes rows or creates synthetic members.
- Hardened the public unsubscribe endpoint with shared request limits, bounded token input, escaped
  HTML output, and production fail-closed secret handling.
- Preserved active family membership checks and tightened listing-share deletion to the owning family
  and listing.
- Added `tests/marketplace-circles-rls.test.ts`.
- Removed process-wide TLS certificate-verification bypasses from six seed scripts and added a
  regression contract test.
- Added `supabase/seed_production_readiness.sql`, an idempotent pack generating 600 realistic
  independence-ladder records without destructive statements or Auth writes.
- Removed a live Supabase service credential from all current seed scripts and centralized credential
  loading in `scripts/seed-client.mjs`.
- Updated `.env.example` with runtime variables previously used by the code but undocumented.
- Preserved pre-existing user changes in the two seed files and the seed-safety contract test.

## Security Findings

- No new secret was added or printed.
- P0: a historical seed script contained a credential matching the current configured service key. The
  current tree is scrubbed and regression-tested, but rotation and audit-log review require a Supabase
  project owner; the CLI returned HTTP 403 for the key-management endpoint.
- Existing middleware refreshes Supabase sessions and redirects anonymous users away from protected
  routes.
- Existing response headers include `nosniff`, frame denial, strict referrer policy, permissions
  policy, and HSTS.
- Existing documentation records earlier auth, webhook, tenant-isolation, and rate-limit repairs.
- Marketplace circles had a P1 availability/authorization-verification defect; the additive repair
  is present but awaits migration application and RLS allow/deny testing.
- Marketplace negotiations now reject same-family self-deals and malformed or above-ask rounds at the
  database boundary; migration `0187` still requires live application and verification.
- `npm audit --omit=dev --audit-level=moderate` reports zero vulnerabilities after the scoped PostCSS
  override; the supported Next.js 15 runtime remains in place.
- Scheduled jobs now fail closed when `CRON_SECRET` is missing; internal welcome email delivery also
  requires a configured `INTERNAL_SECRET`.

## Validation Results

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm.cmd run typecheck` |
| Lint | PASS, with Next.js deprecation notice | `npm.cmd run lint` |
| Unit tests | PASS, 2,919 tests / 380 files | `npm.cmd exec vitest run` |
| Production build | PASS, 250 generated pages | `npm.cmd run build` |
| Public E2E | PASS, 51 of 52 tests; 1 intentional auth skip | `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e` |
| Accessibility E2E | PASS for public routes in dark and light modes | Playwright + axe |
| Mobile overflow E2E | PASS at 320, 390, 768, and 1024 widths | Playwright |
| Migration/seed contract | PASS, 30 focused tests | targeted Vitest run |
| Migration filename audit | PASS, 17 known historical duplicate prefixes; next `0204` | `npm.cmd run db:audit:migrations` |
| Schema probe | PASS | 11 required live table/ledger probes available, including Stripe claim columns |
| Auth Admin probe | BLOCKED/FAIL | live GoTrue HTTP 500 `Database error finding users` (`019f617e-363b-77ea-9e8a-db390083d810`) |
| Local Supabase migration | BLOCKED | Docker Desktop unavailable |
| Dependency audit | PASS | 0 vulnerabilities after the scoped PostCSS override |
| Live RLS attack tests | NOT RUN | requires isolated Supabase with migration applied |

## Remaining Launch Blockers

1. Confirm migration history through `0199_marketplace_handoff_completion.sql` in the intended environment and
   reconcile the 17 known historical duplicate prefixes before using automated migration push there;
   rerun cross-family RLS and negotiation allow/deny probes.
2. Diagnose the live Supabase Auth Admin 500 in Supabase/GoTrue/Postgres logs and rerun the Auth audit.
3. Run authenticated E2E and database RLS tests against an isolated local Supabase instance.
4. Confirm production environment variables and third-party provider configuration using the updated
   `.env.example` and deployment checklist.

## Recommended Launch Decision

**NO-GO.** The local application quality gates are green, but live database migration state, Auth Admin
health, and RLS attack tests are not fully proven. No production data was changed during this audit.

The audited model-backed and external-provider routes now use shared per-user durable request budgets
before provider calls or broad context reads. This covers the model-backed `/api/ai` inventory plus
vacation AI/weather, recipe AI, and weekend discovery routes, while preserving existing plan/day caps.
Rejected requests return `Retry-After`; if migration `0156` or the RPC is unavailable, guarded
operations now fail closed instead of silently bypassing the durable limit.

The follow-up provider inventory also covers marketing-admin AI, behavior coaching, and the authenticated
Giphy proxy. These routes now budget paid/provider work before loading broad context or calling an
external service; marketing prompts are capped at 4,000 characters and rejected requests return
`Retry-After`.

The durable rate-limit RPC security audit found that migration `0156` exposed `rate_limit_hit` to
anonymous/public callers and left `rate_limit_prune` publicly executable. Migration `0179` revokes
those privileges, preserves authenticated server calls only for user-scoped keys, and grants pruning
only to `service_role`. Billing and notification route keys were updated to include the authenticated
user ID.

The Resend webhook now rejects signatures older than five minutes or payloads over 256 KB and records
each Svix event ID in `resend_webhook_events` before applying campaign analytics, suppression, or
automation side effects. Processed deliveries short-circuit; stale processing rows remain retryable.

The public unsubscribe path now uses the shared IP limiter before service-role writes, rejects malformed
or oversized HMAC tokens, escapes the reflected address in HTML, and refuses to mint tokens in production
when no configured signing secret exists.

Signed Twilio Guardian callbacks now reject oversized or malformed input and claim provider event IDs
before decision pipelines, AI screening, notifications, or telephony work. Retries are idempotent through
the service-only `guardian_callback_events` ledger; stale processing claims can be reclaimed after ten
minutes if a worker crashes.

Stripe billing and money webhooks now reject oversized payloads and missing configuration, return a
storage-unavailable response when the event ledger cannot be claimed, and serialize concurrent event
claims. Each worker receives an ownership token, so only its own claim can be marked processed or errored.
Only failed or stale abandoned claims are retried; active concurrent deliveries short-circuit.

Calendar imports and stored-feed syncs now validate every server-side URL against public DNS/IP ranges,
reject credentials and private, loopback, link-local, metadata, and documentation targets, and manually
revalidate up to three redirects. Calendar response bodies are capped at 1 MiB, import request bodies
at 16 KiB, and provider details are excluded from error responses. This closes the SSRF and unbounded
response-read boundary shared by legacy imports and scheduled feed syncs.

Signed webhooks, push registration/removal, calendar sync, Twilio callbacks, and voice transcription now
use bounded request readers before signature or platform parsing. Twilio bodies are capped at 64 KiB and
multipart audio requests at 26 MiB, leaving the existing 25 MiB per-file validation in force.

Social Feed URL unfurling now uses the same public DNS validation and manual redirect checks as calendar
fetches. Its HTML response is bounded at 600 KiB before metadata parsing, preventing a family member's
pasted URL from reaching private redirect targets or causing an unbounded server-side response read.

Audited provider error paths now use a shared streaming response reader before diagnostics are parsed or
logged. OpenAI, Twilio, email, marketing, voice, and flyer provider errors are capped at 64 KiB; Google
and Microsoft Graph sync response text is capped at 2 MiB. Deliberately streamed success responses
remain unchanged.

## Audit Update - 2026-07-13 (Social Feed unfurl SSRF and response bounds)

- `npm.cmd exec vitest run tests/social-feed-fetch-security.test.ts tests/public-calendar-fetch.test.ts tests/weekend-feed-security.test.ts`:
  3 files, 8 tests passed.
- `npm.cmd test`: 326 files and 2,642 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Social Feed unfurling now rejects unsafe redirect targets and oversized streamed HTML before metadata
  parsing; no database migration was required.

## Audit Update - 2026-07-13 (provider response bounds)

- `npm.cmd exec vitest run tests/response-body-boundaries.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts`:
  4 files, 39 tests passed.
- `npm.cmd exec vitest run`: 327 files and 2,645 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Audited provider error and Graph response text reads now stop at bounded byte limits before parsing or
  logging; no database migration was required.

## Audit Update - 2026-07-13 (provider JSON response bounds)

- `npm.cmd exec vitest run tests/response-body-boundaries.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts tests/weather.test.ts tests/weekend-feed-security.test.ts tests/recipe-normalize.test.ts tests/trip-departure.test.ts`:
  8 files, 76 tests passed.
- `npm.cmd exec vitest run`: 327 files and 2,648 tests passed.
- Provider JSON responses now use the shared streaming byte boundary before parsing; OAuth responses also
  reject successful payloads that omit an access token.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.

## Audit Update - 2026-07-13 (external provider timeouts)

- `npm.cmd exec vitest run tests/external-fetch-boundaries.test.ts tests/response-body-boundaries.test.ts tests/assistant-tool-loop.test.ts tests/ai-error.test.ts tests/ai-voice.test.ts tests/sync-adapter.test.ts tests/weather.test.ts tests/weekend-feed-security.test.ts tests/recipe-normalize.test.ts tests/trip-departure.test.ts`:
  10 files, 83 tests passed.
- `npm.cmd exec vitest run`: 328 files and 2,652 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Fixed-provider server integrations now receive finite deadlines between 10 and 60 seconds; browser
  Open-Meteo and OSRM calls use a cancellable 15-second deadline. No database migration was required.

## Audit Update - 2026-07-13 (SECURITY DEFINER trigger hardening)

- `npm.cmd exec vitest run tests/sql-security-contract.test.ts tests/production-migration-contract.test.ts tests/rate-limit-rpc-security.test.ts tests/marketplace-auction-security.test.ts tests/marketplace-negotiation-security.test.ts`:
  5 files, 19 tests passed.
- `npm.cmd exec vitest run`: 329 files and 2,655 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- Migration `0188_harden_trigger_function_security.sql` repairs both legacy trigger functions with
  `SET search_path = public` and revokes `PUBLIC`, `anon`, and `authenticated` execution privileges.

## Audit Update - 2026-07-13 (Stripe claim-column reconciliation)

- `npm.cmd exec vitest run tests/production-migration-contract.test.ts tests/stripe-webhook-replay-contract.test.ts`:
  2 files, 15 tests passed.
- `npm.cmd exec vitest run`: 329 files and 2,656 tests passed.
- `node --check scripts/audit-supabase-schema.mjs`: passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `npm.cmd run db:audit:schema`: 10 live checks passed; `stripe_webhook_events.claim_columns` remains missing
  until `0189` is applied.
- `npm.cmd run db:audit:auth`: public auth health passed; Supabase Auth Admin user listing still returns HTTP 500.
- Migration `0189_reconcile_stripe_webhook_claims.sql` re-applies both claim columns and the processing
  index idempotently; the live schema audit now verifies `processing_started_at` and `claim_token`.

## Audit Update - 2026-07-13 (public metric error boundaries)

- `npm.cmd exec vitest run tests/public-error-contract.test.ts tests/production-migration-contract.test.ts`:
  2 files, 12 tests passed.
- `npm.cmd exec vitest run`: 330 files and 2,657 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Public A/B, landing-page, and exit-intent metric failures now return stable generic messages instead of
  raw Supabase error details; server logs retain the underlying diagnostic.

## Audit Update - 2026-07-13 (API database-error boundaries)

- `npm.cmd exec vitest run tests/database-error-boundaries.test.ts tests/public-error-contract.test.ts`:
  2 files, 2 tests passed.
- `npm.cmd exec vitest run`: 331 files and 2,658 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- Database failures in audited authenticated and cron routes now return operation-specific generic errors;
  the underlying error is logged server-side for diagnosis.

## Audit Update - 2026-07-13 (raw webhook and upload body bounds)

- `npm.cmd exec vitest run tests/raw-body-boundaries.test.ts tests/request-body-boundaries.test.ts`:
  2 files, 7 tests passed.
- `npm.cmd test`: 325 files and 2,639 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `readBoundedRequestText` now enforces streaming byte limits before complete-body buffering for Stripe,
  Resend, and money webhooks, push subscription routes, and calendar sync.
- `readBoundedRequestFormData` now applies the same bounded byte reader before Twilio URL-encoded and
  multipart voice requests reach the platform parser; focused tests preserve form fields and audio files.
- Live schema and Auth Admin blockers remain unchanged; no production data was modified.

## Audit Update - 2026-07-13 (calendar fetch SSRF and response bounds)

- `npm.cmd exec vitest run`: 313 files and 2,583 tests passed.
- `npm.cmd exec vitest run tests/public-calendar-fetch.test.ts tests/calendar-feeds.test.ts`: 2 files,
  14 tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed; only the existing Next.js `next lint` deprecation notice remains.
- `npm.cmd run build`: passed; 233 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
- `lib/server/public-calendar-fetch.ts` now provides the shared public-host, redirect, timeout, and
  bounded-body boundary used by both calendar ingestion paths.

## Audit Update - 2026-07-13 (push registration boundary)

- `npm.cmd exec vitest run tests/push-request.test.ts`: 1 file, 4 tests passed.
- Push registration and removal now cap request bodies, validate HTTPS web endpoints, validate native
  provider/platform pairs and token characters, bound user-agent and key lengths, and apply per-user
  local plus durable request budgets before Supabase writes.
- Database schema is unchanged; the repair uses the existing `push_devices` contract and remains
  compatible with web push, APNs, and FCM clients.

## Audit Update - 2026-07-13 (marketplace auction authorization and atomic purchase)

- `npm.cmd exec vitest run tests/marketplace-auction.test.ts tests/marketplace-auction-security.test.ts`:
  2 files, 13 tests passed.
- Migration `0184_marketplace_auction_authorization.sql` removes direct authenticated bid inserts,
  validates that the RPC member belongs to the authenticated family, and keeps the unchecked bid engine
  private to service-role internals.
- Buy-It-Now now locks the listing and creates the order in one database transaction, so a failed order
  insert cannot leave a claimed listing without an order.
- No production migration has been applied by this agent; the live schema probe must pass after `0184`
  is deployed with the auction feature.
- `npm.cmd run build`: passed; 234 pages generated.
- `$env:PLAYWRIGHT_SKIP_BUILD='1'; npm.cmd run test:e2e`: 51 passed, 1 intentional authenticated test skipped.
## Audit Update - 2026-07-13

Legacy service-role seed scripts were hardened after the initial report: fixed family/user scopes
and stale member fallbacks were removed. Every `scripts/seed*.mjs` script now requires an explicit
non-production environment, confirmed family UUID, and creator UUID through `scripts/seed-client.mjs`.
The focused scope and credential safety tests pass. This does not clear the external Supabase key
rotation, pending migration, Auth Admin 500, or local Docker blockers.

## Audit Update - 2026-07-13 (seed write failure boundaries)

- All six legacy service-role seed scripts now throw on insert failures instead of logging the error and
  continuing with a partial dataset. The medical seed also fails closed on family-scoped cleanup errors.
- `node --check` passed for every `scripts/seed*.mjs` file.
- `npm.cmd exec vitest run tests/seed-failure-safety.test.ts tests/seed-scope-safety.test.ts tests/seed-credentials-safety.test.ts tests/seed-tls-safety-contract.test.ts`:
  4 files, 5 tests passed.
- Full Vitest passed: 344 files and 2,725 tests. Typecheck, lint, audit (0 vulnerabilities), build (235
  pages), and public Playwright/axe/overflow E2E (51 passed, 1 intentional auth skip) also passed.
- `npm.cmd run db:audit:schema`: 11 required live schema checks passed. `npm.cmd run db:audit:auth` still
  fails only on the live Admin users endpoint with HTTP 500 (`019f5de7-9b16-78cc-9e87-d74ac923eb08`).

## Audit Update - 2026-07-13 (CI gate enforcement)

- GitHub Actions now runs `npm audit --omit=dev --audit-level=moderate` in the quality job.
- The isolated Supabase E2E job now runs both `npm run db:audit:auth` and `npm run db:audit:schema`
  before browser tests.
- `npm.cmd exec vitest run tests/production-readiness-workflow.test.ts`: 1 file, 2 tests passed.
- Full local validation after the workflow/documentation update: 345 test files and 2,727 tests passed,
  typecheck, lint, npm audit (0 vulnerabilities), and build (235 pages) passed.

## Audit Update - 2026-07-13 (post-rebase marketplace deals)

- Rebased onto remote `main` commit `4a0fa966`, which adds the marketplace Deals feed and related
  Price Coach coverage.
- Full Vitest passed: 345 files and 2,729 tests. Typecheck, lint, npm audit (0 vulnerabilities), and
  production build (235 pages) passed.
- Public Playwright/axe/overflow E2E passed: 51 of 52 tests, with the intentional authenticated test skip.

The public gift capability flow was also hardened: inactive or revoked gift URLs no longer perform
service-role lookups or disclose child/family names. A regression contract covers the privacy boundary.

Guardian AI screening callbacks now require the next bounded persisted turn before AI work or further
service-role reads, preventing stale, skipped, and over-limit callback replays from duplicating work.

Public A/B event ingestion now validates submitted variants against the active experiment definition
and bounds identifiers before writing service-role events, preventing fabricated metrics.

Public consent ingestion now rate-limits both reads and writes and rejects unknown, non-boolean, or
oversized consent maps before appending service-role events.

The authenticated agentic AI chat route now enforces per-user in-memory and durable request limits,
validates conversation UUIDs, and rejects oversized or empty messages before model/tool execution.

Authenticated voice transcription and speech synthesis now share the same local plus durable per-user
AI request guard before reading keys or calling OpenAI; the existing audio-size and text-size bounds remain.

The family-scoped AI insights endpoint now applies the same per-user guard before loading context or
invoking a model, protecting its broad multi-module data reader from runaway requests.

The public calendar capability feed now validates compact URL-safe tokens and applies local plus durable
IP limits before service-role calendar reads, while keeping anonymous iCalendar subscriptions supported.

Billing checkout, plan-change, cancellation, and portal-session routes now apply per-family local plus
durable request limits after parent authorization and before Stripe side effects.

Generic provider sync, Google sync, and the legacy Google Calendar import now apply per-family/user
request limits before token refreshes or external calendar API work.

Provider-sync OAuth now uses random, provider-scoped, httpOnly state cookies for both the static Google
flow and the generic provider flow. Callbacks compare state in constant time, derive the account from the
live session, and clear the state cookie on every exit path; the previous user/family payload in the
query-string state was not browser-bound and could be replayed as a CSRF token.

Notification refresh and test-push routes now apply family/user request limits before notification
generation or device fan-out side effects.

Public contact, marketing-form, exit-intent, landing-page, visitor-intelligence, and A/B ingestion
routes now use the shared local-plus-durable request limiter before service-role writes, automation
events, or metric RPCs. These routes now return `Retry-After` on distributed-limit rejection.
