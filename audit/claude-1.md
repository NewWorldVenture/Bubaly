# Claude-1 — Coordinator + Architecture / Integration

## A. Findings from this session, already fixed and verified in production

These were found and shipped before the four-worker pass began. They are
recorded here because two of them **change the disposition of prior findings
in `finalaudit.md`**, and the record must not contradict itself.

```
[CLAUDE-1][HIGH][SEO] sitemap lastmod reported generation time, not content change
File:     app/sitemap.ts, lib/marketing/content-revisions.ts (new)
Problem:  `const now = new Date()` stamped all 15 static routes and 9 category
          tabs, so every regeneration claimed ~1,500 URLs had just changed.
Evidence: live sitemap 2026-09-13 had 24 URLs at 2026-07-18T… → 2026-09-13T11:51:45.957Z,
          identical to the millisecond — the build's transaction time.
Impact:   A crawler that learns lastmod is noise stops using it, costing the
          signal on pages that genuinely changed.
Fix:      Shipped. Each source answers from its own date; no real date → no
          lastmod. tests/sitemap-lastmod-is-content-dated.test.ts generates
          twice with the clock moved a year and requires identical dates.
Status:   FIXED (#526, verified in production)
```

```
[CLAUDE-1][HIGH][SEO] 445 of 1,508 sitemap URLs were not indexable
File:     app/sitemap.ts, lib/marketing/sitemap-urls.ts (new)
Problem:  435 URLs answered 404+noindex, 9 canonicalised to /blog, the homepage
          was listed twice.
Evidence: 435 `/blog/Seed <uuid>` entries — marketing_pages registry rows for
          slugs blog_posts hides. Sampled 15: 14 × 404 noindex. Unconditional in
          code via isSyntheticBlogSeedSlug. Raw space in <loc> made them
          unparseable as URLs besides.
Impact:   Crawl budget spent to be told 404, on 29% of the sitemap.
Fix:      Shipped. canonicalUrl() is the only thing that may mint a <loc>.
Status:   FIXED (#526). Production now 1,063 URLs, 0 non-200, 0 noindex.
```

```
[CLAUDE-1][HIGH][PERF] the whole message catalogue shipped on every public page
File:     app/layout.tsx, lib/i18n/scopes.ts (new)
Problem:  LocaleProvider is a client component, so the catalogue handed to it in
          the root layout is serialised into the RSC payload of every route.
Evidence: /cookies was 949,769 raw / 265,651 gzip, of which 246,126 gzip was the
          catalogue — 93% — carrying wallet errors, marketplace copy and the
          admin studio's capability matrix onto a cookie policy.
Impact:   Every visitor, every first view, all 1,063 sitemap URLs.
Fix:      Shipped. Each surface declares its namespaces; the authenticated app
          keeps the whole catalogue deliberately (3,791 keys, 96 non-literal
          t() calls, no provable subset, and no crawler behind a login).
Status:   FIXED (#540). Production: /cookies 266→20 KB, /faq 276→31 KB,
          /terms 269→24 KB, / 291→45 KB gzip.
NOTE:     **This supersedes finalaudit.md F9, which closed it as a decision.**
```

```
[CLAUDE-1][MEDIUM][PERF] /blog shipped its entire search corpus to the client
File:     app/(marketing)/blog/blog-search.tsx, app/api/blog/search-index/route.ts (new)
Problem:  All 1,048 published posts passed to a client component as a prop, so
          React serialised them into the HTML of a page that renders 25 cards.
Evidence: `\"slug\"` appeared 1,048 times in the flight payload; 446 KB of a
          597 KB response.
Impact:   Every visitor paid for the corpus so the minority who search could
          filter locally.
