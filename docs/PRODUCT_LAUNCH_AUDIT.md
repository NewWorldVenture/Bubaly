# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0275 - Vacation AI persistence could leave partial itinerary state

- Timestamp: 2026-07-14
- Service: Vacation AI
- Route: `/api/ai/trip`, `/dashboard/vacations/[id]/ai-assistant`
- Affected files: `app/api/vacations/ai/route.ts`, `tests/vacation-ai-persistence-boundaries.test.ts`
- Role: authenticated family member with vacation access
- Scenario: generated recommendations, itinerary, activities, packing and concierge writes fail mid-request
- Severity: P1
- Launch impact: partial or cross-vacation data could be shown as a successful plan
- Root cause: context reads and follow-up writes were not uniformly checked or compensated
- Resolution: fail-closed reads, checked writes, compensation, and family/vacation conversation scoping
- Supabase impact: family/vacation filters and cleanup writes now define the persistence boundary
- Tests run: focused persistence, full Vitest, typecheck, lint, build, public E2E baseline
- Validation evidence: `tests/vacation-ai-persistence-boundaries.test.ts`, commit history
- Commit: `adfe3139`
- Status: Resolved in code; full service and provider audit remains open
- Remaining dependencies: live provider outage/cost and complete vacation UI workflow test

### PLA-0276 - AI meal planning could replace slots after a partial save

- Timestamp: 2026-07-14
- Service: Meals and AI planning
- Route: `/api/ai/meals/plan`, meal planner UI
- Affected files: `app/api/ai/meals/plan/route.ts`, `tests/ai-meal-plan-persistence.test.ts`
- Role: authenticated family member
- Scenario: generated plan writes fail after existing meal slots are removed
- Severity: P1
- Launch impact: meal plans could be silently incomplete or orphan generated rows
- Root cause: candidate/pantry reads and replacement writes were not fail-closed
- Resolution: checked reads, slot restoration, generated-row cleanup, and all-assignment success requirement
- Supabase impact: meal slot and generated meal writes now have explicit recovery behavior
- Tests run: focused AI meal tests, full Vitest, typecheck, lint, build
- Validation evidence: `tests/ai-meal-plan-persistence.test.ts`
- Commit: `45f911f6`
- Status: Resolved in code; full food service audit remains open
- Remaining dependencies: complete CRUD/import/empty-state and seed-profile verification

### PLA-0277 - AI chat accepted unverified conversation ownership

- Timestamp: 2026-07-14
- Service: AI chat and privacy
- Route: `/api/ai/chat`
- Affected files: `app/api/ai/chat/route.ts`, `tests/ai-chat-ownership.test.ts`
- Role: authenticated family member
- Scenario: client-supplied conversation UUID is reused across family or user boundaries
- Severity: P1
- Launch impact: private conversation history could be read or appended incorrectly
- Root cause: duplicate-tolerant upsert was not followed by explicit ownership read
- Resolution: family and user ownership are revalidated before history/messages are loaded or written
- Supabase impact: conversation reads and message persistence are scoped to active family and user
- Tests run: ownership regression, full Vitest, typecheck, lint, build
- Validation evidence: `tests/ai-chat-ownership.test.ts`
- Commit: `090ded80`
- Status: Resolved in code; complete AI/provider audit remains open
- Remaining dependencies: provider failure, streaming, quota, cost and role testing

### PLA-0278 - Chore transitions could silently diverge

- Timestamp: 2026-07-14
- Service: Chores and missions
- Route: `/missions`, `/kids`, parent review actions
- Affected files: `app/(app)/missions/actions.ts`, `tests/chore-state-transition-persistence.test.ts`
- Role: child submitter, parent/guardian reviewer
- Scenario: submission, assignment, dispute, reward or creation follow-up write fails
- Severity: P1
- Launch impact: proof and reward state could disagree, creating financial or trust disputes
- Root cause: related state transitions were best effort
- Resolution: checked transitions, rollback, dispute cleanup, parent-review fallback, and chore compensation
- Supabase impact: submission/assignment/dispute rows remain coordinated on failure
- Tests run: focused transition tests, full Vitest, typecheck, lint, build
- Validation evidence: `tests/chore-state-transition-persistence.test.ts`
- Commit: `19121862`
- Status: Resolved in code; full mission UI/role/upload audit remains open
- Remaining dependencies: complete browser, notification and dispute workflow matrix

### PLA-0279 - Manual allowance could skip failed payment

- Timestamp: 2026-07-15
- Service: Family Wallet allowances
- Route: `/wallet/allowance`
- Affected files: `app/(app)/wallet/actions.ts`, `tests/wallet-allowance-persistence.test.ts`
- Role: manager with Basic+ wallet access
- Scenario: due allowance credit fails after the schedule advances
- Severity: P1
- Launch impact: a child could permanently miss an allowance
- Root cause: rule reads and schedule writes were not fail-closed
- Resolution: checked schedule write, rollback on credit failure, success-only counters
- Supabase impact: allowance rule state remains due when credit does not persist
- Tests run: focused wallet persistence, full Vitest, typecheck, lint, audit, build
- Validation evidence: `tests/wallet-allowance-persistence.test.ts`
- Commit: `a466600b`
- Status: Resolved in code; live migration/RLS and full wallet audit remain open
- Remaining dependencies: deploy verification and concurrency/reconciliation tests

### PLA-0280 - Allowance cron ignored schedule and credit failures

- Timestamp: 2026-07-15
- Service: Scheduled wallet automation
- Route: `/api/cron/wallet-allowance`
- Affected files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Role: system cron with service-role access
- Scenario: schedule update or wallet credit fails during a due run
- Severity: P1
- Launch impact: duplicate or missing scheduled payments and invisible cron failures
- Root cause: schedule update was unchecked and happened after credit
- Resolution: checked schedule claim before credit, rollback on failure, visible failed response
- Supabase impact: allowance rule schedule and immutable ledger stay recoverable
- Tests run: focused cron/manual allowance tests, full Vitest, typecheck, lint, audit, build
- Validation evidence: `tests/cron-wallet-allowance-persistence.test.ts`
- Commit: `f5cbd014`
- Status: Resolved in code; scheduled-job replay and alerting audit remains open
- Remaining dependencies: cron observability and live replay smoke

### PLA-0281 - Goal funding could debit without updating goal progress

- Timestamp: 2026-07-15 07:49 America/New_York
- Service: Family Wallet savings goals
- Route: `/wallet/goals`
- Affected files: `supabase/migrations/0208_atomic_wallet_goal_funding.sql`, `lib/wallet/server.ts`, `lib/database.types.ts`, `app/(app)/wallet/actions.ts`, `tests/wallet-goal-persistence.test.ts`
- Role: parent/guardian manager
- Scenario: Save-bucket balance is checked, debit is inserted, and goal update/audit fails or races
- Severity: P1
- Launch impact: money can leave the Save bucket without matching goal progress
- Root cause: separate best-effort client writes and non-locking balance read
- Resolution: manager-checked row-locking RPC atomically rechecks balance, debits ledger, updates goal/status, and writes audit
- Supabase impact: new `wallet_fund_goal` function and migration `0208`; typed wrapper replaces direct writes
- Tests run: focused goal/atomic contracts, 403-file/3,024-test suite, typecheck, lint, audit, schema probes, seed invariant, clean build
- Validation evidence: `tests/wallet-goal-persistence.test.ts`, `npm.cmd run db:audit:schema`, 250-route build
- Commit: `7a20e160`
- Status: Resolved in code and pushed to `main`; remote migration application remains a dependency
- Remaining dependencies: reconcile/apply migration remotely, then run authenticated wallet concurrency smoke

