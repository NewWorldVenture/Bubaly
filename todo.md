# FamilyOS â€” Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-15 17:27:51 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `2a86d411` adds weather and packing read safety after the Emergency Summary, shared vacation CRUD, Trip Itinerary, Trip Overview, Vacation Reports, the Connections hub, Sync conflict/account routes, family Sync hub, Admin Users, Social, Security/Auth Admin, command-center, and Sync admin repairs; live provider and deployment evidence remains open
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

#### TODO-0351 - Weather and packing views hid failed trip dependencies as empty plans

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation weather and packing / Supabase failure handling
- Feature: Trip Weather and Trip Packing
- Route: `/dashboard/vacations/[id]/weather`, `/dashboard/vacations/[id]/packing`
- File or files: `components/vacations/trip-weather.tsx`, `components/vacations/trip-packing.tsx`, `tests/trip-weather-packing-boundary.test.ts`
- Database objects: `vacations`, `vacation_weather_snapshots`, `vacation_packing_lists`, `vacation_packing_items`, and `vacation_activities`
- Affected roles: authenticated family members and household trip planners
- Scenario: weather, packing, or activity dependency reads could fail while pages rendered no forecast or no packing items.
- Launch impact: travelers could plan without current weather or lose visibility into a partially unavailable packing plan.
- Root cause: both views used fallback arrays while ignoring secondary query loading and errors.
- Required remediation: track every required dependency read, wait for complete data, and render sanitized retry states before empty-state UI.
- Implementation notes: Weather now validates trip and snapshot reads; Packing validates all five trip, list, item, weather, and activity reads and retries them together.
- Test plan: focused weather/packing boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/trip-weather-packing-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 469 files/3,222 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `2a86d411`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0350 - Emergency summary hid contact and medical read failures as no emergency data

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation safety / Supabase failure handling
- Feature: Trip Emergency Summary
- Route: `/dashboard/vacations/[id]/emergency`
- File or files: `components/vacations/trip-emergency.tsx`, `tests/trip-emergency-boundary.test.ts`
- Database objects: `vacation_emergency_contacts` and `vacation_medical_information`
- Affected roles: authenticated family members and household trip planners
- Scenario: contact or medical reads could fail while the emergency summary returned null, indistinguishable from having no safety information.
- Launch impact: travelers could miss emergency contacts or medical details during a time-sensitive situation.
- Root cause: the summary checked only array lengths and ignored both query loading and error state.
- Required remediation: track both safety reads, distinguish loading from empty, and render a sanitized retry state before returning no summary.
- Implementation notes: Emergency Summary now waits for both reads and retries them together when either fails.
- Test plan: focused emergency boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/trip-emergency-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 468 files/3,220 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `da83e4b`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0349 - Vacation CRUD and budget views hid failed financial and trip-detail reads

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation CRUD and budget / Supabase failure handling
- Feature: Vacation shared CRUD sections and Trip Budget
- Route: `/dashboard/vacations/[id]/budget` plus shared lodging, travel, activity, document, family, and emergency sections
- File or files: `components/vacations/shared.tsx`, `components/vacations/trip-budget.tsx`, `tests/vacation-crud-read-boundary.test.ts`
- Database objects: family-scoped vacation child tables, `vacation_budgets`, and `vacation_expenses`
- Affected roles: authenticated family members and household trip planners
- Scenario: shared CRUD list reads or budget/expense reads could fail while sections rendered empty lists or zero financial totals.
- Launch impact: families could miss trip records or make budget decisions from incomplete data.
- Root cause: `TripCrudSection` ignored read errors, and Trip Budget did not track loading or errors for its summary queries.
- Required remediation: surface retryable errors in the shared CRUD primitive and fail closed on both budget summary reads.
- Implementation notes: shared vacation CRUD sections now show sanitized retry states; Trip Budget waits for both reads and retries them together.
- Test plan: focused CRUD/budget boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/vacation-crud-read-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 467 files/3,218 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `3adef7e6`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0348 - Trip itinerary hid failed day and item reads as an empty schedule

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation itinerary / Supabase failure handling
- Feature: Trip Itinerary
- Route: `/dashboard/vacations/[id]/itinerary`
- File or files: `components/vacations/trip-itinerary.tsx`, `tests/trip-itinerary-boundary.test.ts`
- Database objects: `vacations`, `vacation_itinerary_days`, and `vacation_itinerary_items`
- Affected roles: authenticated family members and household trip planners
- Scenario: trip, day, or itinerary-item reads could fail while the page rendered no days planned or an incomplete schedule.
- Launch impact: families could miss planned activities or incorrectly rebuild an itinerary from incomplete data.
- Root cause: only the itinerary days query exposed loading state; trip and item read failures were ignored.
- Required remediation: track all three required reads, wait for complete data, and render a sanitized retry state before showing an empty schedule.
- Implementation notes: Trip Itinerary now fails closed on any required read failure and retries all three reads together.
- Test plan: focused itinerary boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/trip-itinerary-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 466 files/3,216 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `7e6ce831`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0347 - Trip overview hid incomplete readiness and itinerary reads

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation overview / Supabase failure handling
- Feature: Trip Overview
- Route: `/dashboard/vacations/[id]/overview`
- File or files: `components/vacations/trip-overview.tsx`, `tests/trip-overview-boundary.test.ts`
- Database objects: `vacations`, `vacation_members`, `vacation_lodging`, `vacation_flights`, `vacation_transportation`, `vacation_activities`, `vacation_reservations`, `vacation_budgets`, `vacation_expenses`, `vacation_packing_items`, `vacation_documents`, `vacation_emergency_contacts`, `vacation_itinerary_days`, `vacation_itinerary_items`, `vacation_weather_snapshots`, and `vacation_ai_recommendations`
- Affected roles: authenticated family members and household trip planners
- Scenario: any secondary overview read could fail while readiness, budget, transport, weather, or recommendation summaries rendered from partial arrays.
- Launch impact: families could treat an incomplete trip overview as current and act on an inaccurate readiness score or financial summary.
- Root cause: only the trip query exposed loading state; the other 16 required reads ignored loading and error state.
- Required remediation: centralize all overview query handles, wait for every required result, and render a sanitized retry state before deriving summary data.
- Implementation notes: Trip Overview now fails closed on any required read failure and retries all overview reads together.
- Test plan: focused trip overview boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/trip-overview-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 465 files/3,214 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `f36ea6c5`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0346 - Vacation reports hid incomplete financial and travel-score reads

