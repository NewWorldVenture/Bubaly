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

---

## Sweep 4 — the three descriptions of one offer

There are **three** independent statements of who may use a destination, and no
two of them are read by the same code:

| statement | lives in | what it actually drives |
|---|---|---|
| `minLevel` | `lib/constants/navigation.ts` | **nothing to do with access** — only membership of `NAV_CATALOG`, the free tier's "add a destination" picker |
| `defaultTier` | `lib/constants/feature-catalog.ts` | the sidebar's locked/unlocked rendering (`resolveItems` → `featureAccessByTier`), `requireFeature`, `refuseUnlessEntitled`, **and** the published `/pricing` grid |
| `requirePlanLevel(n)` | eight page files | that page, and nothing else |

`resolveItems` (`components/app/nav-shared.tsx:59-68`) reads `featureTiers[item.href]`
and never looks at `item.minLevel`. Measured across the 135 distinct nav
destinations: **28 disagree** between `minLevel` and the tier that actually
gates. `tests/plans-and-gates-agree.test.ts` guards one direction of this
(a *pinned* route gated above free) and nothing guards the rest.

---

### [CLAUDE-4][HIGH][FEATURES] Home & Maintenance is sold as Family+, locked in the sidebar at Family+, and opened by the page at Family Basic

- **File:** `lib/constants/feature-catalog.ts` → `F('home-inventory', 'Home Inventory', 'Family & Home', 'plus', '/dashboard/home')`
  vs `app/(app)/dashboard/home/page.tsx:8` → `await requirePlanLevel(1)`
  (and the same at `home/diagnose:10`, `home/service:10`, `home/maintenance:14`,
  `home/warranties:10`, `home/pros:10`, `home/assets/[id]:80`)
- **Problem:** three sources, two answers.
  - `/pricing` is generated from `FEATURE_CATALOG`
    (`app/(marketing)/pricing/page.tsx:46`), so **Home Inventory is published as a
    Family+ feature**.
  - `resolveItems` resolves `/dashboard/home` to `plus`, so a **Family Basic**
    household sees "Home & Maintenance" greyed out with a padlock and gets the
    upgrade prompt on click.
  - The seven pages themselves ask for `requirePlanLevel(1)`, which **admits any
    Family Basic household** that reaches the URL. `requirePlanLevel` does not
    consult the catalog at all (`lib/supabase/auth.ts:215-227`): it reads
    `resolveFamilyPlanLevel` and compares to its literal argument.
- **Evidence:** every `requirePlanLevel` call site in `app/`, against the tier
  the catalog resolves for the same route:

  ```
  /dashboard/home/diagnose      page=1  catalog=2   MISMATCH
  /dashboard/home/service       page=1  catalog=2   MISMATCH
  /dashboard/home/maintenance   page=1  catalog=2   MISMATCH
  /dashboard/home               page=1  catalog=2   MISMATCH
  /dashboard/home/assets/[id]   page=1  catalog=2   MISMATCH
  /dashboard/home/warranties    page=1  catalog=2   MISMATCH
  /dashboard/home/pros          page=1  catalog=2   MISMATCH
  /dashboard/contact-center     page=2  catalog=—   MISMATCH   (next finding)
  /dashboard/auto{,/7 subpages} page=1  catalog=1   ok
  ```

  The eight `/dashboard/auto*` pages are the control: same helper, same shape,
  and they agree, so this is drift in one feature and not a property of
  `requirePlanLevel`.
- **Impact:** both directions are wrong at once, which is what makes it worth a
  HIGH rather than a tidy-up.
  - *Revenue:* a Family Basic household that types `/dashboard/home/maintenance`,
    follows an old link, or lands there from a search result gets the whole Plus
    Home vertical — assets, warranties, pros, maintenance, service history.
  - *Product:* that same household is shown a padlock on the sidebar entry for
    the feature the page will hand them, and told to upgrade.
  - *Consistency:* the AI route behind it disagrees with the page too —
    `tests/route-plan-gate.test.ts:125-127` gates `ai/home/diagnose`,
    `ai/home/find-pro` and `ai/home/forecast` on `'/dashboard/home'`, which
    resolves through the catalog to `plus`. So the **page** admits Basic and the
    **AI endpoint the page calls** refuses them: a Basic family opens a Plus
    screen and every AI button on it answers 403.
- **Fix:** pick the tier the product actually sells, then make one source say it.
  If Home is Plus (what `/pricing` publishes), change the seven pages to
  `requirePlanLevel(2)` — better, to `requireFeature('/dashboard/home')`, so the
  page reads the catalog like every other gated page does and cannot drift
  again. If Home is Basic, change `defaultTier` to `'basic'` and the pricing grid
  follows automatically. Then guard it: assert every `requirePlanLevel(n)` in
  `app/**/page.tsx` matches `tierToLevel(tiersByHref[route])` when the route is
  in the catalog — the scan above, as a test. It goes red on seven rows today.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] Operations Center is a permanent unlocked sidebar button that only produces a billing upsell — the Pass L shape, from the other direction

- **File:** `lib/constants/navigation.ts:203` (`/dashboard/contact-center`, `minLevel: 2`)
  vs `app/(app)/dashboard/contact-center/page.tsx:21`
  (`requirePlanLevel(FAMILY_EMAIL_MIN_PLAN_LEVEL)`, and
  `lib/constants/plans.ts:60` sets that to `2`)
- **Problem:** `/dashboard/contact-center` is not in `FEATURE_CATALOG`, so
  `featureTiers['/dashboard/contact-center']` is `undefined`, so
  `featureAccessByTier(undefined, planLevel)` returns `'visible'` — for every
  plan. `resolveItems` therefore pushes it with `locked: false` and `NavEntry`
  renders a normal `<Link>`, with no padlock, no greying, no upgrade prompt. The
  page then answers `redirect('/dashboard/billing?upgrade=1&need=2')`.

  The item's own `minLevel: 2` says exactly what should have happened and is not
  read by anything that renders it.
- **Evidence:** the chain is four short hops and each was read:
  `nav-shared.tsx:63` `const tier = featureTiers[item.href]` →
  `tiers.ts:107` `if (tier === undefined) return 'visible'` →
  `nav-shared.tsx:66` `locked: access === 'locked'` (false) →
  `nav-shared.tsx:115` renders `<Link href={item.href}>` →
  `auth.ts:224` `if (level < minLevel) redirect(...)`.
  The route scan over all eight `requirePlanLevel` pages found exactly one where
  the catalog has no tier, and this is it.
- **Impact:** every Free and Family Basic household carries a sidebar entry that
  looks live and cannot be used. This is the same defect Pass L closed for the AI
  Assistant — *"every free family had a permanent sidebar button that produced a
  billing upsell"* — approached from the other side: there the catalog was too
  strict, here it has no entry at all, and the visible result is identical.
- **Fix:** add the route to the catalog at the tier the plan sells
  (`F('contact-center', 'Operations Center', 'Family & Home', 'plus', '/dashboard/contact-center')`).
  The sidebar then renders the padlock and the upgrade sheet, `/pricing` lists it
  under Family+, and the page's own `requirePlanLevel(2)` becomes the belt to the
  catalog's braces. The same one-line class as the Vacation/Weekend finding
  above, so both are closed by the same guard: *every nav href that any page
  gates must have a catalog tier.*
- **Status:** OPEN

---

### [CLAUDE-4][LOW][FEATURES] Seven free features cannot be added to a free family's sidebar, because the picker filters on the field that no longer gates

- **File:** `lib/constants/navigation.ts:355-368` (`NAV_CATALOG`), filter
  `if ((item.minLevel ?? 0) === 0) push(...)`
- **Problem:** `NAV_CATALOG` is *"the pool of destinations a member can put in
  their curated sidebar … plus every other **free** (minLevel 0) module"*. It
  decides "free" from `minLevel`, which is the one of the three statements that
  does not gate anything. Where `minLevel` says 1 and the catalog says `free`,
  the family is entitled to the page and cannot pin it.
- **Evidence:** computed from the two modules directly, no grep:

  ```
  routes the catalog grants to Free: 41
  NAV_CATALOG (the "add a destination" picker): 66
  Free-tier routes a free family may open but CANNOT add to their sidebar:
      /dashboard/homework   /dashboard/medical   /dashboard/pantry
      /dashboard/school     /dashboard/signups   /dashboard/timetable
      /dashboard/voting                                    (7)
  ```

  Each of those seven pages calls `requireFeature('<its own route>')` and the
  catalog resolves every one of them to `free`, so a free family can open all
  seven today — from All Services, from a link, from search.