## Open Launch Findings

### AUDIT-AUTH-001 - Privileged admin action guard coverage was implicit

- Timestamp: 2026-07-15 07:59 America/New_York
- Service: Authentication and tenant isolation
- Route: `/admin/*`, `middleware.ts`
- Affected files: `tests/admin-auth-boundary.test.ts`, `app/(app)/admin/layout.tsx`, `middleware.ts`, `lib/marketing/admin.ts`
- Role: Super Admin, standard authenticated user, anonymous visitor
- Scenario: a future admin server action accidentally creates a service-role client without rechecking privilege
- Severity: P2
- Launch impact: regression risk could expose cross-family or site-wide data through a privileged action
- Root cause: guard convention existed in code but had no repository-wide drift test
- Resolution: static regression test now scans all service-role admin action files and asserts explicit privileged guards plus page/session gates
- Supabase impact: protects service-role access to cross-family tables; it does not replace live RLS verification
- Tests run: `tests/admin-auth-boundary.test.ts`, full 405-file/3,030-test suite, typecheck, lint, dependency audit
- Validation evidence: all 38 service-role admin action files passed the guard scan
- Commit: `f464ac9e`
- Status: Resolved in code; auth unit remains in progress
- Remaining dependencies: live Auth Admin health, cross-tenant RLS probes, authenticated E2E roles

### PLA-B001 - Auth Admin health is unverified

- Timestamp: 2026-07-15
- Service: Authentication and tenant operations
- Route: Supabase Auth Admin users endpoint
- Affected files: `scripts/audit-supabase-auth.mjs`, auth configuration and deployment secrets
- Role: operator, admin, all authenticated roles
- Scenario: production user administration and account lifecycle are exercised
- Severity: P0
- Launch impact: cannot certify account creation, recovery, admin control, or role lifecycle
- Root cause: live endpoint has historically returned HTTP 500
- Resolution: none yet; tracked as `LB-001`
- Supabase impact: Auth Admin health and user lifecycle remain unverified
- Tests run: historical `npm.cmd run db:audit:auth`
- Validation evidence: `docs/LAUNCH_BLOCKERS.md`
- Commit: n/a
- Status: Open
- Remaining dependencies: Supabase operator diagnosis and live retest

### PLA-B002 - Remote migration history and credential rotation are unverified

- Timestamp: 2026-07-15
- Service: Supabase deployment and secrets
- Route: database migration/deployment pipeline
- Affected files: migrations, deployment environment configuration, secret manager
- Role: deployer/operator
- Scenario: launch applies the checkout to production and revokes historical credentials
- Severity: P0
- Launch impact: schema drift or leaked credentials can invalidate all feature-level evidence
- Root cause: checkout is not linked to a confirmed remote migration ledger; historical credential rotation is pending
- Resolution: none yet; tracked as `LB-002` and `LB-003`
- Supabase impact: migration application, key revocation and RLS posture are not fully proven
- Tests run: local migration audit and 11 schema probes only
- Validation evidence: `docs/LAUNCH_BLOCKERS.md`, `docs/SUPABASE_WIRING_MATRIX.md`
- Commit: n/a
- Status: Open
- Remaining dependencies: Supabase access and secret-manager operation

### PLA-0282 - Onboarding finalization could duplicate records on replay

- Timestamp: 2026-07-15 08:10 America/New_York
- Service: Onboarding and household provisioning
- Route: `/onboarding`
- Affected files: `app/onboarding/actions.ts`, `lib/onboarding/idempotency.ts`, `lib/database.types.ts`, `supabase/migrations/0210_onboarding_idempotency.sql`, `tests/onboarding-idempotency.test.ts`
- Role: new account owner; family administrator
- Scenario: browser timeout, double-submit, or partial required write followed by a resumed wizard submission
- Severity: P1
- Launch impact: duplicate managed members, invitations, calendar events, import markers, and repeated invite email delivery
- Root cause: multi-table finalization used blind inserts without a stable submission/item identity
- Resolution: authenticated deterministic SHA-256 submission/item keys, nullable database columns with family-scoped unique indexes, keyed upserts, existing-invite token reuse without duplicate delivery, and a service-only `onboarding_claim_family` RPC with a per-user transactional advisory lock
- Supabase impact: migration `0210_onboarding_idempotency.sql` adds four nullable columns and four unique indexes; no destructive data operation
- Tests run: focused onboarding safety/idempotency/migration tests, full Vitest, typecheck, lint, dependency audit, migration audit, diff check, production build
- Validation evidence: 8 focused tests; 406 files/3,033 tests; 226 numbered migrations with next `0211`; 250-route build; 0 dependency vulnerabilities
- Commit: `6148080d`
- Status: Resolved in code; remote migration application, live RLS, and authenticated E2E remain open dependencies
- Remaining dependencies: apply `0210`, exercise partial-failure replay in isolated Supabase, verify invite/email behavior and cross-tenant denial

### PLA-0283 - Guardian escalation could replay telephony or miss parent phones

- Timestamp: 2026-07-15 08:30 America/New_York
- Service: Guardian emergency escalation
- Route: `/api/guardian/escalate`
- Affected files: `app/api/guardian/escalate/route.ts`, `lib/guardian/escalation.ts`, `lib/guardian/callbacks.ts`, `tests/guardian-escalation-replay.test.ts`
- Role: Guardian system notifying family parents/managers
- Scenario: a valid internal escalation request is retried or needs to resolve parent phone numbers
- Severity: P1
- Launch impact: duplicate SMS/calls or silent failure to notify parents
- Root cause: the route had no durable callback claim before telephony, and it queried `profiles.id` using `family_members.id` instead of `family_members.user_id`
- Resolution: bounded Zod payload validation, communication-aware deterministic event IDs, service-only callback claim/error/processed state, and correct profile lookup through `user_id`
- Supabase impact: reuses `guardian_callback_events` from migration `0181_guardian_callback_replay.sql`; no schema change
- Tests run: `tests/guardian-escalation-replay.test.ts` and `tests/guardian-callback-security.test.ts` (11 tests), typecheck, diff check
- Validation evidence: claim occurs before `sendSms`/`initiateCall`; parent phones resolve from profile IDs; callback errors remain retryable
- Commit: `6148080d`
- Status: Resolved in code; live provider, role/privacy, and RLS verification remain open
- Remaining dependencies: run isolated Twilio retry/failure smoke tests and verify parent notification privacy in Supabase

### PLA-0284 - Family membership RLS allowed self-promotion and family reassignment

