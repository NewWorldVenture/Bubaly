# FamilyOS â€” Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-16 11:05:00 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `f86dd8a2` makes Marketplace Live Auctions fail closed on listing read failures after `2b06e789` repaired Referrals; live provider and deployment evidence remains open
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

#### TODO-0391 - Live Auctions hid listing read failures as an empty marketplace

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Marketplace / auction discovery / Supabase read boundary
- Feature: Live Auctions
- Route: `/marketplace/auctions`
- File or files: `app/(app)/marketplace/auctions/page.tsx`, `tests/marketplace-auctions-read-boundary.test.ts`
- Database objects: `marketplace_listings`
- Affected roles: authenticated family members with marketplace reachability
- Scenario: the auction listing query could fail while the route rendered zero stats and a healthy empty state.
- Launch impact: buyers could miss available auctions and interpret a marketplace outage as no inventory.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required listing read.
- Required remediation: preserve the query error and render a retryable page-level failure before deriving stats or the empty board.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Live Auctions boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (497 files/3,257 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `f86dd8a2`; local branch pushed; known build warnings remain; live Auth, RLS, browser, payment, and deployment evidence remain open.
- Resolution: Live Auctions no longer presents a fabricated empty marketplace after a failed listing read.
- Remaining dependencies: verify authenticated reachability, marketplace RLS, and deployed retry behavior; continue the buyer/seller workflow audit.

#### TODO-0390 - Referrals hid settings and activity read failures as defaults or no activity

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing referrals / Supabase read boundary
- Feature: Referrals
- Route: `/admin/marketing/referrals`
- File or files: `app/(app)/admin/marketing/referrals/page.tsx`, `lib/referrals/server.ts`, `tests/admin-referrals-read-boundary.test.ts`
- Database objects: `marketing_settings`, `referrals`
- Affected roles: Super Admin
- Scenario: settings failures fell back to defaults and referral activity failures rendered no rows while metrics and settings remained actionable.
- Launch impact: operators could change or interpret the referral program against incomplete state.
- Root cause: both the shared settings helper and the admin activity query discarded read errors.
- Required remediation: preserve both read statuses and render a retryable page-level failure before metrics, settings, or rows.
- Implementation notes: added `getReferralConfigResult` and coordinated settings/activity reads in the admin page.
- Test plan: focused Referrals boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (496 files/3,256 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `2b06e789`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Admin Referrals no longer presents defaults or no activity after a failed settings/activity read.
- Remaining dependencies: verify live Super Admin permissions and deployed referral behavior; continue the marketing workflow audit.

#### TODO-0389 - New Campaign hid segment read failures as an unfiltered audience selector

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / marketing campaigns / Supabase read boundary
- Feature: New Campaign
- Route: `/admin/marketing/campaigns/new`
- File or files: `app/(app)/admin/marketing/campaigns/new/page.tsx`, `tests/admin-campaign-new-read-boundary.test.ts`
- Database objects: `marketing_segments`
- Affected roles: Super Admin
- Scenario: the segment query could fail while the form rendered a â€œNo segmentâ€ fallback and allowed an unfiltered campaign.
- Launch impact: operators could create campaigns without intended audience targeting after a silent backend failure.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required campaign dependency.
- Required remediation: preserve the query error and render a retryable page-level failure before rendering the campaign form.
- Implementation notes: added a ReadFailure state, refresh links, and explicit error logging.
- Test plan: focused New Campaign boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (495 files/3,255 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `d600ad7c`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: New Campaign no longer silently permits an unfiltered audience after a failed segment read.
- Remaining dependencies: verify live Super Admin permissions and deployed campaign-segment behavior; continue the marketing workflow audit.

#### TODO-0388 - Social Providers hid provider-catalog read failures as enabled defaults

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / social integrations / Supabase read boundary
- Feature: Social Providers
- Route: `/admin/social/providers`
- File or files: `app/(app)/admin/social/providers/page.tsx`, `tests/admin-social-providers-read-boundary.test.ts`
- Database objects: `social_providers`
- Affected roles: Super Admin
- Scenario: the provider catalog query could fail while capability cards defaulted every provider to enabled.
- Launch impact: operators could interpret an unavailable catalog as a healthy provider configuration.
- Root cause: the route discarded the Supabase error object and defaulted the enabled map from an empty array.
- Required remediation: preserve the query error and render a retryable page-level failure before building capability cards.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Social Providers boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (494 files/3,254 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `51423350`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Social Providers no longer presents enabled defaults after a failed provider-catalog read.
- Remaining dependencies: verify live Super Admin permissions and deployed provider-catalog behavior; continue the integration audit.

#### TODO-0387 - Admin Settings hid administrator-count read failures as zero access holders

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / system settings / Supabase read boundary
- Feature: Admin Settings
- Route: `/admin/settings`
- File or files: `app/(app)/admin/settings/page.tsx`, `tests/admin-settings-read-boundary.test.ts`
- Database objects: `super_admins`
- Affected roles: Super Admin
- Scenario: the administrator-count query could fail while the page rendered zero access holders and system status as readable.
- Launch impact: operators could mistake an authorization backend outage for an empty administrator roster.
- Root cause: the route discarded the Supabase error object and used a zero fallback for a required access read.
- Required remediation: preserve the query error and render a retryable page-level failure before building system status.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Admin Settings boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (493 files/3,253 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `0f91564a`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Admin Settings no longer presents zero access holders after a failed `super_admins` read.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the authorization workflow audit.

#### TODO-0386 - Admin Management hid administrator read failures as zero admins

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / authorization management / Supabase read boundary
- Feature: Admin Management
- Route: `/admin/admins`
- File or files: `app/(app)/admin/admins/page.tsx`, `tests/admin-admins-read-boundary.test.ts`
- Database objects: `admin_users`
- Affected roles: Super Admin
- Scenario: the administrator query could fail while the page rendered zero admins and retained access-management controls.
- Launch impact: operators could mistake an authorization backend outage for no administrators and make unsafe access decisions.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required access read.
- Required remediation: preserve the query error and render a retryable page-level failure before calculating access metrics or controls.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Admin Management boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (492 files/3,252 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `b465cf71`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Admin Management no longer presents zero administrators after a failed `admin_users` read.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the authorization workflow audit.

#### TODO-0385 - Social Usage hid usage-event read failures as an empty meter

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / social operations / Supabase read boundary
- Feature: Social Usage
- Route: `/admin/social/usage`
- File or files: `app/(app)/admin/social/usage/page.tsx`, `tests/admin-social-usage-read-boundary.test.ts`
- Database objects: `social_usage_events`
- Affected roles: Super Admin
- Scenario: the usage-event query could fail while the page rendered no metering activity and a healthy empty state.
- Launch impact: operators could mistake a usage-data outage for no activity and lose visibility into metered social operations.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required operational read.
- Required remediation: preserve the query error and render a retryable page-level failure before calculating totals or the empty state.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Social Usage boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (491 files/3,251 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `ee26e70c`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Social Usage no longer presents a fabricated empty meter after a failed usage-event read.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the admin workflow and social audit.

#### TODO-0384 - Social Audit hid audit-log read failures as an empty history

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Super Admin / social operations / Supabase read boundary
- Feature: Social Audit
- Route: `/admin/social/audit`
- File or files: `app/(app)/admin/social/audit/page.tsx`, `tests/admin-social-audit-read-boundary.test.ts`
- Database objects: `social_audit_logs`
- Affected roles: Super Admin
- Scenario: the audit-log query could fail while the page rendered no audit entries, masking an unavailable operational history.
- Launch impact: operators could mistake an audit backend outage for an empty history and lose confidence in mutation traceability.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required audit read.
- Required remediation: preserve the query error and render a retryable page-level failure before the empty state or rows.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Social Audit boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (490 files/3,250 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `80a790c6`; local branch pushed; known build warnings remain; live Auth, permissions, browser, and deployment evidence remain open.
- Resolution: Social Audit no longer presents a fabricated empty history after a failed audit-log read.
- Remaining dependencies: verify live Super Admin permissions and deployed retry behavior; continue the admin workflow and social audit.

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

#### TODO-0381 - Competitive Intelligence hid CRUD read failures …132650 tokens truncated…d leave orphan posts, and provider exceptions could expose raw details.
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
