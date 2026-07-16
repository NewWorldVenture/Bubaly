# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0357 - Decision Engine and Health Visits hid required reads as empty states

- Timestamp: 2026-07-16 07:03 America/New_York
- Service: Decision Engine and Health Visits
- Route: `/dashboard/decisions`, health module routes using `/dashboard/health-visits`
- Affected files: `components/modules/decisions-module.tsx`, `components/modules/health-visits-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members, household managers, and health-history users
- Scenario: a failed decision or option read could show no decisions; a failed health-visit read could show an empty medical history.
- Severity: P1
- Launch impact: families could make choices without available trade-offs or miss health-history and follow-up context.
- Root cause: both modules ignored realtime query errors; Decision Engine also failed to coordinate its paired decision/options reads.
- Resolution: Decision Engine now coordinates both reads and retries them together; Health Visits renders sanitized retryable ErrorState UI before its empty history.
- Supabase impact: no schema change; existing family-scoped reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 474 test files, 3,230 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `59b280ae`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed household verification

### PLA-0356 - Behavior insights hid behavior-log read failures as no logged behavior

- Timestamp: 2026-07-16 06:56 America/New_York
- Service: Behavior and Parenting Insights
- Route: `/dashboard/behavior`
- Affected files: `components/modules/behavior-module.tsx`, `tests/behavior-read-boundary.test.ts`
- Role: authenticated family members and household managers
- Scenario: a failed `behavior_logs` read could render â€œNo behavior logged yet,â€ indistinguishable from a household with no recorded behavior.
- Severity: P1
- Launch impact: parents could lose visibility into behavior history and the insight context built from it.
- Root cause: the module ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Behavior now renders sanitized retryable ErrorState UI before behavior summaries and the empty state on any read failure.
- Supabase impact: no schema change; the existing family-scoped behavior read now has an explicit failure contract.
- Tests run: `tests/behavior-read-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 473 test files, 3,228 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `42625b69`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed behavior verification

### PLA-0355 - Location map hid coordinate, geofence, and history read failures as no sharing

- Timestamp: 2026-07-16 06:51 America/New_York
- Service: Family Location
- Route: `/dashboard/locator`
- Affected files: `components/modules/locator-module.tsx`, `tests/family-location-read-boundary.test.ts`
- Role: authenticated family members and household managers
- Scenario: one or more location reads could fail while the map and live-location sections rendered from empty or partial arrays.
- Severity: P1
- Launch impact: families could miss a member location, geofence, or recent safety history while the page appeared usable.
- Root cause: the module only gated on the locations query loading state and ignored errors from all three required reads.
- Resolution: Location now waits for all three reads and renders sanitized retryable ErrorState UI with a coordinated retry before the map.
- Supabase impact: no schema change; existing family-scoped location reads now have an explicit page-level failure contract.
- Tests run: `tests/family-location-read-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 472 test files, 3,227 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `632f677d`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-location verification

### PLA-0354 - Play Dates hid family scheduling read failures as no play dates

- Timestamp: 2026-07-16 06:45 America/New_York
- Service: Play Dates
- Route: `/dashboard/family/play-dates`
- Affected files: `components/family/play-dates-view.tsx`, `tests/family-safety-read-boundaries.test.ts`
- Role: authenticated family members and household planners
- Scenario: a failed `play_dates` read could render â€œNo play dates yet,â€ indistinguishable from a household with no scheduled social activity.
- Severity: P1
- Launch impact: families could miss upcoming child-safety and pickup coordination details.
- Root cause: the view ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Play Dates now renders sanitized retryable ErrorState UI before the empty schedule on any read failure.
- Supabase impact: no schema change; the existing family-scoped schedule read now has an explicit failure contract.
- Tests run: `tests/family-safety-read-boundaries.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 471 test files, 3,226 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `4f5edc92`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-safety verification

### PLA-0353 - Driving Safety and Find Phone hid family location read failures

- Timestamp: 2026-07-16 06:37 America/New_York
- Service: Driving Safety and Find Phone
- Route: `/dashboard/family/driving-safety`, `/dashboard/family/find-phone`
- Affected files: `components/family/driving-safety-view.tsx`, `components/family/find-phone-view.tsx`, `tests/family-safety-read-boundaries.test.ts`
- Role: authenticated family members and safety operators
- Scenario: driving-trip reads could fail while the page showed no trips or zeroed summary metrics; Find Phone could show partial device data when locations or saved places failed.
- Severity: P1
- Launch impact: families could miss driving-safety activity or use incomplete location data.
- Root cause: both views ignored `useRealtimeQuery` errors; Find Phone did not coordinate its location and saved-place read failures.
- Resolution: both views now render sanitized retryable ErrorState UI before empty/partial states; Find Phone retries both required reads together.
- Supabase impact: no schema change; existing family-scoped reads now have explicit failure contracts.
- Tests run: `tests/family-safety-read-boundaries.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 471 test files, 3,225 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `00128cc4`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-safety verification

### PLA-0352 - Family check-in feed hid safety read failures as no check-ins

- Timestamp: 2026-07-15 17:33 America/New_York
- Service: Family Check In
- Route: `/dashboard/check-in`
- Affected files: `components/family/check-in-view.tsx`, `tests/family-check-in-boundary.test.ts`
- Role: authenticated family members and safety operators
- Scenario: the family check-in read could fail while the feed rendered â€œNo check-ins yet,â€ indistinguishable from a household with no safety activity.
- Severity: P1
- Launch impact: family members could miss safety status updates during an incident.
- Root cause: the view ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Family Check In now renders a sanitized retryable ErrorState before the empty feed on any read failure.
- Supabase impact: no schema change; the existing family-scoped safety feed now has an explicit failure contract.
- Tests run: `tests/family-check-in-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 470 test files, 3,223 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `b72a02d2`
- Status: Resolved in code; audit evidence was stamped in `ce9822ad` and the source, test, and docs were published to remote `main`
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Check In verification

### PLA-0351 - Weather and packing views hid failed trip dependencies as empty plans

- Timestamp: 2026-07-15 17:27 America/New_York
- Service: Trip Weather and Trip Packing
- Route: `/dashboard/vacations/[id]/weather`, `/dashboard/vacations/[id]/packing`
- Affected files: `components/vacations/trip-weather.tsx`, `components/vacations/trip-packing.tsx`, `tests/trip-weather-packing-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: weather, packing, or activity dependency reads could fail while pages rendered no forecast or no packing items.
- Severity: P1
- Launch impact: travelers could plan without current weather or lose visibility into a partially unavailable packing plan.
- Root cause: both views used fallback arrays while ignoring secondary query loading and errors.
- Resolution: Weather now validates its trip and snapshot reads; Packing validates all five required reads and renders sanitized retry states before empty-state UI.
- Supabase impact: no schema change; existing family-scoped trip dependency reads now have explicit page-level failure contracts.
- Tests run: `tests/trip-weather-packing-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 469 test files, 3,222 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `2a86d411`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Weather/Packing verification

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
- Commit: `194e4ecb…25599 tokens truncated…-plan`, `/api/billing/cancel`, `/api/billing/portal`
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

