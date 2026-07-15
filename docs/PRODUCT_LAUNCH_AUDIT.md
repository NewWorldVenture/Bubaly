# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0350 - Emergency summary hid contact and medical read failures as no emergency data

- Timestamp: 2026-07-15 17:23 America/New_York
- Service: Trip Emergency Summary
- Route: `/dashboard/vacations/[id]/emergency`
- Affected files: `components/vacations/trip-emergency.tsx`, `tests/trip-emergency-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: contact or medical reads could fail while the emergency summary returned null, indistinguishable from having no safety information.
- Severity: P1
- Launch impact: travelers could miss emergency contacts or medical details during a time-sensitive situation.
- Root cause: the summary checked only array lengths and ignored both query loading and error state.
- Resolution: Emergency Summary now tracks both required reads, distinguishes loading from empty, and renders a sanitized retryable ErrorState before returning no summary.
- Supabase impact: no schema change; existing family-scoped safety reads now have an explicit failure contract.
- Tests run: `tests/trip-emergency-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 468 test files, 3,220 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `da83e4b`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Emergency verification

### PLA-0349 - Vacation CRUD and budget views hid failed financial and trip-detail reads

- Timestamp: 2026-07-15 17:17 America/New_York
- Service: Vacation shared CRUD sections and Trip Budget
- Route: `/dashboard/vacations/[id]/budget` plus shared lodging, travel, activity, document, family, and emergency sections
- Affected files: `components/vacations/shared.tsx`, `components/vacations/trip-budget.tsx`, `tests/vacation-crud-read-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: shared CRUD list reads or budget/expense reads could fail while sections rendered empty lists or zero financial totals.
- Severity: P1
- Launch impact: families could miss trip records or make budget decisions from incomplete data.
- Root cause: `TripCrudSection` ignored read errors, and Trip Budget did not track loading or errors for its summary queries.
- Resolution: shared vacation CRUD sections now show sanitized retry states, while Trip Budget waits for both required reads and retries them together.
- Supabase impact: no schema change; existing family-scoped child-table and budget reads now have explicit failure handling.
- Tests run: `tests/vacation-crud-read-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 467 test files, 3,218 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `3adef7e6`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed vacation CRUD verification

### PLA-0348 - Trip itinerary hid failed day and item reads as an empty schedule

- Timestamp: 2026-07-15 17:11 America/New_York
- Service: Trip Itinerary
- Route: `/dashboard/vacations/[id]/itinerary`
- Affected files: `components/vacations/trip-itinerary.tsx`, `tests/trip-itinerary-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: trip, day, or itinerary-item reads could fail while the page rendered no days planned or an incomplete schedule.
- Severity: P1
- Launch impact: families could miss planned activities or incorrectly rebuild an itinerary from incomplete data.
- Root cause: only the itinerary days query exposed loading state; trip and item read failures were ignored.
- Resolution: Trip Itinerary now tracks all three query handles, waits for complete data, and renders a sanitized retryable ErrorState before showing an empty schedule.
- Supabase impact: no schema change; existing family-scoped itinerary reads now have an explicit page-level failure contract.
- Tests run: `tests/trip-itinerary-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 466 test files, 3,216 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `7e6ce831`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Itinerary verification

### PLA-0347 - Trip overview hid incomplete readiness and itinerary reads

- Timestamp: 2026-07-15 17:05 America/New_York
- Service: Trip Overview
- Route: `/dashboard/vacations/[id]/overview`
- Affected files: `components/vacations/trip-overview.tsx`, `tests/trip-overview-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: any secondary overview read could fail while readiness, budget, transport, weather, or recommendation summaries rendered from partial arrays.
- Severity: P1
- Launch impact: families could treat an incomplete trip overview as current and act on an inaccurate readiness score or financial summary.
- Root cause: only the trip query exposed loading state; the other 16 required reads ignored loading and error state.
- Resolution: Trip Overview now centralizes all 17 query handles, waits for complete data, and renders a sanitized retryable ErrorState before deriving readiness or summaries.
- Supabase impact: no schema change; existing family-scoped trip reads now have an explicit page-level failure contract.
- Tests run: `tests/trip-overview-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 465 test files, 3,214 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `f36ea6c5`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Trip Overview verification

### PLA-0346 - Vacation reports hid incomplete financial and travel-score reads

- Timestamp: 2026-07-15 16:58 America/New_York
- Service: Vacation Reports
- Route: `/dashboard/vacations/reports`
- Affected files: `components/vacations/vacations-reports.tsx`, `tests/vacations-reports-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: expense, budget, or travel-score reads could fail while the report rendered trip counts and partial financial totals as if complete.
- Severity: P1
- Launch impact: families could make travel budget decisions from incomplete or stale report data.
- Root cause: only the trips query exposed loading state; secondary report reads ignored their loading and error contracts.
- Resolution: Vacation Reports now tracks all four required reads, waits for complete data, and renders a sanitized retryable ErrorState before deriving totals or charts.
- Supabase impact: no schema change; existing family-scoped report reads now have an explicit failure contract.
- Tests run: `tests/vacations-reports-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 464 test files, 3,212 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `194e4ecb`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Vacation Reports verification

### PLA-0345 - Connections hub hid family connection read failures as disconnected providers

- Timestamp: 2026-07-15 16:34 America/New_York
- Service: Family Connections hub and integration directory
- Route: `/dashboard/connections`
- Affected files: `components/modules/connections-module.tsx`, `tests/connections-ui-boundary.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: the realtime `family_connections` query could fail while the module rendered every provider as disconnected or showed an empty connection summary.
- Severity: P1
- Launch impact: families could mistake unavailable connection data for revoked credentials and make incorrect setup decisions.
- Root cause: the module ignored the `useRealtimeQuery` error state even though the hook preserved real read failures.
- Resolution: Connections now renders a sanitized retryable ErrorState and wires retry to the query refresh callback before deriving provider statuses.
- Supabase impact: no schema change; the existing family-scoped realtime read now has visible UI failure handling.
- Tests run: `tests/connections-ui-boundary.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 463 test files, 3,210 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `299e2608`
- Status: Resolved in code; live provider callbacks, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Connections verification

### PLA-0344 - Sync conflict and account routes hid required read failures

- Timestamp: 2026-07-15 16:21 America/New_York
- Service: Family Sync conflict resolution and connected accounts
- Route: `/dashboard/sync/conflicts`, `/dashboard/sync/accounts`, `/dashboard/sync/accounts/[provider]`
- Affected files: `app/(app)/dashboard/sync/conflicts/page.tsx`, `app/(app)/dashboard/sync/accounts/page.tsx`, `app/(app)/dashboard/sync/accounts/[provider]/page.tsx`, `tests/sync-route-read-boundaries.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: conflict or connected-account reads could fail while the UI rendered â€œNo open conflictsâ€ or â€œNot connectedâ€.
- Severity: P1
- Launch impact: families could miss records requiring manual resolution or believe provider credentials were absent when data was unavailable.
- Root cause: query errors were discarded before empty-state and provider-status rendering.
- Resolution: all three routes now log failures and render sanitized retry states before showing conflict or account status.
- Supabase impact: no schema change; family-scoped sync conflict and account reads now have explicit failure contracts.
- Tests run: `tests/sync-route-read-boundaries.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 463 test files, 3,209 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `ec14b828`
- Status: Resolved in code; live provider callbacks, conflict-resolution, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, conflict-resolution action drills, cross-family RLS, browser, backup, and deployed Sync verification

### PLA-0343 - Family Sync showed zero health and history after required reads failed

- Timestamp: 2026-07-15 16:16 America/New_York
- Service: Family Sync hub and synchronization history
- Route: `/dashboard/sync`, `/dashboard/sync/history`
- Affected files: `app/(app)/dashboard/sync/page.tsx`, `app/(app)/dashboard/sync/history/page.tsx`, `tests/sync-read-boundary.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: connection, calendar, conflict, run, or audit-history reads could fail while the pages rendered zero health metrics or â€œno runsâ€ empty states.
- Severity: P1
- Launch impact: families could miss provider outages, open conflicts, or failed synchronization and assume their data was current.
- Root cause: query results were used without checking their error fields.
- Resolution: all required hub and history reads now fail visibly with sanitized route-specific retry states before health or history data is derived.
- Supabase impact: no schema change; family-scoped sync operational reads now have explicit failure contracts.
- Tests run: `tests/sync-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 462 test files, 3,208 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `91394c90`
- Status: Resolved in code; live provider callbacks, recovery/conflict, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, retry/conflict drills, cross-family RLS, browser, backup, and deployed Sync verification