- Timestamp: 2026-07-15 08:42 America/New_York
- Service: Authentication, tenant isolation, and RLS
- Route: `/family/members`, `/family/permissions`, direct authenticated Supabase membership writes
- Affected files: `supabase/migrations/0118_rls_drift_repair.sql`, `supabase/migrations/0211_family_members_update_rls.sql`, `tests/tenant-isolation-rls.test.ts`
- Role: any authenticated family member; parent/manager administrator
- Scenario: a non-manager updates their own `family_members` row to change role, `is_active`, or `family_id`
- Severity: P0
- Launch impact: tenant membership and role boundaries could be escalated or reassigned, undermining all family-scoped RLS
- Root cause: migration `0118` restored the legacy `or user_id = auth.uid()` UPDATE exception without a manager-only `WITH CHECK`
- Resolution: migration `0211_family_members_update_rls.sql` reasserts manager-only `USING` and `WITH CHECK` policies; profile and child-login writes remain server-side service-role operations after auth guards
- Supabase impact: policy-only repair on `family_members`; no destructive data change; migration must be applied remotely
- Tests run: four focused files, 9 tests; typecheck; migration filename audit; diff check
- Validation evidence: migration contains manager-only update predicates and no self-update exception; ordinary account actions have no direct client membership update path
- Commit: `eb99f0a0`
- Status: Resolved in code; remote migration application and authenticated two-tenant RLS verification remain open
- Remaining dependencies: apply `0211`, prove non-manager deny/manager allow behavior, and re-run Auth Admin health

### PLA-0285 - Admin notification failures were silent to operators

- Timestamp: 2026-07-15 09:04 America/New_York
- Service: Admin operations and notification observability
- Route: `/admin/notifications`, global admin notification bell
- Affected files: `lib/admin/notify.ts`, `app/(app)/admin/notifications-actions.ts`, `components/admin/admin-notifications-list.tsx`, `components/admin/admin-notification-bell.tsx`, `tests/admin-notification-boundary.test.ts`
- Role: Super Admin; server-side alert producers
- Scenario: an `admin_notifications` insert or mark-read update fails at the Supabase boundary
- Severity: P1
- Launch impact: operational alerts could disappear without diagnostics, or a Super Admin could be shown stale unread state after a failed mutation
- Root cause: returned Supabase insert errors were ignored, and the client refreshed regardless of the mark-read action result
- Resolution: log returned insert errors and expose sanitized action failures through accessible alert states; refresh only after success
- Supabase impact: existing service-role-only `admin_notifications` table; no migration or data change
- Tests run: `tests/admin-notification-boundary.test.ts` and `tests/admin-notifications.test.ts` (12 tests), full 409-file/3,045-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: producer checks query errors; both history and bell handlers branch on `{ ok: false }` before `router.refresh()`; 250-route build passed; live schema audit passed all 11 checks
- Commit: `991ad4dd`
- Status: Resolved in code; live Super Admin workflow and failure-injection evidence remain open
- Remaining dependencies: failure injection, auth permission, alert routing, and browser/operator smoke tests

### PLA-0286 - Connections hub reported label-only integrations as live

- Timestamp: 2026-07-15 09:14 America/New_York
- Service: Family Connections and third-party integrations
- Route: `/dashboard/connections`
- Affected files: `components/modules/connections-module.tsx`, `lib/connections/providers.ts`, `tests/connections-providers.test.ts`, `tests/connections-ui-boundary.test.ts`
- Role: authenticated family members
- Scenario: a member clicked Connect for Gmail, banking, grocery, or smart-home providers without a real OAuth/sync flow
- Severity: P1
- Launch impact: the UI could show an integration as Connected after saving only a label, while no credentials, sync account, or data ingestion existed
- Root cause: the module upserted `family_connections` directly from a free-form account field and treated the directory record as a live integration
- Resolution: live Google, Microsoft, and Apple entries now route to their real sync setup pages; unsupported providers no longer open a fake account modal or persist a false-success row
- Supabase impact: no schema change; removes the false-positive write path while retaining family-scoped reads and disconnects
- Tests run: `tests/connections-providers.test.ts`, `tests/connections-adapter.test.ts`, and `tests/connections-ui-boundary.test.ts` (23 tests), full 410-file/3,048-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: UI contract asserts no label-only upsert/modal and asserts implemented-provider routing; full suite and 250-route build pass
- Commit: `6bd8758f`
- Status: Resolved in code; full third-party integration audit remains open
- Remaining dependencies: push verification and real Gmail, banking, grocery, and smart-home provider implementations

### PLA-0287 - Admin digest cron hid feed and delivery failures

- Timestamp: 2026-07-15 09:24 America/New_York
- Service: Notifications, cron, and operational observability
- Route: `/api/cron/admin-digest`
- Affected files: `app/api/cron/admin-digest/route.ts`, `lib/admin/digest.ts`, `tests/admin-digest.test.ts`
- Role: Super Admin recipients; operations owner
- Scenario: the `admin_notifications` query fails, Resend is disabled, or one recipient delivery fails
- Severity: P1
- Launch impact: the daily digest could claim a quiet day for an unavailable feed, count skipped email as delivered, or return HTTP 200 after partial failure
- Root cause: the route ignored the Supabase read error and counted only boolean success rather than the email provider's `{ ok, skipped }` result
- Resolution: fail closed with a sanitized 502 on feed errors; summarize sent/skipped/failed delivery; return 502 when any recipient fails
- Supabase impact: no schema change; operational read failures are now visible to cron monitoring
- Tests run: `tests/admin-digest.test.ts`, `tests/cron-auth.test.ts`, and `tests/admin-notification-boundary.test.ts` (20 tests), full 411-file/3,061-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: delivery summary tests cover disabled email and partial failure; static route contracts cover feed-error 502 and non-2xx delivery handling; 250-route build passes
- Commit: `50cbbeef`
- Status: Resolved in code; live cron/provider delivery remains open
- Remaining dependencies: Resend sandbox delivery, alert routing, scheduled invocation, and remote deployment verification

### PLA-0288 - Legacy connection adapters reported planned sync as runnable

- Timestamp: 2026-07-15 09:33 America/New_York
- Service: Family Connections and third-party integrations
- Route: legacy adapter registry and sync planner contract
- Affected files: `lib/connections/adapter.ts`, `lib/connections/adapters/google-calendar.ts`, `lib/connections/adapters/gmail.ts`, `lib/connections/adapters/index.ts`, `tests/connections-adapter.test.ts`
- Role: authenticated family member; background sync worker
- Scenario: Google Calendar or Gmail OAuth keys were present and a saved connection existed, but the planned adapter methods returned empty success without making provider calls
- Severity: P1
- Launch impact: a future worker could mark a provider sync as runnable and advance an empty cursor or report zero pushed items as success
- Root cause: the reference adapters declared capabilities and used key presence as readiness even though their provider I/O was still TODO
- Resolution: planned adapters now declare `isImplemented: false`, the planner blocks them as unsupported, and credentialed methods return explicit unavailable errors; only implemented adapters are reported by `syncableProviderIds()`
- Supabase impact: no schema change; prevents false-positive sync execution before provider credentials, token lifecycle, and API calls are wired
- Tests run: focused Connections suite (25 tests), full 411-file/3,063-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: planner and credentialed execution regressions cover fail-closed behavior; 250-route build passes
- Commit: `0ae5cdb0`
- Status: Resolved in code; full third-party integration audit remains open
- Remaining dependencies: implement real Gmail, banking, grocery, and smart-home providers, then verify OAuth callbacks, token storage, retries, and provider sandbox behavior

