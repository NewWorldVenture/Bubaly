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
- Commit: pending publication
- Status: Resolved in code; remote migration application, live RLS, and authenticated E2E remain open dependencies
- Remaining dependencies: apply `0210`, exercise partial-failure replay in isolated Supabase, verify invite/email behavior and cross-tenant denial
