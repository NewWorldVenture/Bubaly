# FamilyOS â€” Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-16 10:20:00 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `03012c8c` makes Super Admin Personalization and Exit-Intent fail closed on read failures after `9c5edb3e` repaired Competitive Intelligence; live provider and deployment evidence remains open
- Environment: Windows workspace; Next.js 15; Supabase project configuration present locally
- Supabase project: configured through `.env.local` (secrets intentionally omitted)
- Auditor: Codex production-readiness audit
- Overall status: `[!]` NO-GO pending live Supabase, account, browser, backup, and deployment evidence
- Critical blockers remaining: Auth Admin HTTP 500; remote migration ledger and credential rotation are unverified
- High-priority issues remaining: authenticated E2E; third-party callback smoke tests; full route/workflow audit
- Medium-priority issues remaining: accessibility, mobile, performance, observability, and backup evidence
- Low-priority issues remaining: final polish findings from the continuing audit

### Audit rules

- Every finding receives a permanent issue ID and remains in this ledger after resolution.
- An item is completed only after the repair is tested, documented, committed, and pushed.
- Production data is never mutated destructively; destructive tests require an isolated environment.
- The companion evidence files are `docs/AUDIT_PROGRESS.md`, `docs/SERVICE_TEST_MATRIX.md`, `docs/SUPABASE_WIRING_MATRIX.md`, `docs/LAUNCH_BLOCKERS.md`, `docs/PRODUCT_LAUNCH_AUDIT.md`, and `docs/progress/`.