### PLA-0289 - Provider sync cron returned success after account failures

- Timestamp: 2026-07-15 09:35 America/New_York
- Service: Notifications, cron, and provider synchronization
- Route: `/api/cron/provider-sync`
- Affected files: `app/api/cron/provider-sync/route.ts`, `tests/cron-provider-sync.test.ts`
- Role: scheduled system worker; connected account owner
- Scenario: one or more account syncs failed, but the cron response still returned HTTP 200 with `ok: true`
- Severity: P1
- Launch impact: scheduler and alerting could record a failed provider run as successful, delaying retry or operator response
- Root cause: the route counted failures but hard-coded the final response to success
- Resolution: final status now derives from `failed === 0`; any account failure returns sanitized HTTP 502 and `ok: false`, while per-account details remain available
- Supabase impact: no schema change; existing sync failure rows and audit logging remain unchanged
- Tests run: `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (7 tests), full 412-file/3,065-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: route contract covers non-2xx failure status and sanitized response fields; 250-route build passes
- Commit: `24e0b64d`
- Status: Resolved in code; live scheduled invocation and provider callback evidence remain open
- Remaining dependencies: run an authenticated provider failure/retry drill, verify alert routing, and validate remote cron deployment

### PLA-0290 - Batch crons hid partial failures behind success responses

- Timestamp: 2026-07-15 09:44 America/New_York
- Service: Scheduled automation, calendar feeds, Autopilot, model refresh, and marketplace settlement
- Route: `/api/cron/calendar-feeds`, `/api/cron/autopilot-scan`, `/api/cron/model-refresh`, `/api/cron/close-auctions`
- Affected files: `app/api/cron/calendar-feeds/route.ts`, `app/api/cron/autopilot-scan/route.ts`, `app/api/cron/model-refresh/route.ts`, `app/api/cron/close-auctions/route.ts`, `tests/cron-batch-failure-status.test.ts`
- Role: scheduled system worker; affected family and marketplace operators
- Scenario: one or more feed, family refresh, Autopilot, or auction settlement operations failed while the cron endpoint still returned HTTP 200 or omitted the failure count
- Severity: P1
- Launch impact: scheduler monitoring could mark partial outages as healthy and delay retries or operator response
- Root cause: batch routes exposed counters but hard-coded success status, and auction RPC errors were only logged
- Resolution: each route now derives `ok` from its failure counter, returns sanitized HTTP 502 on partial failure, and includes settlement failures in the auction summary
- Supabase impact: no schema change; failed work remains retryable and existing transaction boundaries are unchanged
- Tests run: `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (11 tests), full 413-file/3,069-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: static contracts cover all four routes; 250-route build passes
- Commit: `f8226011` (published in merge `59c422ac`)
- Status: Resolved in code; live scheduled invocation and retry/alert routing evidence remain open
- Remaining dependencies: execute isolated failure drills for each cron, verify retry behavior, alert routing, and remote deployment

### PLA-0291 - Notification delivery crons hid push and generation failures

- Timestamp: 2026-07-15 09:50 America/New_York
- Service: Notifications, push delivery, and scheduled automation
- Route: `/api/cron/notifications`, `/api/cron/push-scan`
- Affected files: `app/api/cron/notifications/route.ts`, `app/api/cron/push-scan/route.ts`, `tests/cron-notification-failure-status.test.ts`
- Role: scheduled system worker; family notification recipients
- Scenario: notification generation or push dispatch/delivery failed while the cron endpoint returned HTTP 200 without a failure summary
- Severity: P1
- Launch impact: push outages could be recorded as healthy and notification generation failures could remain hidden until users reported missing alerts
- Root cause: both routes logged per-family/dispatch failures but returned delivery data without deriving endpoint status from those failures
- Resolution: generation, dispatch, and push result failures now contribute to a sanitized failure count; any non-zero count returns `ok: false` and HTTP 502
- Supabase impact: no schema change; existing notification delivery markers and retry behavior remain unchanged
- Tests run: `tests/cron-notification-failure-status.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (13 tests), full 414-file/3,071-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: static contracts cover both routes and preserve sanitized errors; 250-route build passes
- Commit: `92eb434a`
- Status: Resolved in code; live push/email provider delivery and scheduled retry evidence remain open
- Remaining dependencies: run live push/email provider failure drills, verify alert routing, and validate remote cron deployment

### PLA-0292 - Notification email delivery hid provider and persistence failures

- Timestamp: 2026-07-15 09:56 America/New_York
- Service: Notifications and email delivery
- Route: `/api/cron/notifications`, `deliverNotificationEmails`
- Affected files: `lib/server/notification-emails.ts`, `app/api/cron/notifications/route.ts`, `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`
- Role: scheduled system worker; family notification recipients
- Scenario: pending notification reads, preference/recipient lookups, email sends, or `sent_at` resolution updates failed while the helper returned only a sent count
- Severity: P1
- Launch impact: email outages could be mistaken for an empty queue, and successful sends could be retried without a visible persistence failure
- Root cause: Supabase errors were ignored and provider failures were not represented in the return value
- Resolution: the helper now returns `sent`, `failed`, and `skipped`, checks each read/update boundary, leaves failed sends unresolved for retry, and feeds email failures into the cron's sanitized 502 response
- Supabase impact: no schema change; failed `sent_at` updates remain retryable and successful sends preserve existing resolution behavior
- Tests run: `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (9 tests), full 415-file/3,073-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: helper and cron contracts cover read/send/update failures; 250-route build passes
- Commit: `a704a41f`
- Status: Resolved in code; live Resend/provider failure and retry evidence remain open
- Remaining dependencies: run sandbox email failure/duplicate/retry drills, verify alert routing, and validate remote cron deployment

### PLA-0293 - Concurrent protected requests could create duplicate first families

- Timestamp: 2026-07-15 10:08 America/New_York
- Service: Authentication, onboarding, and tenant provisioning
- Route: `requireUserContext` / `ensureActiveFamily`
- Affected files: `lib/server/ensure-family.ts`, `supabase/migrations/0212_atomic_family_provisioning.sql`, `lib/database.types.ts`, `tests/ensure-family-concurrency.test.ts`
- Role: newly authenticated account owner
- Scenario: multiple tabs, refreshes, or parallel protected server components reach family provisioning before the first membership is visible
- Severity: P1
- Launch impact: one account could receive multiple household spaces, splitting preferences and subsequent family data
- Root cause: the membership check, family insert, owner membership, subscription, and active-family preference were separate service-role statements with no per-user lock
- Resolution: the primary provisioning path now calls a service-only security-definer RPC guarded by `pg_advisory_xact_lock` and performs the first-family writes in one transaction; a compatibility fallback preserves rolling deployments until migration `0212` is applied
- Supabase impact: adds `ensure_family_for_user` in migration `0212`; no destructive data changes; the RPC only creates a family when no active membership exists
- Tests run: `tests/ensure-family-concurrency.test.ts` and `tests/onboarding-idempotency.test.ts` (5 tests), typecheck, migration audit, and diff check
- Validation evidence: migration audit passes for 228 numbered SQL files with next version `0213`; the regression contract verifies the lock, service-role grant, and primary RPC path
- Commit: `e0674b15`
- Status: Resolved in code; remote migration application and authenticated concurrent onboarding verification remain open
- Remaining dependencies: apply `0212`, run an isolated two-request first-login drill, and verify the resulting account has exactly one active family and one active-family preference

