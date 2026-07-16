# FamilyOS — Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-16 11:50:00 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `ae763b67` makes Contact Timeline fail closed on contact and relationship-history read failures after `f04895cd` repaired Autonomous Family Management; live provider and deployment evidence remains open
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

#### TODO-0397 - Contact Timeline hid contact, interaction, and communication read failures as missing history

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / Contacts / Supabase read boundary
- Feature: Contact Timeline
- Route: `/dashboard/contacts/[id]`
- File or files: `app/(app)/dashboard/contacts/[id]/page.tsx`, `tests/contact-timeline-read-boundary.test.ts`
- Database objects: `family_contacts`, `contact_interactions`, `family_communications`
- Affected roles: authenticated family members with family-scoped contact access
- Scenario: contact lookup failures could look like a missing contact, while interaction or communication failures rendered an empty relationship history.
- Launch impact: families could miss relationship context and interpret an incomplete contact record as healthy.
- Root cause: the route discarded the contact error and ignored returned errors from both timeline data sources.
- Required remediation: preserve all three read errors and render a retryable page-level failure before building relationship health or timeline views.
- Implementation notes: added a route-level ReadFailure state, checked contact/interactions/communications results, and added a focused regression test.
- Test plan: focused Contact Timeline boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (503 files/3,263 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `ae763b67`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Contact Timeline no longer presents a missing contact or empty history after a failed required read.
- Remaining dependencies: verify authenticated family RLS, contact ownership, communication availability, and deployed retry behavior; continue the dashboard audit.

#### TODO-0396 - Autonomous Family Management hid signal and automation read failures as healthy defaults

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / Autonomous Family Management / Supabase read boundary
- Feature: Autonomous Family Management
- Route: `/dashboard/autonomous-family-management`
- File or files: `app/(app)/dashboard/autonomous-family-management/page.tsx`, `lib/family/signals.ts`, `tests/autonomous-family-management-read-boundary.test.ts`
- Database objects: `calendar_events`, `appointments`, `chore_assignments`, `bills`, `school_events`, `sports_events`, `family_routines`, `meal_plans`, `grocery_items`, `family_ai_recommendations`, `family_automation_rules`, `family_automation_runs`
- Affected roles: authenticated family members; manager-only approval controls
- Scenario: required signal, recommendation, rule, and automation-run reads could fail while the dashboard rendered healthy monitoring, zero metrics, or incomplete approvals.
- Launch impact: families could miss risk signals or act on an incomplete automation queue while the assistant appeared healthy.
- Root cause: the shared signal collector converted failed reads to empty-derived counts, and the page discarded errors from its recommendation and automation queries.
- Required remediation: preserve all required read errors and render a retryable page-level failure before deriving monitoring, recommendations, risk metrics, or approval controls.
- Implementation notes: added `gatherSignalsResult`, fail-closed compatibility for existing callers, coordinated page-level error handling, and a focused regression test.
- Test plan: focused Autonomous Family Management boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (502 files/3,262 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `f04895cd`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Autonomous Family Management no longer presents healthy defaults after a failed required signal or automation read.
- Remaining dependencies: verify authenticated family RLS, signal availability, approval behavior, and deployed retry behavior; continue the dashboard audit.

#### TODO-0395 - Family Assistant hid context and count failures as zero signals

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / Family Assistant / Supabase read boundary
- Feature: Family Assistant
- Route: `/dashboard/agents`
- File or files: `app/(app)/dashboard/agents/page.tsx`, `tests/dashboard-agents-read-boundary.test.ts`
- Database objects: `calendar_events`, `meal_plans`, `family_members`, `agent_activity`, `grocery_items`, `bills`, `subscriptions_tracked`, `chore_assignments`, `documents`, `maintenance_tasks`, `vacations`, `approval_requests`, `family_photos`
- Affected roles: authenticated family members
- Scenario: required context and count queries could fail while agent briefings rendered zero-valued signals and activity.
- Launch impact: families could miss bills, chores, trips, approvals, memories, or schedule conflicts while the assistant appeared healthy.
- Root cause: count helper converted every error to zero and array reads were rendered from empty fallbacks without checking errors.
- Required remediation: preserve all required errors and render a retryable page-level failure before running agent reasoning.
- Implementation notes: changed count results to `{ value, error }`, checked the complete read batch, and added a ReadFailure state.
- Test plan: focused Family Assistant boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (501 files/3,261 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `d43b15c4`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Family Assistant no longer derives zero-valued briefings after a failed required read.
- Remaining dependencies: verify authenticated family RLS, agent context/reasoning, and deployed retry behavior; continue the dashboard audit.

#### TODO-0394 - Family Intelligence hid signal read failures as an empty intelligence screen

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / family intelligence / Supabase read boundary
- Feature: Family Intelligence
- Route: `/dashboard/family-signals`
- File or files: `app/(app)/dashboard/family-signals/page.tsx`, `tests/family-signals-read-boundary.test.ts`
- Database objects: `family_signals`
- Affected roles: authenticated family members
- Scenario: the family-signal query could fail while the page rendered no active or hidden signals.
- Launch impact: families could miss important intelligence while the dashboard appeared healthy and empty.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required family read.
- Required remediation: preserve the query error and render a retryable page-level failure before deriving signal views.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Family Intelligence boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (500 files/3,260 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `384acfbd`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Family Intelligence no longer presents a fabricated empty screen after a failed signal read.
- Remaining dependencies: verify authenticated family RLS, signal availability, and deployed retry behavior; continue the dashboard audit.

#### TODO-0393 - Deals hid listing read failures as no standout deals

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Marketplace / deal discovery / Supabase read boundary
- Feature: Deals
- Route: `/marketplace/deals`
- File or files: `app/(app)/marketplace/deals/page.tsx`, `tests/marketplace-deals-read-boundary.test.ts`
- Database objects: `marketplace_listings`
- Affected roles: authenticated family members with marketplace reachability
- Scenario: the listing query could fail while the route rendered no standout deals and skipped comparable-price analysis.
- Launch impact: buyers could miss discounted inventory while the page appeared healthy and empty.
- Root cause: the route discarded the Supabase error object and used an empty fallback for a required listing feed.
- Required remediation: preserve the query error and render a retryable page-level failure before building price bands or the empty state.
- Implementation notes: added a ReadFailure state, refresh link, and explicit error logging.
- Test plan: focused Deals boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (499 files/3,259 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `071bfd7c`; local branch pushed; known build warnings remain; live Auth, RLS, browser, payment, and deployment evidence remain open.
- Resolution: Deals no longer presents a fabricated empty feed after a failed listing read.
- Remaining dependencies: verify authenticated reachability, price-coach data, and deployed retry behavior; continue the Marketplace audit.

#### TODO-0392 - Selling hid listing and seller-signal read failures as zero activity

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Marketplace / seller cockpit / Supabase read boundary
- Feature: Selling
- Route: `/marketplace/selling`
- File or files: `app/(app)/marketplace/selling/page.tsx`, `tests/marketplace-selling-read-boundary.test.ts`
- Database objects: `marketplace_listings`, `marketplace_saves`, `marketplace_offers`, `marketplace_negotiations`, `marketplace_questions`, `marketplace_handoffs`, `marketplace_orders`
- Affected roles: authenticated seller family members
- Scenario: any required listing or seller-signal read could fail while the cockpit showed zero listings or activity.
- Launch impact: sellers could miss offers, questions, handoffs, bids, or overdue returns while the page appeared healthy.
- Root cause: the route discarded all query errors and derived rankings from empty fallbacks.
- Required remediation: preserve the listing and signal results, fail visibly on any required error, and only derive seller signals after a successful batch.
- Implementation notes: coordinated the listing and six dependent signal reads and added a ReadFailure state.
- Test plan: focused Selling boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (498 files/3,258 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `db158e01`; local branch pushed; known build warnings remain; live Auth, RLS, browser, payment, and deployment evidence remain open.
- Resolution: Selling no longer presents zero seller activity after a failed listing or signal read.
- Remaining dependencies: verify authenticated seller RLS, buyer/seller workflows, and deployed retry behavior; continue the Marketplace audit.

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
- Implementation notes: added a R��z��h��춻�q�^u[��H�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��X�][ۈRH�]H[�Yܚ]H�]]ܚ^�][ۂ�H�X]\�N�RH�X�][ۈ�Z[\��X��[Y[�][ۜ�[��ۘ�Y\��H�۝�\��][ۜH�[H܈�[\Έ\�\KݘX�][ۜ��ZKܛ�]K��\��ݘX�][ۋXZK\\��\�[��KX��[�\�Y\˝\����H\�ܚ\[ێ��\�۝^�XY��X��[Y[�][ۈ�\X�[Y[�ܚ]\��[�\�]Y][�\�\�K�X�]�]K؝Y�]X��[��ܚ]\�[��]Y\��Y�Hܚ]\�YۛܙY�]\��Y]X�\�H\��ܜˈ^\�[���۝�\��][ۈQ��\�B�[��X��\Y�]�]�ۙ�\�Z[��^H�[ۙ�Y�HX�]�H�[Z[H[��X�][ۋ��H�\��][ێ��۝^[�]]][ۈ\��ܜ�����Z[���Y�]�X�H�\�ۜ�\���[�\�]Y����\�H�X��Y�[���\[��]Yۈ�Z[\�K^\�[���Y�]�\�H�\�ܙY�[��YYY[��۝�\��][ۈ�ۙ\��\\�X��Y�Y�ܙHY\��Y�\�\�H\��\�Y��H\��\��ܛYY����\�Y�X�][ۈRH[�]X�\�KX��[�\�H\���[�]\�\X�X��[�\[�[��B�]Y]ZYܘ][ۈ]Y]]�H��[XH�ؙ\���X�[ۈ�Z[�YY[��\�X[��[�X�X�^]ܚY��^Kݙ\����L�K��H]�Y[��N�\��ݘX�][ۋXZK\\��\�[��KX��[�\�Y\˝\����X\���Z[X���Y�XY��X��Yܚ]\�����X���X��[��[��[Z[KݘX�][ۈ�۝�\��][ۈ���[�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L�͈HRHYX[[��[����[�\X�H���Y�\�H\�X[�]�B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN�RHYX[[��[���]H[�Yܚ]H��X�ݙ\�B�H�X]\�N�ۙKX�X��RHYX[[��\��]YX[[�[��H�۝^�H�[H܈�[\Έ\�\K�ZK�YX[��[�ܛ�]K��\���ZK[YX[\[�\\��\�[��K�\����H\�ܚ\[ێ��[�Y]H[�[��H�XY\��ܜ��\�HYۛܙY\��]Y����\�H[]Y�]�]�X��[����]�HZ\��ܙYYX[���[�[XZ[�ܜ[�Y[�H�Z[Y܈[���\]H[�[��\���[�[X]�HB�[��\��\ܝ[��H�X��\�ٝ[ܚ]K��H�\��][ێ��۝^�XY�[��\X�[Y[�]]][ۜ�����Z[���Y�^\�[��\��]Y���\�H�\\�Y�[��\�ܙYۈ�Z[\�K�[�\�]YYX[����\�H�[[ݙY�[�^H�[����H\�Y[�H�X��\���\�ۜ�B��\]Z\�\�]�\�H[�[\��YۛY[���H\��\�Y��H\��\��ܛYY����\�YRHYX[[��\�[�]X�\�KX��[�\�H\���[�]\�\X�X��[�[��\[�[��H]Y]��H]�Y[��N�\���ZK[YX[\[�\\��\�[��K�\����X\���XY�Z[\�\��[�\�]Y[YX[�X[�\����\�ܘ][ۋ[��X��Y�\X�[Y[�ܚ]\˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L���HRH�]X��\Y[��\�Y�YY�۝�\��][ۈ�ۙ\��\��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[HRH�]]ܚ^�][ۈ��]�X�B�H�X]\�N���X[Z[���[Z[H\��\�[��۝�\��][ۜH�[H܈�[\Έ\�\K�ZK��]ܛ�]K��\���ZKX�][�ۙ\��\�\����H\�ܚ\[ێ�H�Y[��[�\�]YH�۝�\��][ۈURQ[�H[��[�\�Y]Y�\�[�YۛܙKY\X�]B�\�\��]�]^X�]H�ۙ�\�Z[��]H^\�[���۝�\��][ۈ�[ۙ�Y�HX�]�H�[Z[H[�\�\���H�\��][ێ�]�\�H�۝�\��][ۈQ\��K\�XY��Y�X�]�H�[Z[W�Y[�\�\��Y�ۙ\��\�[\���Y�ܙB�\�ܞH\��YY܈Y\��Y�\�\�H\��\�Y��XY�Z[\�\�[�Z\��[���ۙ\��\������]�X�H�\�ۜ�\˂�H\��\��ܛYY����\�YRH�]�ۙ\��\[�]X�\�KX��[�\�H\���[�]\�\X�X��[�[��X[����X�[ۈ�Z[��H]�Y[��N�\���ZKX�][�ۙ\��\�\����X\��H�ۙ\��\�[\��[�H��Z\�ܞKۛ�[Y\��Y�H]��[��ۙ\��\�[Y][ۈ�Z[˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L��H�ܙH�]H�[��][ۜ���[�[[�H]�\��B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[HZ\��[ۜ��]H[�Yܚ]H��]�\�H�X]\�N��ܙH��و�]�Y]�\�ݘ[�Z�X�[ۋ\�]K[�ܙX][ۈ���H�[H܈�[\Έ\�\
K�Z\��[ۜ��X�[ۜ˝�\����ܙK\�]K]�[��][ۋ\\��\�[��K�\����H\�ܚ\[ێ��X�Z\��[ۋ\��YۛY[�\�]K[�\��YۛY[�XܙX][ۈܚ]\��\�H���ۜ�\�[�H�X��Y]]�X\�ݘ[[�\�[�\�ݘ[��[X]�H�[]Y�����]و�[��Y�\�H]\�ܚ]H�Z[Y��H�\��][ێ��X��Y�[��][ۈ[\������\]Z\�H\]Y�����\�ܙH�[܈�X�Z\��[ۋ�\��YۛY[��]Hۂ��Z[\�K�[��Z[Y]]�X\�ݘ[�\�[��]�Y]��X[�\\�]H����ۈ�Z[Y�[��][ۜ�[��[[ݙB��]�HܙX]Y�ܙ\��[�\��YۛY[�ܙX][ۈ�Z[˂�H\��\��ܛYY����\�Y�ܙH�]K���ًܙ]�\�\���[�]\�\X�X��[�\[�[��H]Y][���X[���X�[ۈ�Z[��H]�Y[��N�\����ܙK\�]K]�[��][ۋ\\��\�[��K�\����X\���[��][ۈ�X������X��]�\�]B��X[�\[��ܙHܙX][ۈ��\[��][ۋ��H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L��HH�Z[Y[��[��HܙY]���[�HX\��Y\�ZY��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H��X�ݙ\�B�H�X]\�N�X[�X[YKX[��[��H^X�][ۂ�H�[H܈�[\Έ\�\
K��[]�X�[ۜ˝�\����[]X[��[��K\\��\�[��K�\����H\�ܚ\[ێ�HX[�X[[��[��H�[��\�YۛܙY�[K\�XY[���Y[K]ܚ]H�Z[\�\�[�Y�[��Y��^ܝ[��ۘ]�[��[�H�[]�[]ܙY]�Z[Y�[�X[H��\[��[�[��[��H\�X[�[�K��H�\��][ێ��[H�XY�[���Y[HY�[��\�����Z[���Y�XX���Y[HY�[��H\���Y�X��Y�]�[]ܙY]�Z[�[�HX�[ۈ�\ܝ�ۛH�X��\�ٝ[HܙY]Y�[\�[��[�˂�H\��\��ܛYY����\�Y�[][��[��K�]�ZX��\��܋X��[�\�H\���[�]\�\X�X��[�\[�[��B�]Y][��X[���X�[ۈ�Z[��H]�Y[��N�\����[]X[��[��K\\��\�[��K�\����X\���X��Y�XY���Y[H\]\����X��[���X��\����[�\�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�H[��[��HܛۈYۛܙY��Y[H[�ܙY]�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H���Y[Y]]�X][ۂ�H�X]\�N�ܛۋY�]�[�YH[��[��\H�[H܈�[\Έ\�\K�ܛۋ��[]X[��[��Kܛ�]K��\���ܛۋ]�[]X[��[��K\\��\�[��K�\����H\�ܚ\[ێ�HܛۈYۛܙY]���Y[H\]H�\�[[���[Y�[��HH�[HY�\�H�Z[Y�[]�ܙY]XZ�[���]�Y\�[��Y�H[�Y[��\��\�[��H�Z[\�\����H[ۚ]ܚ[�˂�H�\��][ێ�Hܛۈ����X���H��Y[H�Z[H�Y�ܙHܙY][���\�ܙ\�H�[܈��Y[HY�\�B��Z[YܙY]��[��ۛH�X��\�ٝ[ܙY]�[��Z[��\�X�H�[�H�[��[���\��\��Y�[K��H\��\��ܛYY����\�Yܛۈ[��[��H\��\�[��H�۝�X��[�]\�\X�X��[�\[�[��H]Y]�[��X[���X�[ۈ�Z[��H]�Y[��N�\���ܛۋ]�[]X[��[��K\\��\�[��K�\����X\����Y[KX�Y�ܙKXܙY]ܙ\�[�����X����X��Y�Z[\�\�[��X��\��[ۛH��[�\�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�HH��[�[�[����[X�]�]�]\][����[��ܙ\��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H��ۘ�\��[��H��\X�\�H���X�\�]B�H�X]\�N��]�[�����[�[�[�����HH�[	���]�H�X��]�H�[H܈�[\Έ�\X�\�K�ZYܘ][ۜ����]�ZX���[]���[ٝ[�[�˜�[X���[]��\��\����\�\
K��[]�X�[ۜ˝�\����[]Y��[\\��\�[��K�\����H\�ܚ\[ێ�HX�[ۈ�[�[]YH�]�H�[[��K[��\�Y[�[[]]X�HX�][�[�YۛܙYH��[�\]H�\�[��ۘ�\��[��[�[����[[���X�HۈH�[YH�]�H�[[��K��H�\��][ێ�HX[�Y�\�X�X��Y���[���[��������X�X���H�]�H�[[��K[��\��HX�]\]\���[���ܙ\����]\�[�ܚ]\�H]Y]]�[�[�ۙH�[��X�[ۋ�H�\��\�X�[ۈ\�\�H\Y��ܘ\\���H\��\��ܛYY����\�Y��[�]�ZX��[]\��\�[��H�۝�X���[�]\�\X�X��[�\[�[��B�]Y]ZYܘ][ۈ]Y][��X[���X�[ۈ�Z[��H]�Y[��N�\����[]Y��[\\��\�[��K�\����X\��]]ܚ^�][ۋ�������]�ZX�ܚ]Hܙ\�[���[��[[ݘ[و\�X��\�YY��ܝ[ۙ^Hܚ]\����HHX�[ۋ��H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�HY�X�H�ۛ�X�[ۈY\\���\ܝY[��Y�[��\��[��X�B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�ۛ�X�[ۜ��\�\\�H[�Yܘ][ۜ���[���ܜ�X��\�H�X]\�N�Y�X�H����H�[[�\�[��XZ[Y\\��Y�\��B�H�[H܈�[\ΈX���ۛ�X�[ۜ��Y\\���X���ۛ�X�[ۜ��Y\\�������KX�[[�\����X���ۛ�X�[ۜ��Y\\����XZ[��X���ۛ�X�[ۜ��Y\\���[�^��\����ۛ�X�[ۜ�XY\\��\����H\�ܚ\[ێ��]]�^H�\�[��H[�H�]�Y�ۛ�X�[ۈXYH[��YY\\��\X\��[��X�H]�[��Y��Z\��ݚY\�Y]���]\��Y[\H�X��\���]�]�X[THK�˂�H�\��][ێ�YY^X�][\[Y[�][ۈ�XY[�\������Y[��YY\\��[�[��[���]\��Y�[�]�Z[X�H\��ܜ����HܙY[�X[YY]��[��[\�Y�[��X�T�ݚY\�Y�
X�[\[Y[�YY\\�˂�H\��\��ܛYY��H���\�Y�ۛ�X�[ۜ�\����[LKY�[K����]\��Z]N�\X�X���[��\[�[��B�]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\����ۛ�X�[ۜ�XY\\��\����ݙ\��[��YXY\\�����[��[�ܙY[�X[Y�Z[\�H]˂�H�\�Y�YY�N���^�H��[Z]�YMX���H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ[\[Y[�[�^��H�XZ[�[��[��ܛ��\�K[��X\�Z�YH�ݚY\������]��X[�]]��[��]�K�[�X��[��[���]�Y[��H�Y�ܙHY�\�\�[��[H\�]�H[�Yܘ][ۜ˂�������L�HH�ݚY\��[��ܛۈ�]\��Y�X��\��Y�\�X���[��Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��ܛۈ��ݚY\��[���ۚ^�][ۈ�؜�\��X�[]B�H�X]\�N���Y[Y�ݚY\��[���ۚ^�][ۂ�H�[H܈�[\Έ\�\K�ܛۋ��ݚY\�\�[��ܛ�]K��\���ܛۋ\�ݚY\�\�[�˝\����H\�ܚ\[ێ�Hܛۈ��[�Y�Z[YX���[��[���]�]\��Y�[��Έ�YX�X���[YB��ݚY\��]Y�\����H��Y[\�[ۚ]ܚ[��[�[^H�X�ݙ\�K��H�\��][ێ��[�[�\�ۜ�H�]\�[������\�]�H���HH�Z[\�H��[��[�HX���[��Z[\�H�]\���[�]^�YL��[H�]Z[�[��\�XX���[�XYۛ��X���[��[�]Z[˂�H\��\��ܛYY�����\�Yܛۋ�\��܋X��[�\�H\����[L�Y�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋ\�ݚY\�\�[�˝\����X\���ۋL��Z[\�H�]\�[��]�Y\��܈�[�]^�][ۋ��H�\�Y�YY�N���^�H��[Z]��L���H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ]][�X�]Y�ݚY\��Z[\�Kܙ]�H�[[\���][��[��[[�Hܛۈ\�[Y[��\�Y�X�][ۋ��������L�LH�]�ܛۜ�Y\�X[�Z[\�\��Z[��X��\���\�ۜ�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y[Y]]�X][ۈ��[XX�[]H�؜�\��X�[]B�H�X]\�N��[[�\�Y�YY]]�[�[�[\�Y��\�[�]X�[ۋ\�][Y[�ܛۜH�[H܈�[\Έ\�\K�ܛۋ��[[�\�Y�YY�ܛ�]K��\�\K�ܛۋ�]]�[�\��[�ܛ�]K���\�\K�ܛۋ�[�[\�Y��\�ܛ�]K��\�\K�ܛۋ����KX]X�[ۜ�ܛ�]K���\���ܛۋX�]�Y�Z[\�K\�]\˝\����H\�ܚ\[ێ��]�\�[�]���]\��]\��Y�X��\��Y�\�\�Z][H�Z[\�\�[�]X�[ۈ���Z[\�\��\�B���[��YY[�H�\�ۜ�H�[[X\�K��H�\��][ێ��Z[\�H��[�\������]�H��[��]\��\�X[�Z[\�\��]\���[�]^�YL�[��]X�[ۈ�][Y[��Z[\�\�\�H��[�Y�܈�]�K�[ۚ]ܚ[���\�X�[]K��H\��\��ܛYY�LH���\�Yܛۋ�\��܋X��[�\�H\����[L�Y�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋX�]�Y�Z[\�K\�]\˝\����X\��[��\���]H�۝�X�˂�H�\�Y�YY�N���^�H��[Z]�����LX
X�\�Y[�Y\��HNX���X�
B�H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ\��]Y]�H�Z[\�H�[��]�H�Z]�[܋[\���][��[��[[�H\�[Y[��\�Y�X�][ۋ��������L�LHH��Y�X�][ۈ[]�\�Hܛۜ�Y\�[��[�\�][ۈ�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��\�[]�\�H�ܛۈ؜�\��X�[]B�H�X]\�N�Z[H��Y�X�][ۈ[���\]Y[�\�\��[��؜H�[H܈�[\Έ\�\K�ܛۋۛ�Y�X�][ۜ�ܛ�]K��\�\K�ܛۋ�\�\��[�ܛ�]K���\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����H\�ܚ\[ێ�\�Y�[Z[H��Y�X�][ۈ�[�\�][ۈ\��ܜ�[�\�[]�\�H�Z[\�\��\�H���Y�]Y����[��HHܛۈ�\�ۜ�H�]\�[��[��H\��]Y�H����X[K��H�\��][ێ��[�\�][ۋ\�]�[�\�\�\�[�Z[\�\������[��H�[�]^�Y�Z[\�H��[���ۋ^�\��Z[\�\��]\���Έ�[�X�]L���H\��\��ܛYY�L����\�Yܛۋ�\��܋X��[�\�H\����[MY�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����X\������Y�X�][ۈ��]\˂�H�\�Y�YY�N���^�H��[Z]�L�X��X�H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ�[�]�H\��[XZ[�Z[\�H�[�[��\�Y�H[\���][���\�[Y[���������L�L�H��Y�X�][ۈ[XZ[[]�\�HY�ݚY\�[�\��\�[��H�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��[XZ[[]�\�H��\X�\�H\��\�[��H�ܛۈ؜�\��X�[]B�H�X]\�N�\�\�X�\Y[���Y�X�][ۈ[XZ[Y�\�H�[H܈�[\ΈX���\��\�ۛ�Y�X�][ۋY[XZ[˝�\�\K�ܛۋۛ�Y�X�][ۜ�ܛ�]K���\��ۛ�Y�X�][ۋY[XZ[X��[�\�K�\���\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����H\�ܚ\[ێ�H[\�YۛܙY�\X�\�H�XY�\]H\��ܜ�[��]\��YۛHH�[���[����ݚY\���Z[\�\�[�[��\���Y�[��]ܚ]\��\�H[��\�X�H�H��Y�X�][ۈܛۋ��H�\��][ێ�YYH�[�٘Z[Y���\Y�\�[�X��Y[�[����Y��ܙX�\Y[�ܙ\���H��[�\�Y\�Y���Z[Y�[���]�XX�K[�[��YY[XZ[�Z[\�\�[�Hܛۉ��L��]\˂�H\��\��ܛYY�H���\�Y��Y�X�][ۋ�\��܋X��[�\�H\����[MKY�[K����]\��Z]N�\X�X��[��\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\��ۛ�Y�X�][ۋY[XZ[X��[�\�K�\����X\��[\��\�[�[���]H�ۜ�[\[ۋ��H�\�Y�YY�N���^�H��[Z]�M�MY��H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ]�H�\�[��Z[\�K�\X�]Kܙ]�H�[�[\���][��[��[[�Hܛۈ\�[Y[��\�Y�X�][ۋ