- **Impact:** small and entirely in the product's own disfavour: School,
  Homework, Timetable, Medical, Pantry, Signups and Group Voting are the
  everyday-use destinations a new family would most want on their sidebar, and
  they are the ones the picker hides. It is also the clearest single symptom that
  `minLevel` and `defaultTier` have drifted — 28 of 135 destinations disagree.
- **Fix:** build `NAV_CATALOG` from the same resolver everything else uses —
  `tiersByHref(resolveFeatureTiers({}))[href] === 'free'` — and delete `minLevel`
  from `NavItem`, since after that nothing reads it. If `minLevel` is meant to
  stay as documentation, a test that asserts `minLevel === tierToLevel(catalog tier)`
  for every nav destination turns 28 silent disagreements into one red build.
- **Status:** OPEN

---

## Sweep 5 — the gift spine, end to end

`/wallet/gift` (create link) → `/pay/<handle>` (resolve) → `/gift/<token>`
(public giver form) → `app/gift/actions.ts` (payment) → `approveGiftAction`
(credit). Both public prefixes are confirmed public in
`lib/auth/route-access.ts:48,58`, so these two pages render for anyone with the
URL and no session at all.

Most of it is careful — `/pay/[handle]` deliberately gives the same dead-end for
an unknown handle and a revoked one, and `/gift/[token]` distinguishes a missing
link from a failed read rather than telling a giver mid-payment that a valid
token is dead. One thing is not.

---

### [CLAUDE-4][MEDIUM][PRIVACY] A revoked gift link still shows the parent's message to anyone who kept the URL

- **File:** `app/gift/[token]/page.tsx:38-52` vs `:62`
- **Problem:** the page is explicit about the rule and then breaks it three lines
  later. Every identifying lookup is placed behind `active`:

  ```ts
  const active = !!link && link.is_active;
  let childName = 'a child';
  let familyName = 'a family';
  // An inactive capability must not disclose the household or child it used
  // to target. Keep all identifying lookups behind the active-link check.
  if (active && link?.child_wallet_id) { … childName = m.display_name … }
  if (active && link?.family_id)       { … familyName = fam.name … }
  ```

  and then the render does this, outside any `active` check:

  ```tsx
  <p className="mt-1 text-sm text-muted">{occasionLabel(link?.occasion ?? null)} · {familyName}</p>
  {link?.message && <p …>“{link.message}”</p>}
  ```

  `message` and `occasion` are read straight off the row whenever the row exists.
  `is_active` is not consulted for either.
- **Evidence:** `message` is parent-authored free text —
  `app/(app)/wallet/actions.ts:412-431` takes `message?: string | null` from the
  manager and stores it verbatim; there is no length limit and no sanitisation
  step. `occasion` is the same. `/gift` is in `PUBLIC`
  (`lib/auth/route-access.ts:48`), so the whole page renders with no session.
  The revocation path — `is_active: false` — is the only control a family has
  over a gift link once it has been shared, and it does not cover the one field
  the family wrote themselves.
- **Impact:** a family revokes a gift link because it went somewhere it should
  not have: a group chat, a forwarded email, an ex-partner. The name and the
  household are correctly withheld afterwards — and the sentence the parent
  typed, which is the field most likely to name the child, the birthday and the
  reason ("For Emma's 8th — she's been saving for a bike"), is still served to
  anyone holding the URL, forever. The page's own comment says this must not
  happen.
- **Fix:** move both fields behind the same flag the names already sit behind:
  `{active && link?.message && …}` and `occasionLabel(active ? link?.occasion : null)`.
  Better, narrow the query — select `message`, `occasion` and `suggested_cents`
  only in a second read taken after `is_active` is known, so an inactive link
  never loads the fields at all. Guard: render the page for a token whose
  `is_active` is false and assert the response body contains neither the message
  nor the occasion. The page is a server component with a service-role read, so
  the existing `tests/public-route-write-honesty.test.ts` harness is the shape to
  copy.
- **Note:** this is a public-surface privacy defect and may overlap Claude-3's
  area; recording it here because it was found by walking the gift spine, and it
  is a page rather than a `route.ts` (Pass F covered `route.ts` under public
  prefixes only).
- **Status:** OPEN

---

### [CLAUDE-4][LOW][FLOWS] "Add to grocery list" from a recipe treats a failed read as "you have no list" and offers to make a second one

- **File:** `components/modules/recipes-module.tsx:203-208`
- **Problem:**

  ```ts
  const { data: list } = await supabase
    .from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at').limit(1).maybeSingle();
  if (!list) { setNewListName('Groceries'); setGroceryPrompt(recipe); return; } // offer to create one
  ```

  The error is destructured away. A transient failure — an expired token, an RLS
  blip, a dropped connection — yields `data: null`, which the next line reads as
  "this family has no grocery list", and the UI offers to create one. Accepting
  inserts a second `grocery_lists` row beside the one that already exists;
  nothing dedupes by name.
- **Evidence:** this is the class Pass E named ("reads whose error is discarded
  and whose absence is then treated as fact") and closed one instance of. The
  same file handles it correctly two functions later —
  `createListAndAdd` at `:215` destructures `error` and calls
  `describeDbError` — so the pattern is understood here and this call site was
  missed. The rest of the flow is sound: `addItemsToList` scales quantities by
  the servings adjuster (`:182`), dedupes by normalised name in the service, and
  reports how many it skipped.
- **Impact:** a duplicate "Groceries" list, which then splits the family's
  shopping in two — half the items on the list the recipe wrote to, half on the
  one the Grocery page opens (`:203` picks the **oldest** non-archived list via
  `.order('created_at')`, so the new one is not even the one it writes to next
  time). Recoverable, but confusing in exactly the way a shared list must not be.
- **Fix:** destructure the error, and on error toast `describeDbError(error)` and
  return without offering to create — the two states are different and only one
  of them should mint a row.
- **Status:** OPEN

---

## Sweep 6 — tests that assert the source text rather than the behaviour

Census over `tests/` (1,193 `*.test.ts(x)` files):

| | files | note |
|---|---|---|
| read a source file with `readFileSync` | 484 | 41% |
| …and import **no application module at all** — the assertions are entirely about file text | **350** | 29%, **1,233 test cases** |

That is not automatically bad: a "single write path" grep guard is a legitimate
architectural regression net, and several here are excellent
(`tests/plans-and-gates-agree.test.ts` reads copy out of `PLANS` and compares it
to `AI_MONTHLY_ALLOWANCE`, which is a real cross-module invariant). The hazard is
specific: a text guard cannot see a defect that is spelled correctly. This audit
found three instances in the money and entitlement paths alone, and one of them
is worse than blind.

---

### [CLAUDE-4][HIGH][TESTS] `tests/wallet-allowance-persistence.test.ts` pins the exact expression that causes the allowance double-pay — the one-line fix turns the suite red

- **File:** `tests/wallet-allowance-persistence.test.ts:13`
- **Problem:** the assertion is a character-for-character match on the defective
  line:

  ```ts
  expect(source).toContain(
    ".update({ next_run_on: next, last_run_on: today }).eq('id', rule.id).eq('family_id', familyId).select('id').single()"
  );
  ```

  That is the blind claim proved above to credit an allowance twice under two
  concurrent runs. The correct form — the one the cron already uses — is the same
  chain with `.lte('next_run_on', today)` inserted and `.single()` relaxed to
  `.maybeSingle()` (a claim that loses must return no row, not throw). Both edits
  break the substring.
- **Evidence:** the repository file was not modified. The source was read, the
  one-line fix applied **to a copy in scratch**, and the assertion re-evaluated
  against both:

  ```
  current source contains the pinned string:            True
  after the one-line claim fix, it still contains it:   False
  ```

  And the suite is green today:

  ```
  $ npx vitest run tests/wallet-allowance-persistence.test.ts \
                   tests/allowance-cron-idempotency.test.ts \
                   tests/route-plan-gate.test.ts
    Test Files  3 passed (3)
         Tests  30 passed (30)
  ```

  Thirty green cases across the three files that between them own the allowance
  money path, the chore money path and the AI entitlement gate — over two live
  defects and one of the fixes.
- **Impact:** this is the failure mode that makes a text guard dangerous rather
  than merely weak. A developer who finds the double-pay and fixes it correctly
  gets a red build, and the red build names *this* file — a "persistence
  boundaries" test with no obvious connection to concurrency. The likely
  resolutions are to revert the fix or to edit the expected string, and only one
  of those is right. Its sibling `tests/allowance-cron-idempotency.test.ts` — the
  file whose whole subject is *"both must NOT credit the same period"* — asserts
  the **correct** claim on the cron and never opens this file, so the two guards
  for one property are pointed at different implementations and disagree about
  which is right.
- **Fix:** the three cases in this file are each testing a real property —
  fails-closed on an unreadable rule set, rolls the schedule back when crediting
  fails, counts only after success. Assert the property, not the spelling:
  drive `runDueAllowancesAction()` against `tests/helpers/in-memory-supabase`
  (already used by `tests/route-plan-gate.test.ts`) with a seeded due rule, and
  assert one ledger credit for two interleaved calls, a restored `next_run_on` on
  a failed credit, and `ranCount === 0` when the credit fails. If a text assertion
  is kept for the claim predicate, assert `.lte('next_run_on'` is **present**,
  which is the direction that fails when someone removes the guard rather than
  when someone adds it.
- **Status:** OPEN

---

### [CLAUDE-4][INFO][TESTS] The three text-guard instances found in this audit, in one place

For Claude-1, since they are one class and want one decision:

| guard | asserts | what it is green over |
|---|---|---|
| `tests/wallet-allowance-persistence.test.ts:13` | the exact blind-update string | the allowance double-pay, **and it blocks the fix** |
| `tests/allowance-cron-idempotency.test.ts:11` | the cron file carries the claim predicate | the identical server action forty lines away, which does not |
| `tests/route-plan-gate.test.ts:147-150` | each route's source contains `refuseUnlessEntitled(` and the href literal | three routes whose href was absent from the catalog, so the gate allowed everyone |

The common repair is one line per file, and it is the same line each time:
after asserting the text, assert the thing the text is supposed to achieve —
resolve the href through `tiersByHref`, or run the function against the
in-memory client, or glob every file that performs the write rather than naming
one. Each of the three has a sibling in the same file that already does this
(`tests/route-plan-gate.test.ts`'s first `describe` drives the real route and
asserts a `403`), so the harness exists in every case.
- **Status:** OPEN

---

## Sweep 7 — the wallet balance is computed two ways, and only one of them is safe

A child's spendable balance is derived from the immutable ledger. Three places
derive it:

| where | how | bounded? | locked? |
|---|---|---|---|
| `wallet_reserve_card_auth` (`0155`) — Stripe card authorization | `sum(...)` in SQL | yes | `FOR UPDATE` on the bucket |
| `wallet_decide_spend` (`0205`) — a parent approving a held request | `sum(...)` in SQL | yes | `FOR UPDATE` on the bucket and the txn |
| `bucketBalanceCents` (`lib/wallet/server.ts:285`) — the in-app spend path | fetch every row, `reduce()` in JS | **no** | **no** |

F-019 raced the first of those and proved it right. The third had never been
raced, and it is the one a parent uses from the app.

---

### [CLAUDE-4][CRITICAL][MONEY] The in-app spend path reduces the ledger in JavaScript with no row bound and no lock — it overdraws a wallet two different ways

- **File:** `lib/wallet/server.ts:285-300` (`bucketBalanceCents`) and
  `:309-340` (`debitSpendBucket`), reached from
  `app/(app)/wallet/actions.ts:705,729` (`requestSpendAction`)
- **Problem — two independent defects in the same eight lines.**

  **(1) The read is unbounded.** `bucketBalanceCents` is:

  ```ts
  const { data: txns } = await supabase.from('wallet_transactions')
    .select('direction, amount_cents, status')
    .eq('family_id', params.familyId).eq('bucket_id', bucket.id);
  const available = (txns ?? []).reduce(…);
  ```

  No `.limit()`, no `.range()`, no `readAll`. `lib/supabase/read-all.ts` states
  the consequence in its own header, with the project's own measurement:
  *"PostgREST answers an unbounded `select()` with at most `db-max-rows` — 1,000
  on a default Supabase project — and says nothing about it… a table holding
  2,011 rows returns exactly 1,000 to an unbounded select."* `wallet_transactions`
  is append-only and grows forever: one row per bucket per credit, plus a hold
  and a settlement per card purchase.

  **(2) The check-then-write is not atomic.** `debitSpendBucket`'s only overdraw
  guard is `if (!params.requiresApproval && amount > available)`, computed from
  that read, followed by a plain `.insert(...)` over a separate HTTP round trip.
  No `FOR UPDATE`, no RPC, no constraint. This is the one spend path in the
  wallet that does not go through a locking SQL function.
- **Evidence — both raced/measured on the 310-migration replay.**

  *(1) truncation.* One spend bucket, one year of an active teen: 52 weekly
  `$20` allowance credits and 1,000 `$1` card debits — 1,052 rows.

  ```
  ledger rows in this one bucket:                                        1052
  TRUE balance — the SQL sum wallet_reserve_card_auth uses:              4000   ($40.00)
  what bucketBalanceCents() reduces if PostgREST returns db-max-rows:    9200   ($92.00)
  ```

  The credits are early in the heap and the debits are late, so the rows the cap
  discards are debits: the app reports **$92.00 available against a real $40.00**,
  and `debitSpendBucket` will approve any spend up to $92.

  *(2) concurrency.* Fresh bucket, seeded `$10.00`, two simultaneous `$8.00`
  direct (no-approval) spends, each session doing exactly what the two functions
  do — read the whole bucket, reduce, then insert:

  ```
  each session saw available = 1000
  each session saw available = 1000
   debits_posted | balance_cents
  ---------------+---------------
               2 |          -600
  ```

  Two approvals, balance **−$6.00**. This is the identical scenario F-019 ran
  against `wallet_reserve_card_auth`, where *"1 of 2 simultaneous $8
  authorizations approved against $10"*. Same money, same wallet, opposite
  answer, because this path has no lock.
- **Impact:** `requestSpendAction` sets
  `needsApproval = !manager || amount > threshold || decision.effect !== 'allow'`.
  A **parent** spending at or under the household's `require_approval_over_cents`
  (default `5000` = $50) with an allowing trust decision takes the
  `requiresApproval: false` branch, so the debit posts `completed` immediately
  with no second check anywhere — the RPC recheck in `wallet_decide_spend` only
  runs on the *approval* branch. So both defects land on the path that moves
  money without a second pair of eyes. Defect (1) is silent, permanent and grows
  with the family's history; defect (2) needs only two tabs or a double submit.
  `tests/wallet-overspend-probe.test.ts` and
  `docs/audit/wallet-overspend-check.sql` both exercise the **RPC**, not this.

  The action's own docstring is the claim both defects break —
  `app/(app)/wallet/actions.ts:682`: *"**Never overdraws: the requested amount
  must fit the current Spend balance.**"*

  Scope, checked rather than assumed: every other money movement in the wallet
  goes through a locking SQL function — `sendMoneyAction → transferWallets →
  wallet_transfer`, `fundGoalAction → fundGoal → wallet_fund_goal`,
  `decideSpendRequestAction → decideSpend → wallet_decide_spend`, the Stripe
  authorization through `wallet_reserve_card_auth`. `debitSpendBucket`'s
  no-approval branch is the single exception.
- **Fix:** make the third path the same as the other two — compute the balance in
  SQL under the bucket lock. There is already a function shaped for it: extend
  `0205`'s pattern with a `wallet_post_direct_spend(p_family, p_child_wallet,
  p_amount, …)` that takes `FOR UPDATE` on the bucket, re-sums, and inserts or
  returns `insufficient_funds` — then `debitSpendBucket`'s no-approval branch
  calls it and `bucketBalanceCents` is left to do what its name says: report a
  number for display. As an immediate, independent mitigation for (1), a balance
  read must never be an unbounded `.select()` — either `readAll(...)` it or, far
  better, `select('amount_cents.sum()')`/an RPC so the sum never crosses the
  wire. Guard: replay the 1,052-row probe above in CI (it needs no PostgREST —
  the divergence is `sum(all)` vs `sum(limit 1000)`), and add the two-connection
  race beside `docs/audit/wallet-concurrency-check.sql`, which already has the
  `dblink_send_query` harness for exactly this.
- **Status:** OPEN

---

### [CLAUDE-4][LOW][DEAD-CODE] `childSpendableCents` is exported, documented as the real-time card-authorization check, and called by nothing

- **File:** `lib/wallet/server.ts:113-135`
- **Problem:** its docstring says *"This is what a card authorization is checked
  against in real time."* It is not: card authorizations go through
  `reserveCardAuth` → `wallet_reserve_card_auth`, which does its own SQL sum
  under a lock. `rg -n "childSpendableCents"` across `app/`, `lib/`,
  `components/` and `tests/` returns the definition and nothing else.
- **Impact:** none today — it is dead. It matters because it carries the same
  unbounded read as `bucketBalanceCents` and a comment that would invite a future
  caller to trust it for a money decision.
- **Fix:** delete it, or if it is wanted for display, fix the comment and give it
  the bounded read.
- **Status:** OPEN

---

## Sweep 8 — date arithmetic at the edges

Executed, not reasoned: `lib/wallet/allowance.ts` and `lib/services/scope.ts`
bundled with esbuild and driven over month ends, both DST transitions, a leap
day, a year boundary and the ±14-hour zone extremes.

---

### [CLAUDE-4][LOW][EDGE-CASE] A monthly allowance set on the 31st moves to the 28th in February and never moves back

- **File:** `lib/wallet/allowance.ts:14-24` (`nextRunDate`), used by
  `saveAllowanceRuleAction` and by both allowance runners through `rollForward`
- **Problem:** the clamp is correct for one step and wrong as a series. It reads
  the day-of-month off `fromIso`, which on every run after the first is the
  **already-clamped** date:

  ```ts
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  ```

  The rule has no memory of the day the parent chose, so February's clamp is
  permanent.
- **Evidence:**

  ```
  nextRunDate(2026-01-31, monthly) -> 2026-02-28      (correct for one step)
  the series from 2026-01-31:
    2026-01-31 -> 2026-02-28 -> 2026-03-28 -> 2026-04-28 -> 2026-05-28 -> 2026-06-28 -> 2026-07-28
  ```

  Every other case checked is right: `2026-03-31 → 2026-04-30`,
  `2026-12-31 → 2027-01-31` (year rollover), `2024-01-29 → 2024-02-29` (leap),
  `2024-02-29 → 2024-03-29`. Weekly and biweekly are pure UTC-millisecond
  arithmetic and are unmoved by both 2026 DST transitions
  (`2026-03-05 → 2026-03-12`, `2026-10-29 → 2026-11-05`).
- **Impact:** small and permanent. A parent who sets "the last day of the month"
  gets it three days early for the rest of the child's life, and the drift is
  invisible — `next_run_on` simply says the 28th.
- **Fix:** store the intended day-of-month on the rule (or derive it from the
  rule's `created_at`) and clamp from that each time, rather than from the
  previous run date. Two lines, plus a column.
- **Status:** OPEN

---

### [CLAUDE-4][INFO][EDGE-CASE] The rest of the date arithmetic is right at every edge checked

- **Evidence:**

  ```
  addDaysToDayKey(2026-10-26, 7) -> 2026-11-02     (the DST week finalaudit measured; fixed-ms addition lands on 11-01 23:00)
  addDaysToDayKey(2026-02-27, 2) -> 2026-03-01     (non-leap month end)
  addDaysToDayKey(2024-02-27, 3) -> 2024-03-01     (leap month end)
  weekStartDayKey(2026-01-01)    -> 2025-12-29     (week start across a year boundary)

  instant 2026-09-14T01:30:00Z
    dayKeyInTz(America/Los_Angeles)   -> 2026-09-13
    dayKeyInTz(Asia/Tokyo)            -> 2026-09-14
    dayKeyInTz(Pacific/Kiritimati +14)-> 2026-09-14
    dayKeyInTz(Pacific/Midway    −11) -> 2026-09-13
  ```

  `rollForward` also behaves as documented under a long gap:
  a weekly rule six weeks overdue returns `{runs: 1, next: 2026-09-19}` at
  `maxRuns: 1` (what both runners pass) and `{runs: 7, …}` uncapped — it pays one
  period and discards the backlog rather than minting seven credits, which is
  what the header says it does.
- **Status:** VERIFIED

---

## What I traced and found CORRECT

Recorded at the same weight as the defects, because "we checked" and "we could
not see" must not read the same.

### [CLAUDE-4][INFO][FLOWS] The run/step state machine is consistent with the database that stores it

- `lib/ai/runs/states.ts` declares 14 run states and 14 step states. Checked
  against the **replayed** catalogue rather than the migration text:
  - `ai_plan_steps_status_check` — 14 values, exactly `STEP_STATES`.
  - `family_automation_runs_state_check` — 14 values, exactly `RUN_STATES`,
    `paused` included.
  - `ai_requests_status_check` — 13 values, **no `paused`**, which is the one
    place the two vocabularies differ. The executor handles it at the only
    boundary where it can bite: `executor.ts:1301`,
    `status: state === 'paused' ? 'blocked' : state`, with the reason written
    beside it. Nothing else writes a run state to `ai_requests`.
  - `completed` and `cancelled` have empty transition lists in both tables —
    one-way doors, so a finished run cannot silently re-execute its writes.
- No defect found. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] Every nav destination resolves to a real page

- All **183 distinct href literals** in `lib/constants/navigation.ts` (`APP_NAV_GROUPS`, `PRIMARY_NAV`
  and its `children`, `MOBILE_TABS`, `ADMIN_NAV`, `SIDEBAR_FOOTER_NAV`,
  `DASHBOARD_NAV`, `MARKETING_NAV`) and all **102 distinct `href` values** across the 105 entries of
  `FEATURE_CATALOG` were resolved against the 395 real `page.tsx` routes.
  **Zero dead links, in either list.** `ADMIN_NAV`'s promise — *"every entry here
  must point at a real, working page. No 'coming soon' stubs"* — holds.
- Of the 353 static page routes, 22 are never named as a path literal outside
  their own folder. Checked one by one: 9 are marketplace tabs reached through a
  `${BASE}/…` template in `components/marketplace/marketplace-nav.tsx`, 4 are
  deliberate `redirect()` de-duplication stubs with the reason in the file
  (`/admin/tiers`, `/dashboard/family-ai-assistant`,
  `/dashboard/family-knowledge-graph`, `/dashboard/family-memory`), 2 are
  super-admin analytics that gate themselves with `isSuperAdmin() → notFound()`
  (`/dashboard/journeys`, `/dashboard/onboarding-funnel`), and the remainder are
  reachable by URL by design. Only `/dashboard/app-store` is a genuine orphan,
  and it has its own finding above. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] The recipe → grocery list path scales and dedupes correctly

- `components/modules/recipes-module.tsx:180-200`: the servings adjuster is
  applied — `multiplier = (servingsOverride ?? recipe.servings) / recipe.servings`
  feeds `scaleQuantity` per ingredient — and the service skips ingredients already
  on the list by normalised name and reports how many it skipped
  (`groceryAddWasNoOp` / `describeGroceryAdd`). The one defect on this path is the
  discarded read error, recorded above. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] The Pay-ID resolver does not leak whether a handle exists

- `app/pay/[handle]/page.tsx` returns the identical "no active gift link" page for
  an unknown handle, a deactivated handle, and a handle whose links are all
  revoked — no timing branch, no distinct copy, no redirect that would reveal the
  difference. The page it forwards to is the one with the message-disclosure
  defect, which is a separate finding. **VERIFIED**

### [CLAUDE-4][INFO][PERFORMANCE] N+1 and unbounded-read sweeps found no new systemic defect beyond the wallet one

- **N+1:** 56 candidate sites (a query awaited inside a `for…of` or a
  `.map(async …)`). Read: the sync engines iterate pulled provider events (one
  round trip per event is inherent to the protocol), the marketing and autopilot
  runners are crons whose per-row isolation is deliberate and commented, and
  `lib/network/aggregate-server.ts` — which looks like the worst offender — turns
  out to batch every read through `buildContributionsBatch` and only loops for the
  per-family upsert, for stated isolation reasons. No page render path does a
  query per row.
- **Sequential awaits on a render path:** only 4 of 395 `page.tsx` files issue 6
  or more separately-awaited queries, and in three of them the queries are
  genuinely dependent (`app/gift/[token]` must read the link before it can read
  the wallet before it can read the member). `settleAll` is used in 155 files.
- **Unbounded reads:** 63 `.select()` calls on per-family growing tables lack a
  `.limit()`. All but one class are bounded by something else — a date window, an
  `.in(ids)`, a `count: 'exact', head: true`, or `maybeSingle()`. The exception is
  the wallet balance, which is the CRITICAL above. The rest of the list is worth
  a pass by the owner for *display* truncation (a family with more than
  `db-max-rows` documents or transactions silently sees a partial list), but no
  other one of them decides anything.
- **Notification fan-out at 12 members:** `lib/server/notifications.ts` emits one
  row per manager per expiring document and per schedule conflict, which is
  members × items — but every source list is bounded by a date window, and the
  dedupe read is chunked 50 ids at a time with the reason written out (a longer
  batch overflows the gateway's URI limit, returns empty, and re-inserts every
  candidate — *"observed exactly that, every run"*). Correct at 12 members.
- **VERIFIED**