### PLA-0294 - Admin document deletion could orphan private storage objects

- Timestamp: 2026-07-15 10:20 America/New_York
- Service: Super Admin content management and private document storage
- Route: `/admin/content`
- Affected files: `app/(app)/admin/actions.ts`, `components/admin/document-row-actions.tsx`, `tests/admin-document-delete-boundary.test.ts`
- Role: Super Admin
- Scenario: storage removal failed or the database row was missing while the action still continued toward deletion
- Severity: P1
- Launch impact: the console could report success while leaving private objects orphaned, or delete a row without a confirmed target
- Root cause: storage removal errors and missing/empty database delete results were ignored; the client-supplied path was trusted over the database row
- Resolution: the action now loads the document target, uses its canonical `storage_path`, stops on storage failure, and requires a returned database row before auditing success
- Supabase impact: no schema change; storage and row deletion remain Super Admin-only and retryable after failure
- Tests run: `tests/admin-document-delete-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-management-action-boundaries.test.ts` (6 tests), full 417-file/3,079-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies storage failure ordering, canonical path use, missing-row handling, and confirmed delete result
- Commit: `34a24ddd`
- Status: Resolved in code; live storage failure drill and Super Admin browser verification remain open
- Remaining dependencies: run an isolated storage error/delete retry drill and verify object/row parity after success and failure

### PLA-0295 - Admin family creation relied on an optional trigger for owner access

- Timestamp: 2026-07-15 10:24 America/New_York
- Service: Super Admin user and family management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/actions.ts`, `tests/admin-family-create-boundary.test.ts`
- Role: Super Admin creating a family for an existing account
- Scenario: the family insert succeeded while the `handle_new_family` trigger was missing, unapplied, or failed to create the owner membership/subscription
- Severity: P1
- Launch impact: the new owner could not see the family, and the admin console could report a successful family creation with incomplete tenant state
- Root cause: `adminCreateFamilyAction` inserted only the family and trusted a non-authoritative trigger
- Resolution: the action now checks owner lookup failures, explicitly upserts the parent membership, ensures a trial subscription, and rolls back the new family on required-write failure
- Supabase impact: no schema change; existing trigger-created rows are reconciled idempotently
- Tests run: `tests/admin-family-create-boundary.test.ts`, `tests/admin-document-delete-boundary.test.ts`, and `tests/admin-auth-boundary.test.ts` (6 tests), full 418-file/3,081-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract covers owner lookup, membership reconciliation, trial creation, and cleanup paths
- Commit: `46a227b1`
- Status: Resolved in code; live Super Admin family creation and rollback verification remain open
- Remaining dependencies: run an isolated trigger-disabled family creation drill and verify owner visibility, subscription state, and rollback parity

### PLA-0296 - Admin users hid super-admin allowlist read failures

- Timestamp: 2026-07-15 10:28 America/New_York
- Service: Super Admin user and access management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/users/page.tsx`, `tests/admin-users-read-boundary.test.ts`
- Role: Super Admin
- Scenario: the `super_admins` query failed while the page continued rendering the DB-backed allowlist as an empty set
- Severity: P1
- Launch impact: an operator could misread a privileged-access outage as “no database admins” and make unsafe access decisions
- Root cause: the page included seven Supabase result errors in `loadErrors` but omitted `superAdminsRes`
- Resolution: `super_admins` is now included in the same visible error aggregation used by the users/families page
- Supabase impact: no schema change; read failure behavior is now explicit and non-destructive
- Tests run: `tests/admin-users-read-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (6 tests), full 419-file/3,082-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies the allowlist result is part of the visible Supabase error path
- Commit: `c8ec95b1`
- Status: Resolved in code; live Super Admin browser/read-failure verification remains open
- Remaining dependencies: run an isolated `super_admins` read failure drill and verify the page preserves the error banner and does not present an empty allowlist as authoritative

### PLA-0297 - Admin content page hid Supabase read failures as empty content

- Timestamp: 2026-07-15 10:34 America/New_York
- Service: Super Admin content management and document storage
- Route: `/admin/content`
- Affected files: `app/(app)/admin/content/page.tsx`, `tests/admin-content-read-boundary.test.ts`
- Role: Super Admin
- Scenario: documents, family labels, or uploader profile reads failed while the page substituted empty arrays
- Severity: P1
- Launch impact: a storage/database outage could appear as an empty content library, hiding operational data and encouraging incorrect follow-up actions
- Root cause: all three Supabase errors were discarded during destructuring
- Resolution: the page now aggregates the three read errors, logs the boundary, and renders a refreshable error state instead of an empty table
- Supabase impact: no schema change; read behavior is explicit and non-destructive
- Tests run: `tests/admin-content-read-boundary.test.ts`, `tests/admin-users-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests), full 420-file/3,083-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract covers documents, families, profiles, and the visible error state
- Commit: `5c4bad4d`
- Status: Resolved in code; live content outage and Super Admin browser evidence remain open
- Remaining dependencies: run an isolated content-read failure drill and verify the refresh path preserves the operator context

### PLA-0298 - Admin reports hid analytics read failures as zero metrics

