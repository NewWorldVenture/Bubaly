# Claude-4 — QA · Features · Flows · Performance · Edge cases

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-4 and by nobody else.

---

## Sweep 1 — feature gates that cannot fail

Method: extract every href literal passed to `requireFeature()`,
`refuseUnlessEntitled()`, `familyHasFeature()` and `resolveFeatureEntitlement()`
across `app/`, `lib/`, `components/` (worktrees under `.claude/` and `tests/`
excluded — an earlier pass of this scan reported 84 "readers" of one table and
every one of them was a `.claude/worktrees/` copy), and diff that set against the
100 `href` values in `lib/constants/feature-catalog.ts`.

81 distinct gate keys are in use. 79 resolve. **Two do not.**

---

### [CLAUDE-4][HIGH][FEATURES] Vacation Planner and Weekend Planner are gated with a key the catalog does not contain, so 21 gate call sites allow everyone

- **File:** `lib/constants/feature-catalog.ts:22-149` (the catalog) vs
  `app/(app)/dashboard/vacations/page.tsx:8`, `app/(app)/dashboard/vacations/new/page.tsx:8`,
  `app/(app)/dashboard/vacations/[id]/layout.tsx:16`, the eleven
  `app/(app)/dashboard/vacations/[id]/*/page.tsx` tabs,
  `app/(app)/dashboard/vacations/calendar/page.tsx:8`,
  `app/(app)/dashboard/vacations/reports/page.tsx:8`,
  `app/(app)/dashboard/weekend/page.tsx:8`,
  `app/api/vacations/ai/route.ts:37`, `app/api/vacations/weather/route.ts:22`,
  `app/api/weekend/discover/route.ts:35`
- **Problem:** `resolveFeatureEntitlement` (`lib/server/feature-entitlement.ts:63-66`)
  is explicit that an href absent from the catalog is **not gated**:

  ```ts
  const tier = byHref[href];
  if (tier === undefined) return { allowed: true, planLevel };
  ```

  `/dashboard/vacations` and `/dashboard/weekend` are absent. The catalog carries
  `F('trips', …, 'basic', '/dashboard/trips')` — a *different* route, a different
  page — and has no entry for either of these two. Every one of the 21 call sites
  therefore resolves `allowed: true` for every family on every plan, including a
  family whose trial has lapsed to Free.
- **Evidence:** bundled `lib/features/tiers.ts` + the catalog with esbuild and
  evaluated the resolver's own input map:

  ```
  $ node gate1.cjs
  /dashboard/vacations     => undefined
  /dashboard/weekend       => undefined
  /dashboard/trips         => "basic"
  /dashboard/chores        => "free"
  catalog has /dashboard/vacations? false
  catalog has /dashboard/weekend?   false
  ```

  `tiersByHref` is the only source `resolveFeatureEntitlement` consults, and
  `requireFeature` / `refuseUnlessEntitled` are both thin wrappers over it
  (`lib/supabase/auth.ts:246`, `lib/server/route-feature-gate.ts:39-40`). Neither
  page nor route carries any second gate — `grep -rn "requirePlanLevel\|planLevel"`
  over `app/(app)/dashboard/{weekend,vacations}` and `app/api/{weekend,vacations}`
  returns nothing.
- **Impact:** three ways.
  1. `lib/constants/navigation.ts:161,162` publishes both as `minLevel: 1`
     (Family Basic+), and `resolveItems` (`components/app/nav-shared.tsx:63-64`)
     decides locked/unlocked from `featureTiers[item.href]`, **not** from
     `minLevel` — so an undefined tier renders the item as a normal, unlocked
     link. A Free family sees "Vacation Planner" and "Weekend Planner", clicks
     through, and gets the whole 13-tab trip workspace the plan does not sell.
  2. `/api/vacations/ai` calls a model (`resolveProvider`, line 39 onward) with
     only a 20/window rate limit in front of it, and `/api/weekend/discover`
     fans out to Ticketmaster and SeatGeek on the deployment's own API keys.
     Both are billed per request and both are open to Free.
  3. The `/pricing` grid is generated from this same catalog
     (`app/(marketing)/pricing/page.tsx:46`), so neither feature appears on any
     published plan at all. The product sells neither and the code gives both
     away — the mirror image of Pass L.