### PLA-0342 - Admin Users rendered partial access data after required reads failed

- Timestamp: 2026-07-15 16:12 America/New_York
- Service: Super Admin Users & Families access management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/users/page.tsx`, `tests/admin-users-read-boundary.test.ts`
- Role: Super Admin and access-management operators
- Scenario: any required profile, family, membership, subscription, invitation, role, permission, or super-admin read could fail while the page rendered partial users, empty filters, or misleading access counts.
- Severity: P1
- Launch impact: operators could change access based on incomplete or stale membership and permission data.
- Root cause: query failures were collected into a warning banner but the page continued to derive metrics and rows from partial results.
- Resolution: the page now logs the failure and renders a sanitized retryable ErrorState before any access data is derived or shown.
- Supabase impact: no schema change; required service-role access reads now have an explicit fail-closed contract.
- Tests run: `tests/admin-users-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 461 test files, 3,207 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `3e44cb89`
- Status: Resolved in code; live Super Admin role/RLS, browser, audit-log, backup, and deployed evidence remains open
- Remaining dependencies: authenticated access matrix, cross-tenant RLS, audit-log routing, backup, and deployed Users verification

### PLA-0341 - Admin Social hid publishing and provider errors as zero metrics

- Timestamp: 2026-07-15 16:06 America/New_York
- Service: Super Admin Social Platform and publishing operations
- Route: `/admin/social`
- Affected files: `app/(app)/admin/social/page.tsx`, `tests/admin-social-read-boundary.test.ts`
- Role: Super Admin, social operators, and families using social publishing
- Scenario: any of six account, post, publish-result, AI-generation, or provider-error reads could fail while the page rendered zero operational metrics and appeared healthy.
- Severity: P1
- Launch impact: operators could miss failed publishing, AI generation failures, and provider incidents.
- Root cause: Promise query results were used without checking their error fields.
- Resolution: all six required reads now fail visibly with a retryable sanitized ErrorState before metrics or credential readiness are rendered.
- Supabase impact: no schema change; service-role Social operational reads now have explicit failure contracts.
- Tests run: `tests/admin-social-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 461 test files, 3,207 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `709aca24`
- Status: Resolved in code; live social callbacks, publish/retry, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, publish/retry drills, credential/secret rotation, role/RLS, browser, backup, and deployed Social verification

### PLA-0340 - Admin Sync hid provider and queue read failures as healthy metrics

- Timestamp: 2026-07-15 16:35 America/New_York
- Service: Super Admin Sync Platform and third-party integration operations
- Route: `/admin/sync`
- Affected files: `app/(app)/admin/sync/page.tsx`, `tests/admin-sync-read-boundary.test.ts`
- Role: Super Admin, integration operator, and household provider-sync user
- Scenario: connection, fatal provider error, dead-letter job, webhook-signature, or provider-catalog reads could fail while the page rendered zero failures and a complete catalog.
- Severity: P1
- Launch impact: operators could miss provider outages, failed jobs, or signature failures and assume synchronization was healthy.
- Root cause: Promise query results were used without checking error fields.
- Resolution: all five required reads now fail visibly with a retryable sanitized ErrorState before metrics are rendered.
- Supabase impact: no schema change; service-role sync operational reads now have explicit failure contracts.
- Tests run: `tests/admin-sync-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 460 test files, 3,206 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `6a9d7494`
- Status: Resolved in code; live callback, retry, RLS, role, browser, and deployed integration evidence remains open
- Remaining dependencies: provider sandbox callbacks, dead-letter recovery, signature-failure drills, and deployed Admin Sync verification

### PLA-0339 - Admin dashboard hid command-center read failures as zero or empty metrics

