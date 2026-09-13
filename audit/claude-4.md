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