- **Fix:** add the two missing rows to `FEATURE_CATALOG`, at the tier the nav
  already claims:
  `F('vacations', 'Vacation Planner', 'Family & Home', 'basic', '/dashboard/vacations')`
  and `F('weekend-planner', 'Weekend Planner', 'Family & Home', 'basic', '/dashboard/weekend')`.
  No call site changes. Then close the class: a test that asserts every href
  literal reaching `requireFeature`/`refuseUnlessEntitled` exists in
  `tiersByHref(resolveFeatureTiers({}))` — the scan above, as a guard.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][TESTS] `tests/route-plan-gate.test.ts` asserts the gate's source text, so it passes over three routes where the gate does nothing

- **File:** `tests/route-plan-gate.test.ts:136-138`, assertion at `:147-150`
- **Problem:** the table-driven half of this suite reads each route's **source**
  and asserts a substring:

  ```ts
  const source = stripComments(read(route));
  expect(source).toContain('refuseUnlessEntitled(');
  for (const href of hrefs) expect(source).toContain(`'${href}'`);
  ```

  That is a check that the line was typed, not that it refuses anybody. Three of
  its twenty entries — `weekend/discover`, `vacations/ai`, `vacations/weather` —
  name hrefs the catalog does not contain, so at runtime the gate they assert
  returns `allowed: true` for every family. The test is green today and would
  stay green if the catalog were emptied.
- **Evidence:** the file's own first `describe` shows the shape that *would* have
  caught it — it drives `app/api/ai/savings/route.ts` against an in-memory
  Supabase seeded with a `free` and a `plus` family and asserts `403` /
  `needLevel: 1` / the rate limiter never being reached. Exactly one route
  (`ai/savings`) gets that treatment; the other nineteen get the substring check.
  Behavioural proof of the gap is in the finding above.
- **Impact:** this is the guard that exists specifically to stop an AI endpoint
  serving a family that is not entitled, and it is structurally incapable of
  seeing the case where the entitlement key is wrong — which is the only way the
  gate can be present and still not gate.
- **Fix:** keep the substring check (it is a cheap regression net for a deleted
  line) and add one assertion beside it that costs nothing:

  ```ts
  const byHref = tiersByHref(resolveFeatureTiers({}));
  for (const href of hrefs) expect(byHref[href]).toBeDefined();
  ```

  Revert the catalog fix and this goes red on three rows; with the fix it is
  green. Better still, extend the `savings` harness to run the whole `GATED`
  table — the mocks are already generic.
- **Status:** OPEN

---

## Sweep 2 — the money spine: chore → approve → pay, and allowance runs

Traced first click to stored row on a **real 310-migration replay**
(`bash docs/audit/verify-pg.sh up`, 310/310 applied, 0 failed). Everything below
was raced on that database, two connections genuinely in flight.

Pass B / F-019 proved the *debit* side safe: `wallet_reserve_card_auth` holds
`FOR UPDATE`, and two simultaneous $8 authorizations against $10 yield exactly
one approval. **The credit side has no such lock, and nothing had raced it.**

---

### [CLAUDE-4][HIGH][MONEY] `runDueAllowancesAction` claims a rule with a blind update, so a parent tapping "Run now" twice pays the allowance twice — the cron beside it does not have this bug

- **File:** `app/(app)/wallet/actions.ts:328-330` (the claim) vs
  `app/api/cron/wallet-allowance/route.ts:79-87` (the correct claim)