- Timestamp: 2026-07-15 16:20 America/New_York
- Service: Super Admin command center and operational dashboard
- Route: `/admin`
- Affected files: `app/(app)/admin/page.tsx`, `tests/admin-overview-read-boundary.test.ts`
- Role: Super Admin and operational administrator
- Scenario: required family, member, subscription, storage, audit, ticket, notification, or actor reads could fail while dashboard cards and activity rendered plausible incomplete values.
- Severity: P1
- Launch impact: operators could make billing, support, security, or deployment decisions from partial command-center data.
- Root cause: Promise results and the secondary actor lookup were destructured without preserving error state.
- Resolution: all required result errors are checked before metrics are derived; actor profile failures have a separate sanitized retry state.
- Supabase impact: no schema change; service-r…22712 tokens truncated…-plan`, `/api/billing/cancel`, `/api/billing/portal`
- Affected files: `app/api/billing/checkout/route.ts`, `app/api/billing/change-plan/route.ts`, `app/api/billing/cancel/route.ts`, `app/api/billing/portal/route.ts`, `tests/billing-read-boundary.test.ts`
- Role: authenticated family manager or billing administrator
- Scenario: required billing customer or subscription reads failed while the route could continue as though billing state were absent; secondary customer, tracking, and optimistic-sync write failures were not surfaced consistently
- Severity: P0
- Launch impact: billing state could diverge from Stripe or return an unsafe success response during a Supabase outage
- Root cause: Supabase result errors were discarded around precondition reads and secondary billing persistence writes
- Resolution: required reads now fail closed before Stripe mutation or portal creation; customer write failures return 503; checkout tracking and optimistic subscription-sync failures are logged explicitly
- Supabase impact: no schema change; existing billing and checkout tables remain the source of truth
- Tests run: `tests/billing-read-boundary.test.ts` (2 focused tests); full 449-file/3,161-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: focused read-boundary contracts and full local gate pass; live Stripe test-mode, webhook/idempotency, outage, refund, and remote Supabase evidence remain open
- Status: Resolved in code; live billing workflow evidence remains open
- Remaining dependencies: execute non-destructive checkout, plan-change, cancellation, portal, webhook replay, and refund drills against the configured test environment

### PLA-0319 - Contact Center collapsed routing and inbox failures into empty state

- Timestamp: 2026-07-15 13:54 America/New_York
- Service: Family Contact Center and unified communications inbox
- Routes: `/dashboard/contact-center`, `/api/contact-center/sms`, `/api/contact-center/voice`, `/api/contact-center/voice/transcription`, `/api/contact-center/email`
- Affected files: `lib/contact-center/server.ts`, `app/(app)/dashboard/contact-center/page.tsx`, `app/(app)/dashboard/contact-center/actions.ts`, the four Contact Center API routes, `tests/contact-center.test.ts`
- Role: Family+ parent, family member, and inbound communications provider
- Scenario: channel, family, routing, or inbox persistence failures were discarded and the UI/provider flow could continue with null, empty, or unpersisted state; the newly added email webhook also accepted unbounded form payloads and hid reply failures
- Severity: P1
- Launch impact: families could miss messages or receive a false healthy callback response while the inbox was unavailable
- Root cause: unchecked Supabase results in channel helpers, page loads, routing lookups, provisioning, and inbox writes; email parsing was not bounded and reply failures were hidden
- Resolution: channel and page reads now show retryable failure state; SMS, voice, voicemail, and email callbacks return 503 on routing/context read failure; email form parsing is bounded; provisioning and inbox writes are checked; escalation failures are logged; focused tests cover the boundaries
- Supabase impact: no schema change; family-scoped reads remain in the migration and service-role writes remain server-only
- Tests run: `tests/contact-center.test.ts` (15 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; final merged-tree gate passed with 450 files/3,176 tests, 0 production dependency vulnerabilities, and 250 generated routes
- Status: Resolved in code; live provider/RLS evidence remains open
- Remaining dependencies: run Twilio/email retry, provider outage, role, RLS, and browser drills
### PLA-0320 - Remaining wallet routes hid financial read failures

- Timestamp: 2026-07-15 14:08 America/New_York
- Service: Wallet Hub and secondary family-wallet workflows
- Routes: `/wallet`, `/wallet/invest`, `/wallet/babysitters`, `/wallet/gift`, `/wallet/settings`, `/wallet/children/[childId]`
- Affected files: `components/wallet/wallet-hub.tsx`, the five remaining server-rendered wallet pages, `tests/wallet-read-boundary.test.ts`
- Role: household manager, parent, or family member with wallet visibility
- Scenario: failed financial reads became empty arrays, fallback names, or zero-valued derived state while the screen looked healthy
- Severity: P0
- Launch impact: users could act on incomplete balances, holdings, pending orders, gift payments, babysitter history, or child-wallet details
- Root cause: Supabase errors were discarded by the remaining wallet pages and `useRealtimeQuery` consumers did not render error state
- Resolution: primary reads now render retryable ErrorState; secondary failures render accessible health warnings; the Wallet Hub preserves partial/cached data only with an explicit warning
- Supabase impact: no schema change; family filters and existing RLS scopes remain unchanged
- Tests run: `tests/wallet-read-boundary.test.ts` (3 focused tests); full 450-file/3,177-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: final local gate passed with 0 production dependency vulnerabilities and 250 generated routes
- Status: Resolved in code; live wallet/RLS, role, concurrency, and browser evidence remain open
- Remaining dependencies: execute manager/member wallet, invest, gift, babysitter, child-wallet, reconciliation, and tenant-isolation drills against deployed Supabase
### PLA-0321 - Stripe subscription webhook ignored prior billing state failures

- Timestamp: 2026-07-15 14:11 America/New_York
- Service: Stripe subscription webhook synchronization and growth alerts
- Route: `/api/webhooks/stripe`
- Affected files: `app/api/webhooks/stripe/route.ts`, `tests/webhook-persistence-boundaries.test.ts`
- Role: paying family and Super Admin operator
- Scenario: billing-customer and prior-subscription reads ran together, but only the billing-customer error was checked before subscription persistence and conversion/churn comparison
- Severity: P0
- Launch impact: Stripe events could write subscription state with an untrusted transition baseline or fail to trigger accurate growth alerts
- Root cause: `priorSubscriptionError` was discarded; payment automation failures were silently swallowed
- Resolution: both required state reads now fail closed through the reprocessable webhook error path; payment automation failures are logged
- Supabase impact: no schema change; existing event claim/finalization and family-scoped subscription persistence remain in place
- Tests run: `tests/webhook-persistence-boundaries.test.ts`, `tests/stripe-growth-alerts-contract.test.ts`, and `tests/stripe-webhook-replay-contract.test.ts` (11 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live Stripe evidence remain open
- Status: Resolved in code; live replay/idempotency and provider evidence remain open
- Remaining dependencies: execute non-destructive subscription lifecycle, replay, retry, and growth-alert drills in Stripe test mode
### PLA-0322 - Allowance cron skipped credits when subscription gating read failed

- Timestamp: 2026-07-15 14:14 America/New_York
- Service: Scheduled wallet allowance automation
- Route: `/api/cron/wallet-allowance`
- Affected files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Role: family manager, parent, child recipient, and scheduled cron worker
- Scenario: a failed subscriptions read produced an empty plan map, so paid-family eligibility could be treated as Free and credits skipped
- Severity: P0
- Launch impact: scheduled allowances could disappear without a retryable failure signal
- Root cause: the subscription plan-gating error was discarded
- Resolution: subscription read errors now fail the cron through its 500 error path; schedule claim and credit rollback remain checked
- Supabase impact: no schema change; allowance and subscription family scopes remain unchanged
- Tests run: `tests/cron-wallet-allowance-persistence.test.ts`, `tests/cron-auth.test.ts` (9 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live cron/RLS evidence remain open
- Status: Resolved in code; live scheduled execution remains open
- Remaining dependencies: execute isolated outage, duplicate-run, and ledger/RLS drills
### PLA-0323 - Digest crons hid family and delivery failures as zero sends

- Timestamp: 2026-07-15 14:18 America/New_York
- Service: Chore reminder and weekly digest scheduled email workflows
- Routes: `/api/cron/chore-reminders`, `/api/cron/weekly-digest`
- Affected files: `app/api/cron/chore-reminders/route.ts`, `app/api/cron/weekly-digest/route.ts`, `tests/digest-cron-read-boundary.test.ts`
- Role: family member, family admin, and scheduled cron worker
- Scenario: family/Auth Admin/feature reads failed but the cron assembled empty data or recipients; failed email delivery did not change the response status
- Severity: P1
- Launch impact: reminders and digests could be missed while operations saw an apparently successful zero-send run
- Root cause: Supabase result errors were discarded and email send failures were not counted
- Resolution: required reads now fail with 500, per-family read failures are counted, and partial email delivery returns 502 with sent/failed counts
- Supabase impact: no schema change; existing family-scoped queries remain unchanged
- Tests run: `tests/digest-cron-read-boundary.test.ts`, `tests/cron-auth.test.ts` (6 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live scheduler/Resend evidence remain open
- Status: Resolved in code; live delivery evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, recipient, and duplicate-run drills
### PLA-0329 - Wallet hub deletion relied on dynamic ID-only targeting

- Timestamp: 2026-07-15 15:00 America/New_York
- Service: Wallet hub destructive actions
- Route: `deleteWalletRowAction`
- Affected files: `app/(app)/wallet/hub-actions.ts`, `tests/wallet-money-action-boundaries.test.ts`
- Role: family manager or authenticated household member invoking wallet deletion
- Scenario: a dynamic table name and ID-only delete relied on RLS instead of explicitly constraining the active family
- Severity: P0
- Launch impact: policy drift could permit cross-family deletion of wallet data
- Root cause: the action used `from(input.table)` and omitted `family_id` from the delete predicate
- Resolution: explicit supported-table branches now include `family_id = ctx.active.familyId`; RLS remains defense in depth
- Supabase impact: no schema change; strengthens existing family-scoped wallet tables and RLS policies
- Tests run: `tests/wallet-money-action-boundaries.test.ts`, `tests/tenant-isolation-rls.test.ts`, `tests/role-surface.test.ts`, `tests/role-density.test.ts` (22 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live cross-family/RLS/concurrency evidence remains open
- Status: Resolved in code; live wallet authorization evidence remains open
- Remaining dependencies: execute authenticated two-family wallet deletion and role/concurrency drills

### PLA-0328 - Onboarding provisioning acknowledged incomplete state writes

- Timestamp: 2026-07-15 15:00 America/New_York
- Service: Profile onboarding and compatibility first-family provisioning
- Route: `completeProfileOnboardingAction`, `ensureActiveFamily`, and protected-page onboarding fallback
- Affected files: `app/onboarding/actions.ts`, `lib/server/ensure-family.ts`, `tests/onboarding-failure-safety.test.ts`
- Role: new account owner, existing multi-family user, family manager, and first-login provisioning worker
- Scenario: membership/preference reads or subscription/active-family writes failed while onboarding returned success, or a color update touched every family membership
- Severity: P0
- Launch impact: onboarding could complete without valid tenant/subscription state or mutate another familyâ€™s UI data
- Root cause: secondary Supabase result errors were ignored and the member color update lacked a family scope
- Resolution: required reads and writes now fail closed, compatibility provisioning reports false on subscription/active-family failures, and color updates target the resolved family only
- Supabase impact: no schema change; protects existing family_members/user_preferences/subscriptions/families boundaries
- Tests run: `tests/onboarding-failure-safety.test.ts`, `tests/onboarding-idempotency.test.ts`, `tests/ensure-family-concurrency.test.ts`, `tests/auth-context-integrity.test.ts` (11 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live onboarding, tier, invite, and cross-tenant RLS evidence remains open
- Status: Resolved in code; live onboarding/deployment evidence remains open
- Remaining dependencies: apply and verify migrations 0210/0212, then execute first-login, invite, tier, and two-tenant drills

### PLA-0327 - Incomplete family context could be misclassified as onboarding

- Timestamp: 2026-07-15 14:50 America/New_York
- Service: Authenticated user context, tenant membership resolution, and first-family provisioning
- Route: `lib/supabase/auth.ts`, protected app pages, and onboarding fallback
- Affected files: `lib/supabase/auth.ts`, `tests/auth-context-integrity.test.ts`
- Role: authenticated user with memberships, family manager, and first-login provisioning worker
- Scenario: an active membership could not be joined to its family row, but context resolution returned the onboarding state
- Severity: P0
- Launch impact: a partial tenant-context read could create a second family or misroute the user instead of failing safely
- Root cause: missing family joins were silently filtered before the `needsFamily` branch
- Resolution: incomplete family joins and membership mappings now return a retryable context-unavailable failure
- Supabase impact: no schema change; protects existing family_members/families/user_preferences reads and provisioning calls
- Tests run: `tests/auth-context-integrity.test.ts`, `tests/admin-auth-boundary.test.ts`, `tests/tenant-isolation-rls.test.ts`, `tests/ensure-family-concurrency.test.ts` (8 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live Auth Admin/RLS/role/browser evidence remains open
- Status: Resolved in code; live tenant-isolation evidence remains open
- Remaining dependencies: apply 0211/0212 and execute authenticated two-tenant and first-login drills

### PLA-0326 - Scheduled integrations acknowledged secondary persistence failures

- Timestamp: 2026-07-15 14:42 America/New_York
- Service: Guardian Learning, Network Aggregation, auctions, provider sync, and calendar feed sync
- Route: `/api/cron/guardian-learning`, `/api/cron/network-aggregate`, `/api/cron/close-auctions`, `/api/cron/provider-sync`, `/api/cron/calendar-feeds`
- Affected files: `app/api/cron/guardian-learning/route.ts`, `app/api/cron/network-aggregate/route.ts`, `lib/network/aggregate-server.ts`, `app/api/cron/close-auctions/route.ts`, `app/api/cron/provider-sync/route.ts`, `lib/server/calendar-feeds.ts`, `tests/cron-recovery-boundaries.test.ts`
- Role: family member, network-consenting household, auction participant, connected-provider user, calendar subscriber, and scheduled cron worker
- Scenario: secondary reads or writes failed after primary batch reads while the job returned success or published incomplete state
- Severity: P1
- Launch impact: learning, aggregate privacy, auction notifications, sync observability, or calendar state could be incomplete without a retry signal
- Root cause: Supabase result errors were discarded in cleanup, source queries, contribution pruning, notifications, audit logs, event upserts, and feed status writes
- Resolution: required reads and writes are checked; cron errors are sanitized and return 502 on incomplete scheduled work; feed sync fails when event or status persistence fails
- Supabase impact: no schema change; existing consent, aggregate, marketplace, sync, and calendar scopes remain unchanged
- Tests run: `tests/cron-recovery-boundaries.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, `tests/marketplace-auction-security.test.ts` (17 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live scheduler/provider/privacy/RLS evidence remains open
- Status: Resolved in code; live scheduled integration evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, duplicate-run, consent/privacy, and live Supabase drills

### PLA-0325 - Return and model refresh crons acknowledged persistence failures

- Timestamp: 2026-07-15 14:35 America/New_York
- Service: Marketplace return reminders and household model refresh
- Route: `/api/cron/return-reminders`, `/api/cron/model-refresh`
- Affected files: `app/api/cron/return-reminders/route.ts`, `app/api/cron/model-refresh/route.ts`, `tests/cron-return-reminders-boundary.test.ts`
- Role: family members waiting on returns, household members relying on model projections, and scheduled cron workers
- Scenario: secondary listing, notification, order-stamp, dirty-state, or dirty-flag failures were ignored after primary reads succeeded
- Severity: P1
- Launch impact: reminders could repeat or disappear, and model refresh could report success while stale work remained queued
- Root cause: Supabase result errors from secondary reads and writes were discarded
- Resolution: required reads and writes are checked; failed reminder items and dirty-state persistence now produce retryable non-success responses
- Supabase impact: no schema change; existing marketplace and model-dirty scopes remain unchanged
- Tests run: `tests/cron-return-reminders-boundary.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-auth.test.ts` (10 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live scheduler/provider/RLS evidence remains open
- Status: Resolved in code; live scheduled delivery evidence remains open
- Remaining dependencies: execute scheduler, duplicate-run, provider outage/retry, and live Supabase drills

### PLA-0324 - Journey Recovery acknowledged failed abandonment sweeps

- Timestamp: 2026-07-15 14:30 America/New_York
- Service: Abandoned onboarding and demo-lead recovery cron
- Route: `/api/cron/journey-recovery`
- Affected files: `app/api/cron/journey-recovery/route.ts`, `tests/journey-recovery-cron-boundary.test.ts`
- Role: abandoned user, demo lead, marketing operator, and scheduled cron worker
- Scenario: onboarding, CRM, profile, or automation failures were logged but the endpoint still returned success with partial counts
- Severity: P1
- Launch impact: follow-up workflows could be silently skipped without an operational retry signal
- Root cause: sweep/profile/automation failures were not counted in the response status
- Resolution: required reads now fail the sweep, per-record failures increment `failed`, and the endpoint returns 502 when any work fails
- Supabase impact: no schema change; existing onboarding/profile/CRM scopes remain unchanged
- Tests run: `tests/journey-recovery-cron-boundary.test.ts`, `tests/cron-auth.test.ts` (6 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and the full local gate pass; live scheduler/provider evidence remains open
- Status: Resolved in code; live automation evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, duplicate-run, and recipient drills

