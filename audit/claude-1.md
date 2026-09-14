# Claude-1 — Coordinator · Architecture · Integration

> **Two sessions ran this board against one repository.** Both answered the
> same `/goal` and each created `audit/claude-*.md`; the files collided on
> merge. Nothing is dropped — this file carries **both** sets of Claude-1
> findings, in the order they reached the branch. Where they overlap it is
> said so rather than silently deduplicated.

---

# Part A — findings that reached `main` first


Owned by Claude-1. No other worker writes findings here.

Severities: CRITICAL, HIGH, MEDIUM, LOW.
Statuses: OPEN, VERIFIED, FIXED, BLOCKED.

Evidence means something reproducible — a command, an output, a probe, a
measurement. An assertion is not evidence, and this file says so because the
largest finding below is precisely a case of an assertion standing in for one
for the entire life of the repository.

---

## Findings

### [CLAUDE-1][CRITICAL][ARCHITECTURE] The documented production-recovery procedure did not work

- **File/path:** `docs/runbooks/LB-016-wallet-permissive-policy-finding.md` §4.1;
  18 files under `supabase/migrations/`; `.github/workflows/ci.yml`
- **Problem:** LB-016 §4 is the procedure an operator follows to unblock
  production. It rests on the claim that every migration is idempotent, so
  `supabase db push` can replay from `0004` over a database that already carries
  the schema. Nothing had ever tested that claim. It cited two things as proof
  and neither showed what it was cited for: `tests/migrations-are-additive.test.ts`
  bans `DROP TABLE`/`COLUMN`/`TRUNCATE`/`TYPE` (additive, not idempotent), and the
  CI replay ran against an **empty** database, where `create policy` has nothing
  to collide with.
- **Evidence:** `docs/audit/rehearse-ledger-repair.sh` reproduces production's
  condition (full schema, ledger holding only `0001`–`0003`) and replays from
  `0004` as `db push` does. Against the history as it stood:

      re-applied cleanly (no-op as claimed): 286
      FAILED:                               18
      stops at 0004_rls.sql :: policy "profiles_insert_self" already exists
      0004 recorded: 0  -> requiresBaselineReview would still be TRUE

- **Impact:** The operator would have spent a maintenance window and come out
  with the ledger no more repaired than when they started, the release still
  blocked, and no indication which of the remaining 17 files would stop them
  next. `create policy` has no `IF NOT EXISTS` form in any Postgres version, so
  there was no way for those files to be safe to re-run.
- **Recommended fix:** applied. Each of the 18 now follows the convention its own
  neighbours already used (`drop policy if exists` first, `create or replace
  trigger`, `create index if not exists`, `create table if not exists`, `add
  column if not exists`, `create or replace function`, a `pg_publication_tables`
  check around publication adds). `0018` needed its drop inside an
  `execute format(...)` loop. `0226` needed its 525 `LoremFlickr (CC)` hero rows
  seeded NULL, because `0238`'s licence trigger — already installed when a
  populated replay reaches `0226` — rejects them.
- **Status:** FIXED — rehearsal reports 0 failures, `0004` records, guard clears
  on its own; from-scratch replay unchanged at 307/0. Landed on main `c6006f58`.

### [CLAUDE-1][HIGH][ARCHITECTURE] Nothing enforced migration idempotency, so it could regress silently

- **File/path:** `.github/workflows/ci.yml`, `docs/audit/rehearse-ledger-repair.sh`
- **Problem:** The finding above was a class, not an incident. The CI replay
  structurally could not observe idempotency, so any future migration could
  reintroduce it and CI would stay green until an operator hit it in a window.
- **Evidence:** Added a deliberately unguarded `create policy` as `0999` and ran
  the two CI steps in order — the existing from-scratch replay passed it without
  complaint, the new step failed by name and exited 1:

      == migrations applied: 308, failed: 0 ==      <- existing replay is happy
      FAILED: 1
        0999_tmp_regression_probe.sql :: policy "tmp_regression_probe" already exists
      REHEARSAL EXIT=1

- **Impact:** Without the gate, production recovery quietly decays again.
- **Recommended fix:** applied. The rehearsal is the last step of the
  `Database (migration replay · RLS boundary probes)` job. It runs last because
  it rewrites the ledger; it is valuable because the job's earlier step already
  applied every migration once, so this applies each a **second** time — a new
  migration is checked on the PR that introduces it. Confirmed live: the
  rehearsal's output appears in #541's CI Database job.
- **Status:** FIXED — verified green in CI, and verified to fail on a planted regression.

### [CLAUDE-1][HIGH][INTEGRATION] Two branches independently claimed migration version 0295