- **Problem:** both paths do the same job — find rules with `next_run_on ≤ today`,
  advance the schedule, credit the wallet. The cron **claims** the rule:

  ```ts
  .update({ next_run_on: next, last_run_on: today })
  .eq('id', rule.id).eq('family_id', rule.family_id)
  .lte('next_run_on', today)          // ← the exclusivity guard
  .select('id').maybeSingle();
  if (!claimed) continue;             // another run won — do not double-pay
  ```

  and its own comment explains exactly why. The parent-initiated action, forty
  lines away in a different file, does not:

  ```ts
  .update({ next_run_on: next, last_run_on: today })
  .eq('id', rule.id).eq('family_id', familyId)
  .select('id').single();
  if (advanceError || !advancedRule) return actionFailure(…);
  // …then credits unconditionally
  ```

  With no predicate on `next_run_on`, both overlapping runs match the row, both
  get a row back, and both credit. The action's docstring claims the opposite:
  *"Idempotent with the Vercel cron — both act only on DUE rules, so if the cron
  already ran, nothing is due and this pays nothing (no double-pay)."* That holds
  only if the two are sequential.
- **Evidence:** one rule (`amount_cents = 1000`, `next_run_on = current_date − 1`)
  on the replayed database; each shape run twice, concurrently, from two psql
  connections with a 2-second overlap between the read and the write, the credit
  gated on the update's own `RETURNING` exactly as the code gates it on
  `claimed` / `advancedRule`:

  ```
  == CRON shape — UPDATE carries .lte('next_run_on', today) ==
  ledger_rows=1  cents_credited=1000
  == SERVER ACTION shape — UPDATE by id only ==
  ledger_rows=2  cents_credited=2000
  ```

  Same rule, same seconds, same ledger. The predicate is the entire difference.
- **Impact:** the child is paid twice for one period from the family's money, and
  `wallet_transactions` is an append-only ledger (`0088`, and
  `tests/wallet-audit-log-append-only.test.ts`) — so the correction is a manual
  reversal row, not a delete. Reachable without any exotic client:
  `components/wallet/allowance-view.tsx:48` is a plain button, and two tabs, a
  double-submit on a slow connection, or a parent tapping while the nightly cron
  is mid-run all produce the overlap. The window is as wide as one
  `creditChildWallet` round trip.
- **Fix:** one line — add `.lte('next_run_on', today)` to the action's update and
  treat a null result as "another run won", `continue` rather than
  `actionFailure`. That makes the action and the cron the same claim, which is
  what the docstring already says they are.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][TESTS] The allowance double-pay guard is pointed at one of the two places the pattern lives

- **File:** `tests/allowance-cron-idempotency.test.ts:11`
- **Problem:** the guard is a source-text assertion over a single hardcoded file:

  ```ts
  const SRC = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');
  expect(SRC).toMatch(/\.update\(\{\s*next_run_on[\s\S]{0,160}?\.lte\('next_run_on',\s*today\)/);
  expect(SRC).toMatch(/if\s*\(!claimed\)\s*continue/);
  ```

  Its header states the property in general terms — *"If two invocations overlap
  (Vercel cron re-fire / **manual trigger** / >maxDuration run), both must NOT
  credit the same period"* — and "manual trigger" is `runDueAllowancesAction`,
  which the test never opens. The property is asserted of the file, not of the
  behaviour, so the second implementation of the same claim was free to ship
  without one.
- **Evidence:** `grep -rn "next_run_on" app lib --include=*.ts` returns two
  claim sites; the test names one. The race above is the behaviour the test
  header describes, failing in the file the test does not read.
- **Impact:** this is the only guard on the allowance money path, and it is green
  over a live double-pay.
- **Fix:** make the scan cover both — glob every file that updates
  `allowance_rules.next_run_on` and assert each carries the `.lte('next_run_on', …)`
  predicate. Better, add the behavioural half: `tests/helpers/in-memory-supabase`
  already backs `tests/route-plan-gate.test.ts`; two interleaved
  `runDueAllowancesAction()` calls against one due rule must produce one credit.
  Revert the one-line fix above and that test goes red; with it, green.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][MONEY] `payChoreRewardAction` is a check-then-act with no constraint behind it, and its docstring names a marker that does not exist

