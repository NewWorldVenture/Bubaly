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
