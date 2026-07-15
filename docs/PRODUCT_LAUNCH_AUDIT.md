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