- **File:** `app/(app)/wallet/actions.ts:186-215`
- **Problem:** the docstring says *"Idempotent per assignment via a marker on the
  assignment row."* There is no marker on the assignment row. The implementation
  is a SELECT followed, over a separate HTTP round trip, by an INSERT:

  ```ts
  const { data: existing } = await supabase
    .from('wallet_transactions').select('id')
    .eq('family_id', familyId).eq('related_type', 'chore_assignments')
    .eq('related_id', assignment.id).limit(1);
  if ((existing ?? []).length > 0) return { ok: false, error: … };
  …
  const res = await creditChildWallet(supabase, { … relatedType: 'chore_assignments', relatedId: assignment.id });
  ```

  `creditChildWallet` (`lib/wallet/server.ts:267`) then does a plain
  `.insert(rows)`. The supabase-js client has no transaction, so the two calls
  cannot be atomic; the only thing that could make them safe is a database
  constraint.
- **Evidence:** there is none, confirmed on the replayed catalogue rather than
  from the migration text:

  ```
  $ psql -c "select conname, contype from pg_constraint where conrelid='public.wallet_transactions'::regclass"
    …_amount_cents_check | c        (amount_cents >= 0)
    six FK constraints
    wallet_transactions_pkey | p     PRIMARY KEY (id)
  $ psql -c "select indexname from pg_indexes where tablename='wallet_transactions'"
    wallet_transactions_pkey | idx_wallet_txn_child | idx_wallet_txn_status | idx_wallet_txn_bucket
  $ psql -c "select tgname from pg_trigger where tgrelid='public.wallet_transactions'::regclass and not tgisinternal"
    trg_wallet_transactions_updated_at   (BEFORE UPDATE, set_updated_at)
  ```

  Nothing on `(related_type, related_id)`; no BEFORE INSERT trigger. Raced on the
  same database, both sessions reading `already_paid = 0` before either inserted:

  ```
  ledger_rows=2  cents_credited=1000      -- a 500-cent chore
  ```
- **Impact:** lower than the allowance case because
  `components/modules/chores-module.tsx:176` holds a `paying` flag, so a single
  tab cannot double-submit. Two tabs, the mobile client, or a retried server
  action can. The consequence is the same: an unreversible extra credit in an
  append-only ledger.
- **Fix:** a partial unique index is the real guard and costs one migration —
  `create unique index … on wallet_transactions (family_id, related_type, related_id, coalesce(bucket_id,'00000000-…'::uuid)) where related_type = 'chore_assignments'`
  (the composite is needed because `creditChildWallet` writes one row per bucket,
  so `related_id` alone is not unique by design). Then treat `23505` from the
  insert as "already paid" rather than as a failure. Either way, correct the
  docstring: it currently describes a mechanism that was never built.
- **Status:** OPEN

---

## Sweep 3 — features that are wired but cannot work

Method, and its first result was a false positive worth recording: a scan for
`.from('x')` with no matching `.insert/.update/.upsert/.delete` reported 41
"tables read but never written". Checking them one at a time, most were writable
after all —

- **19** are written through a *dynamic* table name the scan cannot see:
  `components/vacations/shared.tsx:130` does `.from(table).insert(...)` where
  `table` is a prop, which is how every `vacation_*` table is populated, and
  `lib/family/actions.ts:22` holds a `WRITABLE` allowlist keyed by table name
  that covers `family_routines`, `family_milestones`, `family_memories`,
  `family_emergency_contacts/plans`, `family_stress_signals` and five more;
- **7** are catalogs seeded by a migration `INSERT` (`invest_assets`,
  `social_providers`, `sync_providers`, `marketplace_circles`, …);
- **12** are written by RPCs or webhook handlers.

Three survive. Each is a feature that a family can reach and that cannot
produce a non-empty state on a production database.

---

### [CLAUDE-4][HIGH][FEATURES] The Experience Scorecard is in every family's sidebar and its only possible state is an empty state that tells them to run a SQL file

- **File:** `lib/constants/navigation.ts:218`,
  `app/(app)/dashboard/experience/page.tsx`,
  `components/modules/experience-scorecard-module.tsx:50-58` and `:87`
- **Problem:** the page reads `experience_audits` and rolls it up. **Nothing
  writes `experience_audits`** — not a server action, not a route handler, not a
  cron, not the `lib/family/actions.ts` `WRITABLE` allowlist, not a migration
  `INSERT`, not even `SEED_ALL.sql`. The only producer in the repository is
  `supabase/seed_experience_audits_one_family.sql`, a hand-run developer seed.
  So `card.auditedSurfaces` is always `0` and the module always renders its empty
  state — whose copy is:

  ```tsx
  description="Once surfaces are audited, this scorecard grades each one across the
  six premium dimensions and tracks the trend. Run
  seed_experience_audits_one_family.sql to populate a baseline."
  ```
- **Evidence:** every reference to the table in the repository, with test files,
  worktrees and `lib/database.types.ts` excluded:

  ```
  supabase/migrations/0144_experience_audits.sql   (DDL, indexes, 4 RLS policies)
  components/modules/experience-scorecard-module.tsx:22,50,51,54   (read only)
  tests/behavior-read-bounded.test.ts:42                            (asserts the read is bounded)
  supabase/seed_experience_audits_one_family.sql                    (dev seed)
  ```

  No writer. `PRODUCTION_DEPLOYMENT_CHECKLIST.md:83` — *"Legacy service-role seed
  scripts require a confirmed non-production seed scope"* — is the line that
  makes this permanent rather than a matter of remembering: the seeds are barred
  from production on purpose.
- **Impact:** `minLevel: 0`, so the entry is visible and unlocked to every family
  on every plan, in the "Family AI OS" group. A parent taps "Experience
  Scorecard" and is told to run a `.sql` file. That is a developer instruction
  shipped as product copy (it is also the one string in that module not passed
  through `t()`, so it is English in all eleven locales).
- **Fix:** decide which of the two this is and do that one.
  (a) It is an internal instrument — remove the nav entry and keep the page for
  super-admins, as `/dashboard/journeys` and `/dashboard/onboarding-funnel`
  already do (`isSuperAdmin()` → `notFound()`).
  (b) It is a product feature — then something has to write the rows: the six
  dimensions are all measurable from telemetry the app already has, and the
  scorecard would need a producer (a nightly pass, or a write at the end of each
  audited surface's render).
  Either way, delete the seed-file instruction from user-facing copy.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] The Family App Store installs apps that nothing in the product ever reads, from a catalog production never gets

- **File:** `app/(app)/dashboard/app-store/page.tsx`,
  `app/(app)/dashboard/app-store/actions.ts:18,32,44`,
  `supabase/migrations/0165_family_app_store.sql`
- **Problem:** three separate things are each individually true.
  1. **The install does nothing.** `installAppAction` upserts
     `family_app_installs`; `uninstallAppAction` deletes; a third action toggles
     `enabled`. The complete set of readers of that table is **one**:
     `app/(app)/dashboard/app-store/page.tsx:27`, which uses it to decide whether
     the button on that same page says "Install" or "Installed". No AI tool, no
     nav, no dashboard, no capability check anywhere consults a family's installs.
     The `enabled` column has no reader at all.
  2. **The catalog is empty in production.** `family_apps` has no `family_id` —
     it is global reference data — and no migration inserts a row. The only
     producer is `supabase/seed_family_apps.sql` / `SEED_ALL.sql`, whose own
     header calls it *"500-row test data"*, and which the deployment checklist
     bars from production.
  3. **The page is unreachable.** `/dashboard/app-store` appears in no nav group,
     no `PRIMARY_NAV`, no `MOBILE_TABS`, no `ALL_SERVICES_CATALOG`, and is not
     linked from any other page. A scan of all 353 static page routes for a path
     literal named anywhere outside the page's own folder leaves 22 candidates,
     of which 9 are `${BASE}`-template marketplace tabs, 4 are deliberate
     `redirect()` stubs, and this is one of the genuine remainder.