- **File/path:** `supabase/migrations/0295_reward_redemption_decision_guard.sql` (main, #542)
  vs `supabase/migrations/0295_social_access_delete_matches_grant.sql` (#541)
- **Problem:** `supabase_migrations.schema_migrations` has a PRIMARY KEY on
  `version`. Two files sharing `0295` means `db push` dies on the second with
  `duplicate key value violates unique constraint "schema_migrations_pkey"` —
  the exact failure `tests/migration-version-safety.test.ts` exists to prevent,
  which could not see it because the two files were on different branches.
- **Evidence:** `git diff --name-only origin/main...origin/claude/roadmap-implementation-ld8bon
  -- supabase/migrations/` returned the second `0295`. After merging, both sides
  had independently bumped the expected `nextVersion` to `0296` for their own file.
- **Impact:** Would have blocked production migration apply — on the very path
  F-001 is already blocked on.
- **Recommended fix:** applied. #541's file renumbered to `0296` with its
  references moved (`finalaudit.md` I-01, `docs/audit/social-access-symmetry-check.sql`,
  the range sentence in `docs/PENDING_PROD_MIGRATIONS.md`); `nextVersion` now `0297`.
- **Status:** FIXED on #541's branch. `db:audit:migrations` passes at 309 files.

### [CLAUDE-1][HIGH][INTEGRATION] A merge would have reopened the child-self-approval hole

- **File/path:** `components/modules/rewards-module.tsx`
- **Problem:** #510 (`codex/final-production-audit-20260912`) still wrote to
  `reward_redemptions` directly from the browser, choosing `status` and
  `decided_by` client-side. main (#542) had replaced both paths with
  `requestRedemptionAction` / `decideRedemptionAction` precisely because a child
  could approve their own reward. Taking the branch's side on the merge conflict
  would have silently reverted a security fix.
- **Evidence:** the conflict hunk contained
  `status: canManage && forMemberId === selfMember?.id ? 'approved' : 'requested'`
  and `decided_by: ... selfMember?.id` on an unguarded PostgREST insert.
- **Impact:** Reintroduced privilege escalation for any family member with a JWT.
- **Recommended fix:** applied — main's side taken;
  `grep -c "from('reward_redemptions').insert\|.update"` now returns 0.
- **Status:** FIXED on #510's branch.

### [CLAUDE-1][MEDIUM][SECURITY] `/api/contact-center` was public as a prefix, not as exact paths

- **File/path:** `lib/auth/route-access.ts`, `middleware.ts`
- **Problem:** main listed `/api/contact-center` in the PUBLIC prefix list, so
  `matchesPrefix` makes every present and future route under it reachable without
  a session. Only the five inbound webhooks need that.
- **Evidence:** #510's own test asserts it —
  `tests/middleware-public-api-boundary.test.ts:200`,
  `expect(middleware).not.toContain("'/api/contact-center'")` — and it failed on
  the merged tree.
- **Impact:** Today the prefix and the exact set are equivalent (the five routes
  are all that exist). The defect is prospective: a future
  `/api/contact-center/settings` or `/history` would be born public.
- **Recommended fix:** applied — the prefix removed; the five webhooks stay
  reachable through middleware's exact `PUBLIC_CONTACT_CALLBACKS` set, with
  main's reason for making them reachable preserved in the comment.
- **Status:** FIXED on #510's branch; the test that forbids regression passes.

### [CLAUDE-1][MEDIUM][TESTING] A runtime gate fails on this Node and passes on CI's

- **File/path:** `tests/stream-cancellation-runtime.test.ts`
- **Problem:** The test asserts the installed Node carries Node PR62040, which
  fixes an internal error when client cancellation and a late SSR write
  interleave. It fails on Node v22.22.2 and passes on the CI runner's Node 22.x.
- **Evidence:** fails identically on #510's branch **without** my merge (checked
  in a separate worktree), so it is not merge-induced:
  `TypeError: controller[kState].transformAlgorithm is not a function`.
- **Impact:** The suite's result depends on the runner's Node patch version. It
  will turn CI red the moment the runner image moves to a Node without the fix,
  and it currently gives a false "all green" impression to anyone running
  locally on an affected Node.
- **Recommended fix:** pin the Node version in CI and in `package.json` engines,
  or make the test skip with a clear notice on a runtime lacking the fix rather
  than fail — a check that cannot run is not a check that found a problem.
  Not applied: the file belongs to #510's active session.
- **Status:** OPEN — reported, not fixed (worker collision; see rule 9).

### [CLAUDE-1][HIGH][DATABASE] Production schema cannot be reached from any agent

- **File/path:** `docs/PENDING_PROD_MIGRATIONS.md`, `docs/runbooks/LB-016-…md` §4
- **Problem:** Production's ledger records only `0001`–`0003` against a schema
  hundreds of tables ahead, so every release touching `supabase/` halts at
  `scripts/audit-production-migration-state.mjs`.
- **Evidence:** no `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` /
  `SUPABASE_DB_PASSWORD` in the environment or `.env.local`; no `supabase` CLI in
  the sandbox; `NEXT_PUBLIC_SUPABASE_URL` points at `127.0.0.1`.
- **Impact:** Code fixes deploy on merge; schema fixes do not. Any finding whose
  remedy is a migration is only half-live in production.
- **Recommended fix:** operator action, unchanged. What changed this pass is that
  the procedure is now proven to work end to end rather than asserted.
- **Status:** BLOCKED — permanently, for agent workers. Not a defect to fix here.

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The audit record told a future worker to revert a shipped fix

- **File/path:** `finalaudit.md` F13; `lib/auth/route-access.ts`; `middleware.ts`
- **Problem:** F13 recorded "unknown top-level paths redirect to login" and
  closed it *"By design — no change"*, adding that "weakening auth routing is
  off-limits". main #544 then shipped exactly the behaviour F13 said would not
  be changed. The record and the code now said opposite things, and the record
  was the more emphatic of the two.
- **Evidence:** F13's text — "Deliberately **not changed**" — against
  `middleware.ts:74`, `const isProtected = !isPublic && matchesPrefix(path, PROTECTED);`
  which routes an unlisted path to the router (404) rather than `/login`.
- **Impact:** This is the failure mode an audit document is *for* preventing. A
  worker reading F13 would conclude #544 weakened auth routing and could revert
  it. The class is worse than the instance: a stale "closed as unavoidable"
  entry is an instruction, not just a stale note.
- **Recommended fix:** applied. F13 is marked superseded, with why the trade-off
  it described was not actually the choice: #544 added a third state. A path is
  now public, protected, or *neither* — and "neither" is a path with no route,
  which 404s. Fail-closed routing for real app routes is unchanged.
- **Status:** FIXED in `finalaudit.md`. No code changed.

### [CLAUDE-1][OBSERVATION][PROCESS] The recurring defect class in this repository is the vacuous guard

- **File/path:** repository-wide
- **Problem:** Not a defect in itself — a pattern across findings, recorded here
  because it should steer the three passes that have not started.
- **Evidence:** F-004 (a money-boundary probe that could not catch F-003),
  F-011 (the fix for F-008 carrying F-008's own defect), F-015 (a probe granting
  itself privileges and leaving them), F-019 (a concurrency probe that ran two
  statements sequentially), F-020 (a replay that could only ever run against an
  empty database), Pass C's sweep (matching only single-line statements, blind to
  both findings it was meant to catch), and an index test that could not see
  `UNIQUE`/`PRIMARY KEY` declarations.
- **Impact:** A guard that cannot fail is worse than no guard: it converts "we
  did not look" into "we checked", and it is the reason several of these defects
  survived multiple audits.
- **Recommended fix:** for Claude-2/3/4 — for every guard you rely on or add,
  break the thing it protects and confirm it goes red. If it stays green, that is
  the finding. This is already the house standard in Pass C–F's verification
  tables; it should be applied to guards nobody has questioned yet.
- **Status:** VERIFIED — the pattern holds across eight independent findings.

### [CLAUDE-1][VERIFIED][SECURITY] The service-role boundary holds — proven by planting a violation

- **File/path:** `lib/supabase/server.ts`, `lib/network/benchmarks-server.ts`,
  `.next/static/**`
- **Problem investigated:** 197 modules carry `import 'server-only'`; the module
  that mints the **service-role** client (which bypasses RLS entirely) did not.
  The question was whether a client component could pull the admin client, and
  whether the key could reach a browser.
- **Evidence — three separate measurements, one of which corrected the other two:**
  1. **The key value does not reach the browser.** Searched the actual 164-char
     `SUPABASE_SERVICE_ROLE_KEY` value across every emitted client chunk in
     `.next/static/` — absent. The three occurrences of the *name* are i18n
     operator-remedy strings, not env reads.
  2. **My first probe was invalid and I nearly reported on it.** I planted the
     client page at `app/__audit_probe/page.tsx` and the build passed, which I
     briefly took as "the missing guard is exploitable". It was not: a folder
     beginning with `_` is a Next **private folder**, excluded from routing, so
     the page was never compiled. The route table in the build log does not
     contain it. Two "compiled successfully" results meant nothing.
  3. **Re-run at `app/auditprobe/page.tsx`, the boundary holds — and held before
     my change.** With the guard: build fails, `You're importing a component that
     needs "server-only"`. Control with the guard removed: build **also** fails,
     `You're importing a component that needs "next/headers"`. So the module was
     already unimportable from a client component.
- **Impact:** No open vulnerability. The finding downgrades from the MEDIUM I
  first suspected to **LOW**, and the substance changes: the protection is real
  but *incidental*. It comes from `createServer()` needing `cookies`, not from
  any declared boundary. `createServiceClient()` does not need cookies, and 493
  modules import this file mostly for that one function — so splitting it out is
  a plausible refactor that would silently remove the only thing keeping the
  admin client out of a client bundle.
- **Recommended fix:** applied, as hardening rather than a fix — both modules now
  state the boundary instead of inheriting it. The comments say plainly that they
  close no currently-open hole, so nobody later mistakes them for a patched
  vulnerability.
- **Status:** VERIFIED (boundary sound) · FIXED (declaration added).
  `tsc` clean, build exits 0, 13,593 tests pass.

**Method note, since this file argues for it elsewhere:** the control run is what
made this finding honest. Had I stopped at "build fails with the guard", I would
have reported a vulnerability I had closed, when the truth is that it was never
open and I added a seatbelt. Running the *negative* case is the same discipline
this audit recommends for every guard — it just cuts the other way here.

### [CLAUDE-1][HIGH][INTEGRATION] The health endpoint reported `ok` while every scheduled job was dead

- **File/path:** `lib/health/status.ts`, `app/api/health/route.ts`,
  `lib/server/cron-auth.ts`, `vercel.json`
- **Problem:** `REQUIRED_ENV` holds three names — the Supabase triple. Six
  secrets that gate entire shipped subsystems were in no tier at all, so their
  absence was invisible to the one endpoint whose job is to say whether the
  deployment is working.
- **Evidence:**
  - `vercel.json` declares **24** cron jobs. All 24 routes call
    `hasCronAuthorization`, and all 24 branch on it (verified per-file, after a
    first scan of mine returned 22 false positives because my pattern omitted the
    real helper name — the Pass D trap, committed by the person who wrote it up).
  - `hasCronAuthorization` is correctly fail-closed: `!!secret && …`. With
    `CRON_SECRET` unset, every job answers **401** — not 503, not an exception.
  - `childSignInAction` returns `kidSignInIsnT` before reading anything when
    `CHILD_LOGIN_SECRET` is unset: no child in any family can sign in.
  - `summarizeHealth` had no branch for any of this, so `/api/health` answered
    `ok` / 200 in both cases.
- **Impact:** A production deployment missing one env var loses nightly
  notifications, wallet allowance, chore reminders, the weekly digest, autopilot
  scan, return reminders, calendar feeds and marketing sends — or child sign-in
  entirely — and every monitor watching `/api/health` reports green. The failure
  is silent at exactly the layer built to make failures loud.
- **Recommended fix:** applied. A `FEATURE_ENV` tier, reported as
  **`degraded` / 200**, never 503. The existing comment was right that a disabled
  feature must not pull an instance from rotation — the gap was reporting, not
  severity. `degraded` already exists for precisely this ("signal it in the body
  for alerting"), and the file already used it for a present-but-invalid
  service-role key, whose comment describes this same shape.
- **Status:** FIXED. `tsc` clean; 13,603 tests pass; the 222 existing health
  tests unchanged.
- **Proved load-bearing:** `tests/health-feature-secrets.test.ts` (10 cases).
  Removing only the `degraded` branch fails exactly the two cases that assert it
  and leaves the other eight passing. Two cases exist to stop the fix drifting:
  one asserts feature secrets stay OUT of `REQUIRED_ENV` (so nobody turns this
  into a 503), one asserts every name in `FEATURE_ENV` is actually read by the
  codebase (so the list cannot go stale and decorative).

### [CLAUDE-1][HIGH][INTEGRATION] Five nightly jobs reported success while counting their own failures

- **File/path:** `app/api/cron/{feedback-github-sync,library-feeds,automations,marketing-social,marketing}/route.ts`
- **Problem:** Each of these counted failures and then answered
  `{ ok: true, … }` with HTTP **200**. Four did it through
  `{ ok: true, ...summary }`, where the failure counter is not visible in the
  response literal at all.
- **Evidence:**
  - **0 of 24** cron routes write a durable run record — verified across the
    directory. Vercel Cron's HTTP status is therefore the only signal a run
    failed, and `/api/health` (before the fix above) could not see cron at all.
  - The counters are real and do increment: `library-feeds` `failed++` at two
    sites; `runAutomations` → `failures`; `runDueRecurringAds` → `failures`;
    `processMarketingGenerationJobs` → `failed`; `runGithubFeedbackSync` →
    `errors`.
  - 19 of the 24 already answer **502** on failure — the house pattern from
    F-009 — so these five were the inconsistent ones, not a deliberate design.
- **Impact:** A run in which every item failed was indistinguishable from a clean
  run. Library feeds could stop refreshing, marketing automations stop firing,
  recurring ads stop posting, and the marketing job worker fail every claimed
  job, with the scheduler recording success each night.
- **Recommended fix:** applied — each derives `ok` from its own counter and
  answers 502 when non-zero. Two things deliberately left alone: an unconfigured
  integration (`configured: false`, `wallet_not_deployed`) is a clean run and
  stays 200; and `persistenceFailed` in the marketing worker already throws, so
  it correctly arrives as a 500.
- **Status:** FIXED. `tsc` clean, 13,609 tests pass.
- **Proved load-bearing:** `tests/cron-failed-runs-are-visible.test.ts`. Each of
  the five fixes was reverted **individually** and the test failed naming that
  file, five for five.

**Method note.** My first version of this test flagged six routes, two of them
wrongly — `{ ok: true, sent: 0, reason: 'no activity in the last 24h' }` is a
legitimate nothing-to-do run. The rule that works is narrower: *reporting success
in the same response that carries a failure counter*. A second case covers the
spread form specifically, because `{ ok: true, ...summary }` is how four of these
hid — the counter never appears in the literal, so any check reading the response
shape alone misses them. That is the third time in this session a text scan of
mine was wrong before it was right; each one is now a test instead.

### [CLAUDE-1][MEDIUM][INTEGRATION] The mobile bundle was safe only by accident, and nothing checked it

- **File/path:** `mobile/metro.config.js`, `mobile/src/lib/{db,supabase}.ts`,
  `lib/database.types.ts`, `.github/workflows/ci.yml`
- **Problem:** Metro bundles only what it **watches**. `mobile/metro.config.js`
  adds the repo's `design` and `shared` folders for exactly that reason. But
  `mobile/src` imports from a third root — `../../../lib/database.types` — which
  is **not** watched. That works today only because both sites use `import type`
  and the target has no runtime exports, so TypeScript erases it before Metro
  sees it. Nothing enforced any part of that.
- **Evidence:**
  - Out-of-package imports from `mobile/src` + `mobile/app` land in three roots:
    `design`, `lib`, `shared`. `watchFolders` contains only `design` and
    `shared`.
  - Both `lib` imports are `import type`; `lib/database.types.ts` has 0 runtime
    exports (131 type/interface exports, no enums).
  - CI's mobile job runs `npm run typecheck` and `npx expo config` — and
    `grep -n "expo export\|metro" .github/workflows/*.yml` returns nothing.
    **No CI job bundles the mobile app.** `tsc` resolves the path happily, so
    every check stays green.
- **Impact:** Changing one `import type` to `import`, or adding a single runtime
  export (an enum, a const) to `database.types.ts`, breaks the mobile bundle with
  CI fully green. The failure first appears in a real or EAS build — the slowest,
  most expensive place to discover it. The `shared/` folder is genuinely shared
  (mobile and web both consume `shared/auth/refresh-fetch`), so this boundary is
  load-bearing rather than vestigial.
- **Recommended fix:** applied — `tests/mobile-imports-stay-bundleable.test.ts`.
  It reads the watch list **out of `metro.config.js`** rather than hardcoding a
  copy, so the test tracks the config instead of drifting from it.
- **Status:** FIXED. `tsc` clean, 13,614 tests pass.
- **Proved load-bearing against all three regressions it claims to catch:**
  1. `import type` → `import` on the unwatched root: 2 cases fail, naming `lib`.
  2. A runtime export added to `database.types.ts`: the erasability case fails.
  3. `shared` removed from `watchFolders`: 3 cases fail.
  It also carries a case asserting the parser finds any escaping imports at all —
  a silently-matching-nothing parser would make every other case vacuous, which is
  this repository's signature defect.

**Recorded as SOUND (not a defect):** Metro pins `nodeModulesPaths` to
`mobile/node_modules` with `disableHierarchicalLookup`, so the app cannot walk up
into the web app's different React version. `shared/` is genuinely shared by both
consumers. Both were checked and are correct.

---

# Part B — findings from the `claude/roadmap-implementation-ld8bon` session


Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-1 and by nobody else.

---
## Sweep 1 — one concept, two implementations

The question for this sweep: this codebase repeatedly builds a shared helper
*specifically* to stop two call sites drifting apart, and says so in the
helper's own comment. Did the call sites adopt it?

Census of the anti-drift helpers (files referencing each, across `app/`, `lib/`,
`components/`, `shared/`):

| helper | purpose | adopters |
|---|---|---|
| `settleAll` | a `Promise.all` that does not discard errors | 155 |
| `notify` | one notification path instead of raw inserts | 70 |
| `readAll` | reads past PostgREST's row ceiling | 27 |
| `logAudit` | one audit-trail write | 13 |
| `authenticateAI` | one AI-edge authenticator | 10 |
| `resolveFeatureEntitlement` | one entitlement answer for page **and** pipeline | 7 |
| `familyMediaPath` | one unguessable storage path | 7 |

Adoption is good. One of them was not adopted at the very place it was written
for, and that is finding 1.

---

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The AI edge has two authenticators, and nine routes depend on the untranslated one

- **File:** `app/api/ai/route.ts:45` (private `authenticate`) vs `lib/server/ai-access.ts:180` (`authenticateAI`)
- **Problem:** `lib/server/ai-access.ts` says in its own header that `authenticateAI`
  *"resolves both to the same `UserContext` and an RLS-bound client, **mirroring
  `app/api/ai/route.ts` so the two AI edges cannot drift in what they accept**."*
  The shared helper was written by mirroring that route — and that route never
  adopted it. It still has its own private `authenticate()`.
- **Evidence:** the two functions were read side by side. Every branch, code and
  status matches exactly: bearer → `invalid_token` 401 / `needs_family` 403 /
  `unavailable` 503; cookie → `signed_out` 401, then `ensureActiveFamily` and a
  re-resolve. **The authorization logic has not drifted.** What has drifted is
  the copy:

  | | `/api/ai/route.ts` | `lib/server/ai-access.ts` |
  |---|---|---|
  | needs-family | `tr('ai.finishSettingUpYourFamily')` | `'Finish setting up your family in Bubaly first.'` |
  | unavailable | `tr('ai.accountContextIsTemporarilyUnavailable')` | `'Account context is temporarily unavailable.'` |

  Six user-facing strings are hardcoded English in `ai-access.ts`
  (lines 122, 144, 150, 184, 186, 197), and they are served by **ten** route
  handlers: `/api/ai`, `/api/ai/requests`, `/api/ai/voice/transcribe`,
  `/api/ai/voice/speak`, and the six `/api/ai/runs/[id]/*` controls.
- **Impact:** every non-English user of those ten endpoints gets English on the
  failure path. It lands hardest on the mobile client, which is the caller these
  routes were built for: it sends a bearer token and **no cookie**, so
  `Accept-Language` is the only locale signal it has — and
  `getAIRequestTranslations(req)` already reads exactly that. The route that
  *does* translate is the one that does not use the shared helper.
- **Fix:** thread a `Translator` through `authenticateAI` and `assertAIAccess`
  (both already take an options object), defaulting to `getTranslations()`; lift
  the six strings into the catalogues; then delete `/api/ai`'s private
  `authenticate()` and call `authenticateAI` — which is what the comment claims
  is already true.
- **Status:** OPEN
- **Correction, mine:** **I made this marginally worse earlier today.** Pass L
  added the allowance message at line 150 and rewrote the `plan_required` copy at
  the same time, both as hardcoded English, matching the file's existing style
  rather than fixing it. Recording it here rather than quietly folding it into
  the fix.

---

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The i18n gate cannot see the surface that answers the mobile app

- **File:** `scripts/i18n-scan.mjs:26` (`GATED_SURFACES`)
- **Problem:** the gate that fails CI when a translated surface regains a
  hardcoded string covers `app-shell`, `marketing-header`, `marketing-pages`,
  `marketing-components`, `marketing-display-catalogs`,
  `marketing-public-pages`, `marketing-lib-copy`. **No entry covers `app/api` or
  `lib/server`.**
- **Evidence:** that key list is the whole of `GATED_SURFACES`. Finding 1's six
  strings sit in `lib/server/ai-access.ts` and the gate is structurally incapable
  of reporting them — this is not a rule that was broken, it is a surface the
  rule was never pointed at.
- **Impact:** the API layer is precisely where locale is hardest and matters
  most: a browser carries a cookie the server can read, and the Expo client
  carries neither cookie nor session — only `Accept-Language`. So the one surface
  with no fallback signal is the one with no gate.
- **Fix:** add an `api-errors` surface covering `app/api/**/route.ts` and the
  `lib/server/*` modules that return user-facing `error:` strings. The gate's own
  README says adding a surface is a promise — so lift the strings first, then
  add the surface, in that order.
- **Status:** OPEN

---

### [CLAUDE-1][HIGH][INTEGRATIONS] Guardian scam screening cannot say that it did not run

- **File:** `lib/guardian/scam-ai.ts:67` (`detectScamWithAI`), consumed by
  `app/api/guardian/inbound/sms/route.ts:79` and
  `app/api/guardian/inbound/whatsapp/route.ts:86`
- **Problem:** three separate paths return a **pattern-only** verdict, and the
  return type has no field that says so:

  ```ts
  const patternResult = detectScamFromText(transcript, callerNumber ?? undefined);
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return patternResult;                 // 1. AI unconfigured
  …
  return validateResult(parsed, patternResult);      // 2. model reply unparseable
  } catch { return patternResult; }                  // 3. provider threw
  ```

  `ScamDetectionResult` is `{ isScam, scamType, confidence, signals, recommendation }`
  — no `source`, no `degraded`, no `analyzedBy`. A regex verdict and a model
  verdict are the same object, **including `confidence`**.
- **Impact:** this is the surface that tells a family whether a message reaching
  their child is a scam. With no API key set — which is the state of any
  deployment that has not configured one — every inbound SMS and WhatsApp message
  is screened by pattern matching alone, and reported with a confidence number
  that reads as analysis. A family acts on `recommendation: 'safe'` believing the
  message was read; it was matched against a word list.
- **Evidence that this class is already understood here:**
  `app/api/behavior/insight/route.ts` carries a comment calling the same shape
  *"the sharpest silence on this list… it answers 200 with a warm sentence that is
  indistinguishable from coaching. Nothing recorded any of the three."* The
  recognition exists; it did not reach this file.
- **Fix:** add `source: 'ai' | 'patterns'` (and a `degradedReason`) to
  `ScamDetectionResult`; set it at each of the three fallbacks; record it on the
  stored screening row; and surface it to the family as *"screened by pattern
  matching — AI screening is unavailable"* rather than as a confidence. Log the
  provider failure, which today is swallowed by a bare `catch {}`.
- **Status:** OPEN

---

### [CLAUDE-1][INFO][ARCHITECTURE] Module layering is clean

- **Evidence:** `grep -rn "from '@/app/" lib shared` returns **0**. Nothing in
  `lib/` or `shared/` imports from `app/`, so the dependency direction is
  one-way and the `'use server'` RPC boundary reasoning in Pass N holds without
  exception.
- **Status:** VERIFIED

---
## Sweep 2 — integration failure modes

For each provider: when it is unconfigured or down, does the feature fail open,
fail closed, or fail *silently while claiming success*? The third is the shape
Pass C was built around, and the interesting place to look for it is at an
integration boundary rather than a database one.

**Mostly clean, and worth stating.** `twilioFetch` throws on any non-2xx and on
an unconfigured account (the SID interpolates to `undefined`, the URL 404s), so
Twilio fails loud rather than no-op. Three of the four `sendSms` call sites catch
and `console.error`. `hasEncryptionKey()` is checked before both sync OAuth
callbacks and redirects to `error=no_encryption_key` rather than storing an
unencrypted token. `isAIConfigured()` gates the assistant with a 503 and a code.

One path is not clean, and it is the emergency one.

---

### [CLAUDE-1][MEDIUM][INTEGRATIONS] An emergency escalation records parents as notified who were not

- **File:** `app/api/guardian/escalate/route.ts:112` (`notifiedIds.push`) vs `:115-120` (the send)
- **Problem:** the member id is pushed onto `notifiedIds` **before** anything is
  attempted, and the row is written with `notified_member_ids: notifiedIds`:

  ```ts
  const phone = m.user_id ? phoneMap.get(m.user_id) : null;
  if (!phone) continue;
  notifiedIds.push(m.id);          // ← recorded as notified here

  try {
    await sendSms(phone, smsText);
    smsSent = true;                // ← honest: only on success
  } catch { /* non-fatal */ }      // ← and no log at all
  ```

  `smsSent` is correct — it is set only after `sendSms` resolves, which is
  **C-02**'s fix applied properly. `notifiedIds` is the same defect one level
  down, and C-02 did not reach it.
- **Evidence:** `pushSent` comes from a single family-wide `notifications` row
  (`user_id: null`), inserted once outside the loop — so it is a family-level
  fact and cannot stand in for any individual member. `smsSent` is one boolean
  for the whole loop, so if the first parent's SMS succeeds and the second's
  throws, the row reads `sms_sent: true` with **both** parents in
  `notified_member_ids`. Nothing distinguishes them.
- **Impact:** `guardian_escalations` is the record of who was warned about a
  family emergency — read afterwards by the family, and by anyone asked why a
  parent did not respond. It can say a parent was notified when their SMS threw.
  And the bare `catch { /* non-fatal */ }` is the **only** send path in this
  codebase that discards the error without logging: the three Contact Center
  callers all `console.error`. So there is no way to reconstruct which parent
  was actually reached.
- **Fix:** track per-member outcomes rather than one boolean — push to
  `notifiedIds` only after a channel succeeds for that member, and log the
  failure the way the Contact Center paths do. If the column is meant to record
  *intent* rather than delivery, rename it; `notified_member_ids` on an emergency
  record cannot mean "we tried".
- **Status:** OPEN

---

### [CLAUDE-1][INFO][INTEGRATIONS] Provider degradation, checked

| provider | unconfigured | on failure | verdict |
|---|---|---|---|
| Twilio | `twilioFetch` throws (SID is `undefined`, URL 404s) | throws with status + bounded body | loud — good |
| Stripe | `effectiveSecretKey` falls back to env, then `null` | — | admin page shows `hasSecret` boolean only |
| Sync (Google/Microsoft/Apple) | `hasEncryptionKey()` guards both callbacks | redirects `error=no_encryption_key` | closed — never stores a plaintext token |
| AI (assistant) | `isAIConfigured()` → 503 `not_configured` | `describeAIError` | honest |
| **AI (scam screening)** | **silently degrades to pattern matching** | **silently degrades** | **see the HIGH finding above** |

- **Status:** VERIFIED
## Sweep 3 — the scheduler

### [CLAUDE-1][MEDIUM][ARCHITECTURE] Every cron route runs from two schedulers, on an idempotency claim nothing checks

- **Files:** `vercel.json` (24 `crons` entries) · `scripts/cron-dispatch.mjs`
  (`SCHEDULES`, 24 entries) · `.github/workflows/cron-dispatch.yml` (ticks `*/5`)
- **Evidence:** set-compared the three sources.

  ```
  routes on disk      : 24
  scheduled in vercel : 24
  in the dispatcher   : 24
  ROUTE WITH NO SCHEDULE ANYWHERE: none
  SCHEDULED BUT NO ROUTE        : none
  IN BOTH (would double-run)    : all 24
  ```

  No orphan route and no orphan schedule — that part is clean and worth
  recording. But **all 24 are scheduled twice**, and this is deliberate: Vercel's
  Hobby plan fails a deployment that schedules anything finer than daily, so
  `vercel.json` holds daily-safe schedules for the deploy and the real cadences
  live in the dispatcher.
- **Problem:** the design rests on one sentence in `scripts/cron-dispatch.mjs`:

  > *"The routes are idempotent and CRON_SECRET-gated, so a Vercel daily run and
  > a GitHub run of the same route never conflict."*

  That claim is load-bearing for all 24 routes, and **nothing verifies it.** It
  has already been false: Pass B's **F-014** found notification dedupe failing on
  every run, so every run re-notified — precisely the failure this sentence
  assumes away. F-014 was closed by running the notification cron **five times**
  and counting duplicate groups. That technique proves the claim for **1 of 24
  routes**. The other 23 have no such proof, and a route that quietly loses its
  dedupe tomorrow will send a family two digests, two reminders, or two
  allowances before anyone notices.
- **Impact:** bounded but real, and it varies by route. `wallet-allowance`
  carries a timestamp guard and a dedupe key, which is what you want on money.
  `weekly-digest` and `admin-digest` send email. `automations` and
  `autopilot-scan` take AI actions on a family's behalf.
- **Fix:** a harness test that runs each of the 24 routes **twice** against the
  replayed database and asserts the second run writes nothing new — the shape
  F-014's fix already used, generalised from one route to the table. The route
  list should come from `SCHEDULES` so a route added tomorrow is covered
  tomorrow, the way `run-probes.sh` globs.
- **Status:** OPEN

#### The count I did NOT report, and why

A first scan looked for an idempotency mechanism in each route file and reported
**11 of 24 with none** — including `notifications`, the one route F-014 already
proved idempotent. That number is wrong. `cron/notifications` dedupes inside
`generateFamilyNotifications` on `related_id` (with `0293` making it a key), and
the mechanism is simply not visible at the route's own level; the same is true
for others that delegate to a service.

**Eleven is not a finding, it is a scan that cannot see helpers.** That is the
tenth time in this audit a pattern-based count would have been wrong, and it is
recorded here so the number is not mistaken for a result. It is also the reason
the recommended fix is a *behavioural* test — run it twice and look — rather than
a static one: the property is not visible in the text.

---

### [CLAUDE-1][INFO][ARCHITECTURE] Scheduler coverage is complete

Every `/api/cron/*` route on disk has a schedule, and every schedule names a
route that exists — in both `vercel.json` and `scripts/cron-dispatch.mjs`. There
is no job that never runs and no schedule pointing at a 404. Verified by set
comparison of all three sources.

- **Status:** VERIFIED
## Sweep 4 — the question S-01 forces on the whole schema

S-01 existed because a policy had `USING` and no `WITH CHECK`. Asked of all 175
UPDATE policies in the replayed catalogue: **13 have no `WITH CHECK`.**

**13 is not 13 findings, and the reason is worth stating.** When `WITH CHECK` is
absent Postgres evaluates `USING` against the NEW row — so
`can_manage_family(family_id)` as a *single* predicate still forces the new row
into a family the caller manages. Eleven of the thirteen are that shape and are
safe: `assistant_links`, `call_logs`, `daily_insights`, `families`,
`family_communications`, `family_signals`, `family_tree_nodes`,
`front_desk_settings`, `home_briefs`, `moment_activations`,
`reasoning_snapshots`.

The dangerous shape is a **disjunction**, where one branch pins a column that is
not the authorization column — S-01's `lower(email) = jwt email` while
`family_id` and `role` moved freely. Two of the thirteen have a broader surface:

### [CLAUDE-1][LOW][SECURITY] `notifications_update` can convert a personal notification into a family-wide one
- **Policy:** `((user_id = auth.uid()) OR ((user_id IS NULL) AND is_family_member(family_id)))`
- A caller may write their own notification row and, setting `user_id` to NULL,
  satisfy the second branch — turning a notification addressed to them into one
  addressed to the whole family. They must already be a member of that family,
  so nothing crosses a tenant. Recorded for completeness, not urgency.
- **Status:** OPEN

### [CLAUDE-1][MEDIUM][SECURITY] A user can rewrite their own `profiles.email`, and an admin flow resolves accounts by it
- **Policy:** `profiles_update_self` — `USING (id = auth.uid())`, no `WITH CHECK`
- **Evidence:** as `authenticated`, `update public.profiles set email='…' where id = auth.uid()` → `UPDATE 1`.
  `profiles` has **no unique index on `email`** — only `profiles_pkey` on `id`.
- **What it does NOT reach:** `is_super_admin()` reads
  `auth.jwt()->>'email'` against the `super_admins` table, and
  `isSuperAdminEmail` reads `auth.user.email` from the JWT. **Neither consults
  `profiles.email`, so this is not an escalation** — checked specifically,
  because that is the version of this finding that would have mattered.
- **What it does reach:** `app/(app)/admin/actions.ts:104` resolves a family
  owner by `.from('profiles').eq('email', …)` during super-admin family
  creation. Two accounts may now carry the same address, and `maybeSingle()`
  over a duplicate returns `PGRST116`. The realistic harm is a super admin
  creating a family for the wrong account, not an attacker reaching an existing
  one.
- **Fix:** `profiles.email` should be maintained from `auth.users` rather than
  written by the user — the upsert in `lib/server/profiles.ts` already does that
  — so the column belongs outside the self-update policy, with a unique index.
- **Status:** OPEN

### [CLAUDE-1][INFO][SECURITY] No second S-01
Of 175 UPDATE policies, 13 lack `WITH CHECK`; 11 are single family-scoped
predicates and therefore safe by Postgres's own default; the two above are
recorded and neither is an escalation. **The invite policy was the only one
where a disjunction let a caller move a row into a scope they did not hold.**
- **Status:** VERIFIED
<!-- Two sessions wrote this file; both sides of the merge are kept. -->
### [CLAUDE-1][VERIFIED][ARCHITECTURE] Platform and security-header configuration — examined, sound

Recorded because an audit that lists only defects says nothing about what was
looked at, and the next worker needs to know which stones are already turned.

- **`next.config.mjs` headers.** `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy`
  scoped to `self` for camera/microphone/geolocation, and HSTS at two years with
  `includeSubDomains`. `preload` is deliberately omitted, with the reason stated
  — it is an irreversible commitment for every subdomain. Correct call.
- **CSP** is composed in `lib/security/csp.mjs`, and `frame-ancestors` mirrors the
  `X-Frame-Options` split so the two headers cannot disagree about who may frame
  a page.
- **`'unsafe-eval'` is dev-only** — `isProduction ? [] : ["'unsafe-eval'"]`.
  `'unsafe-inline'` remains in `script-src`, documented: Next hydrates through
  inline scripts and there is no nonce pipeline. That is a real, acknowledged
  trade-off rather than an oversight.
- **The test is load-bearing, verified rather than assumed.** Planting
  `'unsafe-eval'` unconditionally into the production policy fails
  `tests/csp-header.test.ts` — 1 failed, 6 passed. Restored, 7 pass.
- **`vercel.json` carries only `crons`** — no header or redirect layer that could
  silently contradict `next.config.mjs`. One place to read, which is the right
  shape.

No finding. Status: VERIFIED.

### [CLAUDE-1][MEDIUM][INTEGRATION] The obvious extension of my own FEATURE_ENV fix would have broken it

- **File/path:** `lib/health/status.ts`, `lib/ai/settings.ts`,
  `tests/health-feature-secrets.test.ts`
- **Problem:** Found while auditing the AI provider seam — a self-check on the
  health fix recorded above. `FEATURE_ENV` reports secrets whose absence silently
  disables a subsystem. The AI provider keys look exactly like they qualify, and
  adding them would be wrong.
- **Evidence:** `resolveAiSettings` reads admin-saved values from the database
  **first** and falls back to the environment:
  `stored.anthropicKey || process.env.ANTHROPIC_API_KEY`. So a deployment that
  configures its key in the admin console has no such env var and a fully working
  assistant.
- **Impact:** Had anyone extended the list the obvious way, every such deployment
  would report `degraded` permanently. A field that is always red is a field
  operators stop reading — which would quietly undo the CRON_SECRET reporting the
  tier exists for. The fix would have destroyed itself by being extended in good
  faith.
- **Recommended fix:** applied. The inclusion rule is stated at the list:
  *a name belongs here only if the environment is the ONLY place it can come
  from.* Two test cases enforce it — one names the AI keys explicitly, one
  asserts generically that no listed secret has a `stored.x || process.env.X`
  fallback, so the rule holds for names added later.
- **Status:** FIXED.
- **Proved load-bearing:** adding `ANTHROPIC_API_KEY` to `FEATURE_ENV` fails both
  new cases (2 failed, 10 passed). Restored, 12 pass.

**Method note.** This is the second time in this session that auditing my *own*
fix produced the finding. A fix is a new thing in the codebase and deserves the
same question as everything else: what is the most plausible wrong change
someone makes next, and does anything stop it?

---

## Pass P — the Guardian settings page (merged from Claude-2, plus two found while fixing it)

Claude-2 reported the first of these and did not modify a source file, per the
board's rule 9. I verified it, fixed it, and found two more defects in the same
save path while reading it. All three have the same shape: **the form reports
"Settings saved" and the value never reaches the column.**

### [CLAUDE-2 / verified by CLAUDE-1][HIGH][STATE] A failed profile read rendered the factory defaults, and Save overwrote the family's real call routing

- **File/path:** `app/(app)/guardian/settings/page.tsx:23` →
  `components/guardian/routing-settings.tsx:103` → `app/(app)/guardian/actions.ts:220`
- **Problem:** the page destructured only `data`
  (`const [{ data: profile }, …] = await Promise.all([…])`), so a failed read
  arrived as `profile === null` — **the same value** that means "this member has
  no profile row yet". `RoutingSettings` seeded itself from a hard-coded
  `defaults` object and Save posted that form through an
  `.upsert(payload, { onConflict: 'family_id,member_id' })`.
- **Evidence (behavioural, not a reading):**
  `tests/guardian-settings-failed-read-is-not-an-empty-profile.test.ts` renders
  the real page against the real form with the read in each state. Against the
  pre-fix code, **the failed-read page and the absent-row page are byte-identical
  strings** — the assertion `expect(failed).not.toEqual(absent)` fails — and the
  failed-read markup contains all six routing rows seeded from the defaults, the
  guardian-number form with an empty field, and a live `Save Settings` button.
  3 of 6 cases fail on the original code; 5 of 6 with only the page reverted.
- **Impact:** a transient read failure turned the settings page into a silent
  reset of `ai_persona_name`, `ai_greeting_template`, `voicemail_greeting`,
  `context_overrides` and every routing mode the form sends, unrecoverable from
  the UI. A household that had set unknown callers to `blocked` became
  `ai_handle_first` — unknown callers start getting through. The empty
  guardian-number field is the same lie about a different column.
- **Fix (applied):** the read goes through `settleAll`, so a transport rejection
  arrives in the same shape as a query error rather than taking the page to the
  error boundary; `profileError` is destructured, logged, and returns an
  `ErrorState` **before** anything savable is rendered. The prop changed from
  `Profile | null` to `RoutingProfileSource`
  (`{status:'ok'|'absent'|'error'}`) in the new `lib/guardian/routing-form.ts`,
  and `initialRoutingForm` returns `null` for `error` — so the component refuses
  the form too, and a future caller cannot re-conflate the two by forgetting a
  check. Claude-2's recommendation, followed as written.
- **Status:** FIXED.

### [CLAUDE-1][HIGH][STATE] Three of the six routing rows the form renders had no writer anywhere in the application

- **File/path:** `components/guardian/routing-settings.tsx:116` (`save()`),
  `app/(app)/guardian/actions.ts:191` (the action's input type)
- **Problem:** the Routing Rules tab renders an editable row for six trust tiers.
  `save()` listed three fields by hand — `default_mode_unknown`,
  `default_mode_known`, `default_mode_suspected_spam` — and the action's input
  type accepted exactly those three. **`default_mode_immediate`,
  `default_mode_close` and `default_mode_trusted` were never written by anything.**
- **Evidence:** `grep` for each of the three across the repository returns the
  column definition in `01370_ai_call_guardian.sql`, the read in
  `app/api/guardian/inbound/voice/route.ts:69`, the routing decision in
  `lib/guardian/pipeline.ts:144` (`immediate_family: profile.default_mode_immediate`),
  two type declarations and one test fixture — **and no writer**. The columns
  could only ever hold their `DEFAULT 'immediate_ring'`.
  `tests/guardian-routing-saves-every-row-it-shows.test.ts` drives the real
  buttons and the real Save handler: with the old `save()` body restored, the
  three tiers fail and the other three pass — 7 failed, 10 passed.
- **Impact:** changing any of those three rows highlighted the new mode, answered
  "Settings saved", and reverted on the next load. The tiers affected are exactly
  the ones a member is most likely to want to change for a personal reason — a
  relative in the immediate-family tier they need to stop ringing through. The
  pipeline kept ringing.
- **Fix (applied):** `routingUpdate(form, memberId)` derives the fields from
  `EDITABLE_TRUST_LEVELS` — the same list the JSX maps over — so the form cannot
  render a row it does not send. The action's payload is built by
  `guardianProfilePayload`, one loop over a declared writable set, replacing
  twelve hand-written `if (input.x !== undefined) payload.x = input.x` lines.
- **Status:** FIXED. Proved load-bearing from both ends independently: the old
  `save()` body → 7 failed; removing the three columns from the writable set →
  5 failed.

### [CLAUDE-1][MEDIUM][STATE] A greeting the family deleted came straight back

- **File/path:** `components/guardian/routing-settings.tsx:119-120` (was)
- **Problem:** `ai_greeting_template: form.ai_greeting_template || undefined`.
  Clearing the field made it `''`, `''` became `undefined`, and `undefined` meant
  the key was omitted from the payload — so the upsert left the old text in place.
- **Evidence:** three cases in the new test clear the AI greeting, the voicemail
  greeting, and type whitespace only; all three fail against the old body. The
  fourth types real text and passes both before and after, which is what makes the
  first three about *clearing* rather than about saving.
- **Impact:** neither greeting could be removed once set. Both columns are
  nullable, so there was a correct value to write.
- **Fix (applied):** cleared (or whitespace-only) sends `null`; the key is always
  present. Omitting a key still means "leave this column alone", which is what
  `updateContextAction`'s single-field write relies on — one case pins that too.
- **Status:** FIXED.

### Left open deliberately

- **`ai_persona_name` can still be saved blank.** The form sends it as typed, and
  `''` is a legal value in a `NOT NULL` column, so the AI would introduce itself
  as nothing. Unlike the greetings there is no obviously right write: blank could
  mean "use Bubaly" or it could mean the field should be required. That is a
  product decision, not a defect with one answer, so it is recorded rather than
  guessed at. LOW.
- **The Guardian surface is not in `GATED_SURFACES`.** `routing-settings.tsx`
  still hardcodes 'Routing Rules', 'AI Persona', 'Context Modes', 'Saving…',
  'Save Settings' and the five context labels, and `lib/guardian/trust.ts` +
  `pipeline.ts` hold English catalogues. Claude-2 has this as its own finding; not
  duplicated here beyond noting that the new error copy went through `t()` and the
  catalogue, so this fix did not add to the debt.

**Method note.** The finding I added was found by reading the code the reported
defect pointed at, not by scanning for a pattern. Claude-2's finding named the
save path; the save path had two more defects in it. Worth doing every time a
worker hands over a file: the thing they found is rarely the only thing there.

---

## Pass Q — the stylesheet (merged from Claude-2, plus a finding its evidence led to)

### [CLAUDE-2 / verified by CLAUDE-1][HIGH][A11Y] `.focus-ring` painted a ring that was always on and removed the one that means "focused"

- **File/path:** `app/globals.css:179` (was); 202 bare call sites, including
  `components/ui/input.tsx:5` — the shared `Input`, `Textarea` and `Select`
- **Verified by compiling, independently of Claude-2's compile.** The emitted rule
  is `.focus-ring { outline: 2px solid transparent; … --tw-ring-shadow: …; }` with
  **no focus selector at all**, and the whole sheet holds 11 `:focus-visible`
  rules, none of which restores an outline. The 218/16/202 split is confirmed
  exactly: `grep -o` over `app` + `components` gives 202 bare and 16
  `focus-visible:focus-ring`.
- **Impact:** two failures in one declaration. The ring is painted at all times,
  so it carries no information; and `outline: 2px solid transparent` is
  author-origin, so it beats the UA's `:focus-visible` outline and the native
  indicator is gone too. A keyboard user cannot see where focus is on every text
  input, textarea and select in the product. WCAG 2.1 AA 2.4.7.
- **Fix (applied):** Claude-2's one-liner — scope the DECLARATION, not the 202
  call sites. Verified by compiling before and after: the only rules that change
  are `.focus-ring`, `.btn-cta`, `.btn-inline` and the escaped variant. Tailwind
  **splits** each component class that `@apply`s it into `.btn-cta:focus-visible`
  (carrying the ring) and `.btn-cta` (carrying everything else), which is the
  mechanism that makes this a one-line fix.
- **Status:** FIXED, with a guard that compiles the real stylesheet with the real
  config and asserts on emitted CSS
  (`tests/the-focus-ring-only-shows-on-focus.test.ts`, 6 cases, 1.6 s).
  Reverted → 4 of 6 fail.
- **One correction to the report, recorded because the next reader will check the
  line numbers:** Claude-2 cites "`app/globals.css:414` (`.btn-primary`) and
  `:419` (`.chip`)" as call sites. Those lines are `.btn-cta` and `.btn-inline`.
  **`.btn-primary` and `.chip` are not defined in any CSS file in the
  repository** — which turned out to be the more interesting fact; see below. The
  substance of the finding is unaffected: two component classes do `@apply
  focus-ring`, and both are handled.

### [CLAUDE-1][MEDIUM][FRONTEND] Classes the app uses that compile to nothing at all

Found by following the correction above. If `.btn-primary` is used in markup and
defined nowhere, then **the button it styles has no styling** — and nothing in the
build says so, because an unknown class is not an error in CSS or in Tailwind.

- **Method:** compile `app/globals.css` with the project's own config, using the
  class tokens found in `className` literals as the content, then ask which tokens
  produced **no rule**. A token Tailwind does not recognise and `globals.css` does
  not define is a class that styles nothing. Each one below was then confirmed
  individually: `bg-brand/10` emits, `bg-brand/12` does not.
- **Confirmed and fixed in this pass:**

  | class | where | why it emits nothing | fixed to |
  |---|---|---|---|
  | `btn-primary` | `app/(app)/admin/settings/social-links/social-links-form.tsx:130` | defined in no CSS file | `btn-cta` |
  | `no-scrollbar` | **13 sites** (tab strips and scrolling rows in `app` and `components`) | defined in no CSS file | defined it in `@layer utilities` |
  | `bg-card` | `app/(app)/admin/notifications/page.tsx:56` | no `card` colour in the theme | `bg-surface/40` |
  | `prose-family` | `app/(marketing)/blog/[slug]/page.tsx:249` | defined nowhere, and no typography plugin (`plugins: []`) | removed — every block in that body already carries its own type classes |
  | `bg-emerald-500/12` ×2 | `app/(app)/dashboard/family-operating-index/page.tsx` | **12 is not on the opacity scale** (…5, 10, 20, 25…), so the modifier resolves to nothing | `/10` |
  | `bg-brand/12` ×2 | `app/(app)/marketplace/page.tsx` | same | `/10` |
  | `bg-violet-500/12`, `border-white/12` | `app/(marketing)/pricing/pricing-content.tsx` | same — **on the public pricing page** | `/10` |
  | `divide-white/8` | `app/(marketing)/security/page.tsx` | same — **public** | `/10` |

- **Impact:** each is an element rendering with no background, no border colour, no
  divider, or in `no-scrollbar`'s case a scrollbar under thirteen tab strips. Two
  are on the signed-out marketing site.
- **Status:** FIXED for the eight above. **The inventory is NOT complete** — see
  the next entry, which is the honest state of it.

### [CLAUDE-1][MEDIUM][FRONTEND][OPEN] P-04 — the same defect is systemic: 47 class names style nothing

`scripts/audit-unstyled-classes.mjs` (written for this) now gives an exact
inventory: **47 distinct class names, across ~1,216 files, that compile to no rule
at all.** Three families:

1. **Theme tokens this theme does not define** — shadcn's vocabulary, used as if it
   were installed: `bg-card`, `bg-background`, `bg-background/40`,
   `bg-background/60`, `bg-primary`, `bg-primary/10`, `border-primary`,
   `text-foreground`, `bg-surface-2`, `bg-brand-500/15`. This theme names them
   `brand`, `fg`, `bg`, `surface`, `elevated`. `bg-card` alone appears widely.
2. **`tailwindcss-animate` classes with `plugins: []`** — `animate-in`, `fade-in`,
   `slide-in-from-bottom-2` (`onboarding-wizard.tsx:240`), `zoom-in-95`
   (`service-tooltip.tsx:93`). The entry animations simply do not run.
3. **Values that are not on a scale** — 23 colour-opacity modifiers (`/8`, `/12`,
   `/15`, `/58`, `/63`, `/73`, `/92`, `/98`), `duration-400`, `h-4.5`, `w-4.5`,
   `bg-current/10` and `text-current/70` (`currentColor` takes no opacity
   modifier), and `btn-secondary` / `reference-page` defined nowhere.

**How the number became trustworthy** — four separate corrections, each of which
had the sweep reporting a defect that was not there, or missing one that was:

- **157 → 65.** The first pass was a regex over `className={…}` and read the
  comparison operand in `className={kind === 'high' ? … }` as a class. Replaced
  with a TypeScript AST walk that rejects comparison operands, lookup indices and
  `case` tests.
- **65 → 35.** Tailwind escapes a comma in an arbitrary value as the CSS hex escape
  `\2c ` — **with a trailing space**, which belongs to the escape. Reading the
  emitted class name with `[\w-]` truncated there, so every
  `grid-cols-[minmax(0,1fr)_300px]` in the app looked unstyled. Twenty-odd false
  positives from one space.
- **35 → 51.** The "at least one recognised token" test could not see a literal
  whose tokens are ALL unstyled: `className="h-4.5 w-4.5"` and
  `className="btn-secondary"` were skipped in silence. A guard that cannot see its
  own worst case is not a guard. Fixed by trusting POSITION inside a `className`,
  and keeping the heuristic only for class maps declared at module scope.
- **51 → 47.** Position was then too generous: an argument to a function that
  COMPUTES a class is not a class. `placeBgFor(p?.icon ?? 'other')`,
  `kindMeta('bug').tone` and `cfg.color.split(' ')[1].replace('text', 'bg')` gave
  four more. Only `cn`/`clsx`/`cx`/`classNames`/`twMerge`/`twJoin` arguments count.

- **Why it is still open:** each of the 47 needs a replacement chosen, and the
  177 grep hits behind them span roughly 40 files. That is its own change, and it
  should land with the auditor wired in as a test so the list cannot grow back.
- **Status:** OPEN, inventory exact and reproducible (`node
  scripts/audit-unstyled-classes.mjs`, exits 1 with the list). `group`, `peer` and
  named groups like `group/snooze` are allow-listed, because Tailwind correctly
  emits nothing for them.

**Method note.** The finding came from checking a line number in someone else's
report. It would have been easy to read "globals.css:414 (.btn-primary)", see a
`focus-ring` on line 414, and move on.