- Timestamp: 2026-07-15 10:40 America/New_York
- Service: Super Admin reports and analytics
- Route: `/admin/reports`
- Affected files: `app/(app)/admin/reports/page.tsx`, `tests/admin-reports-read-boundary.test.ts`
- Role: Super Admin
- Scenario: any count, trend, subscription, document, or audit-log query failed while the page substituted empty arrays or zero counts
- Severity: P1
- Launch impact: operators could make decisions from fabricated zero-valued growth, revenue, activity, or storage metrics during a data outage
- Root cause: all eight Supabase result errors were discarded during destructuring
- Resolution: the page now preserves each result error, logs the boundary, and renders a refreshable error state before deriving metrics
- Supabase impact: no schema change; analytics failures are explicit and non-destructive
- Tests run: `tests/admin-reports-read-boundary.test.ts`, `tests/admin-content-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests), full 421-file/3,084-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies the count and activity error paths plus the visible error state
- Commit: `5353c8ce`
- Status: Resolved in code; live analytics outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated count/trend read-failure drills and verify no zero-valued report is presented as authoritative

### PLA-0299 - Admin audit views hid incomplete history after read failures

- Timestamp: 2026-07-15 10:45 America/New_York
- Service: Super Admin audit and audit-log history
- Routes: `/admin/audit`, `/admin/audit-logs`
- Affected files: `app/(app)/admin/audit/page.tsx`, `app/(app)/admin/audit-logs/page.tsx`, `tests/admin-audit-read-boundary.test.ts`
- Role: Super Admin
- Scenario: the audit-log, family, or actor-profile query failed while either page substituted an empty result and presented incomplete history
- Severity: P1
- Launch impact: operators could miss sensitive actions or trust an incomplete audit trail during a Supabase outage
- Root cause: audit read errors were discarded by both page loaders
- Resolution: both pages now preserve read errors, log the boundary, and render a refreshable error state before filtering or displaying history
- Supabase impact: no schema change; audit-read failures are explicit and non-destructive
- Tests run: `tests/admin-audit-read-boundary.test.ts`, `tests/admin-read-boundaries.test.ts`, and `tests/admin-auth-boundary.test.ts` (7 tests), full 422-file/3,086-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify log, family, actor-profile, and complete-history failure paths plus visible retry states
- Commit: `03442ccf`
- Status: Resolved in code; live audit outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated audit-read failure drills and verify the operator can distinguish unavailable history from an empty history

### PLA-0300 - Admin operational pages hid usage read failures as zero metrics

- Timestamp: 2026-07-15 10:54 America/New_York
- Service: Super Admin system and data operations
- Routes: `/admin/system`, `/admin/backup`
- Affected files: `app/(app)/admin/system/page.tsx`, `app/(app)/admin/backup/page.tsx`, `tests/admin-system-read-boundary.test.ts`
- Role: Super Admin
- Scenario: a privileged count, profile, subscription, document, or tracked-table query failed while the page substituted zero-valued usage metrics
- Severity: P1
- Launch impact: operators could interpret unavailable system usage, storage, or table counts as an empty but healthy platform
- Root cause: Supabase read errors were discarded while deriving counts and storage totals
- Resolution: both pages now preserve query errors, log the read boundary, and render refreshable error states before displaying usage metrics
- Supabase impact: no schema change; operational-read failures are explicit and non-destructive
- Tests run: `tests/admin-system-read-boundary.test.ts`, `tests/admin-audit-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (6 focused tests across 3 files), full 423-file/3,092-test suite, migration audit, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify system and table-count failure paths plus visible retry states
- Commit: `ecfb4f95`; merged remote work is preserved in `4accc171`
- Status: Resolved in code; live operational outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated usage-read failure drills and verify the operator can distinguish unavailable metrics from zero metrics

### PLA-0301 - Admin billing and notifications hid read failures as empty views

- Timestamp: 2026-07-15 11:00 America/New_York
- Service: Super Admin billing and notification center
- Routes: `/admin/billing`, `/admin/notifications`
- Affected files: `app/(app)/admin/billing/page.tsx`, `app/(app)/admin/notifications/page.tsx`, `tests/admin-billing-notifications-read-boundary.test.ts`
- Role: Super Admin
- Scenario: subscription, billing-customer, family, or admin-notification queries failed while the page substituted empty arrays or zero counts
- Severity: P1
- Launch impact: operators could miss revenue state or operational alerts during a Supabase read outage
- Root cause: billing and notification read errors were discarded during page loading
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before computing metrics or digest summaries
- Supabase impact: no schema change; billing and alert-feed read failures are explicit and non-destructive
- Tests run: `tests/admin-billing-notifications-read-boundary.test.ts` (2 focused tests), full 424-file/3,094-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify all three billing reads, the notification feed read, and visible retry states
- Commit: `c0bd9ffa`
- Status: Resolved in code; live billing/notification outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated billing and notification read-failure drills and verify no empty view is presented as authoritative

### PLA-0302 - Admin feedback and integrations hid read failures as empty or unconfigured

- Timestamp: 2026-07-15 11:04 America/New_York
- Service: Super Admin feedback queue and integrations
- Routes: `/admin/feedback`, `/admin/integrations`
- Affected files: `app/(app)/admin/feedback/page.tsx`, `app/(app)/admin/integrations/page.tsx`, `tests/admin-feedback-integrations-read-boundary.test.ts`
- Role: Super Admin
- Scenario: feedback ideas/comments/alerts or connected-account status failed to load while the UI substituted an empty board or “not configured” status
- Severity: P1
- Launch impact: operators could miss user feedback or misdiagnose a connected integration during an outage
- Root cause: feedback queue and Google Calendar connected-account read errors were discarded
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before displaying queue or integration status
- Supabase impact: no schema change; feedback and connected-account failures are explicit and non-destructive
- Tests run: `tests/admin-feedback-integrations-read-boundary.test.ts` (2 focused tests), full 425-file/3,096-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify feedback ideas/comments/notification reads, connected-account reads, and visible retry states
- Commit: `9f4c6fa9`
- Status: Resolved in code; live feedback/integration outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated feedback and connected-account read-failure drills and verify no empty/configuration status is presented as authoritative

### PLA-0303 - Admin subscriptions hid billing reads as empty plan totals

- Timestamp: 2026-07-15 11:10 America/New_York
- Service: Super Admin subscriptions and billing history
- Route: `/admin/subscriptions`
- Affected files: `app/(app)/admin/subscriptions/page.tsx`, `tests/admin-subscriptions-read-boundary.test.ts`
- Role: Super Admin
- Scenario: subscription, family, or billing-customer reads failed while the page substituted empty arrays and zero-valued plan metrics
- Severity: P1
- Launch impact: operators could misread unavailable subscription state as no customers, no revenue, or no churn
- Root cause: three Supabase read errors were discarded during page loading
- Resolution: the page now preserves read errors, logs the boundary, and renders a refreshable error state before deriving plan metrics
- Supabase impact: no schema change; subscription-read failures are explicit and non-destructive
- Tests run: `tests/admin-subscriptions-read-boundary.test.ts` (1 focused test), full 426-file/3,097-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies subscription, family, and billing-customer failure paths plus the visible error state
- Commit: `7092ab60`
- Status: Resolved in code; live billing outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated subscription-read failure drills and verify no zero-valued plan report is presented as authoritative

### PLA-0304 - Admin Stripe hid financial reads as zero or unavailable capabilities

- Timestamp: 2026-07-15 11:22 America/New_York
- Service: Super Admin Stripe financial mode
- Route: `/admin/stripe`
- Affected files: `lib/stripe/capabilities.ts`, `app/(app)/admin/stripe/page.tsx`, `tests/admin-stripe-read-boundary.test.ts`
- Role: Super Admin
- Scenario: feature flags, Stripe settings, connected accounts, financial accounts, cards, authorizations, or webhook events failed to load while the page substituted empty or zero-valued status
- Severity: P1
- Launch impact: operators could misdiagnose financial readiness or miss Stripe operational failures
- Root cause: the admin page discarded Supabase read errors and the capability helper exposed no diagnostic error path
- Resolution: added an error-aware feature-flag helper for diagnostics, preserved consumer ledger fallback, and made the admin page fail visibly on any financial read failure
- Supabase impact: no schema change; financial-read failures are explicit and non-destructive
- Tests run: `tests/admin-stripe-read-boundary.test.ts` (2 focused tests), full 427-file/3,099-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify error-aware capability reads, Stripe settings, feature flags, financial tables, webhooks, and the visible retry state
- Commit: `748d0a7d`
- Status: Resolved in code; live Stripe credentials, callbacks, permissions, and browser evidence remain open
- Remaining dependencies: run isolated Stripe read-failure and callback drills with production-safe test credentials

### PLA-0305 - Marketing Ads and Automation hid list read failures as empty planning views

