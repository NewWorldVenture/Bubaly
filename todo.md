# FamilyOS — Roadmap Build TODO

## Production Readiness Audit Control Plane

- Audit started: 2026-07-15 08:04:04 -04:00
- Last updated: 2026-07-18 05:58:00 -04:00
- Repository: NewWorldVenture/FamilyOS
- Branch: `codex/world-class-production`
- Commit: `ab2d2adc` makes Family Assistant reasoning reads fail closed after `e4851253` repaired shared Operating Index and graph loaders; live provider and deployment evidence remains open
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

#### TODO-0406 - Family Assistant hid shared reasoning-context failures by omitting relationship guidance

- Timestamp: 2026-07-18 05:58 America/New_York
- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard intelligence / Family Assistant / Supabase read boundary
- Feature: Family Assistant
- Route: `/dashboard/agents`
- File or files: `app/(app)/dashboard/agents/page.tsx`, `tests/dashboard-agents-read-boundary.test.ts`
- Database objects: shared Operating Index source tables, `family_operating_index`, `graph_entities`, `graph_edges`
- Affected roles: authenticated family members
- Scenario: a shared reasoning-context read failure was converted into an empty relationship-guidance list while primary Family Assistant briefings rendered.
- Launch impact: users could miss relationship-aware guidance without knowing the supporting data was unavailable.
- Root cause: the route used `.catch(() => null)` around `loadFamilyContext`.
- Required remediation: route-level catch must return the existing retryable Family Assistant failure state.
- Implementation notes: replaced the silent fallback with explicit logging and `ReadFailure`; expanded the existing boundary test.
- Test plan: focused Family Assistant boundary suite; constrained-worker full Vitest, typecheck, lint, fresh-directory production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (511 files/3,271 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `ab2d2adc`; local branch pushed; live RLS, browser, and deployment evidence remain open.
- Resolution: Family Assistant no longer presents partial relationship guidance after a failed reasoning read.
- Remaining dependencies: update remaining optional reasoning consumers; verify authenticated RLS and deployed retry behavior; continue the dashboard audit.

#### TODO-0405 - Operating Index and graph loaders converted Supabase read failures into partial household data

- Timestamp: 2026-07-18 05:40 America/New_York
- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard intelligence / shared reasoning / Supabase read boundary
- Feature: Family Operating Index and Knowledge Graph
- Route: `/dashboard/family-operating-index` and shared loaders
- File or files: `lib/operating-index/server.ts`, `lib/reasoning/context.ts`, `app/(app)/dashboard/family-operating-index/page.tsx`, `tests/operating-index-read-boundary.test.ts`
- Database objects: Operating Index source tables, `family_operating_index`, `graph_entities`, `graph_edges`
- Affected roles: authenticated family members using dashboard intelligence
- Scenario: rejected source, snapshot, orchestrator, or graph reads were treated as empty data.
- Launch impact: users could see partial household scores or relationship insights without knowing Supabase data was unavailable.
- Root cause: shared loaders discarded PostgREST errors and returned empty/zero-valued fallbacks.
- Required remediation: preserve loader read errors and return a retryable route failure before showing scores or relationships.
- Implementation notes: added explicit error checks to all Operating Index input/orchestrator/prior-snapshot reads, made graph reads throw on failure, and added route-level error handling plus a focused regression test.
- Test plan: focused shared boundary suite; constrained-worker full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (511 files/3,271 tests); typecheck; lint; clean 250-route build; diff check; live Auth audit.
- Evidence: source repair validated in commit `e4851253`; local branch pushed; live Auth public health passed but Admin users remains HTTP 500; RLS, browser, and deployment evidence remain open.
- Resolution: covered Operating Index and graph paths no longer convert rejected reads into partial dashboard data.
- Remaining dependencies: update optional reasoning consumers with visible failure states; verify authenticated RLS and deployed retry behavior; continue the dashboard audit.

#### TODO-0404 - Command Center hid family and Operating Index read failures as a healthy readiness score

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / command center / Supabase read boundary
- Feature: Family Command Center
- Route: `/dashboard/command-center`
- File or files: `app/(app)/dashboard/command-center/page.tsx`, `tests/command-center-read-boundary.test.ts`
- Database objects: `family_members`, `calendar_events`, `chore_assignments`, `meal_plans`, `documents`, `family_operating_index`
- Affected roles: authenticated family members with the Command Center feature
- Scenario: a source or Operating Index query could fail while the route computed a readiness score and issues from partial data.
- Launch impact: users could receive a reassuring but incomplete household status.
- Root cause: the route discarded primary query errors and assumed `loadOperatingIndex` succeeded.
- Required remediation: preserve all source errors and catch Operating Index load failures before computing derived score, issues, or recap.
- Implementation notes: added route-level ErrorState handling, explicit primary read checks, a try/catch around Operating Index loading, and a focused regression test.
- Test plan: focused Command Center boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (510 files/3,270 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `306aeb17`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Command Center no longer computes readiness from a failed source or Operating Index load.
- Remaining dependencies: verify authenticated family RLS, Operating Index availability, and deployed retry behavior; continue the dashboard audit.

#### TODO-0403 - Dashboard Briefing hid Operating Index snapshot read failures as an empty recap

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / daily briefing / Supabase read boundary
- Feature: Dashboard Briefing
- Route: `/dashboard/briefing`
- File or files: `app/(app)/dashboard/briefing/page.tsx`, `tests/briefing-read-boundary.test.ts`
- Database objects: `family_operating_index`
- Affected roles: authenticated family members
- Scenario: the persisted Operating Index snapshot query could fail while the briefing silently omitted the “since yesterday” recap.
- Launch impact: users could receive an incomplete briefing without knowing the saved trend data was unavailable.
- Root cause: the route discarded the snapshot read error and treated a failed read like an empty history.
- Required remediation: preserve the snapshot error and render a retryable failure before building the briefing recap.
- Implementation notes: added a route-level ErrorState boundary, explicit snapshot error handling, and a focused regression test.
- Test plan: focused Briefing boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (509 files/3,269 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `c56b870e`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Dashboard Briefing no longer silently drops the persisted recap after an Operating Index read failure.
- Remaining dependencies: verify authenticated family RLS, snapshot availability, and deployed retry behavior; continue the dashboard audit.

#### TODO-0402 - Dashboard Activity hid source and chore-enrichment read failures as an incomplete feed

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / activity feed / Supabase read boundary
- Feature: Dashboard Activity
- Route: `/dashboard/activity`
- File or files: `app/(app)/dashboard/activity/page.tsx`, `tests/activity-page-read-boundary.test.ts`
- Database objects: `family_members`, `family_announcements`, `calendar_events`, `chore_assignments`, `family_photos`, `notes`, `grocery_items`, `chores`
- Affected roles: authenticated family members
- Scenario: any activity source or chore-title enrichment query could fail while the route rendered a partial feed.
- Launch impact: users could miss household activity while seeing an apparently healthy timeline.
- Root cause: the route destructured only `data` from parallel responses and discarded all read errors, including the secondary chore lookup.
- Required remediation: preserve every source and enrichment error and render a retryable failure before building feed items.
- Implementation notes: added a route-level ErrorState boundary, explicit source/enrichment error checks, and a focused regression test.
- Test plan: focused Activity page boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (508 files/3,268 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `463c5b60`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Dashboard Activity no longer renders partial data after a failed source or chore-title read.
- Remaining dependencies: verify authenticated family RLS, source availability, and deployed retry behavior; continue the dashboard audit.

#### TODO-0401 - Dashboard Home hid preference read failures as the wrong dashboard

- Status: `[x]` Completed in code, tested, committed, pushed to the audit branch, and published to `main` with remote marker readback.
- Severity: P1
- Category: Dashboard / default view selection / Supabase read boundary
- Feature: Dashboard Home
- Route: `/dashboard` without an explicit `view` query
- File or files: `app/(app)/dashboard/page.tsx`, `tests/dashboard-home-read-boundary.test.ts`
- Database objects: `user_preferences`
- Affected roles: authenticated family members
- Scenario: the saved dashboard preference query could fail while the route silently selected the AI dashboard.
- Launch impact: users could be shown the wrong home experience and lose confidence that their saved preference was honored.
- Root cause: the route discarded the preference read error and treated a failed read as an absent preference.
- Required remediation: preserve the preference error and render a retryable failure before selecting the saved/default dashboard; keep explicit query-based views independent.
- Implementation notes: added a route-level ReadFailure state, checked the preference query error, and added a focused regression test.
- Test plan: focused Dashboard Home boundary suite; full Vitest, typecheck, lint, production build, and diff check.
- Tests performed: focused suite (1 assertion); full Vitest (507 files/3,267 tests); typecheck; lint; clean 250-route build; diff check.
- Evidence: source repair validated in commit `49a5ec33`; local branch pushed; known build warnings remain; live Auth, RLS, browser, and deployment evidence remain open.
- Resolution: Dashboard Home no longer silently selects the wrong view after a failed preference read.
- Remaining dependencies: verify authenticated preference RLS, saved-view persistence, explicit view routing, and deployed retry behavior; continue the dashboard audit.

#### TODO-0400 - Family Operations and Reports hid shared-signal read failures as healthy summaries

- Status: `[x]` Completed in code, tested, committed, and pushed to the audit branch; publication to `main` follows this documentation update.
- Severity: P1
- Category: Dashboard / Family Operations and Reports / Supabase read boundary
- Feature: Family Operations and Family Reports
- Route: `/dashboard/family-operations`, `/family/reports`
- File or files: `app/(app)/dashboard/family-operations/page.tsx`, `app/(app)/family/reports/page.tsx`, `tests/family-summary-read-boundary.test.ts`
- Database objects: shared family signal sources
- Affected roles: authenticated family members
- Scenario: shared signal reads could fail while completion, stress, bills, tasks, and report summaries rendered from an exception or zero-valued fallback.
- Launch impact: families could make decisions from incomplete household summaries while the dashboard appeared healthy.
- Root cause: both routes destructured the throwing compatibility helper without a route-level failure state.
- Required remediation: consume the status-preserving signal result and render retryable page failures before summary metrics.
- Implementation note�����h��춻�q�^w��H�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��X�][ۈRH�]H[�Yܚ]H�]]ܚ^�][ۂ�H�X]\�N�RH�X�][ۈ�Z[\��X��[Y[�][ۜ�[��ۘ�Y\��H�۝�\��][ۜH�[H܈�[\Έ\�\KݘX�][ۜ��ZKܛ�]K��\��ݘX�][ۋXZK\\��\�[��KX��[�\�Y\˝\����H\�ܚ\[ێ��\�۝^�XY��X��[Y[�][ۈ�\X�[Y[�ܚ]\��[�\�]Y][�\�\�K�X�]�]K؝Y�]X��[��ܚ]\�[��]Y\��Y�Hܚ]\�YۛܙY�]\��Y]X�\�H\��ܜˈ^\�[���۝�\��][ۈQ��\�B�[��X��\Y�]�]�ۙ�\�Z[��^H�[ۙ�Y�HX�]�H�[Z[H[��X�][ۋ��H�\��][ێ��۝^[�]]][ۈ\��ܜ�����Z[���Y�]�X�H�\�ۜ�\���[�\�]Y����\�H�X��Y�[���\[��]Yۈ�Z[\�K^\�[���Y�]�\�H�\�ܙY�[��YYY[��۝�\��][ۈ�ۙ\��\\�X��Y�Y�ܙHY\��Y�\�\�H\��\�Y��H\��\��ܛYY����\�Y�X�][ۈRH[�]X�\�KX��[�\�H\���[�]\�\X�X��[�\[�[��B�]Y]ZYܘ][ۈ]Y]]�H��[XH�ؙ\���X�[ۈ�Z[�YY[��\�X[��[�X�X�^]ܚY��^Kݙ\����L�K��H]�Y[��N�\��ݘX�][ۋXZK\\��\�[��KX��[�\�Y\˝\����X\���Z[X���Y�XY��X��Yܚ]\�����X���X��[��[��[Z[KݘX�][ۈ�۝�\��][ۈ���[�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L�͈HRHYX[[��[����[�\X�H���Y�\�H\�X[�]�B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN�RHYX[[��[���]H[�Yܚ]H��X�ݙ\�B�H�X]\�N�ۙKX�X��RHYX[[��\��]YX[[�[��H�۝^�H�[H܈�[\Έ\�\K�ZK�YX[��[�ܛ�]K��\���ZK[YX[\[�\\��\�[��K�\����H\�ܚ\[ێ��[�Y]H[�[��H�XY\��ܜ��\�HYۛܙY\��]Y����\�H[]Y�]�]�X��[����]�HZ\��ܙYYX[���[�[XZ[�ܜ[�Y[�H�Z[Y܈[���\]H[�[��\���[�[X]�HB�[��\��\ܝ[��H�X��\�ٝ[ܚ]K��H�\��][ێ��۝^�XY�[��\X�[Y[�]]][ۜ�����Z[���Y�^\�[��\��]Y���\�H�\\�Y�[��\�ܙYۈ�Z[\�K�[�\�]YYX[����\�H�[[ݙY�[�^H�[����H\�Y[�H�X��\���\�ۜ�B��\]Z\�\�]�\�H[�[\��YۛY[���H\��\�Y��H\��\��ܛYY����\�YRHYX[[��\�[�]X�\�KX��[�\�H\���[�]\�\X�X��[�[��\[�[��H]Y]��H]�Y[��N�\���ZK[YX[\[�\\��\�[��K�\����X\���XY�Z[\�\��[�\�]Y[YX[�X[�\����\�ܘ][ۋ[��X��Y�\X�[Y[�ܚ]\˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L���HRH�]X��\Y[��\�Y�YY�۝�\��][ۈ�ۙ\��\��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[HRH�]]ܚ^�][ۈ��]�X�B�H�X]\�N���X[Z[���[Z[H\��\�[��۝�\��][ۜH�[H܈�[\Έ\�\K�ZK��]ܛ�]K��\���ZKX�][�ۙ\��\�\����H\�ܚ\[ێ�H�Y[��[�\�]YH�۝�\��][ۈURQ[�H[��[�\�Y]Y�\�[�YۛܙKY\X�]B�\�\��]�]^X�]H�ۙ�\�Z[��]H^\�[���۝�\��][ۈ�[ۙ�Y�HX�]�H�[Z[H[�\�\���H�\��][ێ�]�\�H�۝�\��][ۈQ\��K\�XY��Y�X�]�H�[Z[W�Y[�\�\��Y�ۙ\��\�[\���Y�ܙB�\�ܞH\��YY܈Y\��Y�\�\�H\��\�Y��XY�Z[\�\�[�Z\��[���ۙ\��\������]�X�H�\�ۜ�\˂�H\��\��ܛYY����\�YRH�]�ۙ\��\[�]X�\�KX��[�\�H\���[�]\�\X�X��[�[��X[����X�[ۈ�Z[��H]�Y[��N�\���ZKX�][�ۙ\��\�\����X\��H�ۙ\��\�[\��[�H��Z\�ܞKۛ�[Y\��Y�H]��[��ۙ\��\�[Y][ۈ�Z[˂�H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L��H�ܙH�]H�[��][ۜ���[�[[�H]�\��B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[HZ\��[ۜ��]H[�Yܚ]H��]�\�H�X]\�N��ܙH��و�]�Y]�\�ݘ[�Z�X�[ۋ\�]K[�ܙX][ۈ���H�[H܈�[\Έ\�\
K�Z\��[ۜ��X�[ۜ˝�\����ܙK\�]K]�[��][ۋ\\��\�[��K�\����H\�ܚ\[ێ��X�Z\��[ۋ\��YۛY[�\�]K[�\��YۛY[�XܙX][ۈܚ]\��\�H���ۜ�\�[�H�X��Y]]�X\�ݘ[[�\�[�\�ݘ[��[X]�H�[]Y�����]و�[��Y�\�H]\�ܚ]H�Z[Y��H�\��][ێ��X��Y�[��][ۈ[\������\]Z\�H\]Y�����\�ܙH�[܈�X�Z\��[ۋ�\��YۛY[��]Hۂ��Z[\�K�[��Z[Y]]�X\�ݘ[�\�[��]�Y]��X[�\\�]H����ۈ�Z[Y�[��][ۜ�[��[[ݙB��]�HܙX]Y�ܙ\��[�\��YۛY[�ܙX][ۈ�Z[˂�H\��\��ܛYY����\�Y�ܙH�]K���ًܙ]�\�\���[�]\�\X�X��[�\[�[��H]Y][���X[���X�[ۈ�Z[��H]�Y[��N�\����ܙK\�]K]�[��][ۋ\\��\�[��K�\����X\���[��][ۈ�X������X��]�\�]B��X[�\[��ܙHܙX][ۈ��\[��][ۋ��H�\�Y�YY�N���^�H]H��\]Y����L�LM�������L��HH�Z[Y[��[��HܙY]���[�HX\��Y\�ZY��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H��X�ݙ\�B�H�X]\�N�X[�X[YKX[��[��H^X�][ۂ�H�[H܈�[\Έ\�\
K��[]�X�[ۜ˝�\����[]X[��[��K\\��\�[��K�\����H\�ܚ\[ێ�HX[�X[[��[��H�[��\�YۛܙY�[K\�XY[���Y[K]ܚ]H�Z[\�\�[�Y�[��Y��^ܝ[��ۘ]�[��[�H�[]�[]ܙY]�Z[Y�[�X[H��\[��[�[��[��H\�X[�[�K��H�\��][ێ��[H�XY�[���Y[HY�[��\�����Z[���Y�XX���Y[HY�[��H\���Y�X��Y�]�[]ܙY]�Z[�[�HX�[ۈ�\ܝ�ۛH�X��\�ٝ[HܙY]Y�[\�[��[�˂�H\��\��ܛYY����\�Y�[][��[��K�]�ZX��\��܋X��[�\�H\���[�]\�\X�X��[�\[�[��B�]Y][��X[���X�[ۈ�Z[��H]�Y[��N�\����[]X[��[��K\\��\�[��K�\����X\���X��Y�XY���Y[H\]\����X��[���X��\����[�\�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�H[��[��HܛۈYۛܙY��Y[H[�ܙY]�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H���Y[Y]]�X][ۂ�H�X]\�N�ܛۋY�]�[�YH[��[��\H�[H܈�[\Έ\�\K�ܛۋ��[]X[��[��Kܛ�]K��\���ܛۋ]�[]X[��[��K\\��\�[��K�\����H\�ܚ\[ێ�HܛۈYۛܙY]���Y[H\]H�\�[[���[Y�[��HH�[HY�\�H�Z[Y�[]�ܙY]XZ�[���]�Y\�[��Y�H[�Y[��\��\�[��H�Z[\�\����H[ۚ]ܚ[�˂�H�\��][ێ�Hܛۈ����X���H��Y[H�Z[H�Y�ܙHܙY][���\�ܙ\�H�[܈��Y[HY�\�B��Z[YܙY]��[��ۛH�X��\�ٝ[ܙY]�[��Z[��\�X�H�[�H�[��[���\��\��Y�[K��H\��\��ܛYY����\�Yܛۈ[��[��H\��\�[��H�۝�X��[�]\�\X�X��[�\[�[��H]Y]�[��X[���X�[ۈ�Z[��H]�Y[��N�\���ܛۋ]�[]X[��[��K\\��\�[��K�\����X\����Y[KX�Y�ܙKXܙY]ܙ\�[�����X����X��Y�Z[\�\�[��X��\��[ۛH��[�\�˂�H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�HH��[�[�[����[X�]�]�]\][����[��ܙ\��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�[]��[�[��X[]H[�Yܚ]H��ۘ�\��[��H��\X�\�H���X�\�]B�H�X]\�N��]�[�����[�[�[�����HH�[	���]�H�X��]�H�[H܈�[\Έ�\X�\�K�ZYܘ][ۜ����]�ZX���[]���[ٝ[�[�˜�[X���[]��\��\����\�\
K��[]�X�[ۜ˝�\����[]Y��[\\��\�[��K�\����H\�ܚ\[ێ�HX�[ۈ�[�[]YH�]�H�[[��K[��\�Y[�[[]]X�HX�][�[�YۛܙYH��[�\]H�\�[��ۘ�\��[��[�[����[[���X�HۈH�[YH�]�H�[[��K��H�\��][ێ�HX[�Y�\�X�X��Y���[���[��������X�X���H�]�H�[[��K[��\��HX�]\]\���[���ܙ\����]\�[�ܚ]\�H]Y]]�[�[�ۙH�[��X�[ۋ�H�\��\�X�[ۈ\�\�H\Y��ܘ\\���H\��\��ܛYY����\�Y��[�]�ZX��[]\��\�[��H�۝�X���[�]\�\X�X��[�\[�[��B�]Y]ZYܘ][ۈ]Y][��X[���X�[ۈ�Z[��H]�Y[��N�\����[]Y��[\\��\�[��K�\����X\��]]ܚ^�][ۋ�������]�ZX�ܚ]Hܙ\�[���[��[[ݘ[و\�X��\�YY��ܝ[ۙ^Hܚ]\����HHX�[ۋ��H�\�Y�YY�N���^�H]H��\]Y����L�LMB�������L�HY�X�H�ۛ�X�[ۈY\\���\ܝY[��Y�[��\��[��X�B��H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN��[Z[H�ۛ�X�[ۜ��\�\\�H[�Yܘ][ۜ���[���ܜ�X��\�H�X]\�N�Y�X�H����H�[[�\�[��XZ[Y\\��Y�\��B�H�[H܈�[\ΈX���ۛ�X�[ۜ��Y\\���X���ۛ�X�[ۜ��Y\\�������KX�[[�\����X���ۛ�X�[ۜ��Y\\����XZ[��X���ۛ�X�[ۜ��Y\\���[�^��\����ۛ�X�[ۜ�XY\\��\����H\�ܚ\[ێ��]]�^H�\�[��H[�H�]�Y�ۛ�X�[ۈXYH[��YY\\��\X\��[��X�H]�[��Y��Z\��ݚY\�Y]���]\��Y[\H�X��\���]�]�X[THK�˂�H�\��][ێ�YY^X�][\[Y[�][ۈ�XY[�\������Y[��YY\\��[�[��[���]\��Y�[�]�Z[X�H\��ܜ����HܙY[�X[YY]��[��[\�Y�[��X�T�ݚY\�Y�
X�[\[Y[�YY\\�˂�H\��\��ܛYY��H���\�Y�ۛ�X�[ۜ�\����[LKY�[K����]\��Z]N�\X�X���[��\[�[��B�]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\����ۛ�X�[ۜ�XY\\��\����ݙ\��[��YXY\\�����[��[�ܙY[�X[Y�Z[\�H]˂�H�\�Y�YY�N���^�H��[Z]�YMX���H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ[\[Y[�[�^��H�XZ[�[��[��ܛ��\�K[��X\�Z�YH�ݚY\������]��X[�]]��[��]�K�[�X��[��[���]�Y[��H�Y�ܙHY�\�\�[��[H\�]�H[�Yܘ][ۜ˂�������L�HH�ݚY\��[��ܛۈ�]\��Y�X��\��Y�\�X���[��Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��ܛۈ��ݚY\��[���ۚ^�][ۈ�؜�\��X�[]B�H�X]\�N���Y[Y�ݚY\��[���ۚ^�][ۂ�H�[H܈�[\Έ\�\K�ܛۋ��ݚY\�\�[��ܛ�]K��\���ܛۋ\�ݚY\�\�[�˝\����H\�ܚ\[ێ�Hܛۈ��[�Y�Z[YX���[��[���]�]\��Y�[��Έ�YX�X���[YB��ݚY\��]Y�\����H��Y[\�[ۚ]ܚ[��[�[^H�X�ݙ\�K��H�\��][ێ��[�[�\�ۜ�H�]\�[������\�]�H���HH�Z[\�H��[��[�HX���[��Z[\�H�]\���[�]^�YL��[H�]Z[�[��\�XX���[�XYۛ��X���[��[�]Z[˂�H\��\��ܛYY�����\�Yܛۋ�\��܋X��[�\�H\����[L�Y�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋ\�ݚY\�\�[�˝\����X\���ۋL��Z[\�H�]\�[��]�Y\��܈�[�]^�][ۋ��H�\�Y�YY�N���^�H��[Z]��L���H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ]][�X�]Y�ݚY\��Z[\�Kܙ]�H�[[\���][��[��[[�Hܛۈ\�[Y[��\�Y�X�][ۋ��������L�LH�]�ܛۜ�Y\�X[�Z[\�\��Z[��X��\���\�ۜ�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y[Y]]�X][ۈ��[XX�[]H�؜�\��X�[]B�H�X]\�N��[[�\�Y�YY]]�[�[�[\�Y��\�[�]X�[ۋ\�][Y[�ܛۜH�[H܈�[\Έ\�\K�ܛۋ��[[�\�Y�YY�ܛ�]K��\�\K�ܛۋ�]]�[�\��[�ܛ�]K���\�\K�ܛۋ�[�[\�Y��\�ܛ�]K��\�\K�ܛۋ����KX]X�[ۜ�ܛ�]K���\���ܛۋX�]�Y�Z[\�K\�]\˝\����H\�ܚ\[ێ��]�\�[�]���]\��]\��Y�X��\��Y�\�\�Z][H�Z[\�\�[�]X�[ۈ���Z[\�\��\�B���[��YY[�H�\�ۜ�H�[[X\�K��H�\��][ێ��Z[\�H��[�\������]�H��[��]\��\�X[�Z[\�\��]\���[�]^�YL�[��]X�[ۈ�][Y[��Z[\�\�\�H��[�Y�܈�]�K�[ۚ]ܚ[���\�X�[]K��H\��\��ܛYY�LH���\�Yܛۋ�\��܋X��[�\�H\����[L�Y�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋX�]�Y�Z[\�K\�]\˝\����X\��[��\���]H�۝�X�˂�H�\�Y�YY�N���^�H��[Z]�����LX
X�\�Y[�Y\��HNX���X�
B�H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ\��]Y]�H�Z[\�H�[��]�H�Z]�[܋[\���][��[��[[�H\�[Y[��\�Y�X�][ۋ��������L�LHH��Y�X�][ۈ[]�\�Hܛۜ�Y\�[��[�\�][ۈ�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��\�[]�\�H�ܛۈ؜�\��X�[]B�H�X]\�N�Z[H��Y�X�][ۈ[���\]Y[�\�\��[��؜H�[H܈�[\Έ\�\K�ܛۋۛ�Y�X�][ۜ�ܛ�]K��\�\K�ܛۋ�\�\��[�ܛ�]K���\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����H\�ܚ\[ێ�\�Y�[Z[H��Y�X�][ۈ�[�\�][ۈ\��ܜ�[�\�[]�\�H�Z[\�\��\�H���Y�]Y����[��HHܛۈ�\�ۜ�H�]\�[��[��H\��]Y�H����X[K��H�\��][ێ��[�\�][ۋ\�]�[�\�\�\�[�Z[\�\������[��H�[�]^�Y�Z[\�H��[���ۋ^�\��Z[\�\��]\���Έ�[�X�]L���H\��\��ܛYY�L����\�Yܛۋ�\��܋X��[�\�H\����[MY�[K���K]\��Z]N�\X�X���[�\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����X\������Y�X�][ۈ��]\˂�H�\�Y�YY�N���^�H��[Z]�L�X��X�H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ�[�]�H\��[XZ[�Z[\�H�[�[��\�Y�H[\���][���\�[Y[���������L�L�H��Y�X�][ۈ[XZ[[]�\�HY�ݚY\�[�\��\�[��H�Z[\�\�H�]\Έ�H��\]Y[���H[��ݙ\�Y�H�Yܙ\��[ۈ\�˂�H�]�\�]N�B�H�]Y�ܞN���Y�X�][ۜ��[XZ[[]�\�H��\X�\�H\��\�[��H�ܛۈ؜�\��X�[]B�H�X]\�N�\�\�X�\Y[���Y�X�][ۈ[XZ[Y�\�H�[H܈�[\ΈX���\��\�ۛ�Y�X�][ۋY[XZ[˝�\�\K�ܛۋۛ�Y�X�][ۜ�ܛ�]K���\��ۛ�Y�X�][ۋY[XZ[X��[�\�K�\���\���ܛۋ[��Y�X�][ۋY�Z[\�K\�]\˝\����H\�ܚ\[ێ�H[\�YۛܙY�\X�\�H�XY�\]H\��ܜ�[��]\��YۛHH�[���[����ݚY\���Z[\�\�[�[��\���Y�[��]ܚ]\��\�H[��\�X�H�H��Y�X�][ۈܛۋ��H�\��][ێ�YYH�[�٘Z[Y���\Y�\�[�X��Y[�[����Y��ܙX�\Y[�ܙ\���H��[�\�Y\�Y���Z[Y�[���]�XX�K[�[��YY[XZ[�Z[\�\�[�Hܛۉ��L��]\˂�H\��\��ܛYY�H���\�Y��Y�X�][ۋ�\��܋X��[�\�H\����[MKY�[K����]\��Z]N�\X�X��[��\[�[��H]Y]�ZYܘ][ۈ]Y]�Y���X���[��X[��L\��]H��X�[ۈ�Z[��H]�Y[��N�\��ۛ�Y�X�][ۋY[XZ[X��[�\�K�\����X\��[\��\�[�[���]H�ۜ�[\[ۋ��H�\�Y�YY�N���^�H��[Z]�M�MY��H]H��\]Y����L�LMB�H�[XZ[�[��\[�[��Y\Έ]�H�\�[��Z[\�K�\X�]Kܙ]�H�[�[\���][��[��[[�Hܛۈ\�[Y[��\�Y�X�][ۋ