- Status: `[~]` In progress
- Severity: P1
- Category: Vacation reporting / Supabase failure handling
- Feature: Vacation Reports
- Route: `/dashboard/vacations/reports`
- File or files: `components/vacations/vacations-reports.tsx`, `tests/vacations-reports-boundary.test.ts`
- Database objects: `vacations`, `vacation_expenses`, `vacation_budgets`, and `vacation_travel_scores`
- Affected roles: authenticated family members and household trip planners
- Scenario: expense, budget, or travel-score reads could fail while the report rendered trip counts and partial financial totals as if complete.
- Launch impact: families could make travel budget decisions from incomplete or stale report data.
- Root cause: only the trips query exposed loading state; secondary report reads ignored their loading and error contracts.
- Required remediation: track all report reads, wait for every required result, and render a sanitized retry state before calculating totals or charts.
- Implementation notes: Vacation Reports now fails closed on any required read failure and retries all four reads together.
- Test plan: focused vacation report boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/vacations-reports-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 464 files/3,212 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `194e4ecb`; documentation and remote publication remain pending for this increment.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

### Active audit issue

#### TODO-0345 - Connections hub hid family connection read failures as disconnected providers

- Status: `[~]` In progress
- Severity: P1
- Category: Family integrations / connections observability / Supabase failure handling
- Feature: Family Connections hub
- Route: `/dashboard/connections`
- File or files: `components/modules/connections-module.tsx`, `tests/connections-ui-boundary.test.ts`
- Database objects: `family_connections`
- Affected roles: authenticated family members and household integration operators
- Scenario: the realtime query could fail while the module rendered every provider as disconnected or showed an empty connection summary.
- Launch impact: families could mistake unavailable connection data for revoked credentials and make incorrect setup decisions.
- Root cause: the module ignored the `useRealtimeQuery` error state even though the hook preserved real read failures.
- Required remediation: surface a sanitized error state and wire retry to the query refresh callback before deriving provider statuses.
- Implementation notes: Connections now renders a retryable failure state when its family-scoped read fails.
- Test plan: focused Connections UI boundary, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/connections-ui-boundary.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 463 files/3,210 tests, 0 production dependency vulnerabilities, and a clean 250-route build.
- Resolution: source repair validated locally in commit `299e2608`; documentation stamp and push pending.
- Remaining dependencies: live provider callbacks, RLS, browser, backup, and deployed verification.