- Timestamp: 2026-07-15 11:28 America/New_York
- Service: Admin marketing planning
- Routes: `/admin/marketing/ads`, `/admin/marketing/automation`
- Affected files: `app/(app)/admin/marketing/ads/page.tsx`, `app/(app)/admin/marketing/automation/page.tsx`, `tests/admin-marketing-read-boundary.test.ts`
- Role: Marketing Admin / Super Admin
- Scenario: advertising campaign or automation workflow reads failed while the page substituted an empty list and zero counts
- Severity: P1
- Launch impact: operators could mistake unavailable campaign/workflow state for no planned marketing activity
- Root cause: primary Supabase list errors were discarded by both pages
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before displaying planning data
- Supabase impact: no schema change; marketing-read failures are explicit and non-destructive
- Tests run: `tests/admin-marketing-read-boundary.test.ts` (2 focused tests), full 428-file/3,101-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify campaign/workflow failure paths and visible retry states
- Commit: `e20a11d4`
- Status: Resolved in code; live marketing permission, write-action, and browser evidence remain open
- Remaining dependencies: audit all remaining marketing list/detail pages and run isolated read/write failure drills

### PLA-0306 - Marketing dashboard and Analytics hid customer-loader failures as zero metrics

- Timestamp: 2026-07-15 11:35 America/New_York
- Service: Admin marketing customer metrics
- Routes: `/admin/marketing`, `/admin/marketing/analytics`
- Affected files: `lib/marketing/customers.ts`, `app/(app)/admin/marketing/page.tsx`, `app/(app)/admin/marketing/analytics/page.tsx`, `tests/admin-marketing-dashboard-read-boundary.test.ts`
- Role: Marketing Admin / Super Admin
- Scenario: family, subscription, family-member, profile, campaign, email, segment, lead, SEO, or AEO reads failed while dashboards substituted empty customer data or zero-valued metrics
- Severity: P1
- Launch impact: operators could make growth, lifecycle, revenue, or email decisions from incomplete marketing data
- Root cause: the shared customer loader and dashboard queries discarded Supabase errors
- Resolution: added an error-aware customer loader for diagnostic pages and visible retry states for dashboard and Analytics reads; existing consumer fallback remains compatible
- Supabase impact: no schema change; marketing metric failures are explicit and non-destructive
- Tests run: `tests/admin-marketing-dashboard-read-boundary.test.ts` (3 focused tests), full 429-file/3,104-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify all shared customer source reads, dashboard metric reads, analytics campaign/email reads, and visible retry states
- Commit: `e727682c`
- Status: Resolved in code; live marketing permissions, data freshness, and browser evidence remain open
- Remaining dependencies: audit all remaining marketing customer/list/detail pages and run isolated read/failure drills

### PLA-0307 - Marketing admin surfaces silently downgraded read failures

- Timestamp: 2026-07-15 11:55 America/New_York
- Service: Marketing content, campaigns, assets, CRM, publishing, rewards, and surveys
- Routes: `/admin/marketing/content`, `/admin/marketing/campaigns`, `/admin/marketing/assets`, `/admin/marketing/customers`, `/admin/marketing/crm`, `/admin/marketing/video`, `/admin/marketing/loyalty`, `/admin/marketing/surveys`, and related control-plane pages
- Affected files: audited marketing admin page boundaries and six focused `tests/admin-marketing-*-read-boundary.test.ts` suites
- Role: Marketing Admin / Super Admin
- Scenario: list, detail, signed-preview, event aggregate, provider-device, payout, quote, family-label, or survey-response reads failed while the UI substituted empty or zero-valued operational state
- Severity: P1
- Launch impact: operators could publish, pay, score, or make growth decisions from incomplete data without a visible outage signal
- Root cause: many marketing server components discarded Supabase and storage errors while retaining write controls
- Resolution: pages now preserve read errors, log the boundary, and render refreshable error states before deriving metrics or exposing misleading inventory state
- Supabase impact: no schema change; marketing read failures are explicit and non-destructive
- Tests run: six focused files and 18 tests, full 435-file/3,122-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts cover content/campaign, asset/messaging, CRM, SEO/AEO/control-plane, experiment/publishing, affiliate/loyalty/proposal/survey failure paths
- Commit: `0a4d4533`
- Status: Resolved in code; live marketing permissions, storage, provider callbacks, write failures, and browser evidence remain open
- Remaining dependencies: complete remaining marketing pages and run isolated read/write/provider/browser drills

### PLA-0308 - Auth and middleware boundaries silently misrouted failures and public callbacks

- Timestamp: 2026-07-15 12:30 America/New_York
- Service: Shared authentication, admin shell, and public/internal API routing
- Routes: `middleware.ts`, `/auth/callback`, `/admin`, `/api/contact`, `/api/blog`, `/api/mkt`, `/api/cron`, `/api/guardian`, `/api/webhooks`, and related endpoints
- Affected files: `lib/supabase/auth.ts`, `app/auth/callback/route.ts`, `app/(app)/admin/layout.tsx`, `components/admin/admin-shell.tsx`, `middleware.ts`, and focused auth/middleware contracts
- Role: signed-out visitor, authenticated member, Super Admin, scheduled job, internal callback, provider webhook
- Scenario: ignored auth/read errors or missing middleware public exceptions could redirect valid public/callback traffic to login, route an authenticated user into onboarding during a membership outage, or render misleading admin defaults
- Severity: P1
- Launch impact: public lead capture, blog engagement, scheduled jobs, provider callbacks, and admin observability could be unavailable or misleading before their route-level authorization checks executed
- Root cause: shared auth and shell queries discarded errors, and the middleware public inventory did not include all intentionally anonymous or machine-authenticated routes
- Resolution: shared auth now logs and fails closed on provider errors, context treats auth reads as unavailable, OAuth callback membership errors redirect to retry, admin shell read failures are visible, and middleware reaches route-level rate-limit/token/secret/signature checks for intended public/internal endpoints
- Supabase impact: no schema change; auth and route-read failures are explicit and non-destructive
- Tests run: `tests/auth-context-error-contract.test.ts`, `tests/auth-callback-boundary.test.ts`, `tests/admin-shell-read-boundary.test.ts`, `tests/middleware-public-api-boundary.test.ts`, `tests/cron-auth.test.ts`; full 439-file/3,141-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `2a409b13` in merged checkpoint `ed87386f`; build generated 250 routes; live Auth Admin, deployed callback, browser, and provider smoke evidence remain open
- Status: Resolved in code; live deployment and provider evidence remain open
- Remaining dependencies: execute isolated deployed public/callback and authenticated role/device drills

### PLA-0309 - Marketplace overview hid database read failures as an empty board