- **Evidence:**

  ```
  $ rg -n "family_app_installs" (excl. node_modules, .claude, mobile, *.test.*)
    app/(app)/dashboard/app-store/page.tsx:27      ← the only read
    app/(app)/dashboard/app-store/actions.ts:18,32,44
    supabase/migrations/0165_family_app_store.sql  (DDL/RLS)
    database-map.md:103, feature-inventory.md:12   (docs)
  $ rg -ci "insert into (public\.)?family_apps" supabase/migrations/*.sql → 0
  $ rg -n "app-store" lib/constants/*.ts components/app/*.tsx → (no output)
  ```
- **Impact:** a complete vertical — migration, RLS, catalog model, ranking and
  recommendation logic (`lib/appstore/catalog.ts`), three server actions, an
  optimistic install button — that on production shows an empty grid to anyone
  who guesses the URL, and whose one write has no consumer. `feature-inventory.md`
  lists it as a shipped feature.
- **Fix:** it is a product decision, not a code fix. If the App Store ships:
  seed `family_apps` from a **migration** (it is global reference data, which is
  what migrations are for), give installs a consumer, and add the nav entry +
  catalog row. If it does not: the page, the two tables and the actions should
  leave the tree, and `feature-inventory.md` should stop claiming it.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] The first-run brief's "dinner ideas" come from a catalog production has no way to populate

- **File:** `app/onboarding/actions.ts:81-102` (`fetchDinnerCandidates`),
  `lib/onboarding/dinner-ideas.ts`,
  `components/onboarding/onboarding-wizard.tsx:772`,
  `components/dashboard/home-outcome-card.tsx:55`
- **Problem:** same shape as `family_apps`. `meal_ideas` is a global catalog
  (`0139_meal_ideas.sql`, no `family_id`) whose comment says *"No client
  writes"*; nothing in the app writes it; no migration inserts a row; the only
  producer is `supabase/seed_meal_ideas.sql`. `fetchDinnerCandidates` is
  best-effort by design — *"if the table isn't migrated yet the brief just
  carries no dinner ideas (never blocks onboarding)"* — so an **empty** catalog
  is indistinguishable from a missing one and produces `[]` silently.
- **Evidence:** `rg -ci "insert into (public\.)?meal_ideas" supabase/migrations/*.sql`
  → 0. The catalog is the brief's only source: `lib/onboarding/dinner-ideas.ts`
  is a pure picker over the rows it is handed, and its header states the reason —
  *"A brand-new family has no recipes of its own, so the briefing's 3 dinner
  ideas come from the curated meal_ideas catalog."*
- **Impact:** this is the VALUE-FIRST payoff the onboarding wizard is built
  around (`previewCalendarImportAction`, *"the user sees their day/week come
  together before we ask them to configure anything"*). With an empty catalog the
  dinner block never renders, and
  `onboarding-wizard.tsx:772` shows the shape of the worst case:

  ```ts
  const hasBrief = !!brief && (brief.todayCount > 0 || brief.dinnerIdeas.length > 0
                               || brief.timeSavedMinutes > 0 || brief.conflicts.length > 0);
  ```

  A family that skips the calendar import — no events today, no conflicts, no
  minutes saved — has **all four** disjuncts false, so the "here is your first
  brief" card is not rendered at all and the wizard's final step is a plain
  "All set". The one term that would have carried it on its own is the one fed by
  the empty catalog. The same catalog feeds the home dashboard's weekly dinner
  ideas (`home-outcome-card.tsx:55`).
- **Fix:** move the curated catalog into a migration — it is reference data with
  no tenant, exactly like `invest_assets` (`0`-family, seeded by migration) and
  `social_providers`. That is a five-line change of file, not of content. And
  separate "catalog is empty" from "catalog is missing" in
  `fetchDinnerCandidates`, so an empty production catalog is visible in the logs
  instead of looking like a family with no ideas.
- **Status:** OPEN