#### TODO-0344 - Sync conflict and account routes hid required read failures

- Status: `[~]` In progress
- Severity: P1
- Category: Family integrations / conflict resolution / Supabase failure handling
- Feature: Family Sync conflicts and connected accounts
- Route: `/dashboard/sync/conflicts`, `/dashboard/sync/accounts`, `/dashboard/sync/accounts/[provider]`
- File or files: `app/(app)/dashboard/sync/conflicts/page.tsx`, `app/(app)/dashboard/sync/accounts/page.tsx`, `app/(app)/dashboard/sync/accounts/[provider]/page.tsx`, `tests/sync-route-read-boundaries.test.ts`
- Database objects: `sync_conflicts` and `sync_accounts`
- Affected roles: authenticated family members and household integration operators
- Scenario: conflict or connected-account reads could fail while the UI rendered â€œNo open conflictsâ€ or â€œNot connectedâ€.
- Launch impact: families could miss records requiring manual resolution or believe provider credentials were absent when data was unavailable.
- Root cause: query errors were discarded before empty-state and provider-status rendering.
- Required remediation: preserve read errors, log diagnostics server-side, and render sanitized retry states before showing conflict or account status.
- Implementation notes: all three routes now fail visibly with route-specific retry links.
- Test plan: focused Sync route-boundary contract, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/sync-route-read-boundaries.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 463 files/3,209 tests, 0 production dependency vulnerabilities, and a 250-route build.
- Resolution: source repair validated locally in commit `ec14b828`; documentation stamp and push pending.
- Remaining dependencies: provider callbacks, conflict-resolution actions, RLS, browser, backup, and deployed verification.

#### TODO-0343 - Family Sync showed zero health and history after required reads failed

- Status: `[~]` In progress
- Severity: P1
- Category: Family integrations / sync observability / Supabase failure handling
- Feature: Family Sync hub and history
- Route: `/dashboard/sync`, `/dashboard/sync/history`
- File or files: `app/(app)/dashboard/sync/page.tsx`, `app/(app)/dashboard/sync/history/page.tsx`, `tests/sync-read-boundary.test.ts`
- Database objects: `sync_connections`, `sync_calendars`, `sync_conflicts`, `sync_job_runs`, and `sync_audit_logs`
- Affected roles: authenticated family members and household integration operators
- Scenario: connection, calendar, conflict, run, or audit-history reads could fail while the pages rendered zero health metrics or â€œno runsâ€ empty states.
- Launch impact: families could miss provider outages, open conflicts, or failed synchronization and assume their data was current.
- Root cause: query results were used without checking their error fields.
- Required remediation: check all required reads, log diagnostics server-side, and render sanitized retry states before deriving health or history data.
- Implementation notes: the Sync hub and history page now fail visibly with route-specific retry links.
- Test plan: focused Sync read-boundary contract, full Vitest, typecheck, lint, dependency audit, production build, migration/schema probes, and diff check.
- Tests performed: `tests/sync-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Evidence: full local gate passed with 462 files/3,208 tests, 0 production dependency vulnerabilities, and a 250-route build.
- Resolution: source repair validated locally in commit `91394c90`; documentation stamp and push pending.
- Remaining dependencies: provider callbacks, retry/conflict drills, RLS, browser, backup, and deployed verification.

#### TODO-0342 - Admin Users rendered partial access data after required reads failed

- Status: `[~]` In progress
- Severity: P1
- Category: Admin access management / Supabase failure handling
- Feature: Super Admin Users & Families
- Route: `/admin/us…112829 tokens truncated…d leave orphan posts, and provider exceptions could expose raw details.
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