- Timestamp: 2026-07-15 12:40 America/New_York
- Service: Marketplace discovery overview
- Route: `/marketplace`
- Affected files: `app/(app)/marketplace/page.tsx`, `tests/marketplace-home-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: listing, member, offer, match, save, store, follow, review, order, collection, or collection-item reads failed while the page rendered empty discovery and activity state
- Severity: P1
- Launch impact: users could misread an RLS, migration, or database outage as an empty marketplace and make decisions without complete inventory or transaction context
- Root cause: the page’s best-effort loader discarded query errors and treated all failures as empty arrays
- Resolution: labeled query errors are logged and surfaced in an accessible Marketplace data-health warning; unaffected data remains available
- Supabase impact: no schema change; tenant-scoped reads remain scoped by the active family and failures are non-destructive
- Tests run: `tests/marketplace-home-read-boundary.test.ts`, `tests/marketplace-reports.test.ts`, `tests/marketplace-community.test.ts` (18 focused tests); full 440-file/3,143-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `b32e7a0f`; build generated 250 routes; live RLS, role, browser, and marketplace workflow evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: execute isolated listing/order/auction/dispute and cross-family RLS drills across buyer, seller, and manager roles

### PLA-0310 - Marketplace listing detail hid database failures as not-found or incomplete detail

- Timestamp: 2026-07-15 12:46 America/New_York
- Service: Marketplace listing detail and transaction context
- Route: `/marketplace/item/[id]`
- Affected files: `app/(app)/marketplace/item/[id]/page.tsx`, `tests/marketplace-item-read-boundary.test.ts`
- Role: authenticated buyer, seller, and Super Admin marketplace operator
- Scenario: a failed primary listing read rendered `notFound()`, or dependent seller, offer, bid, history, comparable, or negotiation reads failed while the page looked authoritative
- Severity: P1
- Launch impact: users could be told a real listing was missing or act on incomplete trust, pricing, or transaction state
- Root cause: the detail page discarded query errors and treated the primary `maybeSingle()` result as absence without checking its error
- Resolution: primary listing errors now render a retryable ErrorState; all dependent read errors are logged and surfaced in a visible, accessible data-health warning
- Supabase impact: no schema change; the listing and dependent reads remain scoped to the active family and listing permissions
- Tests run: `tests/marketplace-item-read-boundary.test.ts` plus Marketplace home/reports/community suites (20 focused tests); full 441-file/3,145-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `d6685cd9`; build generated 250 routes; live RLS, role, browser, and marketplace transaction evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: execute isolated buyer/seller/manager listing, bid, offer, negotiation, and dispute drills against deployed Supabase

### PLA-0314 - Marketplace Creators hid storefront and trust-data failures

- Timestamp: 2026-07-15 13:08 America/New_York
- Service: Marketplace storefront directory and creator trust context
- Route: `/marketplace/creators`
- Affected files: `app/(app)/marketplace/creators/page.tsx`, `tests/marketplace-creators-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: storefront, follow, review, or open-listing reads failed while the page displayed an empty or incomplete creator ranking
- Severity: P1
- Launch impact: users could miss sellers or act on incomplete ratings and inventory context
- Root cause: Promise.all result errors were discarded and failed reads became empty ranking inputs
- Resolution: storefront failure now renders a retryable ErrorState; dependent failures are logged and shown in an accessible data-health warning
- Supabase impact: no schema change; storefront and trust reads remain scoped to the active family and existing permissions
- Tests run: `tests/marketplace-creators-read-boundary.test.ts` (2 focused tests); full suite/build pending
- Validation evidence: source commit `dcbe9588`; full branch verification remains green; live creator/RLS, role, browser, and family-isolation evidence remain open
- Status: Resolved in code; full verification and live workflow evidence remain open
- Remaining dependencies: execute isolated storefront, follow, review, inventory, and family-isolation drills against deployed Supabase

### PLA-0313 - Marketplace Alerts hid saved-search and matching-data failures

- Timestamp: 2026-07-15 13:04 America/New_York
- Service: Marketplace saved-search alerts and match discovery
- Route: `/marketplace/alerts`
- Affected files: `app/(app)/marketplace/alerts/page.tsx`, `tests/marketplace-alerts-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: saved-search, matching-listing, or saved-state reads failed while the page displayed an empty or incomplete alert view
- Severity: P1
- Launch impact: users could miss relevant new listings or trust inaccurate match counts
- Root cause: Promise.all result errors were discarded and failed reads became empty arrays
- Resolution: primary saved-search failure now renders a retryable ErrorState; matching-listing and saved-state failures are logged and shown in an accessible data-health warning
- Supabase impact: no schema change; alert and listing reads remain scoped to the active family/member permissions
- Tests run: `tests/marketplace-alerts-read-boundary.test.ts` (2 focused tests); full 444-file/3,151-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `4f06b696`; build generated 250 routes; branch and `main` publication verified; live alert/RLS, role, browser, and cross-family evidence remain open
- Status: Resolved in code; full verification and live workflow evidence remain open
- Remaining dependencies: execute isolated alert CRUD, match-count, save-state, and family-isolation drills against deployed Supabase

### PLA-0312 - Marketplace Orders hid transaction and fee-read failures as incomplete data

- Timestamp: 2026-07-15 12:58 America/New_York
- Service: Marketplace orders and exchange coordination
- Route: `/marketplace/orders`
- Affected files: `app/(app)/marketplace/orders/page.tsx`, `tests/marketplace-orders-read-boundary.test.ts`
- Role: authenticated buyer, seller, and Super Admin marketplace operator
- Scenario: primary order, service-fee, listing-title, member, review-history, or handoff reads failed while the page looked healthy or incomplete
- Severity: P1
- Launch impact: users could miss transactions, misunderstand fees, misidentify counterparties, or lose handoff context
- Root cause: Supabase result errors were discarded and an unavailable fee configuration silently fell back to zero
- Resolution: primary order failures now render a retryable ErrorState; dependent failures are logged and surfaced in a visible accessible Marketplace orders data-health warning
- Supabase impact: no schema change; order and related reads remain scoped to the active family and existing permissions
- Tests run: `tests/marketplace-orders-read-boundary.test.ts` (2 focused tests); full 443-file/3,149-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `f1e2ef12`; build generated 250 routes; live order/RLS, role, browser, and fee workflow evidence remain open
- Status: Resolved in code and published to branch and `main`; live workflow evidence remains open
- Remaining dependencies: execute isolated buyer/seller order, fee, review, handoff, return, and dispute drills against deployed Supabase

### PLA-0311 - Community Circles mislabeled transient failures as an unapplied migration

- Timestamp: 2026-07-15 12:52 America/New_York
- Service: Marketplace Community Circles and cross-family listing sharing
- Route: `/marketplace/community`
- Affected files: `app/(app)/marketplace/community/page.tsx`, `components/marketplace/community-module.tsx`, `tests/marketplace-community-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: a transient circle/member/share query failure showed the migration-not-applied message, while own available-listing failures silently emptied the share picker
- Severity: P1
- Launch impact: users could misdiagnose a live outage as missing deployment work or lose the ability to share listings across families without an honest error state
- Root cause: broad catch-based migration detection and discarded per-query Supabase errors
- Resolution: only missing-relation errors trigger the migration state; other failures are logged, labeled, and rendered in an accessible Community data-health warning
- Supabase impact: no schema change; cross-family reads and own-family listing reads retain existing RLS/scoping behavior
- Tests run: `tests/marketplace-community-read-boundary.test.ts` and `tests/marketplace-community.test.ts` (7 focused tests); full 442-file/3,147-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `57e973d3`; build generated 250 routes; live cross-family RLS, role, browser, and invite/share workflow evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: run isolated circle create/join/leave/share/unshare drills across multiple families with live migration 0173/0176 policies