#### TODO-0383 - Exit-Intent hid offer read failures as an empty editor

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing conversion / Supabase read boundary
- Feature: Exit-Intent Popups
- Route: `/admin/marketing/exit-intent`
- File or files: `app/(app)/admin/marketing/exit-intent/page.tsx`, `tests/admin-exit-intent-read-boundary.test.ts`
- Database objects: `marketing_exit_intent`
- Affected roles: Super Admin
- Scenario: the offer query could fail while the page rendered an empty list with create, activate, pause, and delete controls.
- Launch impact: operators could manage conversion offers against incomplete state or interpret a backend outage as no offers.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required CRUD read.
- Required remediation: preserve the query error, fail visibly, and only render metrics and controls after a successful read.
- Implementation notes: added a retryable ReadFailure state and explicit error logging before offer metrics are derived.
- Test plan: focused Exit-Intent boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (489 files/3,249 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `03012c8c`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Exit-Intent no longer exposes CRUD controls over a failed or fabricated empty dataset.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the admin workflow and marketing audit.

#### TODO-0382 - Personalization hid rule read failures as an empty editor

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing personalization / Supabase read boundary
- Feature: Personalization
- Route: `/admin/marketing/personalization`
- File or files: `app/(app)/admin/marketing/personalization/page.tsx`, `tests/admin-personalization-read-boundary.test.ts`
- Database objects: `marketing_personalization_rules`
- Affected roles: Super Admin
- Scenario: the rule query could fail while the page rendered no rules with create, activate, pause, and delete controls.
- Launch impact: operators could manage targeting rules against incomplete state or mistake a backend outage for a clean default.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required CRUD read.
- Required remediation: preserve the query error, fail visibly, and only render slot groupings and controls after a successful read.
- Implementation notes: added a retryable ReadFailure state and explicit error logging before rules are grouped by slot.
- Test plan: focused Personalization boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (489 files/3,249 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `03012c8c`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Personalization no longer exposes CRUD controls over a failed or fabricated empty dataset.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the admin workflow and marketing audit.

#### TODO-0381 - Competitive Intelligence hid CRUD read failures as an empty dataset

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing SEO intelligence / Supabase read boundary
- Feature: Competitive Intelligence
- Route: `/admin/marketing/competitive`
- File or files: `app/(app)/admin/marketing/competitive/page.tsx`, `tests/admin-competitive-intelligence-read-boundary.test.ts`
- Database objects: `competitors`, `keyword_intel`, and `backlinks`
- Affected roles: Super Admin
- Scenario: any competitor, keyword, or backlink query could fail while the page rendered an empty dataset alongside active CRUD controls.
- Launch impact: operators could add, delete, or interpret SEO intelligence against incomplete state.
- Root cause: three Supabase results were destructured without checking their error objects.
- Required remediation: preserve all query results, fail visibly on any error, and only render CRUD collections after a successful read batch.
- Implementation notes: wrapped the read batch for thrown failures, checked all three returned errors, and added a retryable ReadFailure state.
- Test plan: focused Competitive Intelligence boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (487 files/3,247 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `9c5edb3e`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Competitive Intelligence no longer exposes CRUD controls over a failed or fabricated empty dataset.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the admin workflow and SEO audit.

#### TODO-0380 - Customer Intelligence hid analytics failures as zero attribution metrics

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing attribution / Supabase read boundary
- Feature: Customer Intelligence
- Route: `/admin/marketing/intelligence`
- File or files: `app/(app)/admin/marketing/intelligence/page.tsx`, `tests/admin-customer-intelligence-read-boundary.test.ts`
- Database objects: `mkt_visitors`, `mkt_sessions`, and `mkt_touchpoints`
- Affected roles: Super Admin
- Scenario: visitor, session, or touchpoint failures were discarded while the route rendered zero counts and an empty attribution report.
- Launch impact: acquisition and conversion decisions could be made from incomplete telemetry while the admin page appeared healthy.
- Root cause: the route destructured Supabase results without checking error objects.
- Required remediation: preserve all four query results, check every error, and render a retryable error state before calculating attribution.
- Implementation notes: wrapped the read batch for thrown failures, checked returned errors, and only derive channels, conversions, and models after successful reads.
- Test plan: focused Customer Intelligence boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (486 files/3,246 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `c8ef7399`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Customer Intelligence now fails visibly on any required telemetry read failure instead of presenting zero attribution metrics.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the page and workflow audit.

#### TODO-0379 - Onboarding Audit hid progress failures as a healthy zero-run funnel

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / onboarding analytics / Supabase read boundary
- Feature: Onboarding Audit
- Route: `/admin/onboarding`
- File or files: `app/(app)/admin/onboarding/page.tsx`, `tests/admin-onboarding-read-boundary.test.ts`
- Database objects: `onboarding_progress`
- Affected roles: Super Admin
- Scenario: an onboarding progress read failure was caught and rendered as a valid zero-run funnel with 0% rates.
- Launch impact: operators could believe onboarding was healthy or empty while the telemetry table was unavailable.
- Root cause: the page discarded the Supabase error object and used an empty fallback for a required audit read.
- Required remediation: preserve the progress query error and render a retryable error state before calculating funnel metrics.
- Implementation notes: added an explicit ReadFailure state, checked the query result, and only call `analyzeOnboarding` after a successful read.
- Test plan: focused Onboarding Audit boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (485 files/3,245 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `1c028718`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Onboarding Audit now fails visibly on a required progress read failure instead of presenting a fabricated empty funnel.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the onboarding workflow and role audit.

#### TODO-0378 - Lead Scores hid score and contact failures as an empty leaderboard

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing CRM / Supabase read boundary
- Feature: Lead Scores
- Route: `/admin/marketing/lead-scores`
- File or files: `app/(app)/admin/marketing/lead-scores/page.tsx`, `tests/admin-lead-scores-read-boundary.test.ts`
- Database objects: `crm_lead_scores` and `crm_contacts`
- Affected roles: Super Admin
- Scenario: a failed score or contact join query was caught and rendered as no scores, allowing operators to confuse backend failure with an empty CRM.
- Launch impact: lead prioritization and recompute decisions could be made from incomplete or missing data.
- Root cause: the page discarded Supabase error objects and used an empty fallback for required reads.
- Required remediation: check both score and joined-contact reads, preserve failures, and render a retryable error state.
- Implementation notes: added an explicit ReadFailure state, validated the score query before deriving rows, and validated the contact join before rendering lifecycle and identity fields.
- Test plan: focused Lead Scores boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (484 files/3,244 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `deb07a24`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Lead Scores now fails visibly on either required read failure instead of showing a fabricated empty state.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the page and workflow audit.

#### TODO-0377 - Visitor Intelligence hid analytics failures as zero metrics

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing analytics / Supabase read boundary
- Feature: Visitor Intelligence
- Route: `/admin/marketing/visitor-intelligence`
- File or files: `app/(app)/admin/marketing/visitor-intelligence/page.tsx`, `tests/admin-visitor-intelligence-read-boundary.test.ts`
- Database objects: `mkt_visitors`, `crm_contact_profile`, `crm_lead_scores`, and `mkt_consent_events`
- Affected roles: Super Admin
- Scenario: a service-role analytics query could fail while the page rendered zero-valued funnel, lead-band, and consent metrics.
- Launch impact: operators could treat a failed analytics backend as healthy empty traffic and make decisions from false data.
- Root cause: count reads discarded returned Supabase errors and converted thrown errors to zero.
- Required remediation: preserve count-read errors, fail visibly with a retry state, and keep zero as a valid value only when the query succeeds.
- Implementation notes: count now returns `{ value, error }`; all eleven metrics are checked before funnel calculation; the page includes a retry path.
- Test plan: focused Visitor Intelligence boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (483 files/3,243 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `2dde5f16`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Visitor Intelligence no longer masks Supabase analytics failures as zero metrics.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the page and workflow audit.

#### TODO-0376 - Workload Balance hid required read failures as empty history

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / Supabase read boundary / operational integrity
- Feature: Workload Balance
- Route: `/dashboard/workload`
- File or files: `app/(app)/dashboard/workload/page.tsx`, `app/(app)/dashboard/workload/actions.ts`, `components/modules/workload-module.tsx`, `tests/workload-read-boundary.test.ts`
- Database objects: `family_members`, `chore_assignments`, `chores`, `todo_items`, `calendar_events`, and `workload_snapshots`
- Affected roles: authenticated family members
- Scenario: a required workload query could fail while the page rendered empty arrays; snapshot save failures were returned from a fire-and-forget action and never shown to the user.
- Launch impact: a household could see a plausible but incomplete workload report and believe trend history was current.
- Root cause: Supabase read errors were not checked, and the snapshot action result was discarded by the client.
- Required remediation: check every required query, render a retryable error state on failure, and surface snapshot-save failures through the existing toast path.
- Implementation notes: moved snapshot history into the required query set, added a page-level error boundary, replaced the roadmap-style save error, and handled the server action result in the client.
- Test plan: focused workload boundary and balance suites; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused Workload suites (11 assertions); full Vitest (482 files/3,242 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `0a4b83cd`; local branch pushed; known build warnings remain; live RLS, browser, and deployment evidence remain open.
- Resolution: Workload Balance now fails visibly on required read failure and reports snapshot persistence errors instead of presenting empty or silently degraded state.
- Remaining dependencies: verify live workload RLS and browser behavior, and complete the broader route audit.

#### TODO-0374 - Sync account pages exposed Amazon without a real account adapter

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Sync / third-party integration integrity / route exposure
- Feature: Sync hub and connected account setup
- Route: `/dashboard/sync`, `/dashboard/sync/accounts`, `/dashboard/sync/accounts/[provider]`
- File or files: `app/(app)/dashboard/sync/page.tsx`, `app/(app)/dashboard/sync/accounts/page.tsx`, `app/(app)/dashboard/sync/accounts/[provider]/page.tsx`, `tests/sync-connectable-surface.test.ts`
- Database objects: `sync_accounts`, `sync_connections`, `sync_calendars`, `sync_conflicts`, and `sync_job_runs`
- Affected roles: authenticated family members
- Scenario: Amazon/Alexa was listed as a connectable account even though the production sync registry has no Amazon adapter; only export-only ICS capability exists.
- Launch impact: users could open an account setup route for a provider that cannot authenticate or run account sync.
- Root cause: account-page provider arrays were broader than the authoritative `lib/sync/registry.ts`.
- Required remediation: expose only Google, Microsoft, and Apple in account setup pages; retain Amazon only in the capability matrix with its true export-only limitation.
- Implementation notes: removed Amazon from the three setup arrays and updated the Sync hub copy; capability tests and ICS semantics remain unchanged.
- Test plan: focused Sync surface, route-read-boundary, and capability suites; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused Sync suites (14 assertions); full Vitest (481 files/3,240 tests); typecheck; lint; clean production build; diff check.
- Evidence: source repair validated in commit `05bc83e4`; local branch pushed; known build warnings remain; live OAuth, RLS, browser, and deployment evidence remain open.
- Resolution: Amazon/Alexa is no longer advertised as an account-sync setup path.
- Remaining dependencies: implement a real Amazon adapter before exposing account setup; validate Google/Microsoft/Apple live flows.

#### TODO-0373 - Dead Connections adapter layer duplicated the real sync registry

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Connections / integration architecture / dead code
- Feature: Provider adapter registry
- Route: internal `lib/connections` layer; user-facing runtime is `/dashboard/connections`
- File o…129026 tokens truncated…d leave orphan posts, and provider exceptions could expose raw details.
- Resolution: Required reads/writes now fail closed, incomplete pre-publish posts are cleaned up, publish results are persisted before final target state, uncertain post-publish state is preserved for review, and provider exceptions use stable client messages.
- Tests performed: Focused social publishing tests, full Vitest, typecheck, lint, dependency audit, migration audit, live schema probes, production build, public Playwright/axe/overflow E2E.
- Evidence: `tests/social-publish-persistence.test.ts` guards target setup, job/read transitions, result ordering, schedule cleanup, safe action errors, and connector redaction.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0272 - Social ancillary mutations could report success after ignored writes or over-broad access checks

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Social access control / data integrity / input validation
- Feature: Social account, inbox, media-library, settings, and access-management actions
- File or files: `app/(app)/dashboard/social/actions.ts`, `tests/social-action-persistence.test.ts`
- Description: Disconnect, resolve, media, settings, and role-grant writes ignored returned errors; role grants used `manage_settings`, accepted arbitrary users/roles, and media URLs/text had no server-side bounds.
- Resolution: Required mutations now check returned rows and errors, form actions fail with stable messages, role grants require `manage_access` plus an active current-family member and valid role, and media input is bounded with HTTP(S)-only URLs.
- Tests performed: Focused social action/publish/role tests, full Vitest, typecheck, lint, dependency audit, migration audit, live schema probes, production build, public Playwright/axe/overflow E2E.
- Evidence: `tests/social-action-persistence.test.ts` guards mutation checks, input validation, and the manage-access/current-family boundary.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0273 - Loyalty awards and redemptions could become inconsistent under concurrency

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Loyalty / data integrity / concurrency / Supabase RPC security
- Feature: Loyalty points, reward redemption, finite stock, and cancellation refunds
- File or files: `supabase/migrations/0204_atomic_loyalty_transactions.sql`, `lib/loyalty/server.ts`,
  `app/(app)/admin/marketing/loyalty/actions.ts`, `tests/loyalty-atomic-persistence.test.ts`
- Description: Points debits, redemption creation, and finite-stock decrements were separate writes;
  cancellation also marked a redemption cancelled before attempting a best-effort refund.
- Resolution: Service-role-only row-locking RPCs now commit account, ledger, redemption, and stock changes
  atomically. The server and admin action consume structured RPC outcomes, and cancellation refunds points
  and restores finite stock in the same transaction.
- Tests performed: Focused loyalty persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/loyalty-atomic-persistence.test.ts` guards RPC routing, row locks, service-role grants,
  stock restoration, and the absence of direct best-effort ledger writes.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0274 - Wallet money actions could leave ledger and approval state partial

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / concurrency / Supabase RPC security
- Feature: Wallet transfers, gift approvals, spend approvals, and allowance approvals
- File or files: `supabase/migrations/0205_atomic_wallet_money_actions.sql`, `lib/wallet/server.ts`,
  `app/(app)/wallet/actions.ts`, `tests/wallet-atomic-persistence.test.ts`
- Description: Transfers debited and credited in separate writes, gift approvals credited before gift
  state was updated, and parent approvals updated their ledger and approval/audit rows independently.
- Resolution: Authenticated manager-checked RPCs now lock the affected wallet, bucket, gift, approval, and
  transaction rows; server-side split allocation preserves every cent, and ledger/state/audit writes
  commit atomically. Typed wrappers map domain failures to stable action messages.
- Tests performed: Focused Wallet persistence tests, full Vitest, typecheck, lint, dependency audit,
  migration audit, live schema probes, production build, and public Playwright/axe/overflow E2E.
- Evidence: `tests/wallet-atomic-persistence.test.ts` guards row locks, authenticated grants, split-credit
  helper use, typed RPC routing, and removal of direct partial state transitions.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0275 - Vacation AI could report success after partial persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Vacation AI / data integrity / authorization
- Feature: AI vacation builder, recommendations, and concierge conversations
- File or files: `app/api/vacations/ai/route.ts`, `tests/vacation-ai-persistence-boundaries.test.ts`
- Description: Trip context reads, recommendation replacement writes, generated itinerary/activity/budget/
  packing writes, and chat message writes ignored returned database errors. Existing conversation IDs were
  also accepted without confirming they belonged to the active family and vacation.
- Resolution: Context and mutation errors now fail closed with stable responses; generated rows are tracked
  and compensated on failure, existing budgets are restored when needed, and conversation ownership is
  checked before messages are persisted.
- Tests performed: Focused Vacation AI and database-boundary tests, full Vitest, typecheck, lint, dependency
  audit, migration audit, live schema probes, production build, seed invariants, and public Playwright/axe/
  overflow E2E.
- Evidence: `tests/vacation-ai-persistence-boundaries.test.ts` guards fail-closed reads, checked writes,
  rollback tracking, and family/vacation conversation scoping.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0276 - AI meal planning could replace slots after a partial save

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: AI meal planning / data integrity / recovery
- Feature: One-click AI meal planner with meal and pantry context
- File or files: `app/api/ai/meals/plan/route.ts`, `tests/ai-meal-plan-persistence.test.ts`
- Description: Candidate and pantry read errors were ignored, targeted slots were deleted without checking,
  newly mirrored meals could remain orphaned, and a failed or incomplete plan insert could still leave the
  planner reporting a successful write.
- Resolution: Context reads and replacement mutations now fail closed. Existing targeted slots are captured
  and restored on failure, generated meal rows are removed when they cannot be used, and the success response
  requires every model assignment to be persisted.
- Tests performed: Focused AI meal planner and database-boundary tests, full Vitest, typecheck, lint, and
  dependency audit.
- Evidence: `tests/ai-meal-plan-persistence.test.ts` guards read failures, generated-meal cleanup, slot
  restoration, and checked replacement writes.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0277 - AI chat accepted unverified conversation ownership

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family AI / authorization / privacy
- Feature: Streaming family assistant conversations
- File or files: `app/api/ai/chat/route.ts`, `tests/ai-chat-ownership.test.ts`
- Description: The client generated the conversation UUID and the endpoint used it after an ignore-duplicate
  upsert without explicitly confirming that the existing conversation belonged to the active family and user.
- Resolution: Every conversation ID is re-read through active `family_id` and `user_id` ownership filters before
  history is loaded or messages are persisted. Read failures and missing ownership now stop with stable responses.
- Tests performed: Focused AI chat ownership and database-boundary tests, full Vitest, typecheck, lint, and clean
  production build.
- Evidence: `tests/ai-chat-ownership.test.ts` guards the ownership filters and the no-history/no-message path
  when ownership validation fails.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0278 - Chore state transitions could silently diverge

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Missions / data integrity / rewards
- Feature: Chore proof review, approval, rejection, dispute, and creation flows
- File or files: `app/(app)/missions/actions.ts`, `tests/chore-state-transition-persistence.test.ts`
- Description: Submission, assignment, dispute, and assignment-creation writes were not consistently checked;
  auto-approval and parent approval could leave related rows out of sync after a later write failed.
- Resolution: Checked transition helpers now require updated rows, restore prior submission/assignment state on
  failure, send failed auto-approval to parent review, clean up dispute rows on failed transitions, and remove
  newly created chores when assignment creation fails.
- Tests performed: Focused chore state/proof/reward tests, full Vitest, typecheck, lint, dependency audit, and
  clean production build.
- Evidence: `tests/chore-state-transition-persistence.test.ts` guards transition checks, rollback paths, dispute
  cleanup, and chore creation compensation.
- Verified by: Codex
- Date completed: 2026-07-14

### TODO-0279 - Failed allowance credits could be marked as paid

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / recovery
- Feature: Manual due-allowance execution
- File or files: `app/(app)/wallet/actions.ts`, `tests/wallet-allowance-persistence.test.ts`
- Description: The manual allowance runner ignored rule-read and schedule-write failures, and advanced
  `next_run_on` even when the child-wallet credit failed, potentially skipping an allowance permanently.
- Resolution: Rule reads and schedule advances now fail closed. Each schedule advance is rolled back if its
  wallet credit fails, and the action reports only successfully credited rules and cents.
- Tests performed: Focused wallet allowance/atomic/error-boundary tests, full Vitest, typecheck, lint, dependency
  audit, and clean production build.
- Evidence: `tests/wallet-allowance-persistence.test.ts` guards checked reads, schedule updates, rollback, and
  success counters.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0280 - Allowance cron ignored schedule and credit failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / scheduled automation
- Feature: Cron-driven due allowances
- File or files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Description: The cron ignored its schedule update result and could advance a rule after a failed wallet
  credit, making retries unsafe and hiding persistence failures from monitoring.
- Resolution: The cron now checks the schedule claim before crediting, restores the prior schedule after a
  failed credit, counts only successful credits, and fails visibly when the run cannot persist safely.
- Tests performed: Focused cron allowance persistence contract, full Vitest, typecheck, lint, dependency audit,
  and clean production build.
- Evidence: `tests/cron-wallet-allowance-persistence.test.ts` guards schedule-before-credit ordering, rollback,
  checked failures, and success-only counters.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0281 - Goal funding could debit without updating goal progress

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Wallet / financial data integrity / concurrency / Supabase RPC security
- Feature: Savings goal funding from a child's Save bucket
- File or files: `supabase/migrations/0208_atomic_wallet_goal_funding.sql`, `lib/wallet/server.ts`,
  `app/(app)/wallet/actions.ts`, `tests/wallet-goal-persistence.test.ts`
- Description: The action calculated a Save balance, inserted an immutable debit, and then ignored the goal
  update result. Concurrent funding could also race on the same Save balance.
- Resolution: A manager-checked row-locking RPC now rechecks the Save balance, inserts the debit, updates goal
  progress/status, and writes the audit event in one transaction. The server action uses the typed RPC wrapper.
- Tests performed: Focused goal/atomic wallet persistence contracts, full Vitest, typecheck, lint, dependency
  audit, migration audit, and clean production build.
- Evidence: `tests/wallet-goal-persistence.test.ts` guards authorization, row locks, atomic write ordering,
  and removal of direct best-effort money writes from the action.
- Verified by: Codex
- Date completed: 2026-07-15

### TODO-0288 - Legacy connection adapters reported planned sync as runnable

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Family Connections / third-party integrations / sync correctness
- Feature: Legacy Google Calendar and Gmail adapter registry
- File or files: `lib/connections/adapter.ts`, `lib/connections/adapters/google-calendar.ts`,
  `lib/connections/adapters/gmail.ts`, `lib/connections/adapters/index.ts`, `tests/connections-adapter.test.ts`
- Description: OAuth key presence and a saved connection made planned adapters appear runnable even though
  their provider methods returned empty success without real API I/O.
- Resolution: Added explicit implementation readiness, blocked planned adapters in `planSync`, returned
  unavailable errors from credentialed methods, and filtered `syncableProviderIds()` to implemented adapters.
- Tests performed: 25 focused Connections tests; full 411-file/3,063-test suite; typecheck; lint; dependency
  audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/connections-adapter.test.ts` covers planned-adapter blocking and credentialed failure paths.
- Verified by: Codex
- Commit: `0ae5cdb0`
- Date completed: 2026-07-15
- Remaining dependencies: implement and expose Gmail, banking, grocery, and smart-home provider flows with
  real OAuth, token, retry, callback, and sandbox evidence before advertising them as live integrations.

### TODO-0289 - Provider sync cron returned success after account failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / cron / provider synchronization / observability
- Feature: Scheduled provider synchronization
- File or files: `app/api/cron/provider-sync/route.ts`, `tests/cron-provider-sync.test.ts`
- Description: The cron counted failed account runs but returned HTTP 200 and `ok: true`, which could hide
  provider outages from scheduler monitoring and delay recovery.
- Resolution: Final response status and `ok` now derive from the failure count; any account failure returns
  sanitized HTTP 502 while retaining per-account diagnostic counts and details.
- Tests performed: 7 focused cron/error-boundary tests; full 412-file/3,065-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-provider-sync.test.ts` guards non-2xx failure status and raw-error sanitization.
- Verified by: Codex
- Commit: `24e0b64d`
- Date completed: 2026-07-15
- Remaining dependencies: authenticated provider failure/retry drill, alert routing, and remote cron deployment verification.

### TODO-0290 - Batch crons hid partial failures behind success responses

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Scheduled automation / reliability / observability
- Feature: Calendar-feed, Autopilot, model-refresh, and auction-settlement crons
- File or files: `app/api/cron/calendar-feeds/route.ts`, `app/api/cron/autopilot-scan/route.ts`,
  `app/api/cron/model-refresh/route.ts`, `app/api/cron/close-auctions/route.ts`,
  `tests/cron-batch-failure-status.test.ts`
- Description: Several batch routes returned success after per-item failures, and auction RPC failures were
  not included in the response summary.
- Resolution: Failure counters now drive `ok` and HTTP status; partial failures return sanitized HTTP 502 and
  auction settlement failures are counted for retry/monitoring visibility.
- Tests performed: 11 focused cron/error-boundary tests; full 413-file/3,069-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-batch-failure-status.test.ts` guards all four route contracts.
- Verified by: Codex
- Commit: `f8226011` (published in merge `59c422ac`)
- Date completed: 2026-07-15
- Remaining dependencies: isolated live failure drills, retry behavior, alert routing, and remote deployment verification.

### TODO-0291 - Notification delivery crons hid push and generation failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / push delivery / cron observability
- Feature: Daily notification and frequent push-scan jobs
- File or files: `app/api/cron/notifications/route.ts`, `app/api/cron/push-scan/route.ts`,
  `tests/cron-notification-failure-status.test.ts`
- Description: Per-family notification generation errors and push delivery failures were logged but did not
  change the cron response status, allowing a push outage to look healthy.
- Resolution: Generation, dispatch, and push-result failures now roll into a sanitized failure count; non-zero
  failures return `ok: false` with HTTP 502.
- Tests performed: 13 focused cron/error-boundary tests; full 414-file/3,071-test suite; typecheck; lint;
  dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/cron-notification-failure-status.test.ts` guards both notification routes.
- Verified by: Codex
- Commit: `92eb434a`
- Date completed: 2026-07-15
- Remaining dependencies: run live push/email failure drills and verify alert routing/deployment.

### TODO-0292 - Notification email delivery hid provider and persistence failures

- Status: [x] Completed in code and covered by regression tests.
- Severity: P1
- Category: Notifications / email delivery / Supabase persistence / cron observability
- Feature: Per-recipient notification email digests
- File or files: `lib/server/notification-emails.ts`, `app/api/cron/notifications/route.ts`,
  `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`
- Description: The helper ignored Supabase read/update errors and returned only a sent count, so provider
  failures and unresolved `sent_at` writes were invisible to the notification cron.
- Resolution: Added a sent/failed/skipped result, checked pending/prefs/recipient/resolve boundaries, left
  failed sends retryable, and included email failures in the cron's HTTP 502 status.
- Tests performed: 9 focused notification/error-boundary tests; full 415-file/3,073-test suite; typecheck;
  lint; dependency audit; migration audit; diff check; and clean 250-route production build.
- Evidence: `tests/notification-email-boundary.test.ts` guards helper results and route consumption.
- Verified by: Codex
- Commit: `a704a41f`
- Date completed: 2026-07-15
- Remaining dependencies: live Resend failure/duplicate/retry drills, alert routing, and remote cron deployment verification.
