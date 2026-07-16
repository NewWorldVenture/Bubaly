# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0386 - Admin Management hid administrator read failures as zero admins

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/admins`.
- Finding: the `admin_users` query could fail while the page rendered zero administrators and retained access-management controls.
- Repair: the Supabase error is checked before calculating role counts, filters, or admin-management controls; failures return a retryable page state.
- Evidence: focused Admin Management boundary suite (1 assertion), full 492 test files/3,252 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `b465cf71`.
- Remaining launch gate: validate live Super Admin authorization, admin table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0385 - Social Usage hid usage-event read failures as an empty meter

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/social/usage`.
- Finding: the usage-event query could fail while the page rendered no metering activity, masking an unavailable operational feed.
- Repair: the Supabase error is checked before calculating totals or rendering the empty state; failures return a retryable page state.
- Evidence: focused Social Usage boundary suite (1 assertion), full 491 test files/3,251 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `ee26e70c`.
- Remaining launch gate: validate live Super Admin authorization, usage table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0384 - Social Audit hid audit-log read failures as an empty history

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/social/audit`.
- Finding: the audit-log query could fail while the page rendered â€œNo audit entries yet,â€ masking an unavailable operational history.
- Repair: the Supabase error is checked before rendering the empty state or audit rows; failures return a retryable page state.
- Evidence: focused Social Audit boundary suite (1 assertion), full 490 test files/3,250 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `80a790c6`.
- Remaining launch gate: validate live Super Admin authorization, audit-trigger table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0383 - Exit-Intent hid offer read failures as an empty editor

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/exit-intent`.
- Finding: the offer query could fail while the page rendered zero offers and kept create, activate, pause, and delete controls available.
- Repair: the Supabase error is checked before calculating offer metrics or rendering CRUD controls; failures return a retryable page state.
- Evidence: focused Exit-Intent boundary suite (1 assertion), full 489 test files/3,249 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `03012c8c`.
- Remaining launch gate: validate live Super Admin authorization, marketing table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0382 - Personalization hid rule read failures as an empty editor

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/personalization`.
- Finding: the rule query could fail while the page rendered no rules and kept create, activate, pause, and delete controls available.
- Repair: the Supabase error is checked before grouping rules by slot or rendering CRUD controls; failures return a retryable page state.
- Evidence: focused Personalization boundary suite (1 assertion), full 489 test files/3,249 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `03012c8c`.
- Remaining launch gate: validate live Super Admin authorization, marketing table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0381 - Competitive Intelligence hid CRUD read failures as an empty dataset

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/competitive`.
- Finding: competitor, keyword, or backlink read failures could be masked while active CRUD controls remained available over empty collections.
- Repair: all three Supabase results are checked before rendering collections or CRUD controls; thrown failures also return a retryable state.
- Evidence: focused Competitive Intelligence boundary suite (1 assertion), full 487 test files/3,247 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `9c5edb3e`.
- Remaining launch gate: validate live Super Admin authorization, SEO table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0380 - Customer Intelligence hid analytics failures as zero attribution metrics

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/intelligence`.
- Finding: visitor, session, and touchpoint reads could fail while the route rendered zero counts, no channels, and no attribution rows.
- Repair: all four Supabase results are checked before channel, conversion, and attribution calculations; thrown failures also render a retryable state.
- Evidence: focused Customer Intelligence boundary suite (1 assertion), full 486 test files/3,246 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `c8ef7399`.
- Remaining launch gate: validate live Super Admin authorization, telemetry table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0379 - Onboarding Audit hid progress failures as a healthy zero-run funnel

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/onboarding`.
- Finding: the onboarding progress query could fail while the page rendered zero runs, zero rates, and no stalls as if the audit were healthy and empty.
- Repair: the query now preserves its error state and returns a retryable page-level failure before funnel analysis.
- Evidence: focused Onboarding Audit boundary suite (1 assertion), full 485 test files/3,245 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `1c028718`.
- Remaining launch gate: validate live Super Admin authorization, onboarding telemetry availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0378 - Lead Scores hid score and contact failures as an empty leaderboard

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/lead-scores`.
- Finding: the score query and required contact join could fail while the page rendered an empty leaderboard and zero stats.
- Repair: score and contact reads now retain their error state and return a retryable page-level failure instead of deriving rows from missing data.
- Evidence: focused Lead Scores boundary suite (1 assertion), full 484 test files/3,244 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `deb07a24`.
- Remaining launch gate: validate live Super Admin authorization, CRM table availability, and deployed retry behavior; Auth Admin and broader launch blockers remain open.

### PLA-0377 - Visitor Intelligence hid analytics failures as zero metrics

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/admin/marketing/visitor-intelligence`.
- Finding: eleven service-role analytics counts collapsed returned or thrown database failures to zero, making an unhealthy funnel look like a valid empty one.
- Repair: count reads now retain `{ value, error }`; the page checks all metrics before deriving funnel and lead-band state and renders a retryable error state on failure.
- Evidence: focused Visitor Intelligence boundary suite (1 assertion), full 483 test files/3,243 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `2dde5f16`.
- Remaining launch gate: validate live Super Admin authorization, service-role table availability, and deployed retry behavior; the Auth Admin and broader launch blockers remain open.