Fix:      Shipped. Index fetched on first interaction, edge-cached.
Status:   FIXED (#543). Production /blog 88,907 → 40,098 gzip (−54.9%),
          corpus occurrences 1,048 → 0, 25 cards still rendered.
```

```
[CLAUDE-1][MEDIUM][SEO] every unrouted path redirected to /login
File:     middleware.ts, lib/auth/route-access.ts (new)
Problem:  Middleware had one list (PUBLIC) and redirected everything else, so a
          path with no route answered 307 to a sign-in form.
Evidence: /nope, /some-random-thing, /.env → 307 /login?redirect=…
Impact:   A login form in front of a typo; for crawlers a redirect to an
          irrelevant page, which Google counts as a soft 404, on every bad URL.
Fix:      Shipped. PROTECTED added; a path on neither list falls through to
          app/not-found.tsx. tests/route-access-is-total.test.ts fails if any
          routable top-level path is unclassified.
Status:   FIXED (#544), verified in production: unrouted → 404+noindex, all 20
          protected segments still 307, public pages still 200.
NOTE:     **finalaudit.md F13 recorded this as "By design — no change".** The
          owner directed the change explicitly on 2026-09-13. The prior
          disposition is superseded, not contradicted on the merits.
RISK:     The change inverts a safety property — an unclassified route used to
          default to protected and now defaults to reachable. The guard test is
          what makes that safe, and it earned itself immediately: it caught
          /display (the signed-in kiosk), /account, /money and /settings missing
          from the first PROTECTED list.
```

```
[CLAUDE-1][LOW][I18N] a CSS margin lived in the message catalogue
File:     app/(marketing)/blog/[slug]/table-of-contents.tsx
Problem:  `tableOfContents.80px0px600px` = '-80px 0px -60% 0px', the rootMargin
          of the table of contents' IntersectionObserver, duplicated across all
          seven full catalogues.
Evidence: `{ rootMargin: t('tableOfContents.80px0px600px'), threshold: 0.1 }`
Impact:   A translator or tool altering the value produces one
          IntersectionObserver rejects; it throws at construction and the table
          of contents disappears for that locale on every article, while the
          English build stays green.
Fix:      Constant in the component; key deleted from every catalogue.
          tests/catalogue-holds-language-only.test.ts sweeps for CSS lengths,
          hex colours, URLs and CSS keywords.
Status:   FIXED (#546, in CI at time of writing)
```

## B. Verified clean (recorded so no worker re-derives)

- **Security headers**: full CSP with `frame-ancestors 'none'`, HSTS
  `max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `nosniff`,
  `strict-origin-when-cross-origin`, a scoped permissions policy. Nothing to fix.
- **Redirects**: `http→https` and apex→www are clean 308s.
- **Images**: 69 `<img>` on public pages, every one with non-empty alt; 35
  lazy-loaded, above-fold ones correctly not.
- **Structured data**: 33 JSON-LD blocks, all parse, one schema type per page,
  no duplicates.
- **Page metadata**: no duplicate titles or descriptions across the 15 static
  routes; every page has exactly one `<h1>`, a description and an `og:image`.

## C. Open — owner action, not a defect I can close

```
[CLAUDE-1][HIGH][OPS] production migrations cannot be applied
File:     .github/workflows/supabase-production-migrations.yml
Problem:  The workflow fails at `supabase link` — "Authorization failed for the
          access token and project ref pair".
Evidence: Runs #40, #41 and #42 all died at the same step in ~33s. Run #42 was
          my own migration 0286.
Impact:   Migration 0286 (blog_posts.updated_at backfill) is merged but
          unapplied, so blog `lastmod` stays pinned at 2026-07-18 for all 1,048
          posts. 0282–0285 are likely also unapplied.
Fix:      A Supabase access token with project privileges in the repo secret,
          then a workflow_dispatch re-run.
Status:   BLOCKED — needs a credentialed operator.
NOTE:     Same wall as finalaudit.md F5 / F-001. Confirms both still open.
```

## D. Architecture / integration

Repo shape: 395 pages, 141 API routes, 456 components, 789 lib modules,
308 migrations, 1,181 test files.

### Verified clean

```
[CLAUDE-1][INFO][INTEGRATION] the CSP covers every host the browser actually calls
Evidence: enumerated every `fetch('https://…')` inside a "use client" module and
          compared against the live connect-src. Zero client-side fetches to a
          host outside it. Google APIs, OpenAI, Resend and the grocery/recipe
          integrations are all server-side, which is where they belong.
Status:   VERIFIED — no action
```

```
[CLAUDE-1][INFO][ARCHITECTURE] the server/client boundary holds
Evidence: no "use client" module imports lib/supabase/server, createServiceClient
          or SUPABASE_SERVICE_ROLE_KEY. `import 'server-only'` is doing its job.
Status:   VERIFIED — no action
```

### Findings

```
[CLAUDE-1][MEDIUM][OPS] 19 environment variables are undocumented
File:     .env.example (75 documented) vs 89 referenced in app code
Problem:  Nineteen variables the code reads are absent from .env.example.
Evidence: CONTACT_CENTER_INBOUND_SECRET, APPLE_CALDAV_BASE_URL,
          APPLE_SYNC_ENABLED, GITHUB_FEEDBACK_TOKEN, GITHUB_FEEDBACK_REPO,
          GITHUB_TOKEN, GITHUB_REPO, BUBALY_BUILD_REVISION,
          NEXT_PUBLIC_BUILD_ID, AI_PROVIDER_STUB_DIR, EXPO_PUBLIC_* (3),
          PLAYWRIGHT_*/PW_* (3), TZ, VERCEL_REGION,
          NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA.
Impact:   Two whole integrations are invisible to an operator setting the app
          up. CONTACT_CENTER_INBOUND_SECRET is the sharpest: the inbound email
          endpoint is correctly fail-closed in production, so without the
          secret set it rejects EVERY inbound message, silently, and nothing
          says why. Apple calendar sync is configured by two undocumented
          variables and is simply off until someone reads the source.
Fix:      Add the operator-facing ones to .env.example with a line each saying
          what breaks when unset. The test-only ones (PW_*, PLAYWRIGHT_*,
          AI_PROVIDER_STUB_DIR) can be grouped under a "tests only" heading.
Status:   OPEN
```

```
[CLAUDE-1][LOW][OPS] Supabase credentials fail at first use, not at boot
File:     lib/i18n/…, lib/supabase/* — 13 sites use `process.env.X!`
Problem:  NEXT_PUBLIC_SUPABASE_URL (7 sites) and NEXT_PUBLIC_SUPABASE_ANON_KEY
          (6) are read with a non-null assertion. There is no central env
          validation module.
Evidence: Reproduced in this session: starting the built app with those unset
          made /pricing answer 500 with `Error: supabaseUrl is required`, while
          /terms and /cookies rendered fine. The failure looks like a broken
          page, not a missing variable.
Impact:   A misconfigured deploy degrades into scattered 500s on whichever
          pages happen to read the database, instead of refusing to start.
Fix:      One module that asserts the required set at import time and names
          every missing variable at once.
Status:   OPEN
```

```
[CLAUDE-1][MEDIUM][OPS] the forward-release workflow is failing
File:     .github/workflows/supabase-forward-release.yml
Problem:  Its most recent run failed; the run before that also failed.
Evidence: run 34781290560, 2026-09-13T20:36Z, conclusion `failure`, with
          APPLY_RELEASE=false / REQUIRE_APPLIED=false (a dry run). It uploaded
          its `production-forward-release-audit` artifact successfully, so the
          failure is the audit's own verdict rather than a broken job.
Impact:   Unknown until the artifact is read — but this is the second release
          workflow found failing today, alongside the migrations one, and
          together they mean production database state is not being verified by
          anything that currently works.
Fix:      Read the run's artifact to get the specific gap. Likely the same
          ledger wall as F5 / F-001, but I have NOT confirmed that and will not
          assert it.
Status:   OPEN — needs the artifact or the earlier part of the job log
```

### Workflow health, checked

| workflow | last 5 runs | verdict |
|---|---|---|
| cron-dispatch | success ×5 | healthy — matters, given Pass B's nightly-job findings |
| supabase-schema-audit | success ×3 | healthy |
| finance-transaction-operation-runtime | success ×5 | healthy |
| travel-confirmation-runtime | success ×5 | healthy |
| move-date-recalculation-runtime | success, failure | last run 2026-09-06; stale, worth a look |
| supabase-forward-release | failure, success, failure | **failing** — see above |
| supabase-production-migrations | failure ×3 | **blocked on credentials** — see section C |


### E. Architecture / integration — second sweep

```
[CLAUDE-1][MEDIUM][MOBILE] the Expo app has no tests and CI barely checks it
File:     mobile/ (42 .ts/.tsx files), .github/workflows/ci.yml:82-105
Problem:  The mobile app ships zero test files, and its CI job runs only
          `npm run typecheck` and `npx expo config --type public`.
Evidence: `find mobile -name '*.test.*' -o -name '*.spec.*'` returns 0. The job
          has exactly three steps: install, typecheck, validate config. No lint,
          no unit tests, no build.
Impact:   The web app is gated on 13,500 tests and a device matrix; the mobile
          app is gated on "it compiles and its config parses". A logic defect in
          any of the 42 files reaches a store build unchallenged.
Fix:      Two steps at least — lint, and a smoke test that renders the root and
          asserts the Supabase client is constructed from EXPO_PUBLIC_* rather
          than a hardcoded value. A build step would be better still.
Status:   OPEN
```

```
[CLAUDE-1][LOW][DEPS] the mobile dependency tree is not audited anywhere
File:     mobile/package-lock.json (separate from the root lockfile)
Problem:  Nothing runs `npm audit` against the mobile tree.
Evidence: root `npm audit --production` → 0 vulnerabilities of any severity,
          which is genuinely clean. `cd mobile && npm audit --package-lock-only`
          → 14 moderate. None high or critical, so this is hygiene rather than
          an incident, but no one is watching it.
Impact:   A future high-severity advisory in the mobile tree surfaces only when
          someone happens to look.
Fix:      Add `npm audit --audit-level=high` to the mobile CI job.
Status:   OPEN
```

```
[CLAUDE-1][INFO][DEPS] the web dependency tree is clean
Evidence: `npm audit --production` reports 0 info / 0 low / 0 moderate / 0 high
          / 0 critical.
Status:   VERIFIED — no action
```

```
[CLAUDE-1][LOW][OPS] a runtime workflow has not run in a week
File:     .github/workflows/move-date-recalculation-runtime.yml
Problem:  Last run 2026-09-06, and the run before it failed.
Evidence: two runs on record: success, failure. Nothing since.
Impact:   NONE. Checked: it is `pull_request` with a five-path filter covering
          two migrations and three SQL fixtures. Nothing has touched those
          files since 2026-09-06, so the workflow is correctly idle, not
          broken. Withdrawn.
Status:   VERIFIED — not a finding
```

---

# Findings from the parallel audit session (merged 2026-09-13T23:51Z)

Two audit sessions ran against this repository at the same time. Both
wrote to this path, so git saw an add/add conflict. **Neither side is
discarded** — the rule is that no worker's findings are deleted, and that
applies across sessions as much as within one. The other session's file
follows verbatim; it uses a different finding format, which is left as it
was written rather than reformatted.

# Claude-1 — Coordinator · Architecture · Integration

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

### [CLAUDE-1][LOW][ARCHITECTURE] A build-time read of the whole blog table that could not do anything

- **File/path:** `app/(marketing)/blog/[slug]/page.tsx`
- **Problem:** The route declared both `export const dynamic = 'force-dynamic'`
  and `generateStaticParams()`. Those contradict: with `force-dynamic` every slug
  renders on demand, so there is no prerendered output for the params to
  enumerate. What the function did do was call `getAllPosts()` — the entire
  published table, 1,049 rows — on every build, and discard the result.
- **Evidence — built both ways and compared, rather than reasoned about:**

  | | with `generateStaticParams` | without |
  |---|---|---|
  | route table | `● /blog/[slug]` (SSG) | `ƒ /blog/[slug]` (Dynamic) |
  | static pages generated | 245 | 245 |
  | `[blog] getAllPosts failed` at build | 1 | 0 |
  | build exit | 0 | 0 |

  The identical page count is the point: it was never prerendering anything. The
  route marker moving to `ƒ` makes the build report what the route actually is.
- **Impact:** Low but real. It is a build-time dependency on Supabase for no
  benefit — with the database unreachable the build logged a stack of connection
  failures and returned an empty list, which looks like a broken build and
  changes nothing. It also mislabels the route as SSG, which is exactly the
  confusion F-012 came out of.
- **Recommended fix:** applied. Removed, with a comment recording that this was
  behaviour-neutral (measured, table above), that `force-dynamic` is what fixed
  F-005 and must not be removed casually, and that anyone re-adding
  `generateStaticParams` should read that first.
- **Status:** FIXED. `tsc` clean, lint 0 errors, 13,616 tests pass.

---

## Coordination note — Claude-2, Claude-3 and Claude-4 did not complete

All three workers were launched in parallel and **all three terminated early**
with `rate_limit / HTTP 429: session limit, resets 3:10am UTC`. None of them
reached the point of writing findings:

- Claude-2 (frontend/a11y) stopped at "Now let me survey the frontend surface area."
- Claude-3 (backend/API/security) stopped at "Now let me build the route inventory and start the authorization sweep."
- Claude-4 (QA/flows/perf) stopped at "Let me record the findings so far."

`audit/claude-2.md`, `claude-3.md` and `claude-4.md` therefore still contain only
the templates Claude-1 created. **They contain no findings, and this file does not
invent any on their behalf.** The three areas they own stay marked *not yet
audited* in `finalaudit.md` Part 0 — which is the honest state, and the whole
reason that convention exists.

This is a capacity blocker, not a technical one. The work is scoped and the
prompts are written; it needs either a session-limit reset or the workers run as
genuinely separate accounts, which is what the brief describes.

### [CLAUDE-1][HIGH][TESTING] A gate that calls itself a CI gate ran in no workflow

- **File/path:** `scripts/i18n-gate.mjs`, `.github/workflows/ci.yml`, `finalaudit.md`
- **Problem:** `scripts/i18n-gate.mjs` opens with *"CI gate for surfaces declared
  translated"* and ends *"Nothing else in the build would notice, so this does."*
  It appeared in **no workflow**. Meanwhile `finalaudit.md`'s status summary
  listed it as a passing check — so the audit reported a guard that never ran.
- **Evidence:**
  - `grep -rn "i18n" .github/workflows/` → **no match in any workflow**.
  - Every `run:` line in `ci.yml` enumerated; `npm run i18n:gate` is absent.
  - The gate itself is sound: 8 declared surfaces, all clean, exit 0.
- **Impact:** This is the defect class this repository keeps finding, in its
  purest form — not a check that fails to observe its property, but one that
  **cannot fail because it is never invoked**. What it protects is real: the
  repo has shipped raw English on translated surfaces before, and the gate's own
  header explains the mechanism (someone adds a button, types the label inline,
  every non-English visitor silently gets English on a page that was clean
  yesterday).
- **Recommended fix:** applied — wired beside `Lint` in the
  `Typecheck · Lint · Test · Build` job. It is a static scan with no network or
  database, so it belongs in the fast job.
- **Status:** FIXED.
- **Proved load-bearing, after one invalid attempt of my own.** My first plant
  was `const x = "…"` rendered as `{x}` — a JSX *expression*, which is outside
  the scanner's stated rules, so its passing proved nothing about the gate. The
  fair test is the mistake the gate exists for: an inline JSX text node. Planting
  `<span>Start your free trial today</span>` in
  `components/marketing/site-header.tsx` fails it by file, line and string across
  both covering surfaces, exit 1. Removed, exit 0.

### [CLAUDE-1][MEDIUM][TESTING] A second CI-intended gate is unwired — and wiring it naively would make it vacuous

- **File/path:** `scripts/verify-oauth-config.mjs`, `.github/workflows/ci.yml`
- **Problem:** Its header states *"Exit 1 on any error so CI or a deploy hook can
  gate on it."* No workflow runs it.
- **Evidence:** measured in both environments rather than assumed.
  - With this sandbox's `.env.local`: **exit 1**, 4 errors (`GOOGLE_SYNC_CLIENT_ID`
    and three others *set but blank* — the script correctly distinguishes blank
    from unset).
  - With `.env.local` moved away, i.e. what the PR job actually has: **exit 0**,
    1 warning, 3 notes.
- **Impact:** The naive fix is the wrong one. Wiring it to the PR job would add a
  green check that has no configuration to inspect — a guard that cannot fail,
  which is exactly what the finding above is about. Adding it there would make
  the audit's coverage *look* better while proving nothing.
- **Recommended fix:** NOT applied deliberately. It belongs in a deploy-time hook
  or a job that actually carries the OAuth environment. The script itself already
  says what it does and does not prove: *"Shape is all this proves… run the live
  round-trip in docs/runbooks/LB-006-provider-callback-smoke.md."*
- **Status:** OPEN — recommended, with the reason the obvious fix is refused.

**Also examined, not findings:** the three `marketing:verify:*:remote` scripts are
likewise absent from the PR job, and correctly so — each makes network calls
against a deployed URL (3, 4 and 6 env/fetch references respectively). The e2e job
runs the two that work against its isolated Supabase.

### [CLAUDE-1][VERIFIED][TESTING] The boundary-probe infrastructure — examined, sound, with one narrow gap closed

Applying the lens that found the i18n gate (a guard nothing invokes) to the SQL
probes. The result is mostly a clean bill, which is worth recording as such.

- **All 18 `docs/audit/*-check.sql` genuinely assert.** Counted per file:
  `wallet-write-rls` 15, `sensitive-role-boundary` 12, `money-write-boundary` 11,
  `family-credentials-boundary` 10, `document-vault-boundary` 9, down to
  `household-trail` 1. None is report-only.
- **The four files outside the glob are report-only by design** —
  `migration-ledger-state`, `money-boundary-state`, `money-policy-diagnostic`,
  `demo-mode-teardown`. Their `-state` / `-diagnostic` / `-teardown` names are
  load-bearing, and none contains an assertion, so nothing is parked where the
  runner cannot see it. Verified, not assumed.
- **`run-probes.sh` already refuses to pass vacuously.** With an empty glob it
  exits 1 — *"no probes found in docs/audit — the boundary proofs have been
  deleted"*. Without that branch, `shopt -s nullglob` would report `0/0 passed`
  and exit 0. Someone here had already thought about exactly this defect class,
  which is worth saying out loud given how often it is the finding.
- **The gap, now closed:** nothing stopped a *future* `*-check.sql` from
  asserting nothing, or an assertion from being written into a report-only file.
  `tests/boundary-probes-actually-assert.test.ts` covers both.
- **Proved load-bearing:** a planted `tmp-vacuous-check.sql` containing only
  `select 1;` fails with *"runs in CI but asserts nothing — it can only ever
  pass"*; a `raise exception` appended to `money-boundary-state.sql` fails with
  *"does not end in -check.sql, so run-probes.sh never executes it"*. Both
  removed, 4 pass.
- **Status:** VERIFIED (infrastructure sound) · FIXED (guard added).
  13,662 tests pass.

---

## Consolidation pass — fixes applied from Claude-2, -3 and -4's findings

Correcting my own earlier record first: this file previously stated that
Claude-2/3/4 "did not complete" and their files "hold only the template". That
was true of the moment I checked and is **false now**. Other parallel sessions had
already populated all three files and pushed; `finalaudit.md` carries Passes A–K
and is ~3,957 lines. My rebases pulled that in without my noticing, and
`audit/status.md` went on asserting "not audited" afterwards. Recorded rather than
quietly edited, because a stale coverage claim in an audit document is the same
defect as F13.

Four HIGH findings applied this pass. Three are the same shape — **a call whose
error or escaping is skipped, then success reported** — which is now the most
frequently recurring defect in this repository after the vacuous guard.

### [CLAUDE-1][HIGH][SECURITY] Inbound email routed by an unescaped wildcard — FIXED

Claude-3's finding; verified and fixed. `lib/contact-center/server.ts`
`resolveFamilyByEmailLocalResult` matched `.ilike('email_local', local)` where
`local` is parsed from the inbound message's **`To` header** — supplied by the
sender. `_` is both a legal local-part character (`LOCAL_RE` permits it) and
LIKE's single-character wildcard.

Measured in PostgreSQL 16 on the harness rather than reasoned about:

```
'smith'  ilike 'smit_'    -> t     <- mail reaches another family's inbox
'smith'  ilike 'smit\_'   -> f     <- escaped
'smith'  ilike 's%'       -> t     <- one message reaches any family
'smit_h' ilike 'smit\_h'  -> t     <- a REAL underscore still routes
```

Impact: a sender guessing a family name and substituting one character with `_`
reaches that family's Contact Center — their AI concierge, their planner rows,
potentially their urgent-SMS escalation, and an auto-reply from their own
identity confirming the match. Same class as the child sign-in ILIKE bug this
repo already fixed; the fix had not reached this call site, where the input is
not merely guessable but attacker-supplied.

Fixed by escaping, **not** by switching to `.eq`: the fourth row above is why —
addresses containing an underscore must keep routing — and `.eq` would also drop
case-insensitivity while the unique index is on `lower(email_local)`.
`tests/contact-center-email-routing-wildcards.test.ts`, 6 cases; reverting the
escape fails 5 of them.

### [CLAUDE-1][HIGH][INTEGRATION] Google Calendar reported connected, and could wipe preferences — FIXED

Claude-2's C2-17, plus a worse consequence they had not reached.
`app/api/google/calendar/callback/route.ts` discarded the error from BOTH the
preferences read and the token upsert, inside a `try/catch` that cannot see
either, since a PostgREST call resolves with `{ data, error }` rather than
throwing.

The upsert writes the **whole** `notification_prefs` object. So a refused *read*
falls back to `{}` and the upsert then overwrites every other notification
preference the user has set — a transient read failure silently resets their
settings as a side effect of connecting a calendar. A refused *write* told them
the calendar was connected while no token was stored, so every later sync failed
for a reason the screen denied. Both now redirect to the error state.

### [CLAUDE-1][HIGH][INTEGRATION] Blog unsubscribe confirmed consent it had not recorded — FIXED

Claude-2's C2-16. Recorded in `finalaudit.md` Pass F-a as fixed — but that fix is
on #541's branch, which has not merged, so `main` still carried it. Worth noting
as a coordination hazard: a finding marked FIXED on an unmerged branch is not
fixed in production.

`app/api/blog/unsubscribe/route.ts` discarded both results. A refused SELECT
rendered *"that unsubscribe link doesn't look right"* at a real subscriber
holding a real link — sending them to check the one thing that was never wrong.
A refused UPDATE rendered *"you've been unsubscribed"* over a row still marked
subscribed, so the mail kept arriving after they had been told it would stop.
Both now route to a third state whose copy says the link is fine and we were not.

### [CLAUDE-1][HIGH][DATA] readAll returned a truncated ledger as a complete one — FIXED

Claude-4's F-F01, **in code I wrote**, and the comment defending it was mine:
*"A ceiling the CALLER chose is a destination… Reaching the first is success."*
That is wrong. A caller's `max` is a bound they expect the data to fit under, so
reaching it exactly does not mean the read finished — it means rows may exist
past it that were never read.

`readAll` returned `{ rows: rows.slice(0, max), error: null }` on truncation:
indistinguishable from a complete read. `admin/wallet/reconciliation/page.tsx`
reads with `{max: 20000}` and its own header says *"this page RECONCILES the
ledger, so reading part of it is worse than not reading it at all"* — it would
have reported that a ledger it had only partly read balanced. Ten call sites pass
a `max`, including three nightly crons paging families.

Fixed by reading **one row past** the ceiling. That single extra row is what
separates "there were exactly `max` rows" (complete) from "there were more"
(truncated), and it is discarded from the result — only its existence is used.
Truncation now returns an error the callers already know how to render.

Four existing cases in `tests/supabase-read-all.test.ts` failed, and they were
right to: one of them, `"reports reaching the ceiling as success, not as a runaway
query"`, **literally asserted the defect**. I wrote that too. The contract is now
corrected, with a new case for the exact-fit read the probe exists for, and the
tripwire and caller-ceiling errors asserted to stay distinguishable.

### [CLAUDE-1][HIGH][INTEGRATION] RESEND_API_KEY unset: mail never sent, rows marked delivered — FIXED

- **File/path:** `lib/health/status.ts`, `lib/email.ts`
- **Problem:** Claude-4's finding, and it belonged in a list I had already built
  and then failed to check against their file. `RESEND_API_KEY` gates every
  outbound email — notification digests, family invites, marketing sends — and
  was absent from `FEATURE_ENV`.
- **Evidence:** env-only across five read sites (`lib/email.ts`,
  `lib/server/email.ts`, `lib/marketing/send.ts`, `lib/marketing/*`,
  `lib/server/health.ts`), with no `stored.x || process.env.X` fallback — so it
  satisfies the inclusion rule exactly.
- **Impact:** Worse than silent. `lib/email.ts` reports success when the key is
  unset, so notification rows are marked **delivered** for mail that was never
  sent — and the dedupe then suppresses the retry. The record says the family was
  told; they were not, and nothing will try again.
- **Recommended fix:** applied — added to `FEATURE_ENV`, so `/api/health` reports
  it as `degraded` with the name.
- **Status:** FIXED. The two rule-enforcing cases still pass, which is the point:
  they accepted this name and would have rejected an admin-configurable one.

---

## Audit completeness — the coordinator's own check

Claiming an audit complete is itself a claim that needs evidence, so:

- **All 19 required sections of Part 0 are present**, verified by name.
- **Zero sections still say "not yet audited" or "has not started"** — five did
  after the workers reported, which was the same stale-coverage defect as F13, and
  they are now written from the workers' actual findings rather than from my
  expectations of them.
- **All four workers have findings on file**: `claude-1.md` (this file),
  `claude-2.md` (C2-01–C2-18), `claude-3.md` (3 findings + a verified-sound
  inventory), `claude-4.md` (C-4-01–C-4-13 plus a second block).
- **The remaining OPEN items are open because of a decision, a credential, or a
  named piece of work** — not because nobody looked. Each names its owner in
  Recommended Fix Order.
- **One area is explicitly NOT covered**, and is recorded as unchecked rather
  than clean: browser-executed accessibility (contrast, tab order, screen-reader
  output, live 360–400px overlap). No worker had a browser. Reasoning from source
  is not the same as running it, and writing it down as a gap is the only honest
  option.

Verified at the close: `tsc` clean · lint 0 errors · `npm run build` exits 0 ·
13,669 tests across 1,192 files · i18n gate 8/8 surfaces · migration replay
310/0 · ledger-repair rehearsal FAILED: 0.

### [CLAUDE-1][HIGH][UX/ACCESSIBILITY] A dialog that claimed the page was inert and did nothing to make it so — FIXED

- **File/path:** `components/marketing/consent-manager.tsx`, `components/ui/modal.tsx`
- **Problem:** The privacy preference centre declared `role="dialog"` and
  `aria-modal="true"` on hand-rolled markup. Focus never entered it, Tab walked
  the page behind it, Escape did nothing, and on close focus stayed wherever it
  had been rather than returning to the control that opened it.
- **Evidence:** the component contained no `useRef`, no `.focus()`, no `Escape`
  handler and no `tabIndex` — only the two ARIA attributes. Meanwhile
  `components/ui/modal.tsx` implements the entire contract and says so in its
  header: focus trap, Escape, scroll lock, focus restore, and labelling by id.
- **Impact:** For a keyboard or screen-reader user this is **worse than a plain
  `div`**: `aria-modal="true"` tells assistive technology to ignore a background
  the user can still reach, so the announced structure and the operable one
  disagree. And of every surface to get this wrong, a cookie preference centre is
  the one whose entire job is recording a deliberate choice.
- **Recommended fix:** applied — it now uses the shared `Modal`. Same lesson as
  the four duplicated `escapeLike` helpers and the kiosk's private error
  boundary: the fix already existed and had not reached this call site. The
  bespoke header icon went with it, and labelling improved from a repeated
  `aria-label` to `aria-labelledby`.
- **Status:** FIXED.
- **The larger finding it surfaced:** eleven other components declare
  `aria-modal` themselves, and of those only `components/app/command-bar.tsx`
  calls `.focus()` at all — the rest promise inertness and implement none of it,
  including three gates and the exit-intent overlay. They are **listed, not swept**:
  each has bespoke layout and some (the gates) may deliberately refuse Escape, so
  converting them unexamined would be a worse change than the defect.
  `tests/consent-preference-centre-focus.test.ts` holds the list so it can only
  **shrink** — a new offender fails, and an entry that has been converted but
  left in the list also fails, so it cannot rot into a licence nobody is using.
- **Status of the eleven:** OPEN, enumerated, contained.

### [CLAUDE-1][HIGH][ARCHITECTURE] Mixed read batches: some queries settled, one not, so the page still dies

- **File/path:** `app/(app)/guardian/contacts/page.tsx`,
  `app/(app)/guardian/settings/page.tsx`, `app/(app)/missions/page.tsx`,
  `app/(app)/display/page.tsx`
- **Problem:** A Supabase query builder resolves with `{ data, error }` for
  anything the database answers and **rejects** only when the request never
  completed — DNS, TCP, TLS, a timed-out fetch. Inside `Promise.all` one
  rejection rejects the batch, so a page that handles `res.error` for every read
  still dies on an unhandled rejection and renders the error boundary.
  `lib/supabase/settle.ts` records that this is what took out `/dashboard` while
  production was reporting `CONNECT_TIMEOUT`.
  These four batches had **some** elements wrapped in `settle(...)` and at least
  one not — the same failure, with none of the protection the surrounding code
  appears to have.
- **Evidence:** proved rather than cited — `Promise.all([ok, reject])` rejects and
  loses the result it already had; `settleAll` returns
  `{ data: null, count: null, error: { message } }` for the failed one and keeps
  the other. Two cases in the test file assert exactly that.
- **Impact:** Guardian is a child-safety surface and `display` is the always-on
  kiosk; both went to an error boundary on a transport blip that the neighbouring
  reads in the same batch were written to survive.
- **Recommended fix:** applied to these four. The conditional ones settle the
  **branch**, not the ternary: `settle(cond ? a : b)` does not typecheck, since
  `Promise<A> | Promise<B>` is not `PromiseLike<A | B>`.
- **Status:** FIXED (4 files) · the remainder OPEN, see below.

**Why there is no repository-wide guard here, which is itself the finding.**
I tried three times to write one and each attempt was wrong in a different way:

1. A blanket `Promise.all` → `settleAll` rewrite produced **137 type errors** —
   many batches hold helper calls returning their own result shapes, not
   `{ data, error }`, and `SettledFallback` is not a substitute for those.
2. Wrapping every unsettled element produced **syntax errors in 40 files**: my
   transformer re-joined array elements and put a comma after a trailing `//`
   comment.
3. The counting scans over-reported three separate times — 86, then 47, then 37 —
   because a ternary whose query branch is already settled reads as unsettled, a
   local `try/catch` wrapper (`marketplace`'s `safe`) settles but is
   unrecognisable by name, and a generic call `settle<T>(…)` breaks naive bracket
   tracking, so files I had already fixed kept reappearing.

A guard with false positives is worse than none: it trains people to add
exemptions. So the test asserts only the four files verified by hand, and the
~20 remaining batches are recorded here for a pass that reads them rather than
pattern-matches them: `admin/marketing/visitor-intelligence`,
`admin/marketplace/reports`, `dashboard/agents`, `dashboard/readiness`,
`marketplace/store`, four `api/ai/*` routes, `api/blog/{like,save}`, and about
ten modules under `lib/` (`briefing/deliver`, `metric/strategy-server`,
`schedule/intelligence-server`, `twin/completeness-server`, `ai/runs/*`,
`graph/resolve-server`, `autopilot/policy-scan`).

**And the test I wrote to hold the four was itself vacuous on first draft.** It
asserted `expect(src).toMatch(/\? settle\(supabase\.from\(/)`, which passes as
long as ONE branch is settled — so unsettling one of missions' three left it
green. Caught by running exactly that regression. It counts both sides now, and
the same regression fails it by name.

### [CLAUDE-1][MEDIUM][EDGE CASE] Every once-a-day routine fires twice on the autumn DST night — FIXED

- **File/path:** `app/api/cron/family-routines/route.ts`,
  `lib/services/routines/schedule.ts`, `supabase/migrations/0259_routine_schedules.sql`
- **Problem:** The autumn transition repeats an hour, so a once-a-day routine's
  wall clock arrives **twice**. The scheduler fires whatever has
  `next_run_at <= now` and then recomputes from `now`, which lands on the second
  arrival. The family gets the routine twice, an hour apart, both showing the
  same local time.
- **Evidence — measured against real `Intl` data, not reasoned about.**
  `America/New_York`, 2026-11-01 (02:00 EDT → 01:00 EST), expression
  `30 1 * * *`:

  ```
  first  = 2026-11-01T05:30:00.000Z   -> 11/1/2026, 01:30:00
  second = 2026-11-01T06:30:00.000Z   -> 11/1/2026, 01:30:00
  gap    = 1 hour, identical wall clock
  ```

  The occurrence key `uq_routine_runs_occurrence (rule_id, due_at)` does not stop
  it, and that is the subtle part: those are two genuinely different instants, so
  the reservation is not a duplicate. The idempotency that exists is real and
  simply does not apply.
- **Impact:** Once a year, per DST-observing family, every routine with a fixed
  hour runs twice — a duplicate notification at best, a duplicated action at
  worst. Spring-forward was checked too and behaves acceptably: a `30 2 * * *`
  rule on the skipped hour moves to the next day rather than firing at a time
  that did not exist.
- **Recommended fix:** applied. On rescheduling, a candidate whose local
  wall-clock minute equals the occurrence just fired is skipped.
- **Why it is gated on a fixed hour, which is the whole subtlety:** `0 * * * *`
  *also* repeats its wall clock across the transition and **must** run in both
  halves, because two real hours pass — the family asked for every hour, not for
  a time of day. `firesOncePerDay` is true only when the hour field names a
  single hour, so `0 1,13 * * *` and `0 */4 * * *` are left alone as well.
- **Status:** FIXED.
- **Proved load-bearing twice over:** removing the guard fails the route case;
  widening the gate to every expression *also* fails it. The behavioural cases
  assert the two instants, their one-hour gap and their identical wall clock,
  and that an ordinary June night is still exactly 24 hours apart.

### [CLAUDE-1][HIGH][EDGE CASE] Relative routines fired on the wrong DAY, every day of the year — FIXED

- **File/path:** `lib/services/routines/schedule.ts` (`nextRelativeRun`),
  `lib/services/scope.ts` (`zonedTimeMs`)
- **Problem:** A relative routine fires an offset from an anchor date at the
  family's hour — "the night before the trip, at 22:00". Placing that hour
  measured the zone offset at the UTC instant `<key>T<atHour>:00Z` and subtracted
  it. That reads the offset on whichever local **day** that instant falls on,
  which is not always the target day; when it is not, the hour difference wraps
  and the correction moves a whole day.
- **Evidence — measured, and note the dates: plain summer days, so this is not a
  DST edge case but every day of the year.** All with `offsetDays: 0`:

  ```
  America/New_York, anchor 2026-06-15, atHour  1  -> fired 06-14 01:00   a day EARLY
  America/New_York, anchor 2026-06-15, atHour  2  -> fired 06-14 02:00   a day EARLY
  America/New_York, anchor 2026-06-15, atHour  9  -> fired 06-15 09:00   correct
  Asia/Tokyo,       anchor 2026-06-15, atHour 22  -> fired 06-16 22:00   a day LATE
  Asia/Tokyo,       anchor 2026-06-15, atHour 23  -> fired 06-16 23:00   a day LATE
  Asia/Tokyo,       anchor 2026-06-15, atHour  9  -> fired 06-15 09:00   correct
  ```

  The pattern is the giveaway: a zone **behind** UTC breaks early-morning
  routines, a zone **ahead** of it breaks late-evening ones, and the middle of
  the day is fine in both — which is exactly what an offset misread on the wrong
  local day produces.
- **Impact:** Every US family's early-morning relative routine and every
  Asia-Pacific family's evening one fired a day out. "The night before the trip"
  arrived two nights before. This sat behind the hours most likely to be chosen
  for a *reminder*, and the hours a developer is least likely to test.
- **Recommended fix:** applied — `zonedTimeMs(key, atHour, 0, tz)`, the
  repository's own helper, which resolves the offset twice (at the guess, then at
  the corrected instant) so it lands on the right local day and survives both DST
  transitions. **The correct implementation already existed and had not reached
  this call site** — the fourth instance of that shape this audit has found,
  after `escapeLike`, the kiosk's error boundary and the accessible `Modal`.
- **Status:** FIXED. `tsc` clean, build exits 0, 13,858 tests pass.
- **Proved load-bearing:** restoring the old drift arithmetic fails **8 of 11**
  cases, naming the zone, the hour and the day it landed on. Four cases exist to
  stop the fix over-reaching — the correct mid-day hours, the offset arithmetic,
  both DST transition days, and the already-passed case returning null.

**Also recorded:** `zonedTimeMs` exists twice — `lib/services/scope.ts` (129
importers) and `lib/schedule/zoned.ts` (3). They differ only in whether
`tzOffsetMs` takes a `Date` or a number. Not merged here because both are
correct and a third session is active in this tree, but it is the same
duplication that let this call site drift in the first place. OPEN.

---

## [CLAUDE-1][HIGH][FRONTEND / DATABASE] Nine forms wrote Greenwich's day into a DATE column

- **Where:** `components/modules/{school,expenses,trip-memories,health-visits,finances,pets,subscriptions}-module.tsx`,
  `components/finance/bills-view.tsx`, `components/wallet/wallet-hub.tsx`
- **Problem:** each defaulted a date field to `new Date().toISOString().slice(0, 10)`
  (school-module used the `.split('T')[0]` spelling) — the day at Greenwich, not
  the day on the family's wall. This is the default a parent gets when they leave
  the date blank, and it lands in a DATE column.
- **Evidence:** measured, not reasoned:

  ```
  2026-09-18T01:30Z   Greenwich 2026-09-18
      America/Los_Angeles  2026-09-17   DIFFERS
      America/New_York     2026-09-17   DIFFERS
  2026-09-18T23:30Z   Greenwich 2026-09-18
      Pacific/Auckland     2026-09-19   DIFFERS
      Asia/Tokyo           2026-09-19   DIFFERS
  ```

  7h/day wrong in Los Angeles, 10h/day in Sydney.
- **Impact:** a parent in Los Angeles adding a grade at 18:30 Sunday filed it
  against Monday; one in Auckland logging an expense before 13:00 filed it
  against yesterday. A wrong read renders one wrong screen; a wrong **write**
  persists, and every later read of that row is wrong too. In `finances` and
  `pets` the prefilled value and the submit-time fallback were *both* Greenwich,
  so the form and its fallback could also disagree with each other.
- **Recommended fix:** applied. New `todayInZone(tz, now?)` in
  `lib/schedule/zoned.ts` (client-safe — no `server-only`, unlike
  `lib/services/scope.ts`). All nine sites are client components with the family
  row already in scope, so each resolves through `family?.timezone ?? 'UTC'` —
  the defensive form the repo already uses at `family-module.tsx:393`, and
  necessary because many test mocks return a `useApp()` object with no `family`.
- **Status:** FIXED. `tsc` clean, `next build` exits 0, 13,866 tests pass.

### Why the existing guard missed all nine

`tests/family-day-not-greenwich-day.test.ts` is a good guard aimed at exactly
this bug, and it could not see any of them, for three independent reasons:

1. `UTC_DAY_KEY` matched only `.slice(0, 10)`, never `.split('T')[0]` — the
   spelling school-module used, making that file invisible to it entirely.
2. Its detector matched only PostgREST **filter** operators
   (`gte|lte|gt|lt|eq|neq`). The whole **write** side was uncovered.
3. `ROOTS = ['app', 'lib']`. All nine are in `components`.

Extended with a write-side check over all three roots. The write side can be
asked *precisely* — is the value assigned to a DATE column a Greenwich key? — so
unlike the read check it needs no whole-file `ZONE_AWARE` blind spot.

**Measuring this honestly took three attempts, and the first two were wrong:**

| detector | files | verdict |
|---|---|---|
| any `col:` key anywhere in a file that also builds a Greenwich key | 57 | over-reports 4.4× — matches type annotations, unrelated literals, chart config |
| `col:` with `[^,]*` up to the key | 13 | under-reports — a comma inside `str(fd, 'service_date')` ends the value early |
| depth-aware property-value extraction | **14** | every one verified by eye |

The loose number would have put 43 phantom findings on the board. Recorded
because the temptation to ship the first count is the failure mode, not the regex.

- **Proved load-bearing:** restoring the school-module line turns the guard red,
  naming the file and column — in the spelling *and* the directory that were both
  invisible before.

**Five server-side writes remain, allowlisted with reasons rather than silently
skipped:** `app/(app)/dashboard/{auto,home}/actions.ts` and
`app/(app)/wallet/hub-actions.ts` need a zone threaded through their `ctx()`;
`lib/planning/prep-server.ts` through its signature;
`lib/reasoning/engine-server.ts` writes `as_of_date`, which is an **upsert key**
(`onConflict: 'family_id,as_of_date'`) — changing it changes what "already
snapshotted today" means, so it wants its own change with the idempotency
thought through, not a drive-by. OPEN.

---

## [CLAUDE-1][HIGH][PERFORMANCE / FRONTEND] Two reads capped at 1,000 rows in the directory the guard skipped

- **Where:** `components/calendar/busyness-heatmap.tsx`, `components/modules/language-module.tsx`
- **Problem:** both wrote `.limit(2000)`. PostgREST caps a response at
  `db-max-rows` (1,000) whatever the client asked for, so neither was a bound —
  each was a silent truncation wearing the costume of a deliberate choice. This
  is the exact defect `tests/no-limit-above-the-row-cap.test.ts` was written to
  end across 26 call sites; these two survived because its roots were `app` and
  `lib`, and a client component reaches PostgREST through the same browser
  client and the same cap.
- **Evidence:** `busyness-heatmap` orders by `starts_at` **ascending**, so the
  1,000 rows it kept were the *oldest* in the window — an eight-week busyness
  strip that silently dropped the most recent weeks. `language-module` reads
  `vocab_cards` ordered by `due_on`, so a deck past 1,000 lost its tail and
  every count drawn from it (due today, total, mastery) was over a prefix.
- **Impact:** the heatmap turned out to have **three** defects, and the limit was
  the least of them:
  1. the truncation above;
  2. the fetch destructured `{ data }` and dropped `error` — a failed read left
     rows empty and rendered eight calm weeks *with a rebalancing tip under
     them*, telling a family they are not busy because the query broke;
  3. a raw `.then()` on a query builder with no `.catch()`, so a transport
     failure (DNS/TCP/TLS) became an unhandled rejection rather than an error
     the component could show.
  All three came from hand-rolling a `useEffect` fetch instead of using
  `useRealtimeQuery`, which already carries the error, the offline fallback and
  the missing-table degrade. **The correct implementation already existed and
  had not reached this call site** — the fifth instance of that shape this audit
  has found.
- **Recommended fix:** applied. Both now page through `readAllAsQuery(…, { max: 2000 })`,
  and the heatmap uses `useRealtimeQuery` with an `ErrorState` branch. Both
  pagers add `.order('id')` after the intended sort: `starts_at` and `due_on`
  are not total orders, and paging a non-total order repeats and skips rows
  across page boundaries.
- **Status:** FIXED. `tsc` clean, build compiles, 13,873 tests pass.
- **Proved load-bearing:** restoring either `.limit(2000)` turns the extended
  guard red, naming the file and line.

**The gap, not the instances.** Both were found by asking which *guards* scan
only part of the tree, rather than by hunting another over-cap limit. Surveying
every guard with a literal `ROOTS`:

| guard | roots | gap |
|---|---|---|
| `family-day-not-greenwich-day` | `app`, `lib` | **yes** — 9 writes in `components` |
| `no-limit-above-the-row-cap` | `app`, `lib` | **yes** — 2 over-cap limits |
| `no-dev-markers-in-shipping-code` | `app`, `lib` | clean today (0 hits), included anyway |
| `no-hardcoded-secrets` | `app`, `lib`, `components` | none |
| `no-injection-vectors` | `app`, `lib`, `components` | none |

Two of five guards were blind to `components`, and both had real findings behind
the blind spot. `no-dev-markers` is included now rather than after the first
marker arrives.

---

## [CLAUDE-1][HIGH][MOBILE / UX] Twenty-six money inputs could not take a decimal point on iOS

- **Where:** `components/wallet/wallet-hub.tsx` (6), `components/finance/savings-view.tsx` (3),
  `components/meals/nutrition-view.tsx` (3), and one each in
  `components/finance/{bills,budgets}-view.tsx`, `components/wallet/invest-view.tsx`,
  `components/vacations/{trip-budget,trip-itinerary,vacations-list}.tsx`,
  `components/home/{service,warranties}-client.tsx`,
  `components/family/driving-safety-view.tsx`,
  `components/billing/family-value-comparison.tsx`,
  `components/admin/stripe-setup-form.tsx`,
  `app/(app)/admin/marketing/{pipeline,proposals,loyalty}/page.tsx`
- **Problem:** `type="number"` alone does not reliably surface the "." on the iOS
  Safari keypad. A decimal field without `inputMode="decimal"` cannot accept
  cents on an iPhone.
- **Evidence:** `tests/mobile-numeric-inputmode.test.ts` was written to prevent
  exactly this, and reported **zero** offenders. It read `components/modules`
  with `readdirSync` — one flat directory, not even its subdirectories.
- **Impact:** this is the money-entry surface of the app — every wallet balance,
  available and limit, bill and budget amounts, savings targets and
  contributions, trip budgets and itinerary costs, investment share counts,
  service and warranty costs. On an iPhone, none of it could take a decimal.
- **Recommended fix:** applied to all 26. The guard now walks `app` and
  `components` whole.
- **Status:** FIXED. `tsc` clean, 13,875 tests pass, lint unchanged (same 3
  pre-existing warnings).
- **Proved load-bearing:** removing one `inputMode` turns it red with file and line.

**This is the guard-that-cannot-fail class in its softest and most convincing
form.** The `i18n:gate` instance was obvious once seen — it ran in no workflow.
This one *ran*, on every CI job, and passed honestly. What made it useless was
that its sanity check — "more than 20 money inputs scanned" — was satisfied by
the single directory it read. A coverage assertion calibrated to the scanned
subset cannot detect that the subset is the problem. Its sanity bound is now
past what one directory can meet, and a new case asserts the walk reaches
nested directories, so flattening it back fails instead of narrowing quietly.

**Sweep of the sibling mobile guards** (the point was the narrowing, not another
missing `inputMode`):

| guard | old scope | offenders outside it |
|---|---|---|
| `mobile-numeric-inputmode` | `components/modules/*.tsx`, non-recursive | **26** |
| `mobile-no-horizontal-overflow` | `components/modules/*.tsx`, non-recursive | 0 |
| `mobile-hover-reveal` | `components/modules/**`, `app/**` | 0 |

All three now scan `app` + `components` whole. The two that are clean were
widened anyway — the cost is nothing and the gap is identical.

**Also measured, no finding:** `tests/ilike-patterns-are-escaped.test.ts` scans
`app` + `lib` only, but `components` contains **zero** `.ilike(`/`.like(` calls,
so nothing hides behind that gap. Recorded so the next sweep does not re-derive it.

---

## [CLAUDE-1][HIGH][BACKEND / FRONTEND] Five reads that handled every database failure and no network one

- **Where:** `app/(app)/dashboard/calm/page.tsx`, `components/settings/app-lock-settings.tsx`,
  `components/modules/event-detail-modal.tsx`, `components/modules/meals-module.tsx`,
  `components/auth/step-up-form.tsx` (and `components/marketplace/quick-post.tsx`, best-effort)
- **Problem:** a query builder **resolves** with `{ data, error }` for anything the
  database answers and **rejects** only when the request never completed — DNS,
  TCP, TLS, an aborted fetch. `.then(handler)` supplies only the first path.
- **Impact:** each broke differently, which is why counting them as one shape matters:

  | site | what the missing rejection path did |
  |---|---|
  | `calm/page.tsx` | a transport failure went through `Promise.all` and out of the page — the error boundary rendered **instead of** the degraded view the page was built to show |
  | `app-lock-settings.tsx` | a failed read presented a **configured App Lock as never set up** |
  | `event-detail-modal.tsx` | "No RSVPs yet — be the first!" over a read that never came back |
  | `meals-module.tsx` | the meal library silently never updated |
  | `step-up-form.tsx` | the MFA form sat on its loading state forever |

- **Evidence (calm/page.tsx), measured:** three reads with one rejecting —

  ```
  safe (as shipped)        -> Promise.all THREW    (error boundary)
  safe + rejection path    -> Promise.all RESOLVED, 3/3 failures counted (degrades)
  ```

  Every sibling hub page's local `safe` already used `try/catch`
  (`marketplace/page.tsx`, `planning/page.tsx`, `dining/page.tsx`,
  `lib/meals/degrade-read.ts`). This one was the lone outlier of six.
- **`app-lock-settings` deserves its own note.** The component's own comment
  defines three states — `undefined` = loading, `null` = no PIN ever set,
  otherwise the config. A failed read is a **fourth** meaning and was given the
  second. So a transient error offered the user "Set up PIN", and setting one
  there **overwrites the real config of a lock they still have**. A failed read
  now says so and offers nothing.
- **Status:** FIXED. `tsc` clean, build compiles, 13,878 tests pass, lint unchanged.
- **Proved load-bearing:** restoring `safe()`'s single-argument form turns the
  new guard red at the exact line.

**Why the existing guard could not see any of this.** `tests/read-error-surfaced.test.ts`
is a good guard covering exactly this failure mode — for `useRealtimeQuery` call
sites. Every one of these **bypassed the hook** and hand-rolled a fetch, which
put them outside its premise entirely. *A guard on the safe path does not cover
the path taken to avoid it.* That is a distinct shape from the scope gaps above
and worth naming separately.

`tests/query-builders-have-a-rejection-path.test.ts` now forbids the shape
itself. Its argument splitting is bracket-depth-based, not regex: a first
attempt matched `}` `,` to spot `.then(onFulfilled, onRejected)` and reported
the file that had **just been fixed** to use it — the handler body `({ data })`
puts a `)` between the `}` and the `,`. Recorded because a guard whose false
positive is the correct code is worse than no guard.

### Measured, NOT fixed — and explicitly not verified

A scan for `const { ... } = await …from(…)` destructures that omit `error`
returns **95 sites**. That number is a population, not a finding: most are
existence checks where null-on-error and null-on-absent want the same answer,
and the raw count even included a `settle()` written minutes earlier. Two were
probed by hand:

- `app/(app)/family/child-login-actions.ts:46` — a username uniqueness check
  that fails **open** (a failed read reads as "not taken"), running as the
  **service role**. Looked serious; is not. `child_logins` carries
  `unique index on (lower(username))`, and `syntheticChildEmail(username)`
  collides at the auth layer first, so the invariant holds and the rollback path
  runs. It degrades the error message, not the data. **LOW.**
- `app/(app)/family/child-login-actions.ts:37` — fails **closed** ("member not
  found"). Correct as written.

The remaining 93 need per-site judgement. Recorded as OPEN and **unverified** —
not as 93 findings. Mass-converting them would repeat the `Promise.all` →
`settleAll` mistake earlier in this audit (137 type errors, then syntax errors
in 40 files, both reverted).

---

## [CLAUDE-1][HIGH][BACKEND / PERFORMANCE] The admin console reported the first thousand of everything

- **Where:** `app/(app)/admin/reports/page.tsx`, `app/(app)/admin/backup/page.tsx`
- **Problem:** PostgREST answers an **unbounded** select with at most
  `db-max-rows` (1,000) and says nothing. The admin console computes its
  aggregates by reading rows into the page and reducing them, so each silently
  became "the first thousand" once a table passed it.
- **Evidence, measured against a fake holding the server's cap** — 1,337
  documents of 1,000 bytes:

  ```
  unbounded select   -> 1,000 rows, error: null, total 1,000,000
  readAllAsQuery     -> 1,337 rows, error: null, total 1,337,000
  count head:true    -> 1,337                      (never capped)
  ```

- **Impact:** `admin/reports` is the clearest case *because it is half right*.
  Its family, user and subscription tiles use `{ count: 'exact', head: true }` —
  a count is not rows and was never capped. Beside them, the **Documents tile
  rendered `docs.length`**, so past a thousand documents it read exactly "1,000"
  forever; storage used, both growth buckets and the revenue trend were reduced
  over a prefix; and daily activity came from 1,000 `audit_logs`, which fourteen
  days of a live platform passes easily. Exact counts sat next to charts built
  from a sample with nothing saying they disagreed. `admin/backup` reported the
  size of the first thousand documents as the total, on a page titled
  "Data & Storage".
- **Recommended fix:** applied. Both page through `readAllAsQuery` to a real
  ceiling; the Documents tile uses an exact count like its neighbours. **The
  ceiling matters as much as the paging:** reaching it returns the rows as a
  prefix *plus an error*, which `admin/reports` already joins into its
  `PartialReadBanner` and `admin/backup` already renders. Without that, a larger
  ceiling would only be a larger silent truncation.
- **Status:** FIXED. `tsc` clean, build compiles, 13,882 tests pass.
- **Proved:** `tests/admin-aggregates-read-past-the-cap.test.ts` reproduces the
  truncation against a capped fake before asserting the fix, and asserts that
  passing the ceiling is *reported* rather than rounded down to.

### Why the existing guard missed it

`tests/whole-table-reads-are-not-capped.test.ts` is a strong **behavioural**
guard: it seeds a capped fake and asserts four jobs read past it. But the list
is **enumerated** — `deliverMorningBriefs`, `runNetworkAggregation`,
`getMarketingCustomersWithError`, `runAutomations` — and nothing keeps it
complete. A fifth surface (the admin console) was simply never added.

That is a third distinct guard-failure shape, after scope gaps and premise gaps:
**an enumerated guard with no scan behind it.** It cannot be wrong about what it
checks; it just never grows.

### OPEN — measured, not fixed

- **A database aggregate is the real fix.** Summing bytes and bucketing months
  by reading every row into a page does not scale however it is paged. The
  ceilings applied here convert "silently wrong" into "explicitly incomplete",
  which is a strict improvement and not the destination.
- **~20 further unbounded cross-platform reads** remain on admin list pages
  (`admin/users`, `admin/content`, `admin/audit`, `admin/security`,
  `admin/billing`, `admin/subscriptions`, `admin/support`, `admin/stripe`).
  These truncate a **list** rather than corrupt a **number**, which is why they
  are ranked below the two fixed here. A scan is in this file's history; the
  raw count of "unbounded unfiltered reads" is 106, and most of that number is
  small config tables (`roles`, `permissions`, `feature_flags`,
  `social_providers`) or reads scoped by a non-family id — **not** 106 findings.

---

## [CLAUDE-1][HIGH][BACKEND] Est. MRR, and the unpaid accounts the billing page could not see

- **Where:** `app/(app)/admin/billing/page.tsx`
- **Problem:** every figure on the page — Est. MRR, Active Subscriptions,
  Past Due / Unpaid, the plan donut, the six-month new-MRR trend, the recent
  list — is reduced from **one** read of `subscriptions`. That read was
  unbounded (capped at 1,000, silently) **and carried no `.order()`**.
- **Evidence, measured against a fake holding the cap,** 1,337 subscriptions
  with every overdue account seeded past it:

  ```
  unbounded select  -> 1,000 rows, error: null, past-due found:   0
  readAllAsQuery    -> 1,337 rows, error: null, past-due found: 237
  ```

- **Impact:** the two faults compound rather than repeat.
  - *Capped:* MRR and Active understated past a thousand.
  - *Unordered:* which thousand is arbitrary, so **"Past Due / Unpaid" could
    omit unpaid accounts outright** — the number on this page most likely to be
    acted on — and "recent" sorted an arbitrary thousand by `created_at` and
    took ten, which need not contain a single genuinely recent row.
  - The page's own subtitle is "live subscription revenue across every family".
- **Recommended fix:** applied. The subscriptions read pages to a real ceiling;
  reaching it returns an error, which this page already turns into a read-error
  state. **On a revenue page, refusing to show a number beats showing a smaller
  one with no way to tell.** `families` was also read unbounded only to build a
  name map for ten rows — it now reads just the families those rows name, which
  is both correct (a row past the cap rendered "—" for a family that exists) and
  far fewer rows.
- **Status:** FIXED. `tsc` clean, build compiles, 13,887 tests pass, CI green.

## [CLAUDE-1][MEDIUM][TESTING] A ratchet on the ungated i18n surface — and a number that lied

- **Where:** `scripts/i18n-scan.mjs` (`GATED_SURFACES`), new
  `tests/i18n-ungated-surface-ratchet.test.ts`
- **Problem:** `app/` + `components/` is deliberately **not** gated, for a good
  recorded reason. But "it goes back in the list when it scans clean" has no
  force on its own: nothing stopped the number growing and nothing would have
  reported it.
- **A wrong conclusion, recorded because it was nearly shipped.** The comment
  records 2,343; today's scan says **2,812**. That reads like 469 strings of
  drift, and I was one step from reporting it that way. Measured with **one
  scanner held fixed** against both trees:

  ```
  current scanner, tree at 0babad30 (where 2,343 was written)   2,903
  current scanner, tree today                                   2,812
  ```

  The surface has **improved by 91**. The apparent rise was entirely the scanner
  getting better at seeing strings — the same improvement that produced the
  2,343. *Two numbers from two different scanners say nothing about the code,
  and the obvious reading of them was backwards.*
- **Recommended fix:** applied — a ratchet, not a gate. The surface need not be
  clean, only not get worse. The failure message names both causes of a rise,
  because they are indistinguishable from the number alone, and a third case
  fails when the surface improves enough that the ceiling should be **lowered**,
  so a ratchet nobody tightens cannot drift up to meet the code.
- **Status:** FIXED. Verified load-bearing: one hardcoded string added to a
  component takes it to 2,813 and fails, naming the direction.

---

## [CLAUDE-1][HIGH][BACKEND] Two wallet balances summed from a capped read

- **Where:** `app/(app)/wallet/invest/actions.ts` (`investBucketBalance`),
  `lib/wallet/server.ts` (`childSpendableCents`, removed)
- **Money was never at risk, and that is the first thing to establish.** Both
  authoritative paths sum in **SQL under a lock**: `wallet_reserve_card_auth`
  (0155) decides card authorizations, `invest_decide_order` (0196) decides fills
  and refuses with `insufficient_cash`. A SQL aggregate reads every row —
  `db-max-rows` caps response **rows**, not an aggregate. Verified by reading
  both functions before drawing any conclusion.
- **Problem:** the TypeScript pre-checks *in front of* those summed an
  **unbounded** read, which PostgREST answers with at most 1,000 rows, silently.
- **Evidence, measured** — 900 credits and 400 debits of $1, true balance $500:

  ```
  unbounded select -> 1,000 rows, error: null, balance $800
  readAllAsQuery   -> 1,300 rows, error: null, balance $500
  ```

  It read **high** here only because the debits sorted after the credits. Which
  way it errs depends on which thousand the server returns — that is the point.
- **Impact:** `investBucketBalance` gates order placement with "not enough money
  in the Invest bucket". A child past a thousand ledger rows could be **refused
  funds they have**, with nothing they can do about it. Fixed by paging.
- **`childSpendableCents` was removed, not fixed.** It had **zero callers**
  anywhere in the repository, and its doc comment said *"this is what a card
  authorization is checked against in real time"* — untrue of it, and untrue
  since 0155. Leaving it was the hazard: a correct-looking, ready-to-use helper
  with a capped sum and a comment inviting the next author to wire it into
  exactly the decision that must not use it.
- **Status:** FIXED. 13,894 tests pass, build compiles.

## [CLAUDE-1][MEDIUM][PERFORMANCE / BACKEND] The routine cron read each family's clock once per rule, and guessed it on failure

- **Where:** `app/api/cron/family-routines/route.ts`, both loops
- **Problem:** each loop read `families.timezone` **inside** the loop, so a
  household with ten routines cost ten identical round trips. The tick is
  **deadline-bounded** (`if (Date.now() > deadline) break;`), so wasted round
  trips are not merely slow — they are routines that never get processed, and a
  routine that is not processed does not fire.
- **The worse half:** both reads destructured `{ data: family }` and dropped the
  error, falling back to `'America/New_York'`. That is not a loss of precision —
  a failed read **asserts a specific US zone** for a family that may be in
  Tokyo, and files their routine against the wrong day. This sits directly in
  front of the DST handling added earlier in this audit, which exists precisely
  to get a family's wall clock right.
- **Recommended fix:** applied. One `.in()` read per tick into a Map. A failed
  zone read now fires nothing and reports, because late is recoverable and the
  wrong wall clock is not. A family row that is genuinely absent or blank keeps
  the long-standing default — only a *failed read* is treated as unknown.
- **Status:** FIXED. Verified load-bearing: restoring the per-rule read makes
  the tick take 6 `families` reads for 6 rules instead of 1, and file routines
  despite a failed zone read. The test double needed `.in()` support, which is
  recorded in it — a double that cannot answer the query shape under test
  exercises a client the code never meets.

**Also noted, not changed:** the repo has two different default timezones —
`DEFAULT_TZ = 'UTC'` in `lib/services/scope.ts` and `'America/New_York'` in four
AI routes plus this cron. In the AI routes the fallback covers an *empty* value
on a NOT NULL column, which is a different situation from a failed read, so they
are not the same bug. Recorded as a consistency question for an owner, OPEN.

---

## [CLAUDE-1][HIGH][BACKEND] The medication reminder, and the UTC fallback the file argues against

- **Where:** `lib/server/notifications.ts:61`
- **Problem:** the file spends ten lines explaining why a UTC "today" is
  unacceptable here, and then silently falls back to UTC when the read fails.
  Its own comment, verbatim:

  > `todayStartIso` bounds the doses already logged today, and the medication
  > reminder asks "has this dose been taken yet?" against it. Read in UTC it
  > starts at 17:00 local in California — so the morning dose looks untaken
  > every evening and the family is reminded again — and in Tokyo it starts at
  > 09:00 the PREVIOUS local day, so yesterday's dose is mistaken for today's
  > and **the reminder never fires**. A missed medication reminder is the worse
  > of the two, and neither is acceptable.

  The code underneath was `const { data: familyRow } = await …` — the error
  dropped — followed by `familyRow?.timezone || 'UTC'`.
- **Impact:** a transient read failure produces exactly the outcome the comment
  calls unacceptable, and produces it **silently**. This is a sharper case than
  the sibling reads in the same function: those fan out ~13 source reads and
  degrade a *category* (a missing notification), while this one corrupts the
  *day key every category is bounded by* — a wrong notification, and for
  medication a missing dose reminder.
- **Recommended fix:** applied. The zone read now fails the family's tick.
  Verified first that all **three** callers wrap each family in `try/catch` and
  count `generationFailures`, so the family is retried next tick and a broken
  tick still reads differently from a quiet one. A family row with **no zone
  set** keeps the default — absent is not unreadable, and only a failed read is
  treated as unknown.
- **Status:** FIXED. 13,896 tests pass, build compiles.
- **Proved load-bearing:** restoring the dropped-error form fails the new case.

### Triage that produced no finding, recorded so it is not redone

The scan behind this was "a discarded read error falling through to a
**substantive** default" (not `?? []` / `?? null`), which returned 15 sites.
Most are cosmetic name fallbacks (`?? 'a family'`). Two looked serious and are
**not** bugs:

- `lib/server/entitlement.ts:76` — `prefs?.active_family_id ?? ''`. The
  function's own header says it returns `UNLOCKED_FALLBACK` "on any error / no
  family / pre-migration DB, so a hiccup never traps a user". Failing **open**
  on entitlement is a deliberate, documented product decision, and the `?? ''`
  simply falls through to `familyIds[0]`, the user's first family. Correct.
- `app/(app)/missions/actions.ts:301` — `assignment.ai_score ?? 100`. Reads like
  a failed AI validation scoring full marks. It is not: the line above is
  `if (!assignment || !chore) return;`, so a failed read returns early — fails
  **closed**. The `?? 100` is reached only on a real row with no AI score, in a
  path already gated on `isManager`, where a parent is explicitly approving.

Recorded because both cost real time to clear, and the next sweep over this
shape will surface them again.
