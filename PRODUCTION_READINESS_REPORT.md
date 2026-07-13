# Production Readiness Report

## Executive Summary

FamilyOS is in a strong local validation state, but it is not proven production-ready. The current
tree compiles, passes lint and type checking, passes 2,600 unit tests, builds all 234 Next.js build
routes, and passes 51 public/mobile/accessibility E2E checks. The audit also found and repaired a
real RLS recursion defect in marketplace circles, but the new migration has not been applied to a
live database by this audit.

Recommended decision: **NO-GO until the pending database migration is applied and the live Supabase
Auth Admin 500 is diagnosed, and the exposed historical Supabase credential is rotated.** After
those checks pass in an isolated environment, the posture can be reconsidered as Conditional Go.

## Scope and Inventory

- 348 `page.tsx` route files.
- 100 API route handlers.
- 193 migrations at audit start; additive repair migrations `0178` through `0182` added.
- 315 SQL files under `supabase`.
- 316 unit-test files and 2,600 passing tests.
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
- `npm audit --omit=dev --audit-level=high` reports two moderate PostCSS advisories through Next.js,
  with no available fix in the installed dependency graph.

## Validation Results

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm.cmd run typecheck` |
| Lint | PASS, with Next.js deprecation notice | `npm.cmd run lint` |
| Unit tests | PASS, 2,600 tests / 316 files | `npm.cmd test` |
| Production build | PASS, 234 generated pages | `npm.cmd run build` |
| Public E2E | PASS, 51 tests; 1 intentional auth skip | `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e` |
| Accessibility E2E | PASS for public routes in dark and light modes | Playwright + axe |
| Mobile overflow E2E | PASS at 320, 390, 768, and 1024 widths | Playwright |
| Migration contract | PASS, 10 focused tests | targeted Vitest run |
| Schema probe | BLOCKED/FAIL | 10 live table/ledger probes pass; Stripe claim column from 0182 is missing |
| Auth Admin probe | BLOCKED/FAIL | live GoTrue HTTP 500 `Database error finding users` |
| Local Supabase migration | BLOCKED | Docker Desktop unavailable |
| Dependency audit | FAIL/PENDING | 2 moderate PostCSS advisories, no fix available |
| Live RLS attack tests | NOT RUN | requires isolated Supabase with migration applied |

## Remaining Launch Blockers

1. Apply migrations through `0182_stripe_webhook_claims.sql` in the intended environment and
   rerun schema plus cross-family RLS allow/deny probes.
2. Diagnose the live Supabase Auth Admin 500 in Supabase/GoTrue/Postgres logs and rerun the Auth audit.
3. Resolve or formally accept the PostCSS advisory after reviewing the next compatible Next.js release.
4. Run authenticated E2E and database RLS tests against an isolated local Supabase instance.
5. Confirm production environment variables and third-party provider configuration using the updated
   `.env.example` and deployment checklist.

## Recommended Launch Decision

**NO-GO.** The local application quality gates are green, but live database migration state, Auth Admin
health, and RLS attack tests are not fully proven. No production data was changed during this audit.

The audited model-backed and external-provider routes now use shared per-user durable request budgets
before provider calls or broad context reads. This covers the model-backed `/api/ai` inventory plus
vacation AI/weather, recipe AI, and weekend discovery routes, while preserving existing plan/day caps.
Rejected requests return `Retry-After`; durable enforcement still depends on migration `0156` being
applied in the target environment.

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
rotation, pending migration, Auth Admin 500, local Docker, or dependency advisory blockers.

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