### PLA-0376 - Workload Balance hid required read failures as empty history

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/workload`.
- Finding: required workload and snapshot queries could fail while the page rendered empty arrays, and snapshot-save failures were discarded by a fire-and-forget action.
- Repair: check every required query, render a retryable error state, replace the roadmap-style save error, and surface persistence errors through the toast path.
- Evidence: focused Workload suites (11 assertions), full 482 test files/3,242 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `0a4b83cd`.
- Remaining launch gate: verify live Workload RLS and deployed browser behavior; the broader Auth, role, backup, and deployment gates remain open.

### PLA-0375 - Apple Reminders was advertised before VTODO sync existed

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/sync/accounts/apple` and the shared sync capability matrix.
- Finding: Apple Reminders was presented as a two-way CalDAV capability even though the Apple adapter drops VTODO collections and returns no task list.
- Repair: marked Apple Reminders unsupported, kept Apple Calendar available over CalDAV, and removed Reminders from Apple setup guidance.
- Evidence: Apple sync and capability suites (34 assertions), full 481 test files/3,240 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `ada8107c`.
- Remaining launch gate: implement and test Apple VTODO read/write sync before advertising Reminders again; live Auth Admin, OAuth, RLS, browser, backup, and deployment evidence also remain open.

### PLA-0374 - Sync account pages exposed Amazon without a real account adapter

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/sync`, `/dashboard/sync/accounts`, and `/dashboard/sync/accounts/[provider]`.
- Finding: Amazon/Alexa appeared as a connectable account despite having no production sync adapter; only export-only ICS capability exists.
- Repair: removed Amazon from all three setup arrays and updated the Sync hub copy; the truthful Amazon capability matrix remains intact.
- Evidence: `tests/sync-connectable-surface.test.ts`, route-boundary/capability suites, full 481 test files/3,240 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `05bc83e4`.
- Remaining launch gate: validate live Google/Microsoft/Apple OAuth/sync and implement a real Amazon adapter before exposing account setup.

### PLA-0373 - Dead Connections adapter layer duplicated the real sync registry

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: internal `lib/connections` adapter layer and `/dashboard/connections` integration boundary.
- Finding: planned adapters returned â€œnot available yet,â€ had no production callers, and duplicated the authoritative `lib/sync` registry.
- Repair: deleted the dead contract, planned Google/Gmail adapters, registry, and their tests; stale-reference scan is clean. The real `lib/sync` path remains unchanged.
- Evidence: remaining Connections provider suite, full 480 test files/3,238 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `23cd749b`.
- Remaining launch gate: validate the real Google/Microsoft/Apple OAuth and sync flows in live sandbox/deployed environments; implement future providers before exposing them.

### PLA-0372 - Connections hub exposed providers without live setup routes

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/connections`.
- Finding: the user-facing directory included Gmail, Plaid, grocery, and smart-home services without live setup/sync routes.
- Repair: added `CONNECTABLE_PROVIDERS`, made the runtime merge use it, and updated the hub copy to supported calendar services only. Future providers remain internal until their full integration path exists.
- Evidence: focused connection suites, full 481 test files/3,252 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `9eb160b0`.
- Remaining launch gate: live OAuth callbacks, provider sync, RLS/role, and deployed browser verification for the supported calendar routes; implement remaining providers before exposing them.

### PLA-0371 - Independence empty state used roadmap language

- Status: Resolved in source; live and deployed verification remain open.
- Severity: P2.
- Surface: Independence badge collection.
- Finding: an empty collection rendered â€œFirst badge coming soon,â€ which described a roadmap rather than current data.
- Repair: changed the empty state to â€œNo badges yet â€” start a skill above.â€
- Evidence: `tests/independence-empty-state.test.ts`, full 481 test files/3,250 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `14f0d14b`.
- Remaining launch gate: verify live progress reads and deployed UI copy.

### PLA-0370 - App Store advertised unavailable catalog entries as â€œComing soonâ€

- Status: Resolved in source; live catalog and deployed verification remain open.
- Severity: P1.
- Surface: `/dashboard/app-store`.
- Finding: catalog entries with `coming_soon` status rendered a roadmap label in the install-control position instead of a clear unavailable state.
- Repair: renamed the control prop to `available` and changed the non-installable label to `Unavailable`; available entries retain the real install/uninstall action.
- Evidence: `tests/appstore-availability.test.ts`, full 480 test files/3,249 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `916ee059`.
- Remaining launch gate: verify live catalog status policy and deployed App Store behavior.

### PLA-0369 - Documents exposed cloud-import buttons without provider adapters

- Status: Resolved in source; provider implementation and deployed verification remain open.
- Severity: P1.
- Surface: Family Documents quick actions.
- Finding: Google Drive and Dropbox buttons were clickable but only fired a â€œnot connectedâ€ toast because no provider adapters existed.
- Repair: removed both disconnected actions, unused icons, and the dead `comingSoon` helper; supported upload, folder creation, and scan actions remain visible.
- Evidence: `tests/documents-import-actions.test.ts`, full 479 test files/3,248 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `2c474f5a`.
- Remaining launch gate: implement OAuth, storage, retry, and tenant controls before reintroducing cloud-import actions.

### PLA-0368 - Wallet card surfaces implied an issued payment card before provider setup

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: `/wallet/cards` and `/wallet/children/[childId]`.
- Finding: provider-disabled card mode used â€œcoming soonâ€ copy, and child detail rendered Visa-like preview art without explicitly stating that no card had been issued.
- Repair: provider-disabled mode now says spending cards are unavailable until configured; child detail now renders a clearly labeled non-issued preview with ledger-only language and no payment-card number/brand simulation.
- Evidence: `tests/wallet-card-availability.test.ts`, Stripe capability suite, 478 test files/3,246 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `faf75b75`.
- Remaining launch gate: verify real Stripe Issuing account capability, feature-flag/RLS state, and deployed browser behavior before enabling or advertising card issuance.

### PLA-0367 - Intelligence and Briefing context reads hid failures as safe-looking defaults

- Timestamp: 2026-07-16 08:22 America/New_York
- Service: Intelligence Network preferences and Briefing Kitchen Mode
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/intelligence-module.tsx`, `components/modules/briefing-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: a failed consent read could silently appear as privacy-disabled defaults, while failed event/reminder reads could leave Kitchen Mode looking current with incomplete context.
- Severity: P1
- Launch impact: users could make privacy decisions from unverified state or miss time-sensitive household context while the interface appeared healthy.
- Root cause: both surfaces ignored realtime query errors; Kitchen Mode also lacked a coordinated retry for its two context reads.
- Resolution: Intelligence now blocks controls behind a retryable ErrorState; Briefing Kitchen Mode retries calendar and reminder reads together before rendering.
- Supabase impact: no schema change; existing consent and household context reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (9 focused assertions); full Vitest; typecheck; lint; clean production build; diff check.
- Validation evidence: 477 test files, 3,244 tests, 250-route build, and diff check passed; known build warnings remain documented.
- Commit: `9682ff06`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed AI/context verification

### PLA-0366 - Tax, subscription, memory, and routine reads hid failures as empty state

- Timestamp: 2026-07-16 08:13 America/New_York
- Service: Tax Vault, Subscriptions, Trip Memories, and Routines
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/tax-vault-module.tsx`, `components/modules/subscriptions-module.tsx`, `components/modules/trip-memories-module.tsx`, `components/modules/routines-panel.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state or allowed trip and routine summaries to derive from partial query results.
- Severity: P1
- Launch impact: families could miss tax records, recurring charges, travel memories, or saved routines while the UI appeared usable.
- Root cause: modules ignored realtime query errors; Trip Memories and Routines also lacked coordinated loading and retry behavior across dependent reads.
- Resolution: all four surfaces now expose retryable ErrorState UI; Trip Memories and Routines coordinate every required read before rendering derived state.
- Supabase impact: no schema change; existing family-scoped record, trave…34493 tokens truncated…-plan`, `/api/billing/cancel`, `/api/billing/portal`
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
