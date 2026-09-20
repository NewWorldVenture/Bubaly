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

### [CLAUDE-1][MEDIUM][FRONTEND] P-04 — the same defect was systemic: 47 class names styled nothing. All fixed.

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

**Fixed: 134 replacements across 54 files, and the audit now reports zero.**

| what | fix |
|---|---|
| `bg-card` (28 cards) | `bg-surface/40` — the pattern every other card in the app uses |
| `bg-background`, `/40`, `/60` | `bg-bg`, `bg-bg/40`, `bg-bg/60` |
| `bg-primary`, `bg-primary/10`, `border-primary` | `bg-brand`, `bg-brand/10`, `border-brand` |
| `text-foreground` (6) | `text-fg` |
| `bg-surface-2` (3) | `bg-elevated` |
| `bg-brand-500/15` | `bg-brand/15` — the colour was wrong, not the opacity (`/15` is a multiple of five and compiles) |
| 23 opacity modifiers | rounded to the nearest multiple of five: `/12`→`/10`, `/8`→`/10`, `/58`→`/60`, `/63`→`/65`, `/73`→`/75`, `/92`→`/90`, `/98`→`/95` |
| `animate-in fade-in slide-in-from-bottom-2 duration-300` | `animate-fade-in-up` — the theme's own keyframe, which is the same gesture |
| `animate-in fade-in zoom-in-95 duration-100` | `animate-fade-in` |
| `btn-secondary` (3) | `variant="secondary"` — the `Button` component has had that variant all along, and the three sites are `<Button>`s. My first pass put `btn-inline` on them, which would have stacked a second border and background on top of the Button's own; caught by reading the component instead of the class name. |
| `duration-400` | `duration-300` |
| `h-4.5`, `w-4.5` (4 each) | `h-[1.125rem]`, `w-[1.125rem]` |
| `bg-current/10`, `text-current/70` | `bg-fg/10`, `opacity-70` — `currentColor` takes no opacity modifier |
| `reference-page` | removed; it sat beside `soft-grid-bg`, which is the class that does the work |

- **Status:** FIXED, and guarded.
  `tests/every-class-in-the-app-styles-something.test.ts` runs the audit over the
  whole app (4 s) and asserts the offender list is empty — plus **five positive
  controls** that plant one known-bad token each in a temp file and require the
  audit to report it. Those controls are the point: with every real offender fixed,
  "0 offenders" is otherwise indistinguishable from a sweep that has gone blind.
  The test also asserts the sweep actually looked at the app (>800 files, >10,000
  class lists), because a glob that matched nothing would also report zero.
  `group`, `peer` and named groups like `group/snooze` are allow-listed: Tailwind
  correctly emits nothing for them.

### [CLAUDE-1][MEDIUM][TESTING] A guard anchored on the text of the broken class unhooked itself when the class was fixed

- **File/path:** `tests/mobile-fullscreen-panel-safe-area.test.ts:22`
- **Found by:** the full suite going red on the P-04 fix — 2 failed, 13,777 passed.
- **Problem:** the test finds the panel it checks by searching for a literal:

  ```ts
  const shell = src.split('\n').find((l) => l.includes('fixed inset-0 z-50 bg-background')) ?? '';
  ```

  `bg-background` is one of the 47 names that styled nothing. Renaming it to
  `bg-bg` made `.find` return undefined, `?? ''` turned that into an empty string,
  and all six assertions then failed — on a file whose safe-area padding, the only
  thing this test is about, had not changed at all.
- **Impact:** two ways round. Before the fix, the guard was pinned to a defect: as
  long as `bg-background` stayed, the test passed and said nothing about the class
  being dead. And `?? ''` means "not found" and "found, missing everything" are the
  same outcome — so had someone deleted the takeover entirely, this would have
  reported six assertion failures rather than "the panel is gone".
  **This is Claude-4's finding #2 in a different file**: a test that asserts the
  exact text of defective code makes the fix look like the regression.
- **Fix (applied):** anchor on the STRUCTURE — `fixed inset-0 z-50` — and assert
  there is exactly one such shell per file, so "not found" and "found but wrong"
  are different failures. A separate assertion now checks the panel has *some*
  themed background (`bg-bg`, `bg-surface` or `bg-elevated`) without naming which,
  which is the property that was actually broken.
- **Status:** FIXED.
- **Worth generalising:** I then grepped `tests/` and `e2e/` for every one of the
  47 replaced tokens. This was the only one. Recorded because the answer being
  "one" is itself the finding — a sweep like that is cheap and it is the only way
  to know a mass rename did not quietly unhook a guard somewhere else.

**Method note.** The finding came from checking a line number in someone else's
report. It would have been easy to read "globals.css:414 (.btn-primary)", see a
`focus-ring` on line 414, and move on.

---

## Pass R — the Guardian read boundary (merged from Claude-2)

### [CLAUDE-2 / verified by CLAUDE-1][HIGH][STATE] Five safety pages made safety claims they had not checked

- **File/path:** `app/(app)/guardian/page.tsx:34` (eight reads),
  `guardian/history/page.tsx:28`, `guardian/rules/page.tsx:19`,
  `guardian/contacts/page.tsx:20`, plus `app/(app)/family/activity/page.tsx:23`
- **Verified:** none of the five destructured `error`, and none appears in the 127
  existing `*-read-boundary` guards. Traced through the rendering path and then
  **rendered**, which is the difference between reading the code and knowing what
  a user sees:

  | page | what a failed read rendered |
  |---|---|
  | `/guardian` | `0` in all four stat tiles, from `count ?? 0` — including **"0 Scams Stopped"** and **"0 Blocked"** |
  | `/guardian/history` | `0 total`, and `CallHistory`'s "No communications match your filters" over a log that may be full of blocked scam calls |
  | `/guardian/rules` | no routing rules — i.e. "you have written none" |
  | `/guardian/contacts` | `0 contacts` — i.e. "you have trusted nobody" |
  | `/family/activity` | "No activity recorded yet" over the family's audit trail |

- **Impact:** Guardian is the product's safety feature. It decides which calls and
  texts reach a child, and it is the surface a parent opens *because* they are
  worried about a caller. On a failed read it did not say "we could not load
  this"; it made a positive safety claim. `components/ui/partial-read-banner.tsx`
  had already written the rule down for the admin pages — *"A zero that means 'we
  could not check' must never be mistaken for an all-clear"* — and the safety
  dashboard was the one place it was not applied. `/guardian/history` also
  mislabelled the failure: "match your filters" invites the reader to clear a
  filter that was never the problem.
- **Fix (applied), as Claude-2 specified:**
  - `/guardian`: `settleAll`, all eight errors destructured, and a
    `PartialReadBanner` naming each failed read individually. The `stats` prop is
    now `number | null` and **`null` means "not read"** — the tile renders an em
    dash. `countOf(count, error)` is the one place that decision lives, so a
    future read cannot reintroduce `?? 0`.
  - `/guardian/history`, `/rules`, `/contacts`: `settle`/`settleAll`, and an
    `ErrorState` in place of the list. History's header shows `—` rather than
    `0 total`.
  - `CallHistory` now tells the two facts apart: `communications.length === 0`
    renders "No calls or messages yet", and only a non-empty log that filters to
    nothing says "none match your filters".
  - `/family/activity`: the error `settleAll` already delivered is now read.
- **One decision recorded rather than made silently:** on `/guardian/contacts` the
  `family_members` read is **decoration** — it fills a name dropdown — so its
  failure does not take the trust graph down. A test case pins that, so the
  distinction is deliberate rather than an oversight in the same shape as the
  original defect.
- **Status:** FIXED, with `tests/guardian-read-boundary.test.ts` — 14 cases that
  render the real pages with the real components, once per read state. Five of the
  14 are negative controls: a family with a genuinely quiet day still sees `0`, an
  empty log still reads empty, and a successful read renders no banner. Without
  those, "no zero on the page" would pass on a page that can no longer render a
  number.
- **Proved load-bearing:** reverting all five pages and both components → **9 of
  14 fail**, and the 5 that pass are exactly the negative controls. That is the
  right split: the controls are supposed to pass before and after.

---

## Pass S — the child-login mapping (merged from Claude-3), and a stale-worktree hazard

### [CLAUDE-3][HIGH → CRITICAL on verification][RLS] A child could repoint a login mapping at a parent, and a PIN reset would then set the parent's password

- **File/path:** `supabase/migrations/01051_child_logins.sql:44`; consumer
  `app/(app)/family/child-login-actions.ts` (`resetChildPinAction`)
- **Verified against a replay of all 312 migrations.** The policy is *named*
  "Managers manage child_logins" and *predicated* on
  `is_family_member(family_id)`, on both sides of a `for all`. Claude-3 rated it
  HIGH for the sibling lockout. Reading the consumer makes it worse than that:

  `resetChildPinAction` is manager-gated, reads `row.user_id` straight out of
  that table, and calls `admin.auth.admin.updateUserById(row.user_id, { password })`
  **under the service role**. So a child points their own row's `user_id` at a
  PARENT's auth user, asks that parent to reset their PIN — "I forgot it", an
  ordinary request — and the reset sets the **parent's** account password to
  `deriveChildPassword(secret, childUsername, pin)`, a value the child chose.
  Child to parent account takeover, with the parent's own hand on the button and
  nothing in the audit log to tell it from a normal reset.
- **Evidence, executed both ways:**
  - `docs/audit/child-login-mapping-is-managers-only-check.sql` against the
    replayed schema: **OK** — a child cannot repoint, delete or plant a mapping;
    a parent still can; reads stay open.
  - Negative control, permissive policy restored: *"a child REPOINTED 1 login
    mapping(s) at another auth user — this is the reset-PIN takeover | a child
    DELETED 1 sibling login(s) | a child INSERTED a login mapping"*.
  - `tests/a-pin-reset-cannot-reach-a-parents-account.test.ts` calls the real
    action against the pre-fix code and the failure prints the id it set a
    password for: `[ "22222222-2222-4222-8222-222222222222" ]` — the parent.
- **Fix, in two halves, and the order matters:**
  1. **`0299_child_logins_write_boundary.sql`** makes the write policy
     `can_manage_family(family_id)` on both sides. **NOT applied to production**
     (F-001). Third table in this audit with this exact defect, after F20's chore
     board and O-01's password vault.
  2. **The application half, which does NOT wait for the migration.**
     `resetChildPinAction` now resolves the auth user from `family_members`
     (already manager-only on writes), refuses when `child_logins` disagrees with
     it, and refuses outright when the named member is a manager. Deliberately a
     REFUSAL rather than a fallback: a disagreement is evidence of tampering, and
     it is logged as such. This matters because production's ledger is gated, so
     0299 will sit unapplied while the takeover is closed in code today.
- **Why "refuse a manager" cannot block a legitimate reset:**
  `createChildLoginAction` refuses a member who already has a `user_id`, and a
  manager always has one, so no manager can ever hold a child login honestly. A
  test case pins that teens, caregivers and guests still reset fine — the check
  had to not quietly narrow to `role === 'child'`.
- **Status:** FIXED (app half live; RLS half queued). Probes **22/22**.
  Proved load-bearing: reverting the action → **6 of 10 fail**, and the 4 that
  pass are the happy-path controls.

### The negative control found a bug in my own probe, again

The first draft caught only `insufficient_privilege` around the child's INSERT.
With the permissive policy restored the insert *succeeded*, hit
`unique (member_id)`, and the block died on **"duplicate key value violates unique
constraint"** instead of naming the boundary as open. RLS is checked **before** a
unique index, so an insert that reaches the constraint is an insert RLS let
through — it has to be reported, not swallowed. Fixed by catching
`unique_violation` as a failure and giving the parent's positive control a member
of its own.

**Second time in this audit that a failure path nobody had run was itself wrong**
(Pass O's `failures || 'literal'` array-literal bug was the first). A probe is
code, and the branch that only executes when something is broken is the branch
nobody reads.

### [CLAUDE-1][MEDIUM][TOOLING] S-02 was already fixed, and the evidence for it came from a stale checkout

Claude-3's S-02 — the child-PIN throttle bypass via `ILIKE`'s `_` wildcard — is
**already fixed on main**, by `adaa04d8` "Match a child's username as a value, not
as a pattern (#545)" (2026-09-13 18:46, an ancestor of HEAD), with a dedicated
guard in `tests/child-login-username-is-not-a-pattern.test.ts`. `app/(auth)/actions.ts`
reads `.eq('username', username)` and carries a comment describing the exact
defect. Verified rather than assumed before writing anything.

**Where the stale evidence came from:** `.claude/worktrees/` holds **81 git
worktrees** — whole checkouts of this repository at older commits, left by
completed workflow runs. They are gitignored, so they never reach a commit, but
they are on disk: `grep -rn "ilike('username'"` finds the pre-fix line in dozens
of them. Any sweep that greps the filesystem rather than `git ls-files` reads code
that was fixed hours ago and reports it as open.

- **Checked, and this is the reassuring half:** the three tests that walk from the
  repo root (`catalogue-key-rendered-through-t`, `marketing-aeo-localized-everywhere`,
  `server-action-authorization`) all skip dot-directories, two of them with an
  explicit comment naming `.claude/worktrees`. `scripts/audit-unstyled-classes.mjs`
  uses `git ls-files`. So no guard in the suite is reading stale copies — only
  ad-hoc greps are at risk, which is exactly what an auditor does by hand.
- **A second, operational half, for the owner:** those worktrees are **7.7 GB**,
  against **7.6 GB** of free disk on this machine (80% used). They are the whole
  remaining headroom. I did **not** delete them: `git worktree list` has 92
  entries and **19 of them hold commits that are not reachable from HEAD or
  origin/main**, so a blanket removal would discard work from runs that never
  merged. The safe recipe, for whoever owns that decision: check
  `git -C <dir> status --porcelain` and reachability per worktree, remove only the
  ones that are clean AND reachable, then `git worktree prune`.
- **Status:** S-02 FIXED (not by me — recorded so it is not re-fixed). The
  worktree hazard is OPEN and is the owner's call, not an agent's.

---

## Pass T — the audit trail says who wrote it (merged from Claude-3)

### [CLAUDE-3][HIGH][RLS] Any member could sign an audit row with someone else's name — and flood the platform security feed

- **File/path:** `supabase/migrations/0118_rls_drift_repair.sql:116` (originally
  `0004_rls.sql:132`), policy `audit_insert` on `public.audit_logs`
- **Verified against a replay of 313 migrations.** The check is
  `family_id is null or public.is_family_member(family_id)` — `family_id` and
  nothing else. `actor_id`, `action`, `resource`, `resource_id` and `metadata`
  are all free.
- **Executed, both directions.** `docs/audit/audit-log-says-who-wrote-it-check.sql`
  passes against the fixed schema; with the old check restored its negative
  control reports:
  > *a child ATTRIBUTED a wallet deletion to the parent | a child wrote a
  > family_id IS NULL row into the platform security feed | a PARENT attributed
  > an action to the child — the pin is a role check, not an identity check*
- **Impact:** the trail is writable by the people it exists to hold accountable.
  A child can attribute an action to a parent in `/family/activity`, bury a real
  entry under noise, and write `family_id = null` rows that **no** RLS reader can
  see while `app/(app)/admin/security/page.tsx` renders the newest 25 of them with
  `createServiceClient()`. That page claims *"Append-only audit log — Sensitive
  actions are recorded permanently"*. It is append-only (no UPDATE/DELETE
  policies) and read-restricted. What it was not is **authentic**.
- **Why 0300 pins rather than drops, unlike 0260.** `0260_trust_ledger_lockdown.sql`
  fixed this exact defect on `trust_audit_logs` by dropping member INSERT
  outright, because every legitimate writer there held the service role. Here
  that is false: **fourteen callers append on the caller's own cookie-bound
  client**, and `docs/audit/household-trail-check.sql` states the intent
  deliberately — *"ANY member may append … while only a parent or adult may read
  it back"*. A trail a child cannot write has holes in it exactly where the work
  happens. So 0300 pins the shape instead:
  `is_family_member(family_id) and actor_id = auth.uid()`. Checked all fourteen
  callers first: every one already passes its own `ctx.user.id`, so the pin costs
  the honest callers nothing.
- **The `family_id is null` branch, and the one caller that used it.** Exactly one
  client-side writer relied on it — `app/onboarding/actions.ts`' reset row, when
  the user has no active family — and it now writes with the service client it
  already held two lines above, which is the right client for a row the server
  authors about itself. Every other null-family writer (`adminAuditLog`, the
  benchmarks export) was already on the service role. `scopeForSystem` documents
  that crons pass the service client, so the `actor_id = null` system rows keep
  working: service_role bypasses RLS.
- **No application half exists here, and that is worth stating.** S-03's takeover
  could be closed in code because the dangerous read was one the app performed.
  This one is a direct PostgREST INSERT by the attacker; only RLS can refuse it.
  So `audit_logs` stays forgeable in production until 0300 is applied — recorded
  in `docs/PENDING_PROD_MIGRATIONS.md` rather than softened.
- **Status:** FIXED in the repository, **NOT applied to production** (F-001).
  Probes **23/23** — including `household-trail-check.sql`, whose "any member may
  append" assertion is the one the pin could plausibly have broken, and did not.

---

## Pass U — the allowance is paid once (merged from Claude-4)

### [CLAUDE-4][HIGH][MONEY] "Run now" twice paid the allowance twice; the cron beside it never did

- **File/path:** `app/(app)/wallet/actions.ts:327` (the blind claim) vs
  `app/api/cron/wallet-allowance/route.ts:80` (the correct one)
- **Verified by re-running the race myself**, on two connections against a replay
  of 313 migrations, with a two-second overlap standing in for the
  `creditChildWallet` round trip and the credit gated on the update's own
  `RETURNING` exactly as the code gates it:

  ```
  == BLIND shape — UPDATE by id only (the defect) ==
  ledger_rows=2  cents_credited=2000
  == CLAIMED shape — UPDATE carries next_run_on <= current_date (the fix) ==
  ledger_rows=1  cents_credited=1000
  ```

  Claude-4's numbers exactly. Same rule, same seconds, same ledger; the predicate
  is the entire difference. Preserved as
  `docs/audit/allowance-double-pay-race.sh` so it can be re-run — it is a race,
  not a boundary check, so it is deliberately outside the `*-check.sql` set that
  `run-probes.sh` globs.
- **Impact:** the child is paid twice for one period from the family's money, and
  `wallet_transactions` is append-only (`0088`), so the correction is a manual
  reversal row rather than a delete. No exotic client needed:
  `components/wallet/allowance-view.tsx` is a plain button, so two tabs, a
  double-submit on a slow connection, or a parent tapping while the nightly cron
  is mid-run all produce the overlap. The action's own docstring claimed the
  opposite — *"Idempotent with the Vercel cron … no double-pay"* — which held only
  if the two never ran at the same time.
- **Fix (applied):** the action now claims the rule the way the cron does —
  `.lte('next_run_on', today)`, `.maybeSingle()`, and `continue` on a loser rather
  than `actionFailure`. A loser is not an error: it means the period is already
  paid. (`single()` treats zero rows as a failure, which is exactly the case this
  now expects, so the switch to `maybeSingle` is part of the fix rather than
  cosmetic.) The i18n key `actions.allowanceScheduleWasNotUpdated`, which existed
  only to build the synthetic error for that case, is removed from all seven
  catalogues.
- **Status:** FIXED.

### [CLAUDE-4][MEDIUM][TESTS] One guard was pointed at one of the two places the pattern lives — and another pinned the defect

Two test defects, and the second is the worse kind.

**`tests/allowance-cron-idempotency.test.ts` read one hardcoded file.** Its header
states the property in general terms — *"if two invocations overlap (Vercel cron
re-fire / **manual trigger** / >maxDuration run), both must NOT credit the same
period"* — and "manual trigger" is the server action, which the test never opened.
So the second implementation of the same claim shipped without one. It now
**discovers** every site that advances a schedule (keyed on `next_run_on: next`,
which excludes the two rollback sites that deliberately restore the prior value)
and requires the claim of each. It also asserts that discovery found **both** known
files by name — a discovery that finds nothing would satisfy every loop in the file
and report success.

**`tests/wallet-allowance-persistence.test.ts:13` asserted the EXACT TEXT of the
defective update**, `.select('id').single()` and all. The one-line fix for a live
double-pay would have turned that test red — a guard that makes the fix look like
the regression. Rewritten to assert what that file is actually about (the advance
is checked, and rolled back when crediting fails) in ordered pieces, without
re-pinning a formatting choice.

- **Proved, in the direction that matters:** against the *defective* action, the
  idempotency guard fails **3 of 13** and every failure names
  `app/(app)/wallet/actions.ts` — while the persistence file **passes**, which is
  the whole point of decoupling it. Restored: 13 pass.
- **This is the second instance of the class in this session** — the first was
  `tests/mobile-fullscreen-panel-safe-area.test.ts` anchoring on a dead CSS class
  (Pass Q). Both times the shape is the same: a test that names an implementation
  detail of the code under test, so correcting the code breaks the test.
- **Status:** FIXED.

---

## Pass V — two features that disagree with themselves (merged from Claude-4)

### [CLAUDE-4][HIGH][ENTITLEMENT][OPEN] `/dashboard/home` is sold as Plus, listed for Basic, and opened for Basic

- **Verified in the current tree; three declarations, three answers:**

  | declaration | says | file |
  |---|---|---|
  | the plan catalogue (which generates `/pricing`) | **plus** (level 2) | `lib/constants/feature-catalog.ts:95` |
  | the sidebar | `minLevel: 1` (Basic) | `lib/constants/navigation.ts:149` |
  | the pages themselves | `requirePlanLevel(1)` (Basic) | `app/(app)/dashboard/home/**` |

- **Consequence:** `/pricing` sells Home & Maintenance as Plus, the sidebar offers
  it to a Basic family, the page opens for them — and the AI routes behind it gate
  on the **catalogue**, so every AI button on a screen they were invited into
  answers 403. Same family of defect as L-01 and P-01: three declarations of one
  fact with nothing comparing them.
- **Why I did not fix it.** The direction is a product decision, and it is not the
  same decision P-01 was. P-01's catalogue was *missing* two entries, so amending
  it was restoring a fact. Here the catalogue and the published pricing page agree
  with each other and the code is the outlier — so the consistent fix RAISES the
  gate to Plus and takes a screen away from Basic families who have it today. That
  is a comms decision, not a code one. Recorded with the three-way table so
  whoever decides has the whole picture.
- **What is worth building either way:** a guard that compares all three
  declarations per route. It would fail today, which is the honest state, so it
  belongs with the decision rather than before it.
- **Status:** OPEN, owner's decision.

### [CLAUDE-4][HIGH][BROKEN][part fixed] `/dashboard/experience` can only ever be empty, and its empty state told the family to run a SQL file

- **Verified:** `git grep experience_audits -- app lib` returns **only**
  `lib/database.types.ts` and the reader in
  `components/modules/experience-scorecard-module.tsx`. **Nothing writes the
  table.** The nav entry is `minLevel: 0`
  (`lib/constants/navigation.ts:218`), so the page is in *every* household's
  sidebar, Free included.
- **The half that needed no decision, and is fixed.** The only state that page can
  reach ended with:

  > *"Run seed_experience_audits_one_family.sql to populate a baseline."*

  An internal seed-script filename, rendered to every user of the product, in
  hardcoded English on a surface where everything else goes through `t()`. Replaced
  with copy that describes the feature and names no file, lifted into all seven
  catalogues.
- **And a guard, because the class generalises.**
  `tests/no-user-facing-copy-names-an-internal-file.test.ts` sweeps the catalogue
  for anything that reads like a file to run or a path into the repository. It
  found exactly one other, and that one is **allowed with its reason**:
  `users.runSupabaseSeedSqlAgainst` renders on Super Admin → Users, where the
  reader is whoever deploys Bubaly and running the seed is genuinely the remedy.
  The distinction the guard encodes is not "no filenames anywhere" but "no
  filenames in front of a family" — and the allowance is itself asserted to stay
  true, so a stale exception fails rather than lingering (the
  `KNOWN_DUPLICATE_MIGRATIONS` lesson). Positive controls pin that the pattern
  still sees the string it was written for and does not flag ordinary copy with a
  full stop in it.
- **Proved load-bearing:** planting the old sentence back into the catalogue fails
  the sweep; removed, 3 pass.
- **The half that IS a decision, and is not mine:** a page in every sidebar whose
  table has no writer. Either build the writer or take it out of the nav — and
  `memory.md` forbids touching the sidebar without being asked, which settles who
  chooses.
- **Status:** the user-facing copy is FIXED; the empty feature is OPEN for the owner.

---

## Pass W — the erasure path (merged from Claude-3's S-05, scoped)

### [CLAUDE-3][HIGH][DB] Deleting a family scans a whole table per dependent — 36 times over

- **Verified from the catalogue, not from the finding.** Against a replay of all
  314 migrations, counting CASCADE/SET NULL constraints whose referencing column
  has no index leading on it:

  | parent | CASCADE | SET NULL | **unindexed** |
  |---|---|---|---|
  | `families` | 391 | 12 | **36** (28 + 8) |
  | `family_members` | 55 | 123 | **158** (41 + 117) |
  | `vacations` | 26 | 2 | **22** |
  | `child_wallets` | 13 | — | **11** |

  Claude-3's numbers for `families` and `family_members` match exactly. The total
  across the four hot parents is **227**, not the "~100" the finding estimated —
  worth stating, because the estimate is what a scope decision would have been
  made on.
- **Measured myself, on `ai_messages` at 200,050 rows with 50 belonging to the
  family being closed — the exact statement the RI trigger issues:**

  ```
  as shipped   LockRows → Seq Scan    4,990 buffers   21.4 ms   (200,008 rows removed by filter)
  with index   LockRows → Index Scan     55 buffers    0.064 ms
  ```

  Claude-3 measured the identical shape on `sync_webhook_events`: 5,765 → 54
  buffers, 52.9 → 0.18 ms, whole family delete 189 ms.
- **The part worth reading twice.** `ai_messages` is the example ON PURPOSE:
  `docs/audit/family-scoped-index-check.sql` names it as one of four tables
  *"checked and left alone"*, with a stated reason — its page query carries another
  selective column (`conversation_id`), so a `family_id` index buys that query
  nothing and costs write throughput. **That reasoning is correct about the READ
  and silent about the DELETE.** The RI trigger has no other column. All four
  tables the earlier pass excluded (`ai_messages`, `member_badges`,
  `marketplace_listing_shares`, `social_publish_jobs`) are in the erasure path,
  which I confirmed from the catalogue before writing anything.
- **Fix (applied), deliberately scoped to 36 of 227:**
  - `0301_family_erasure_indexes.sql` — the 36 `families` constraints, **generated
    from the catalogue query rather than hand-listed**. 32 are on `family_id`, the
    column every RLS policy on those tables already filters on, so each index pays
    for itself on ordinary reads too: this is the low-regret set. Applied to a
    fresh replay: 0 errors, and the remaining count for `families` goes 36 → **0**.
  - `docs/audit/family-erasure-indexes-concurrently.sql` — the same 36 as
    `create index concurrently`, for production. A migration file runs inside a
    transaction and `concurrently` cannot, which is why 0301 itself uses the plain
    form; plain creation takes ACCESS EXCLUSIVE for the duration of the build,
    which on a live `ai_messages` is a write outage. Includes how to find and drop
    the INVALID index a cancelled concurrent build leaves behind.
  - `docs/audit/family-scoped-index-check.sql` gains a **generic** half: no
    CASCADE/SET NULL constraint referencing `families` may lack a leading index.
    It names no table, so the child table added next month is caught by CI instead
    of by an erasure request that times out half-way. It carries its own
    can-this-fail self-test, matching the A-14 half above it.
- **NOT included, and this is a decision rather than an omission:** the **191**
  constraints on `family_members` (158), `vacations` (22) and `child_wallets` (11).
  Those are member-reference columns — `member_id`, `assignee_id`, `created_by` —
  **not** the RLS predicate, so indexing them accelerates member removal and
  nothing else, at 191 indexes' worth of write amplification on the platform's
  busiest tables. Recorded for the owner with the measured split. Asserting it in
  the probe would encode a decision nobody has made.
- **Status:** the `families` half is FIXED in the repository and **NOT applied to
  production** (F-001). Fresh replay 314 migrations / 0 failed, probes **23/23**,
  both new assertions verified to be able to fail.

---

## Pass X — every icon button has a name (merged from Claude-2's U-05)

### [CLAUDE-2][MEDIUM → the destructive half is worse][A11Y] Icon-only buttons with no accessible name

- **Verified with my own scanner, and the count moved:** Claude-2 reported 74; the
  current tree has **82**. `scripts/audit-icon-button-labels.mjs` walks the
  TypeScript AST for every `<button>` and reports one only when it can see no way
  for it to have a name — deliberately conservative, because over-reporting is the
  trap here. Claude-2's own first two formulations produced **903** and then
  **256** by treating `{t('notes.edit')}` as "not text"; mine treats ANY non-JSX
  `{expression}` child as a name for exactly that reason.
- **Impact:** WCAG 4.1.2. A screen-reader or voice-control user hears "button" and
  cannot tell Edit from Delete, and on these lists the pair sits side by side: an
  insurance policy, a financial transaction, an immunisation record, a Guardian
  routing rule. And two I found that Claude-2's list did not reach:
  `components/wallet/invest-view.tsx:71,73` are **approve and reject on a child's
  investment order** — a Check and an X, no names, moving money.
- **Icon vocabulary, counted:** 46 `Trash2`, 16 `X`, 9 `Pencil` + 2 `Edit2`, 5
  `Copy`, 4 `MoreHorizontal`, 4 `ChevronRight`, 4 `Plus`, 3 `Pin`, 3 `PinOff`, 3
  `Check`, and a tail of navigation and one-offs. So **28 reusable labels** cover
  all 82 — which is why the fix is an `a11y.*` key group translated once with care
  rather than 82 bespoke strings in seven languages.
- **Fix (applied): all 82, in two deliberate halves.**
  - **62 automatically**, for icons whose meaning is unambiguous (`Trash2` →
    delete, `Pencil` → edit, `MoreHorizontal` → more actions, and so on).
  - **20 by hand, each read first**, because the icon alone was not enough. An `X`
    beside a `Check` means **Reject**, not Close — mislabelling that is worse than
    leaving it unnamed. An `X` inside a search field means **Clear search**; an `X`
    on a panel header means **Close**; an `X` beside a `Textarea` in a recipe step
    means **Remove**.
  - **`components/wallet/wallet-activation.tsx:78` was the interesting one.** A
    checkbox drawn as a `<button>`, inside a `<label>` whose sibling `<span>`
    carries the sentence — so it looks perfectly labelled on screen and had **no
    accessible name at all**, because a `<label>` names a form CONTROL and not a
    `<button>`. It now carries `role="checkbox"`, `aria-checked` and the agreement
    sentence as its name.
- **Five of the automated labels were then corrected**, and this is worth recording
  because the automation looked right: where a button switches between two icons
  (`Pin`/`PinOff`, `ChevronUp`/`ChevronDown`, `List`/`LayoutGrid`) a FIXED label is
  wrong half the time. Those five now read the state:
  `aria-label={t(view === 'grid' ? 'a11y.listView' : 'a11y.gridView')}`.
- **And fifteen type errors, all of one kind.** My detector took each file's FIRST
  `useTranslations()` — but these files hold several components and each has its own
  translator in its own scope, so five labels named `t` where the enclosing
  component has `tr`, or the reverse. Three child components
  (`ContactRow`, `MiniCalendar`, `NoteGroup`) had **no** translator at all and now
  declare one. One was a real logic error I introduced: `viewing.pinned` where the
  column is `is_pinned`. `tsc` found every one — which is the argument for running
  it before believing a mass edit, not after.
- **Status:** FIXED, and guarded by
  `tests/every-icon-button-has-a-name.test.ts` — the offender list must be empty,
  with **three positive controls** (a bare icon button, a conditional between two
  icons, and the button-inside-a-label case) and **eight negative controls** that
  pin the over-reporting the scanner must not do. Reverting one label fails the
  sweep naming that exact file and line.
- **Replaces two file-by-file guards' coverage gap:** `tests/mobile-touch-a11y.test.ts`
  and `tests/photos-a11y-labels.test.ts` cover five files between them and **none
  of the 82 was in those five**. This one names no file.

### And an existing guard caught a defect this change introduced

`tests/i18n-client-scope.test.ts` failed on *"the marketing site has no key outside
its scope"*. `app/(marketing)/blog/blog-search.tsx` is a marketing client component,
and each surface ships only the part of the catalogue its client components use — so
`a11y.clearSearch` would have rendered as the **raw key** to every visitor of the
blog. Exactly what that guard exists to prevent, and it earned its keep.

Fixed by putting `a11y` in `ROOT_CHROME_SCOPE` rather than in each surface's own
list — a deliberate widening. These keys are the accessible NAMES of controls, and a
control appears on every surface: the blog's search field, a public gift page, the
sign-in screen. Scoping them per surface means adding an `aria-label` to an auth
component fails a test about authentication copy, for a reason unrelated to the
author's intent. 28 short strings in the active locale is a few hundred bytes
against the marketing scope's 2 KB, and the alternative is a guard that punishes the
right change.

---

## Pass Y — the other half of U-05: controls a mouse can operate and a keyboard cannot

### [CLAUDE-1][HIGH][A11Y] 22 click targets were reachable by mouse only — and the obvious fix would have undone Pass X

- **Status:** FIXED (all 22), commit in this branch
- **Files:** `components/modules/calendar-module.tsx:620,639,687,732,816` ·
  `notes-module.tsx:268,311` · `photos-module.tsx:327,376,404` ·
  `recipes-module.tsx:308` · `contacts-module.tsx:191` · `meals-module.tsx:372,413` ·
  `goals-module.tsx:134` · `documents-module.tsx:613` · `scan-module.tsx:115` ·
  `components/migrate/migrate-wizard.tsx:369` · `chores-module.tsx:225` ·
  `locator-module.tsx:221` · `components/guardian/contact-list.tsx:276` ·
  `rules-editor.tsx:253`
- **Problem:** `<div onClick={…} className="cursor-pointer …">` with no `role`, no
  `tabIndex` and no key handler. Not focusable, so Tab never reaches it and Enter
  never fires. WCAG 2.1.1 Keyboard, **Level A**.

**Claude-2 recorded 44 sites and estimated "roughly half" were harmless dismiss
catchers.** Recounted with an AST scanner against the current tree: 49 non-native
`onClick` elements, of which 21 are empty `inset-0` catchers, 7 are
`stopPropagation`-only wrappers, and **22 are defects**. Claude-2's list also named
`files-hub-module.tsx`, which is already correct — its dropzone is a real
`<button type="button">` (line 302) and its only div-onClick is an empty catcher. It
was the one entry listed without a line number, which was the tell.

Five sites its list did not reach: `components/app/blog-launcher.tsx`,
`marketing/consent-manager.tsx`, `ui/modal.tsx` (all three already correct — `aria-hidden`
scrims), and `guardian/contact-list.tsx` + `rules-editor.tsx`, which are not.

### Why `role="button"` on the row is the wrong fix, and this is the point of the pass

Claude-2's recommended fix was `role="button" tabIndex={0} onKeyDown` plus an
`aria-label`. That is right for a leaf and **wrong for 8 of the 22**, because
`role="button"` has **presentational children**: ARIA states that assistive
technology may drop the semantics of every descendant, and that authors MUST NOT put
interactive elements inside such a role. The note row holds the Pin, Copy and Delete
buttons whose `aria-label`s Pass X had just added. Putting `role="button"` on that row
would have traded a Level A failure for silencing the labels from the previous tranche.

So the fix splits by shape, and the scanner reports which shape each site is:

| shape | sites | fix |
|---|---|---|
| leaf activation | 6 | `role="button" tabIndex={0} onKeyDown` — name comes from its own contents |
| upload dropzone | 3 | same; the hidden `<input>` is `display:none`, so not a descendant that can be silenced |
| row holding its own buttons | 8 | a real nested `<button>` over the content region; the row keeps its `onClick` as a mouse convenience |
| empty-slot cell | 2 | a real `<button>`, because the cell's handler fired only when the cell was empty and the remove button only when it was full — never both |
| mouse-only dismissal | 3 | Escape, not a tab stop |

No `aria-label` where the element already shows text: `role="button"` takes its name
from its contents, and the calendar chip already shows the title and the time. A fixed
label would replace that with something less useful and break WCAG 2.5.3 Label in Name.
Three new keys only, in all seven catalogues, for the two cases with no visible text
(a photo tile, an empty meal slot) and the lightbox's dialog name.

### The keyboard trap the pass surfaced on the way

`photos-module.tsx`'s lightbox covers the screen and had **no key handling at all** —
Escape did nothing, and the only way out was clicking the backdrop. WCAG 2.1.2 No
Keyboard Trap, Level A. It mattered more the moment the tiles that open it became
operable: the fix for 2.1.1 would have walked users into a trap. It now closes on
Escape and moves with the arrows, since the Previous/Next buttons already sit either
side of the image.

Both Guardian editors (`contact-list.tsx`, `rules-editor.tsx`) declare
`role="dialog" aria-modal="true"` and build the shell by hand instead of through
`components/ui/modal.tsx`, **which handles Escape** — so neither closed on Escape and
both scrims were mouse-only and in the accessibility tree. Fixed in place; that they
duplicate `ui/modal.tsx` rather than use it is recorded, not refactored.

### The instrument, and five bugs in it

`scripts/audit-keyboard-operable.mjs`. Every exemption is **structural**, derived from
the code — a list of filenames would go stale the first time one of those files gained
a real control and nothing would say so. The dismissal exemption is conditional on
Escape being wired somewhere in the same file, which is deliberately coarse in the
direction that over-reports.

Getting the count honest took five corrections, each now a comment in the script and a
test case:

1. **A zero-argument call is not a dismissal.** `onlyDismisses` looked for a non-off
   argument and found none in `inputRef.current?.click()` — silently exempting all
   three upload dropzones.
2. **`hidden sm:inline-flex` is not `hidden`.** Reading a bare `/hidden/` made the
   contacts row look like a leaf when it holds a call button and a mailto link — the
   one distinction that decides whether the row may take `role="button"`.
3. **`aria-hidden` is the airtight exemption for a scrim**, not "the handler is named
   onClose". Three of the five newly-surfaced sites were already correct that way.
4. **The nested-button exemption must match the ACTION, not the shape.** Compared by
   called-function name, ignoring `stopPropagation`/`preventDefault` — the contacts row
   toggles, so its nested button must stop propagation or the row's handler fires second
   and toggles straight back.
5. **And that exemption must not cover a dismissal.** The lightbox backdrop dismisses
   with `setLightboxIdx(null)` and its Previous/Next buttons navigate with the **same
   setter**, so the exemption matched and hid a full-screen overlay with no Escape
   handler. Caught only by noticing the reverted count was 21 where the first probe said
   22.

`tests/every-click-can-be-made-with-a-keyboard.test.ts` — 20 cases: the sweep must be
empty, 6 positive controls, 12 negative controls, and the two ways the nested-button
exemption was too generous. Reverted all 14 component files: the sweep fails naming all
22 sites and the other 19 cases still pass, which is the proof they are decoupled.

### One defect this pass introduced, caught by lint

The `chores-module.tsx` Escape effect landed **after** `if (loading) return …` — a
conditionally-called hook, which breaks the hook order on the first render that resolves.
`react-hooks/rules-of-hooks` named it. Moved above the early returns. Third time this
session a mechanical insertion needed a compiler or linter rather than a reading to catch.

### Declined

`git checkout -- lib/i18n/messages/` was **not** used to revert the catalogues for the
proof — earlier in this session that exact command discarded an uncommitted new key and
broke six locales' parity. The 14 component files were copied out first and restored
from the copies.

The initial catalogue edit sorted the keys, which reordered all seven files: a
**5,700-line diff for 3 keys**. Reverted and redone by inserting each key after its
nearest existing namespace sibling: 21 insertions, 3 per file. The catalogues are not
sorted and this pass does not sort them.

### A third guard that made a correct fix look like a regression

`tests/photos-a11y-labels.test.ts:55` failed on the photos list row. Its last case
re-implemented the icon-button check as a **line heuristic**: for each `<button`, join
the next five lines and call it unnamed if that window holds an icon component and no
visible text.

The window is the flaw. The list row's open button begins with a conditional
thumbnail — five lines of `<Play />` and an `<img>` — and the caption that **names**
it is eleven lines further down. So the guard reported a button whose accessible name
is its own visible text.

Adding an `aria-label` to satisfy it would have been wrong twice: it overrides that
visible caption (WCAG 2.5.3 Label in Name) and invents a name for a control that
already has a better one. Instead the case now delegates to
`scripts/audit-icon-button-labels.mjs`, which parses the real JSX and is **strictly
more accurate** than the window it replaces — the same scanner that already sweeps
the whole app in `tests/every-icon-button-has-a-name.test.ts`, kept here pinned to
the file where A-05 was found. The three cases that pin specific label strings are
untouched.

Proved it still catches what it was written for, rather than merely made to pass:
stripping `aria-label={tr('photos.editPhotoDetails')}` fails 2 of 4 cases and names
`components/modules/photos-module.tsx:385`.

**Third instance of this class in the session** — after
`tests/mobile-fullscreen-panel-safe-area.test.ts` anchoring on a dead CSS class
(P-04) and `tests/wallet-allowance-persistence.test.ts` asserting the exact text of a
defective UPDATE (W-02). The shape is always the same: a guard that pins an
implementation detail rather than the property it is named for, so the correct fix is
what turns it red.

`fs` has been an unused import in that file since before this pass; eslint does not
flag it and it is left alone rather than widening the diff.

---

## Pass Z — the shared formatter follows the locale, and the honest size of what is left

### [CLAUDE-1][HIGH][I18N] Every date, time and money value in the shared formatter rendered in US English — and there are 24 money formatters, not one

- **Status:** MECHANISM FIXED + PROVEN; conversion RATCHETED (249 sites remain, ceiling enforced)
- **File:** `lib/utils/format.ts`, plus `components/i18n/use-format.ts` (new),
  `lib/utils/format-server.ts` (new)

Claude-2 recorded *"245 hardcoded `'en-US'` formatters and a USD-only
`lib/utils/format.ts`"*. Verified, and it is worse in two directions and narrower in a
third:

| measure | finding | measured |
|---|---|---|
| `'en-US'` literals in app/components/lib | 245 | **261** |
| hardcoded-locale **formatter** sites | — | **252** in 144 files |
| independent money formatters | "a USD-only format.ts" | **24** |
| family-facing `fmtMoney` files | — | **5 of 20** — the other 16 are Super Admin |

`lib/utils/format.ts` was locale-blind in four ways, not one: `format(d, 'EEE, MMM d')`
gives "Tue, Jul 14" to a German family who expect "Di., 14. Juli"; `'h:mm a'` gives
12-hour AM/PM to locales using a 24-hour clock; `fmtRelative` said **"Today,"** in
hardcoded English; and `fmtMoney` pinned `new Intl.NumberFormat('en-US')` at module
scope. 323 call sites across 144 files go through it — 70 client, 74 server.

**`lib/i18n/locales.ts` states the intent in its own header** — the unit is a full
locale because *"a family in Mexico and a family in Spain both read Spanish but expect
different dates, currency and vocabulary"* — and the `Locale` type carries no date or
currency information and nothing consumed it for either.

### Why Intl and not date-fns with a locale

This is the part that looks equivalent and is not. A pattern like `'EEE, MMM d'`
hardcodes the **order** as well as the names, so `format(d, 'EEE, MMM d', { locale: de })`
yields *German names in American order*. `Intl.DateTimeFormat` gets both right, and
costs no bundle. The test asserts the ORDER (`de.indexOf('14') < de.indexOf('Juli')`),
which is exactly the half a locale-aware date-fns call would still get wrong.

`PATTERNS` maps the nine date-fns patterns the app actually passes to Intl option bags,
and anything unmapped falls through to date-fns so it renders as today rather than
wrong. The guard reads every pattern the app passes **out of the source** and requires
each to be mapped — removing one mapping fails naming `'MMM d, yyyy'`.

### Money: the currency is not a locale question

The currency belongs to the money, not the reader's language: a US family's wallet is
in dollars whichever language they read, and showing a USD balance as euros because the
UI is French would **misstate an amount** — worse than the defect. So `fmtMoney(cents,
currency)` keeps the currency a caller's argument (eight tables carry a `currency`
column; `lib/wallet/ledger.ts:127` already threads it and pinned only the locale) while
the grouping and separators follow the locale. `"12,50 $"` is how German writes twelve
and a half US dollars; `"$12.50"` is not.

`lib/insurance/policies.ts:160` is deliberately NOT merged into the shared one: it takes
**whole dollars**, not cents, so routing those amounts through the cents formatter would
divide them by a hundred.

### What is fixed, and what is ratcheted

Fixed: the mechanism (`createFormat(code, t?)`, `useFormat()`, `await getFormat()` —
matching the existing `useTranslations()`/`getTranslations()` idiom exactly), and the
five family-facing money/date surfaces (insurance, settings, the referral panel and
page, Home). 252 → 249.

**Not fixed: 249 sites in 141 files, and this is recorded as a ratchet rather than
claimed.** Converting 24 money formatters and 144 files is a project, and a
half-conversion is worse than either finishing it or recording it precisely — it leaves
two conventions and no way to tell which a surface follows.
`tests/hardcoded-locales-only-go-down.test.ts` pins the ceiling so the total can only
fall, names the offenders on failure, and states which categories are legitimately
`'en-US'` (the locale code as data in `lib/i18n`; crons, exports and model prompts,
which have no reader whose language is known; Super Admin pages in the platform's own
currency).

### A sixth instrument bug, and the one that would have made the ratchet worthless

The ceiling took three tries and the derivation is now written into the test rather than
just the result:

- `git grep -c` says **247** — it counts matching LINES and several hold two formatters.
- Counting matches says **252** — but that **reads comments**, and one of them is this
  pass's own header quoting `new Intl.NumberFormat('en-US')` to explain the defect. So
  the module that CLOSED a site still showed one, and **deleting the explanation would
  have "converted" it**. A ratchet satisfiable by removing a comment measures nothing.
- Comments stripped: **252** on HEAD, **249** now.

The bare `fmtDate`/`fmtMoney` exports are kept and are **not** a leftover: a cron, a CSV
export and the text of a prompt sent to a model have no reader with a language
preference, and the source language is right there. They are documented as that, and the
ratchet's failure message names them as the correct answer for that case.

### Next tranche, with its number

Convert the 249. The order that follows from the measurements: the 24 money formatters
first (money is where a wrong locale misstates a value rather than reading oddly), then
the 70 client files via `useFormat()`, then the 74 server files via `getFormat()`,
leaving `lib/i18n`, the crons/exports and the Super Admin pages as recorded exceptions.

---

## Pass AA — four semantic colours that failed WCAG AA in light mode, on web and on mobile

### [CLAUDE-1][HIGH][A11Y] 506 text sites below the contrast floor, and a guard that could not see it

- **Status:** FIXED (web and Expo, one change reaching both)
- **Files:** `app/globals.css` (light block), `design/tokens.json` (light block),
  `tests/brand-contrast-contract.test.ts`

Claude-2's ratios verified by independent computation — they match exactly:

| token | light, on `--bg` | on `--surface`/`--elevated` (pure white) | verdict |
|---|---|---|---|
| `--accent` | **2.67** | 2.86 | fails even the 3:1 large-text floor |
| `--success` | **2.91** | 3.12 | fails even 3:1 |
| `--warning` | **2.70** | 2.89 | fails even 3:1 |
| `--danger` | **4.09** | 4.38 | large text only |

Across **506** `text-*` sites — 295 of them `text-danger`, 128 `text-success`, 55
`text-warning`, 28 `text-accent`. **Dark mode was 7.13 to 11.74 throughout**, which is
how it survived: the app's own default theme is the dark one, so nobody developing in
it ever saw the failing combination.

### The fix is four lines, not 506

The house pattern for this already exists — `--brand` (4.70) beside `--brand-text`
(6.36) — so the obvious move was a `-text` variant per token and a rename of all 506
class names. Rejected: `text-success-text` reads badly, and darkening the base token in
**light mode only** fixes every site at once.

It is safe *because of what these tokens also drive*, which had to be checked rather
than assumed. The non-opacity fills are 21 `bg-danger`, 16 `bg-success`, 7
`bg-warning` — and reading them, every one is a **dot, a bar or a progress fill**:
graphics, not text backgrounds. A darker fill is *more* visible on a light page. Where
one does carry white text the ratio improves too, because contrast is symmetric:
`bg-danger` with white text goes 4.38 → **4.84**.

Hue and saturation held, lightness reduced in 0.005 steps, stopping at the **first**
value to reach 4.5:1 — so each is the smallest change that passes rather than a
repalette:

    --accent   233 122 74  ->  194 75 24    4.54 on --bg
    --success   31 165 122 ->   24 129 95   4.51
    --warning  197 142 24  ->  147 106 18   4.54
    --danger   213 70 70   ->  210 55 55    4.51

`--danger` barely moves, which matters because it is 295 of the 506 sites.
`--warning` moves most — a darker gold — and that is a real visible change, recorded
rather than glossed: it is the minimum that clears the floor at that hue.

### The mobile app had the same defect

`design/tokens.json` holds the same four light values and its own header calls itself
*"the ONE place the visual language is defined"*, with `mobile/src/theme/tokens.ts`
importing it directly. So fixing `app/globals.css` alone would have (a) failed
`tests/design-tokens.test.ts`, which exists to catch exactly that drift, and (b) **left
the Expo app inaccessible**. Claude-2's finding covers the web only; the same four
values were wrong in both. Both updated.

### The guard that was green while this shipped

`tests/brand-contrast-contract.test.ts` asserted that a `--brand-text` token *exists*
and that `text-brand` is never used. It pins the **shape of the brand fix** and computes
no ratio at all — so it was green for a stylesheet with four failing text colours. The
same class as the three defective guards already recorded this session: a test that
asserts the solution instead of the property.

It now parses the tokens out of `app/globals.css` and measures every text role against
every ground in both themes. Reverting the four values fails it naming **all twelve**
combinations with their exact ratios — `--accent on --bg: 2.67` … `--danger on
--elevated: 4.38` — matching the independent computation. Controls: the parse must find
the tokens (or "no failures" is indistinguishable from a loop that ran zero times), and
the measurement is checked against known ratios (black/white = 21, white/white = 1, and
the shipped `--warning` on `--bg` = 2.70) so a broken luminance formula fails there
rather than passing everything.

### Two near-misses worth recording

**The dark theme parsed to nothing.** `indexOf(':root {')` found the FIRST `:root {` in
the stylesheet — a block holding safe-area insets and no colours. The dark case was
measuring an empty token set. It surfaced only because a missing `--fg` is an explicit
error in the loop rather than an empty iteration; with a laxer check it would have
passed vacuously forever. The selector is `.dark {`, which is unambiguous.

**`json.dump` reflowed `design/tokens.json`** — 224 insertions for four values, because
Python's serialiser puts each array element on its own line. Reverted and done as a
surgical text replacement asserting **exactly one** occurrence, which also proves the
dark block (different values) was not touched. Second time this session a serialiser
turned a four-value edit into a whole-file diff, after the i18n catalogue sort.

---

## Pass AB — the money formatters, and a defect in Pass Z that only a rendered string could find

### [CLAUDE-1][HIGH][I18N] Eight money surfaces converted, and the ratchet lowered for behaviour rather than for shape

- **Status:** FIXED (8 sites); ratchet 249 → **241**
- **Files:** `components/modules/{billing,finances,trust,concierge}-module.tsx`,
  `components/wishlists/before-you-buy.tsx`, `components/approvals/approval-card.tsx`,
  `app/(app)/dashboard/family-cfo/page.tsx`, `components/modules/finances-module.tsx`

All six client money helpers were **module-scope functions**, outside any component,
so a hook could not reach them. Rather than thread a parameter through 59 call sites
(31 in billing alone), each became a factory taking the locale, shadowed inside the
component by a binding of the same name — so **every call site reads unchanged** and
the typechecker names any scope that still needs a binding. `tsc` found them all: one
component in billing and finances, two in concierge, and in `trust-module` the use is
inside `conditionSummary`, a plain function where a hook cannot go, so the locale is a
parameter there exactly as the translator already was.

`app/(app)/dashboard/family-cfo/page.tsx`'s helper took **dollars** where
`getFormat().fmtMoney` takes cents. Rather than reason about the conversion, the
equivalence was checked numerically across 11 values including the half-cent rounding
boundaries (`1234.565`, `0.005`, `999999.999`) — all identical.

### The Pass Z defect this pass found

Writing a behavioural assertion for the approval card's amount — `formatAmount(1050,
'USD', 'de-DE')` — failed against an expectation that *looked identical* to what came
back. The difference was **U+00A0**.

`createFormat`'s `normalise` replaced both U+202F and U+00A0 with an ordinary space,
across every helper. That is right for the AM/PM gap, whose character changed with ICU
72, and **wrong everywhere else**:

    de-DE   12,50<U+00A0>$              a NON-BREAKING space — the amount cannot be split
    fr-FR   1<U+202F>234<U+202F>567     U+202F is French's thousands separator
    pt-PT   1<U+00A0>234<U+00A0>567     U+00A0 is Portuguese's

So Pass Z shipped money that can break across a line mid-amount, and French and
Portuguese numbers whose grouping character was replaced. `normaliseClock` now applies
to U+202F in the date/time path only.

**Both the ratchet and the typechecker were green over it**, and so were the 16 cases
in `the-shared-formatter-follows-the-locale.test.ts` — because they asserted
`toContain('12,50')` and `toContain('$')`, which a flattened separator still satisfies.
Only an assertion on the **exact rendered string** could see it. That is the case for
`toBe` over `toContain` on a formatter, and it is now pinned: restoring the broad
normalisation fails the new case.

### Why the ratchet fell by exactly eight

The remaining money formatters are pure exported functions in `lib/` —
`lib/wallet/ledger.ts formatCents` alone has **137 calls across 22 files outside
`lib/`**, `lib/finance/{hub,splits,timeline}.ts`, `lib/home/utilities.ts`,
`lib/purchases/answer.ts`, `lib/services/finances/index.ts`, `lib/wallet/hub.ts`.

Adding an optional `locale` parameter to each, defaulting to `en-US`, would have
dropped the ratchet by nine more **without changing a single thing a family sees** —
the callers would still pass nothing. That would make my own ratchet lie, which is
worse than a higher number. So they are untouched and the count stands at 241.

`lib/ai/context/render.ts` is a separate case and is **correctly** `en-US`: it renders
the context sent to the model, and the reader is the model.

### Next tranche, with its numbers

`formatCents` (137 calls / 22 files) and the six other `lib/` money functions, each
converted **together with its callers** so the ratchet falls only for sites whose
output actually changed. Then the 70 client and 74 server date surfaces.

---

## Pass AC — the Family Wallet's money follows the reader (79 sites), and a mechanical edit I had to throw away

### [CLAUDE-1][HIGH][I18N] `formatCents` pinned the locale on every amount in the wallet

- **Status:** FIXED — 79 call sites across 12 views and 30 components; ratchet 241 → **240**
- **Files:** `lib/wallet/ledger.ts` + `components/wallet/{wallet-dashboard, child-detail-view,
  treasury-view, invest-view, send-money-view, babysitters-view, goals-view,
  public-gift-form, allowance-view, gift-view, activity-view, money-cards-view}.tsx`

`formatCents(cents, currency = 'USD')` already took the currency as an argument — eight
tables carry a `currency` column — and pinned only the **locale**. So a German family
read their child's balance as `$8,245.50` where they expect `8.245,50 $`, on every
amount in the Family Wallet: a balance, a savings goal, a sibling transfer, a
babysitter payment.

`currency` stays the caller's and only the separators follow the reader. Converting the
currency would misstate a balance, which is worse than the defect.

### The ratchet moved by one and the fix covers seventy-nine

Worth stating plainly, because the numbers look wrong together: the ratchet counts
hardcoded **literals**, and `formatCents` is one literal serving 79 call sites. A
ratchet is a floor on regression, not a measure of work.

### Two things correctly left alone

`lib/wallet/coach.ts` (9 calls) and `lib/wallet/gift-ai.ts` (1) build **AI prompts** —
the reader is the model, so the source language is right. Together with the five Super
Admin ledger pages (18 calls), that is 28 calls deliberately on the en-US default,
which is why the default was kept rather than removed.

### The mechanical edit I threw away, and why

The first attempt inserted the 28 bindings by finding, for each `formatCents` use, the
nearest preceding function declaration in the file's **lines**. eslint then reported

    React Hook "useLocale" is called in function "downloadStatement" that is
    neither a React function component nor a custom React Hook function

fourteen times, across seven files: the nearest preceding declaration was a nested
handler — `submit`, `archive`, `onSubmit`, `downloadStatement` — and a hook there is
illegal. Two more were *at the top level of the module*.

I reverted all twelve files rather than patch them. A half-applied mechanical edit
across twelve files is the case for resetting, not for chasing errors: every patch
would have been guesswork about which of my own insertions were sound.

The second attempt parses each file with the TypeScript AST and takes only
**top-level function declarations whose name begins with a capital** — the same rule
`react-hooks/rules-of-hooks` applies. Nested handlers then see the binding through the
closure, which is what should have happened the first time. 30 bindings, tsc clean,
eslint clean.

### And a second extraction bug in the same pass

The first binding script read tsc's output for `error TS2304: Cannot find name
'formatCents'` — and three files came out with **no binding at all**. TypeScript emits
**TS2552** ("Did you mean 'formatCentsIn'?") instead of TS2304 once a similarly-named
symbol is in scope, which is exactly what the aliased import created. So which files
got a binding depended on which error code the compiler chose. Matching both codes
fixed it.

Both bugs are the same shape as the five in Pass Y: an instrument reading a proxy for
the thing it cares about.

### Proof

`tests/wallet-ledger.test.ts` gains three cases on `formatCents` — the locale, the
currency, and the unchanged default — asserting **exact strings**, because the space
between amount and symbol is U+00A0 and French groups thousands with U+202F. Both are
non-breaking and load-bearing, and `toContain` cannot see either. Reverting the locale
to a literal fails 2 of the 3.

Arithmetic correction along the way: `formatCents(5000)` is **$50**, not $5,000 — the
argument is cents. My first expectations read `'5.000 $'` and `'€5,000'` and were
simply wrong; the French separator case needed 500,000 cents to have a thousands
separator to show at all.

### Remaining, with numbers

`lib/marketplace/fees.ts` (6) and `listings.ts` (2) each define their **own**
`formatCents`, shadowing the ledger's, used inside narrative strings — a separate
piece. Then `app/(app)/marketplace/{orders,insights,item}` (8, server pages),
`components/modules/chores-module.tsx` (1), and the six other `lib/` money functions.

---

## Pass AD — sixty date sites in twenty-six components, and the mirror of a guard that already existed

### [CLAUDE-1][HIGH][I18N] Dates rendered in US English across the calendar, meals, sports and 23 more

- **Status:** FIXED — 60 sites in 26 files; ratchet 240 → **180**
- **Biggest:** `calendar-module.tsx` ×15, `meals-module.tsx` ×10, `sports-module.tsx` ×5

Of the 116 remaining component sites, an AST pass split them: **70 inside top-level
capitalised components** (where a `useLocale()` binding works) and **47 inside 35
module-scope helpers** — `fmtDate`, `fmtTime`, `timeAgo`, `dueLabel` — where a hook
cannot go and the locale has to be threaded as a parameter along with its call sites.

**The unit of work is the FILE, not the site.** Converting only the component-level uses
in a file that also has a helper would leave one date localised and another not *in the
same view* — worse than leaving the file alone. So this pass takes the **26
component-only files** whole: 60 sites, 0 helpers. The 34 mixed files (57 sites) are a
separate pass that converts each helper together with its callers.

### Two async server components, and what caught them

`components/dashboard/{family,personal}-dashboard.tsx` have no `'use client'` and are
`export async function` — **server** components. The script gave them `useLocale()`,
which cannot run there. They read `getLocaleContext()` now, the way the
`getTranslations()` call beside them already did.

The only reason it surfaced is that `react-hooks/rules-of-hooks` refuses a hook in an
**async** function. A **non-async** server component would have passed `tsc`, passed
lint and shipped, failing at render.

So the gap is guarded. `tests/i18n-server-boundary.test.ts` checks that
`lib/i18n/server.ts` never reaches the browser — the header explains it shipped a red
build twice — and nothing checked the **mirror**: that the client provider's hooks never
reach the server. It does now.

The rule is about the **specifiers, not the edge**, and the first version got that
wrong: it flagged `app/layout.tsx` and `components/i18n/scoped-locale-provider.tsx`,
both of which import `<LocaleProvider>` from a server module *correctly* — that is what
a client boundary is for. Only `useTranslations`, `useLocale` and `useLocaleSource` are
the defect. Planting `useLocale` back into the dashboard fails it naming
`components/dashboard/family-dashboard.tsx: useLocale`.

### A third ordering bug of the same shape

The conversion script checked `if (!/\buseLocale\b/.test(text))` before adding the
import — **after** it had already inserted `const locale = useLocale();` into that same
text. So the test found the name it had just written and skipped the import in 24 of 26
files. Identical in shape to the `lib/wallet/ledger.ts` `LocaleCode` check in Pass AC
and to the comment-reading ratchet in Pass Z: a check whose subject includes the
change it is guarding. Fixed by testing for the *import statement* specifically.

### Remaining

180, of which **~39 are correct**: 13 AI-prompt sites (the reader is the model), 8
Super Admin, and the locale-as-data uses in `lib/i18n`. The real remainder is the 34
mixed component files (57), `lib/` (66), app pages (18) and api routes (18).

---

## Pass AE — attempted, reverted: why the 34 mixed component files are not a mechanical sweep

### [CLAUDE-1][MEDIUM][PROCESS] The remaining 57 component date sites need per-file judgement, and here is the evidence

- **Status:** NOT DONE — attempted, reverted, tree clean. Ratchet unchanged at **180**.

The previous four locale passes were all mechanical: find the hardcoded literal, thread
the locale, let `tsc` and `eslint` name the gaps. This one is not, and it is worth
recording *why* rather than leaving the next attempt to rediscover it.

A curried-factory tool was built and trialled on three files, converting a module helper
into `const fmtDateIn = (locale: LocaleCode) => (d: string) => …` with a per-component
binding so every call site reads unchanged. It worked on those three. Run across all 31
candidate files it produced **21 conversions and errors in four distinct classes**:

1. **Chained helpers.** `documents-module.tsx` has a relative-time helper that falls
   through to `fmtDate` for anything older than a week. Converting `fmtDate` alone leaves
   the caller referring to a name that no longer exists. Fixed in the tool with a
   fixed-point loop — a helper that *calls* a converted helper must itself become a
   factory, to any depth. That part now works.
2. **A pre-existing `locale`.** Several components already declare `locale`, from
   `useLocale()` or otherwise, and further into the body than the 500-character window
   the tool checked. Result: `Cannot redeclare block-scoped variable 'locale'`.
3. **Declaration order.** Where the existing `locale` came *after* the insertion point,
   `Block-scoped variable 'locale' used before its declaration`.
4. **Another async server component.** `dashboard/ai-home-dashboard.tsx`, like the two
   dashboards in Pass AD, is a server component and cannot take a hook.

**Reverted rather than patched**, for the same reason as the wallet attempt in Pass AC:
once a mechanical edit has misfired in several distinct ways across twenty-one files,
every subsequent patch is guesswork about which of my own insertions were sound. The
difference from Pass AC is that there the *approach* was recoverable — the AST knew what
a component was. Here four independent per-file facts have to be established first, so
the honest conclusion is that this is a per-file job, not a sweep.

**Ten of the 31 files were also skipped outright**, reported as "no module helper":
their helpers are declared as `const fmtDate = (d) => …` rather than
`function fmtDate()`, which the detector did not cover —
`declutter-module.tsx:27` is the example. That is a fifth thing a sweep has to handle.

### What the next attempt should do

Per file, in this order: (1) does it already declare `locale`, and where; (2) is the
component async, i.e. server — `getLocaleContext()`, not a hook; (3) are the helpers
`function` or `const` declarations; (4) does any helper call another. Convert one file,
run `tsc` and `eslint`, commit, repeat. 31 files at roughly 2 sites each — slower than a
sweep and the only way it stays correct.

The ratchet holds at 180 either way, so none of this can regress silently while it waits.

---

## Pass AF — components/ reaches zero, one file at a time as Pass AE said it had to

### [CLAUDE-1][HIGH][I18N] Every date, time and money value a component renders now follows the reader

- **Status:** FIXED — **components/ is at 0**. Ratchet 180 → **123**, 57 sites across 34 files.

Pass AE established that this could not be a sweep and named the four facts to check per
file. Working that way it went through cleanly:

| shape | files | approach |
|---|---|---|
| one `function` helper, client, clean | 12 | curried factory + per-component binding |
| `const` arrow helpers, client, clean | 10 | same; the tool gained the second declaration form |
| a chained helper | 1 | the fixed point passes the locale through to the inner factory |
| a pre-existing `locale` | 4 | binding moved **below** that declaration |
| async **server** components | 2 | `getLocaleContext()`, not a hook |
| component-level uses as well | 5 | the Pass AD tool, after the helpers |

The 23 clean files converted with **tsc and eslint clean on the first attempt** — the
difference from Pass AE being that the four facts were established first rather than
discovered by breakage.

### The three that still needed reading

**`ai-home-dashboard.tsx` already had `getLocaleContext()`** and a `locale` in scope. My
assertion refused to add a second one, which is the only reason a duplicate did not land.
The inspector had reported the file as async but *not* as having a locale, because its
regex required `const { locale } =` and the file writes `const { locale, messages } =`.
Another pattern too narrow for its subject — the fourth this session.

**Four files had the binding inserted above the `locale` it depends on**
(`Block-scoped variable 'locale' used before its declaration`), and `approval-card.tsx`
got a duplicate declaration outright. Fixed by hand: the binding belongs after the
existing declaration, not at the top of the body. Exactly the ordering failure Pass AE
predicted, and cheap to fix once it is four files rather than twenty-one.

**`completed-by-bubaly.tsx`** says in its own header *"No hooks: the server page renders
it from rows it is given"* — so its helper takes the locale as a parameter and the
component reads `getLocaleContext()`. The file documented its own constraint.

### What is left, and how much of it is a defect

123 sites: **app/ 44 in 25 files, lib/ 79 in 52 files, components/ 0.** A meaningful
share is correct rather than outstanding — the AI prompt builders (the reader is the
model), the crons and CSV exports (no reader whose language is known), the Super Admin
pages (the platform's own currency), and `lib/i18n`'s locale codes, which are data. The
next pass should classify those explicitly rather than convert blindly, so the ceiling
can stop at the honest floor instead of zero.

---

## Pass AG — classifying the last 123, and two things a sweep to zero would have broken

### [CLAUDE-1][HIGH][I18N] A family's language choice cannot reach anything Bubaly sends them

- **Status:** OPEN — **owner-owned**, needs a migration
- **Evidence:** no locale column exists on any member or profile table. `git grep locale
  -- supabase/migrations` returns only the AEO marketing-translation tables. The
  preference lives in one place: `LOCALE_COOKIE = 'bubaly-locale'`
  (`lib/i18n/locales.ts:54`).

`lib/i18n/server.ts:47` states the design assumption in its own words — cron handlers
and background jobs *"have no request and **no user to have a language preference**"*,
so falling back to the default locale is *"the correct answer"*.

**That assumption is false for eight sites across five files**, every one of which sends
something to a family:

| file | sites | what it sends |
|---|---|---|
| `lib/emails/weekly-digest.tsx` | 2 | the weekly digest **email** |
| `lib/emails/notification-digest.tsx` | 1 | the notification digest **email** |
| `lib/server/notifications.ts` | 3 | notification bodies |
| `lib/notifications/deadline-reminders.ts` | 1 | deadline reminders |
| `lib/moments/notify.ts` | 1 | moment notifications |

A family switches Bubaly to German in the UI and every email and push it then receives
is in English with US dates — and nothing in the product says so. Two further
consequences of a cookie-only preference, worth stating because they are not about
formatting at all: **the choice does not follow the user to a second device**, and it is
lost when site data is cleared.

**I cannot fix this.** Persisting a locale per member is a schema change, and migrations
are the owner's (F-001 has the ledger gated regardless). What code *can* do once the
column exists is thread it into these five files exactly as the component surfaces were
threaded. Recorded rather than half-built, because a formatter that takes a locale no
caller can supply is the "optional parameter nobody passes" that would make the ratchet
lie.

### The classification, so the ratchet can stop at an honest floor

123 sites remain. **41 are correct as `en-US` and must not be converted:**

| kind | sites | why en-US is right |
|---|---|---|
| `app/api/ai/*` prompt construction | 17 | read by the model, not a person — verified by reading `chat/route.ts:110`, which builds `fmtDate` inside the prompt |
| `lib/ai/*` context and result builders | 13 | same |
| Super Admin / operator pages | 9 | the platform's own books in its own currency |
| **`lib/onboarding/ics-time.ts`** | **2** | **not a display formatter at all** |

**`ics-time.ts` is the one a sweep to zero would have broken.** Its two
`Intl.DateTimeFormat('en-US', …)` calls are a *mechanism*, not output:
`resolvedOptions().timeZone` canonicalises an IANA zone name, and the second pins
`calendar: 'gregory'`, `numberingSystem: 'latn'` and `hourCycle: 'h23'` to extract
numeric parts for an ICS payload. Localising it could change the numbering system or the
calendar under a parser that reads those parts positionally. A ratchet demanding zero
would have forced someone to either break this or delete the guard.

**82 are genuine defects**, and of those **8 are blocked** by the finding above. The
remaining 74: `lib/` shared helpers reached by a family surface (54), family-facing pages
(18), the activity feed's compact relative time, and the feedback board.

### The honest floor is 41, not 0

Recorded in `tests/hardcoded-locales-only-go-down.test.ts` so the next person converting
knows where to stop, and knows which four categories to leave alone and why. A ratchet
that demands zero where zero is wrong is a ratchet someone deletes.

---

## Pass AH — every family-facing page follows the reader; app/ reaches its floor

### [CLAUDE-1][HIGH][I18N] The 18 family-facing page sites, and one signature threaded five frames deep

- **Status:** FIXED — **app/ is at its floor of 25**, all of which is exempt. Ratchet 123 → **104**.
- **Files:** `app/(app)/dashboard/{conflicts,food,memories,planning}/page.tsx`,
  `dashboard/playbook/playbook-actions.ts`, `display/page.tsx`, `wallet/treasury/page.tsx`,
  `home/page.tsx`, `feedback/feedback-board.tsx`, `app/(marketing)/blog/page.tsx`

All server components (plus one `'use server'` action and one client board), so the locale
comes from `getLocaleContext()` — the same source the `getTranslations()` call beside it
already uses — and each module helper takes it as a parameter. 14 call sites needed the
argument and `tsc` named every one.

`display/page.tsx` was the deep one: `formatBirthday` is called from `loadDisplay`, which
is called from `KitchenDisplayPage`. The locale had to be threaded through all three, and
the compiler walked it out one frame at a time.

`playbook-actions.ts` was mis-detected as a helper — my tool took
`refreshPlaybookAction` for a module-scope formatter because the name starts lowercase.
Adding a locale parameter to an **exported server action's signature** would have changed
its public shape. Reverted and done by hand: the action reads `getLocaleContext()` itself,
which is what a `'use server'` module should do.

### The fifth time I made the same ordering mistake

`if (!/LocaleCode/.test(text))` — checked **after** the edit had written
`, locale: LocaleCode` into that same text. So the import was skipped in all five files.
Identical to the `useLocale` check in Pass AF, the `LocaleCode` check in Pass AC, and the
comment-reading ratchet in Pass Z. Four of those five were the same two-line shape: a
guard whose subject includes the change it is guarding. Testing for the **import
statement** rather than the name is the fix, and it is the fix every time.

And one new one: the path regex `^(app/[^(]+)\(` never matched, because a Next route group
puts parentheses **in the path** — `app/(app)/dashboard/…`. It stopped at `(app)` and the
loop ran zero times over a non-empty error list, silently. It printed nothing, which is
the only reason I looked.

### app/ is now at its floor, and what that floor is

25 sites remain under `app/`, and every one is in an exempt category: **17** `app/api/ai/*`
prompt-construction sites (read by the model), **7** Super Admin pages (the platform's own
books), **1** `app/api/cron/admin-digest` (no reader). Nothing family-facing is left there.

**Remaining overall: 104**, of which the floor is 41. So 63 real defects, all in `lib/` —
54 shared helpers reached by a family surface, 8 blocked on I18N-001 (the cookie-only
locale), and the activity feed's compact relative time.

---

## Pass AI — the floor was wrong: 16 of these formatters are parsers, and one says so itself

### [CLAUDE-1][HIGH][I18N] Correcting my own number, and a guard for the failure a ceiling cannot see

- **Status:** the documented floor moves **41 → 55**; convertible defects **63 → 41**.
  Ratchet unchanged at 104. New guard added and proved.

Surveying `lib/` for the next conversion tranche turned up a category I had not separated,
and it changes the target rather than the schedule.

**Sixteen of the remaining sites are not display formatters at all.** They use
`Intl.DateTimeFormat('en-US', { timeZone })` as a **timezone-and-parts engine**, and the
pinned locale is load-bearing:

| module | what it actually does |
|---|---|
| `lib/services/scope.ts` | `hourInTz` parses the hour with `parseInt` — and **already carries a comment** that `'en-US'` renders midnight as `'24'` in some ICU versions, which it normalises |
| `lib/schedule/zoned.ts` | `tzOffsetMs` reads `formatToParts` for a DST-correct offset "without a tz database" |
| `lib/time/zoned.ts` | `isValidTimezone` uses the **constructor itself** as a validity probe |
| `lib/onboarding/ics-time.ts` | `resolvedOptions().timeZone` canonicalises a zone; the second pins `calendar`/`numberingSystem`/`hourCycle` for positional ICS part reads |
| `lib/guardian/rules.ts` | parses hour and minute out of a fixed-format string **to decide call routing** |
| `lib/services/trips/confirmation-import.ts` | comment: *"h23 and explicit calendar/numerals keep midnight and early years unambiguous"* |
| + `routines/schedule`, `onboarding-calendar`, `first-brief`, `first-brief-display`, `assistant/answers` | part extraction and validity probes |

Localising any of those changes **arithmetic, not wording**. Quiet hours, Guardian call
routing, trip import, routine scheduling and onboarding all read them. `scope.ts` is the
sharpest case: the code itself documents that the pinned locale's ICU quirk is what it
normalises against.

**So my earlier floor of 41 was wrong, and in the dangerous direction.** Had someone taken
it as a target they would have converted 14 parsers. Corrected to **55** (39 exempt by
category + 16 mechanism).

### The guard, and why a ceiling could not have caught this

A ratchet counts hardcoded locales and only refuses increases. **Localising a parser makes
it go DOWN** — the ceiling looks better while the code breaks. That is a failure mode the
shape of the guard cannot see.

So the mechanism count is now **pinned rather than minimised**, with the five signals that
identify one (`resolvedOptions`, `formatToParts`, `hour12: false`/`h23`, a pinned
`calendar`/`numberingSystem`, output parsed back into a number) and a bare-constructor
case for validity probes. If the count **falls**, the test fails naming the reason:

> *"a timezone/parts engine has been localised — read the note above before "fixing" this.
> These calls compute offsets, hours and ICS parts; the locale is load-bearing, and
> lib/services/scope.ts says so in its own comment."*

Proved by localising `scope.ts`'s `hourInTz`: **expected 15 to be 16**, with that message.

### Where the count actually stands

104 total = **55 correct** (39 exempt + 16 mechanism) + **8 blocked** on I18N-001 + **41
convertible defects**, all display formatters in `lib/` reached by a family surface.

---

## Pass AJ — the Finances surfaces follow the reader, and one "formatter" turned out to be a record

**Status: FIXED.** 5 formatter sites, 3 `lib/` modules, 12 surfaces. Ceiling 104 → **99**.

### What was converted

| module | helper | surfaces |
|---|---|---|
| `lib/finance/hub.ts` | `usd(amount, locale)`, `fmtDueDate(iso, locale)` | Bill Manager, Auto Pay, Due Reminders, Budget Planner, Savings, Payments |
| `lib/finance/splits.ts` | `usd(cents, locale)` | Expense Splitting, Subscriptions, Tax Vault |
| `lib/finance/timeline.ts` | `money(n, locale)`, `pretty(ymd, locale)` | Financial Copilot, affordability form, Family CFO forecast tiles |

The nine client views import the helper **aliased** (`usd as usdIn`) and rebind it under
`useLocale()`; `app/(app)/dashboard/family-cfo/page.tsx` is a server component and reads
`getLocaleContext()`. `BuildTimelineInput` gained an optional `locale`, so the insight copy
`buildCashflowTimeline` writes is formatted for whoever is reading the page rather than for
nobody.

### `[CLAUDE-1][MEDIUM][I18N]` `lib/services/finances/index.ts formatDollars` is NOT a display formatter

**Status: VERIFIED — reclassified as exempt, was counted as a defect.**

It reads exactly like one ("`"$1,234.56"` for narrative summaries") and I had it in the
convertible 41. Reading its **27 callers** says otherwise:

- 17 are `lib/ai/tools/finances.ts` `summarize` / `consequences` strings — read by the
  **model**, the same category as the AI prompt builders.
- 10 are activity-ledger `title`/`detail` rows this module **writes** (`index.ts:704, 723,
  945, 1017, 1096, 1187`).

A ledger row is a **record**: written once, read by many members over time. Formatting its
numbers in the language of whoever happened to trigger the write makes the record depend on
the actor. Its hardcoded **English prose** is the real defect there, and that is a
catalogue change rather than a formatter change. Floor is 56, not 55.

### `[CLAUDE-1][LOW][I18N]` the persisted Copilot insights are write-only

**Status: VERIFIED — not a defect, and worth writing down because it looked like one.**

`syncMoneyInsightsAction` upserts each insight's formatted `title`/`detail` into
`money_timeline_insights`. That looks like baked-in text a family would later read in one
member's language. It is not: `money-timeline/page.tsx:42` reads back only
`dedupe_key, status` and re-derives the copy from a fresh `loadMoneyTimeline` for its own
reader. The persisted columns are a record of what was surfaced.

Two things had to be true for that to be safe, and both were checked rather than assumed:

1. **`insightDedupeKey` is `${kind}:${weekStart ?? 'general'}`** — it does *not* include the
   title. Had it hashed the copy, localising the text would have changed every key and
   **orphaned every acknowledge/dismiss a family had set**. That was the real risk in this
   file and it is absent.
2. `AffordabilityResult` carries only numbers and dates, no prose — so
   `family-cfo/actions.ts` needed no locale and was left alone.

### `[CLAUDE-1][LOW][TEST]` a fourth guard that asserted the solution instead of the property

`tests/family-cfo-read-boundary.test.ts:45` asserted the **exact call text**
`'forecastInput = await loadMoneyTimelineInput(supabase, familyId);'`. Adding a locale to
the loader broke it — a change to an argument list, not to the read boundary the test
exists to hold. Now `toMatch(/forecastInput = await loadMoneyTimelineInput\(/)`: the
property is that the read is awaited into `forecastInput`, and the ordering assertions
below it already anchor on the `console.error` line.

That is the **fourth** guard in this audit to assert the solution rather than the property
(after a dead CSS-class anchor, an exact-text UPDATE assertion, and a five-line window).

### The new guard

`tests/the-finance-surfaces-follow-the-reader.test.ts`, 19 cases. What it holds that a
green diff would not:

- **Exact strings, not `toContain`.** `usd(1234.5, 'de-DE')` must be `'1.234,50 $'`
  and `usd(1234.5, 'fr-FR')` must be `'1 234,50 $US'`. A `toContain('1.234,50')`
  passes against a formatter that has flattened U+00A0 to a plain space — which is how an
  earlier pass shipped German money that could break mid-amount.
- **The order, not the words.** `fmtDueDate('2026-07-14', 'de-DE')` is `'14. Juli 2026'`
  and the test asserts `indexOf('14') < indexOf('Juli')`, because a date-fns pattern gives
  German month names in American order.
- **`timeZone: 'UTC'` survives the locale.** `pretty()` renders a week-start built at UTC
  midnight; under `TZ=America/Los_Angeles` it must still say `'Jan 19'`, not Jan 18.
- **The locale does not reach the arithmetic.** The de-DE forecast's `amount` and
  `weekStart` must equal the en-US one.
- **Every surface binds.** Each of the 10 files must import the helper aliased *and* rebind
  it to `locale.code`, and must read the locale from the correct half of the boundary
  (`useLocale()` in a client file, `await getLocaleContext()` in a server one). This is the
  half-conversion tsc cannot see, because the locale parameter is optional — a view that
  imports `usd` unaliased compiles and silently renders `en-US`.

Proved load-bearing by reverting `bills-view.tsx`: 2 of 19 fail, naming the file and
saying it must import `usd as usdIn` and must contain `useLocale()`.

### `[CLAUDE-1][LOW][LINT]` a real eslint error sits outside CI's lint scope

`npm run lint` is `next lint`, which does **not** lint `tests/`. `npx eslint .` finds
`tests/school-sports-desk.test.ts:359` — `@next/next/no-assign-module-variable`, an
**error**, committed 2026-09-09 and green in CI ever since. Not this pass's to fix, but the
gap is: `next lint` is deprecated, and whatever replaces it will start failing on a file
nobody has been told about. Recorded, not touched.

### Where the count stands

**99 total = 56 correct** (40 exempt + 16 mechanism) + **8 blocked** on I18N-001 +
**35 convertible defects**, all display formatters in `lib/`. `components/` is at zero;
`app/` is at its floor of 25.

---

## Pass AK — one time-ago, and the defect class a locale ratchet cannot see

**Status: FIXED (english-only ladders now zero).** Ceiling 99 → **93**, plus a new
measured class the ceiling was structurally blind to.

### `[CLAUDE-1][HIGH][I18N]` eleven private "time ago" ladders, all English-only

**This is the finding, not the conversion.** `tests/hardcoded-locales-only-go-down.test.ts`
counts `'en-US'` in a formatter position. It cannot see this:

```ts
if (mins < 60) return `${mins}m ago`;
```

There is no locale in that line to find — **the English is the literal.** Eleven surfaces
had grown their own ladder, under **five different names** and with **three different
wordings**, every one of them English for all eleven locales, and the locale scan was green
over all of it:

| where | name | wording |
|---|---|---|
| `lib/activity/feed.ts` | `relativeTime` | `just now` / `30m ago` / `1w ago` → `MMM d` |
| `lib/memories/memories.ts` | `relativeTime` | same, → `MMM d, yyyy` after 7 days |
| `lib/marketplace/discover.ts` | `relativeTime` | `5 min ago` / `3 hr ago` / `2 days ago` |
| `lib/family/safety.ts` | `relTime` | `30m ago`, **`Math.round`** not floor |
| `lib/location/geo.ts` | `timeAgo` | `30m ago` — **and nothing calls it** |
| `components/modules/school-module.tsx` | `timeAgo` | `30m ago` |
| `components/modules/social-feed-module.tsx` | `timeAgo` | bare `2h`, no "ago" |
| `components/modules/contact-center-module.tsx` | `timeAgo` | `just now` → `toLocaleDateString()` |
| `components/modules/voice-module.tsx` | `ago` | 45s threshold → `toLocaleDateString(undefined, …)` |
| `components/modules/care-module.tsx` | inline in JSX | `Just now` / `${h}h ago` |
| `components/modules/inbox-queue.tsx` | `fmtTime` | `5m` / `3h` → `toLocaleDateString(undefined, …)` |

Two further things fell out of reading them side by side:

- **`social-feed-module.tsx` disagreed with itself.** Its ladder returned a bare `"2h"`, and
  only **one** of its two call sites appended `" ago"` — so the same value read `· 2h ago`
  on the list and `· 2h` on the card.
- **`lib/location/geo.ts timeAgo` has no caller anywhere.** Exported, unit-tested, rendered
  by nothing. A tested export with no caller is a guard measuring nothing.

### `[CLAUDE-1][HIGH][I18N]` I18N-002 — fourteen dates follow the BROWSER, not the family

**Status: VERIFIED, measured, pinned. Not fixed in this pass.**

`toLocaleDateString()` and `toLocaleTimeString()` **with no argument** follow the browser's
locale. A family who sets Bubaly to Deutsch on an en-US laptop gets American dates at
fourteen sites — `quick-capture.tsx`, `guardian-dashboard.tsx` (×2), `migrate-wizard.tsx`
(×2), `life-events-module.tsx` (×2), `relationship-module.tsx`,
`independence-module.tsx`, `calendar-sync-panel.tsx`, `marketplace/item/[id]/page.tsx`,
`admin-notifications-list.tsx`, `lib/emails/chore-reminder.tsx`.

This is the **hardest of the four flavours to diagnose**, because the source looks
locale-aware: it calls a `toLocale…` method. Only the missing argument gives it away, and no
scan for `'en-US'` can ever say so.

### The shared helper

`fmtTimeAgo` on `createFormat`, so `useFormat()` and `await getFormat()` both carry it.
Two deliberate choices, both of which change what a reader sees, and both written into the
code rather than left for someone to discover:

- **`style: 'narrow'`, `numeric: 'always'` renders en-US byte-identically** to the ladders
  — `"30m ago"`, `"3h ago"`, `"2d ago"`, `"1w ago"`. The shipped English copy is unchanged
  and the five existing tests keep asserting a real contract. The cost is that narrow is
  terse in French and Portuguese (`"-30 min"` rather than `"il y a 30 min"`). Flipping the
  single `AGO_STYLE` constant to `'short'` fixes those **and** changes en-US to
  `"30 min. ago"` on ten surfaces — visible product copy in the majority locale, so it is
  the owner's call, and it is one constant with a comment saying exactly that.
- **Sub-minute takes `numeric: 'auto'` on seconds**, giving `"now"`, `"jetzt"`,
  `"maintenant"`, `"ahora"`, `"adesso"`, `"nu"`, `"agora"` — a real word in all eleven.
  The ladders said `"just now"`; narrow/always would say `"in 0s"`, which is worse than
  either. **en-US loses the "just" and gains ten correct locales**, and the three tests
  that pinned `'just now'` now say why.

Marketplace was the other visible English change: `"5 min ago"` → `"5m ago"`. Unifying on
one implementation means unifying on one wording, and the compact form is what nine
surfaces already showed.

### Two things that are NOT this helper's job, and are counted separately

- **`lib/display/ambient.ts countdownLabel` is FORWARD-facing** — `"in 15 min"`,
  `"Sat 3:00 PM"` on the Kitchen Display. A past-tense helper cannot express it. Converted
  in place instead: clock and weekday from the locale, `"Now"` and `"in {minutes} min"` from
  two new catalogue keys, translator optional with an English fallback — the contract
  `fmtRelative` already uses for "Today"/"Tomorrow". Its three call sites in
  `display-grid.tsx` bind it.
- **`lib/marketplace/auction.ts timeLeft` ("2d 4h") and `lib/sleep/coach.ts fmtHours`
  ("7h 30m") are COMPOSITE DURATIONS.** `Intl.RelativeTimeFormat` describes one unit in one
  direction, so it cannot express either. A real gap needing `Intl.DurationFormat` or a
  catalogue key, and not the same defect as showing a German family American words.
  Classified apart so the two are not conflated.

### The instrument, and the exemption that was too generous

`scripts/audit-time-ago-ladders.mjs` finds a millisecond→label conversion and classifies it
four ways: `ladder` (English-only), `ladder-localised` (private but locale-aware),
`composite-duration`, `browser-locale`. The discriminator between a ladder and a duration is
**the word, not the shape** — a "time ago" label says so (`ago`, `just now`); a duration
says `"2d 4h"` or `"Ended"`.

**Its first version had an exemption that made it useless, and only planting a defect back
found that.** It skipped any window mentioning `fmtTimeAgo` — but a component that
destructures `const { fmtTimeAgo } = useFormat()` at the top has that name in scope for the
whole file, so a ladder written twenty lines below it was silently exempt. I re-planted the
`inbox-queue.tsx` ladder and the guard **stayed green over it**. The exemption is gone: a
site that delegates has no ago-template, so `isLadder` is already false for it and no
exemption was needed at all. Re-planted again: fails, naming
`components/modules/inbox-queue.tsx:77`.

That is the **third** instrument in this audit whose exemption was too generous (after the
zero-argument call read as a dismissal, and the nested-button exemption covering a
dismissal) — and the third caught only by reverting a fix rather than by reading the code.

### The guard

`tests/one-time-ago-and-it-follows-the-reader.test.ts`, 12 cases. It pins the four counts
with a different meaning for each: **english-only must stay 0**; localised-private held at 5
(four worth folding in, the fifth correctly separate); composite durations named by file;
browser-locale held at **14**. Plus a positive control requiring the instrument to still see
three of the four shapes, since all four counts come from one scanner and a blind one would
report zeros that three of the four tests would happily accept.

### Catalogue

Three keys × 7 base catalogues (the four regional overlays inherit through
`FALLBACK_CHAIN`): `locatorModule.now`, `locatorModule.sinceTime`, `care.noContactLogged`,
`ambient.now`, `ambient.inNMin`. Checked while there: **en-GB, es-MX, es-US and fr-CA hold
zero keys**, which looks alarming and is correct — they are deliberate overlays and
`lib/i18n/messages.ts` documents the chain.

### Where the count stands

**93 = 56 correct + 8 blocked** on I18N-001 + **29 convertible** hardcoded-locale defects,
all display formatters in `lib/`. Separately: **0** English-only time-ago ladders, **5**
private-but-localised, **2** composite durations, **14** browser-locale dates (I18N-002).

---

## Pass AL — I18N-002 closed: eighteen dates stopped following the machine

**Status: FIXED (18 of 19; the 19th is blocked on I18N-001).**

`toLocaleDateString()` / `toLocaleTimeString()` with **no locale argument** follow the
browser. A family who sets Bubaly to Deutsch on an en-US laptop got American dates. Every
one now takes `useFormat()` in a client component or `await getFormat()` in a server one.

| surface | what it showed |
|---|---|
| `components/app/quick-capture.tsx` | the live "when" preview — **and** `'Today'`, `'Tomorrow'` and the joining `" at "` were English literals |
| `components/guardian/guardian-dashboard.tsx` | an escalation's clock, and every call row's date |
| `components/guardian/call-history.tsx` | the day heading and each call's clock |
| `components/migrate/migrate-wizard.tsx` | both event-preview lists |
| `components/modules/life-events-module.tsx` | `fmtDate` + `fmtFullDate`, module-scope |
| `components/modules/relationship-module.tsx` | anniversary and gift dates |
| `components/modules/trip-intel-module.tsx` | `fmtDateTime` + `fmtTime`, module-scope, plus a trip card |
| `components/modules/independence-module.tsx` | a milestone's achieved date |
| `components/dashboard/calendar-sync-panel.tsx` | "synced {date}" |
| `app/(app)/marketplace/item/[id]/page.tsx` | the price-history dates (server) |
| `app/(app)/dashboard/trip-intel/actions.ts` ×2 | **worse than the rest** — see below |

### `[CLAUDE-1][HIGH][I18N]` the two worst were on the server, writing into a calendar

`app/(app)/dashboard/trip-intel/actions.ts:151` and `:220` build a calendar event's
**description** with `toLocaleTimeString([], …)`. On a server that is not the browser's
locale — it is **the server's**, and a server has no reader at all. The text is then
persisted into the family's calendar, so the leave-by time a family reads was formatted
for a machine in whatever region Vercel happened to run the action. Both now take
`await getFormat()`.

### The instrument was wrong in three ways, and only the conversion found them

Pinning a number makes the scanner a contract, so its blind spots become false assurance.
Three came out while working the list:

1. **`/ 1000` was not a divisor it recognised.** A ladder that converts to *seconds* and
   then divides by 60 twice reads identically to a person and not at all to a regex looking
   for `60_000`. Two real sites were invisible.
2. **`toLocaleTimeString([], …)` was not a spelling it recognised.** An empty array is the
   same defect written so it looks deliberate, and it hid **five** more sites, including
   both server actions above.
3. **`components/admin/` was not covered by the operator-page exemption**, only
   `app/(app)/admin/` — so `admin-notifications-list.tsx` was being counted as a
   family-facing defect when the audit's own rule says the operator console is en-US.

Widening it surfaced a **false positive** in the other direction: `lib/blog/engagement.ts`
`formatLikeCount` renders `"1.2k"` and `"1.2m"`, and `` `${…}m` `` reads exactly like
"1.2 minutes" to a regex. The discriminator added: a time label **compares against a
time** — 60, 24, 3600, 86400, 604800 — or says "ago". A like count compares against 1,000.

Also added: dedupe by `file:line:kind`, because one source line can hold two matches (a
ternary with a clock on one branch and a date on the other is **one** site to fix) and
counting it twice makes a pinned number drift on a cosmetic edit.

### Four patterns added to the shared map

`'EEEE, MMM d'`, `'EEEE, MMMM d'`, and — for the sites that were calling
`toLocaleDateString()` with no options at all — `'P'` and `'pp'`, which are date-fns's own
spelling for "this locale's short date" and "this locale's time with seconds". Mapping the
shape lets a converted site keep the rendering it had while taking the family's locale
instead of the machine's.

### Catalogue

`quickCapture.tomorrow` and `quickCapture.dayAtTime` (`"{day} at {time}"` → `"{day} um
{time}"`, `"{day} à {time}"`, `"{day} às {time}"` …) across the 7 base catalogues.
`calendar.today` already existed and is reused.

### What is left, and why

**One** browser-locale site: `lib/emails/chore-reminder.tsx`. It is an **email**, and a
family's language lives only in `LOCALE_COOKIE`, which a cron cannot read — one of the
eight blocked on **I18N-001**. It is counted in the guard rather than exempted from it, so
it stays visible as blocked work instead of disappearing into a passing test.

Also still open, pinned so they can only fall: **8** localised-but-private ladders (seven
worth folding into `fmtTimeAgo`; the eighth, `lib/display/ambient.ts countdownLabel`, is
forward-facing and correct as it is) and **5** composite durations
(`lib/marketplace/auction.ts` `"2d 4h"`, `lib/sleep/coach.ts` `"7h 30m"`,
`lib/analytics/{journey,onboarding}.ts` `"1m 05s"`), which `Intl.RelativeTimeFormat` cannot
express at all.

---

## Pass AM — the instrument was the defect: three false positives, two hidden ladders, one pass reverted

**Status: FIXED.** No production behaviour depended on this except two English-literal
countdowns it uncovered. The point of the pass is that **pinning a number turns a scanner
into a contract**, so its blind spots become false assurance — and this one had them in
both directions.

### Bounding the window to the enclosing declaration

The scanner took a ±character window around each millisecond divisor. That window read
across **three unrelated functions**. `lib/location/geo.ts` has `distanceLabel` (metres →
km, `/ 1000`) sitting between `timeAgo` above and `isStale` below, so the window picked up
`Date` from one and `60_000` from the other — and a **distance** label satisfied every
signal for a time ladder. Bounded to the enclosing top-level declaration, the signals now
have to be true *of the same function*.

That one change removed three false positives and **surfaced two English-only ladders the
wide window had mis-classified as localised**, because it had seen the word `locale`
somewhere else in the file:

- **`components/modules/trust-module.tsx` `timeLeft`** — `'expired'`, `` `${n}m left` ``,
  `` `${n}h left` ``, `` `${n}d left` ``. A delegation's remaining time, in English, on a
  **trust** surface. Forward-facing, so `fmtTimeAgo` is the wrong tool: it takes the
  translator instead, with four new catalogue keys.
- **`components/display/kitchen-timers.tsx`** — `'Done!'` on the Kitchen Display, and a
  custom timer's own **name** built as `` `${m} min` ``. "min" is an abbreviation that
  differs by locale (German writes "Min."), and `Intl.NumberFormat` with
  `style: 'unit'` knows all eleven — en-US still renders "15 min".

### Two more things the widened divisor got wrong

Widening `MINUTE_DIVISOR` to accept `/ 1000` (so a ladder that goes via seconds is visible)
made **every** `/ 1000` a candidate. Besides `distanceLabel`, `lib/blog/engagement.ts`
`formatLikeCount` renders `"1.2k"` and `"1.2m"` — and `` `${…}m` `` reads exactly like
"1.2 minutes" to a regex. Added: a ladder must also **be about a time** (`Date`,
`getTime()`, `now`, `iso`, `ms` in the same declaration).

### And one pass I built and then reverted

Tightening the window cost visibility of `lib/sleep/coach.ts` `fmtHours`, which renders
`"7h 30m"` from **minutes** and so has no millisecond divisor to anchor on. I added an
independent scan over two-unit templates to get it back. It found 18 "composite durations"
— and the new ones were `lib/calendar/heatmap.ts`'s prose (*"3 packed days in the last 4
weeks"*), `lib/watchlist/picker.ts`'s `` `${n} min fits` ``, and single-unit labels matched
across template boundaries in `lib/library/feed-parse.ts`.

**Reverted.** A count I cannot defend is worse than a name I can: the miss is one helper,
and it is now written by name into the scanner's header and asserted by the guard, which
requires the scanner to keep naming it. Three widenings, three crops of false positives —
that is the signal to stop widening.

### Also fixed while there

Six `lib/` modules had their new `createFormat` import land **mid-file** (after a
function, or inside `geo.ts`'s header comment) because the anchor I inserted against was
the declaration rather than the top. All moved to the top. tsc never minded; a reader
would have.

### Counts

**0** English-only ladders · **6** localised-but-private (five worth folding into
`fmtTimeAgo`; the sixth, `countdownLabel`, is forward-facing and correct) · **3** files of
composite durations plus one named miss · **1** browser-locale date, the email blocked on
I18N-001.

---

## Pass AN — "it takes a LocaleCode" was not evidence of anything

**Status: FIXED.** Four more ladders folded into `fmtTimeAgo`; private ladders **6 → 2**.

### `[CLAUDE-1][MEDIUM][I18N]` the `ladder-localised` label was flattering four defects

Pass AK's instrument split private ladders into `ladder` (English-only) and
`ladder-localised` (takes a locale). Reading the six that carried the second label, **four
of them were English-only too**:

| file | what every rung actually said |
|---|---|
| `app/(app)/feedback/feedback-board.tsx` | `'just now'`, `` `${m}m ago` ``, `` `${h}h ago` `` |
| `components/modules/documents-module.tsx` | `'just now'`, `` `${hrs} hours ago` ``, **`'Yesterday'`** |
| `components/modules/front-desk-module.tsx` | `` `${h}h ago` ``, **`'Yesterday'`** |
| `components/modules/inbox-module.tsx` | the same ladder, duplicated |

Each took a `LocaleCode` — and passed it **only to the fallback date**, thirty days or
seven days or two days down. Everything a reader actually sees on a fresh item was
English. **Accepting a `LocaleCode` is not evidence that anything is localised**, and my
own classifier had been treating it as exactly that.

All four now delegate to `fmtTimeAgo` with the threshold each already used, so their
switch-to-a-date behaviour is unchanged and every rung above it follows the reader.
`front-desk-module.tsx` and `inbox-module.tsx` held **byte-identical** copies of the same
ladder, which is the duplication the shared helper exists to end.

One wording change, documented in the guard: `'Yesterday'` at 24–48 hours becomes
`"1d ago"` in en-US. Intl's `numeric: 'auto'` would say "yesterday", but that is the
setting whose week rung reads "last wk." rather than "1w ago", and keeping en-US
byte-identical at the other four rungs is worth more than one word.

### The guard now names files rather than counting

Two private ladders remain and **both are correct as they are**, so a number would be
misleading: `lib/display/ambient.ts countdownLabel` is forward-facing (`"in 15 min"`,
`"Sat 3:00 PM"`) and `lib/location/overview.ts sinceLabel` says `"Since 3:04 PM"` rather
than an elapsed span. Neither can be expressed by a past-tense helper, and both take the
locale *and* a translator. The test asserts the two file paths, so folding one in or
adding a third both fail loudly.

---

## Pass AO — the Wallet and the Home dashboard, and a symbol in the wrong place

**Status: FIXED.** 5 sites, 4 surfaces. Ceiling 93 → **88**.

`lib/wallet/hub.ts` (`fmtUsd`, `fmtDollars`, `fmtSignedUsd`, `fmtCount`, `fmtTxnDate`),
`lib/home/home-data.ts` (`usd`) and `lib/home/utilities.ts` (`usd`) take the reader's
locale; the Family Wallet hub, the Home dashboard's finance card and donut, and Utility
Tracking bind them.

### `[CLAUDE-1][MEDIUM][I18N]` `home-data.ts usd` would have been wrong even with a locale

```ts
return `$${(amount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
```

The `"$"` is **prefixed by hand** and only the digits are localised. A mechanical
locale swap — exactly what the rest of this ratchet has been doing — would have produced
`"$2.767,60"`: the symbol in the American position with German separators, a currency
notation nobody writes. `style: 'currency'` puts the symbol where the locale puts it
(`"2.767,60 $"`). The test asserts the exact string *and* that the symbol does not lead in
a locale that puts it last, because a `toContain` cannot see either.

**This is why the conversion is a per-file reading rather than a sweep.** The ratchet would
have gone down either way.

### `[CLAUDE-1][MEDIUM][I18N]` `fmtCount` — a wrong separator that reads as a different number

Its own comment said *"Grouped integer count with **locale separators** (2,850)"* while
the code pinned `'en-US'`. German writes **`2.850`** for two thousand eight hundred and
fifty and **`2,850`** for two-point-eight-five: the grouping mark and the decimal mark are
**swapped** between the two conventions. So the Wallet's reward-points count was not
merely styled oddly for a German reader — it was legible as a different number.

### A binding that landed in the wrong function

`TransactionList` declares no `useTranslations()`, so my "insert after the translator"
anchor matched the **next** component's, 50 lines down, and the binding landed inside
`useAddForm`. tsc named it (`TS2552: Did you mean 'fmtTxnDateIn'?`). Third time this pass
family that an anchor found a later occurrence than intended — the lesson each time is the
same: anchor on something inside the target, or verify the match is within it.

### Not converted, and why

`lib/home/utilities.ts deterministicSavingsFindings` builds English prose with `usd`
inside it. Its **only** caller is `app/api/ai/home/utility-savings/route.ts`, which feeds
the model — the exempt category. No threading needed, and threading would have been
speculative.

---

## Pass AP — the hand-prefixed dollar sign was six files, not one

**Status: FIXED.** 8 sites, 14 surfaces. Ceiling 88 → **80**.

### `[CLAUDE-1][MEDIUM][I18N]` a defect a locale sweep would have counted as fixed

Pass AO found `lib/home/home-data.ts` writing the `"$"` by hand. It is **six modules**,
all carrying the same line:

```ts
`$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
```

`lib/career/hub.ts`, `lib/moving/planner.ts`, `lib/projects/planner.ts`,
`lib/vacations/meta.ts`, `lib/weekend/meta.ts`, `lib/twin/simulate.ts` — a salary band, a
move's budget, a home project's forecast, a trip's spend, a weekend event's price, and the
digital twin's "can we afford it" verdict.

**The ratchet would have gone down either way.** Swapping `'en-US'` for the reader's
locale — the exact move this ceiling rewards — renders `"$2.768"` in German: the American
symbol position with German separators. `style: 'currency'` puts the symbol where the
locale puts it, and the guard asserts both the exact string and
`de.startsWith('$') === false`, because neither is visible to `toContain`.

Converted with them: `lib/declutter/missions.ts` (the weekday chip on the seven-day plan)
and `lib/memories/timeline.ts` (the `"July 2026"` month heading — where the **order**
matters as much as the words, since several locales put the year first).

### How each reaches a reader

The three modules' `money` and the trip `dollars` are bound in 11 client components.
`lib/twin/simulate.ts` builds **prose** (`"That would blow the Fun budget by $200."`), so
the locale rides in on `SimContext` — the same shape `BuildTimelineInput` uses — and
`simulateDecisionAction` reads `getLocaleContext()`. `lib/weekend/meta.ts priceRange`
needed both halves: the amounts from the locale, and `"from"` / `"up to"` from two new
catalogue keys with an English fallback when no translator is supplied.

### `[CLAUDE-1][LOW][DEAD]` a second tested export nothing renders

`lib/memories/timeline.ts groupByMonth` is imported **only by its own test**. No page, no
component. That is the second such find after `lib/location/geo.ts timeAgo`, and both were
found the same way — by looking for the callers before changing a signature.

### `[CLAUDE-1][MEDIUM][TEST]` the fifth guard asserting the solution, and this one failed *because the work succeeded*

`tests/hardcoded-locales-only-go-down.test.ts` carried a control:

```ts
expect(scan(sourceFiles()).length).toBeGreaterThan(50);
```

Its purpose was to prove the scanner is not blind. But it was keyed to a number **that
falls as the defect is fixed**, and it went red at exactly 50 files — so *finishing the
job* would have looked identical to *the scanner breaking*. It now asserts the property by
name: the scan must see `lib/services/scope.ts`, `lib/schedule/zoned.ts` and
`lib/time/zoned.ts`, which pin a locale **on purpose** and are therefore never going away.

### And the non-breaking separator caught me a third time

Four expectations in the new test were written with a plain space where Intl emits U+00A0,
and the failure prints two strings that look **identical** in the diff. The separators are
now written as ` ` / ` ` escapes, with a note in the file header saying why.

### An anchor guard that earned its keep

The binding inserter asserts its "insert after the translator" match falls within 400
characters of the component start. On `ProjectDetail` it fired — that component declares no
`useTranslations()`, so the match belonged to a component further down. Pass AO learned
that from a tsc error; this time the script refused before writing.

---

## Pass AQ — I18N-003: fifty-one money values whose symbol is a literal

**Status: VERIFIED, measured, pinned. Deliberately NOT converted — see below.**

### `[CLAUDE-1][HIGH][I18N]` the second class the locale ratchet cannot see

The ceiling counts `'en-US'` in a formatter position. It cannot see this:

```ts
`$${(cents / 100).toFixed(2)}`
```

And this is **worse** than a hardcoded locale, not milder. `toFixed` has **no locale at
all**: it always emits a `.` decimal mark and never groups. A German reader gets
`"2768.00"` where their convention is `"2.768,00"`, with the symbol on the American side.
**Even at ceiling zero, fifty-one money values would still render that way.**

Nor would a locale swap fix it — the symbol is *text*, so the best a swap achieves is
`"$2.768,00"`: the American symbol position with German separators, which nobody writes.

**51 sites across 43 files**, after excluding the operator console and model-read text
structurally. Among them: the billing module's seven plan prices, the pricing page, the
upgrade modal, the trial paywall, the approval card, Closet, Dining, Inventory, Voting,
the marketplace's auction, negotiation, listing, price-coach and price-history helpers,
and `lib/stripe/service-fee.ts`.

This is the **second** class of this shape, after the English-literal time labels of Pass
AK. A ceiling on hardcoded locales is necessary and not sufficient — twice over, now.

### Why this pass pins rather than converts

Every one of the 51 needs one of two things first, and neither is a formatter change:

- **a locale threaded from a caller that does not have one.** `lib/autopilot/engine.ts`
  takes a `FamilySnapshot`; `lib/intelligence/hard-signals.ts` takes rows. Neither carries
  a reader.
- **the English prose around the amount moved to the catalogue.** `"Spent $120 of your
  $400 monthly Fun budget"` is not fixed by localising two numbers inside an English
  sentence.

Converting without that lowers a number while changing nothing a family sees — the
"optional parameter nobody passes" this audit has refused since Pass Z. So it is held at
51, visible, and may only fall. `scripts/audit-hand-written-currency.mjs` names every
site; `tests/the-currency-symbol-is-not-a-literal.test.ts` holds the count with a positive
control (two files certain to hold the shape), a negative control (a like count and a
distance label, which must **not** appear), and a structural assertion that no admin or AI
path is ever counted. Planting one back: **"52 hand-written currency symbols, held at 51."**

### And the first instrument I wrote for it was useless

My first regex was `` [`'"]\s*[$€£¥]\s*\$?\{ `` — which matches `` `${ `` itself, because
the `$` of a template placeholder is a dollar sign. It reported **167 sites**, most of them
percentages and counts. A measurement I could not defend is not a measurement. The dollar
must be **doubled** (`` `$${x}` ``) or sit outside the braces (`` `${x} $` ``) for the
symbol to be a literal.

### Three more reclassifications, from reading callers

- **`lib/marketing/crm.ts formatCents` — Super Admin.** Its only three callers are
  `app/(app)/admin/marketing/{affiliates,pipeline,proposals}/page.tsx`.
- **`lib/assistant/tools.ts` — model-read.** Its `note` field addresses the model directly
  (*"These are the busy blocks; open time is the gaps between them"*), and the line below
  it uses `'en-CA'` as a YYYY-MM-DD formatter, which is a mechanism.
- **`lib/meals/pantry-chef.ts` — model-read.** Its own header says *"Vision prompt"*.

That is six exempt sites found by reading callers rather than the call, across this
segment. And one **near-miss in the other direction**: I had `lib/marketing/format.ts
formatFamilies` written down as dead before checking — it is used twice inside its own
module, by `familiesNote` and `formatHandled`. I checked before acting.

---

## Pass AR — "Overdue" beside "Di., 14. Juli" is worse than "Overdue" beside "Tue, Jul 14"

**Status: FIXED.** 6 sites, 4 helpers, 5 surfaces. Ceiling 80 → **74**.

### The shape, and why it is the harder half

Four helpers mix a formatter **this ratchet counts** with English literals **it cannot
see**:

```ts
if (diff < 0) return 'Overdue';                                     // invisible
return d.toLocaleDateString('en-US', { weekday: 'short', ... });    // counted
```

Converting only the counted half would have left a German family reading **"Overdue"
beside "Di., 14. Juli"** — a half-translated chip, which is *worse* than a wholly English
one, because it looks like someone tried and stopped. So each takes the locale **and** a
translator, on the contract `fmtRelative` already used: words from the catalogue when a
caller has one, English when it has none.

| helper | the words it was hiding |
|---|---|
| `lib/chores/dashboard.ts dueLabel` | `'No due date'`, `'Overdue'`, `'Today'`, `'Tomorrow'` |
| `lib/messages/overview.ts shortTime` | `'Yesterday'` + a seven-entry weekday array |
| `lib/moments/prep.ts momentWhen` | `'starting now'`, `'in N min'`, `'in N hours'`, `'Today'`, `'Tomorrow'` |
| `lib/memories/memories.ts relativeDay` | `'Today'`, `'Yesterday'`, `` `Last ${weekday}` `` |

Only **three** new catalogue keys were needed — `moments.startingNow`,
`moments.inNHours`, `memories.lastWeekday`. The rest already existed (`todos.overdue`,
`todos.noDueDate`, `calendar.today`, `quickCapture.tomorrow`,
`completedByBubaly.yesterday`, `ambient.inNMin`), which says the words had been lifted
elsewhere and only these four helpers were missed — `lib/` sits outside the i18n gate's
surfaces, which scan `app/` and `components/`. That is the same reason
`lib/marketing/format.ts` records for its own case.

### `Last ${weekday}` could not have been fixed by localising the weekday

French writes **"samedi dernier"** — the word *after* the day. A template with the word
baked in front cannot express that however well the weekday itself is translated. The
test pins exactly this: `relativeDay(…, 'fr-FR', …)` must be `'samedi dernier'`, not
`'Last samedi'`.

### Two English weekday arrays deleted, not left unread

`['Sun','Mon',…]` and `['Sunday','Monday',…]`. `Intl.DateTimeFormat` knows the weekday in
all eleven locales, so the arrays are **gone** rather than sitting unused beside a comment
saying nothing reads them. Four patterns joined the shared map to make that possible:
`'EEE'`, `'EEEE'`, `'M/d/yy'` (the messages list's compact date — and note `fr-FR` renders
it `14/06/26`, day first, which the old `M/D/YY` could never express).

### What the guard holds that a green diff would not

- **The TONE never moves.** `dueLabel` returns `{ label, tone }` and the tone drives colour
  and urgency. The test asserts `dueLabel(d, now, 'de-DE', de).tone === dueLabel(d, now).tone`
  across every rung, so a locale can never reach the thing that decides whether a chore
  looks urgent.
- **The English fallback is a contract, not an accident.** Every helper is asserted twice:
  once with no translator (English, unchanged, byte for byte) and once with one.
  `lib/moments/notify.ts` is a cron with no reader — I18N-001 — and the English path is
  what it gets, deliberately.
- **The arrays are asserted gone**, by pattern, in the source.

One expectation of mine was wrong and the test caught it: I wrote `'Morgen 09:00'` where
`hour: 'numeric'` renders `'Morgen 9:00'`. The 24-hour clock is the locale's; the
zero-padding is the pattern's. Two separate choices.

---

## Pass AS — the floor rose a third time, and again by reading callers

**Status: FIXED (what was reachable) + reclassified (what was not).** Ceiling 74 → **70**.

### `[CLAUDE-1][MEDIUM][I18N]` three more sites are blocked, not convertible

`lib/autopilot/engine.ts` (`fmtUsd`) and `lib/intelligence/hard-signals.ts` (`money`) build
money **prose** — *"Spent $120 of your $400 monthly Fun budget"*, *"$14 charge: Netflix in
3 days"*. Both are driven by crons — `app/api/cron/autopilot-scan/route.ts` and
`app/api/cron/model-refresh/route.ts` — that **persist** what they write. A cron has no
reader, so a locale parameter would be one nobody could fill.

Their three sites therefore join the eight already behind **I18N-001**: **eleven blocked,
not eight.** That is the **third** time this audit's floor has risen, and all three times
from reading callers rather than the call — the mechanism engines (Pass AI), the
records-not-formatters (Pass AJ), and now the cron-driven prose builders.

### What was genuinely reachable, and converted

| module | what a family sees |
|---|---|
| `lib/location/overview.ts groupHistoryByDay` | the location history's day heading — `'Today'`/`'Yesterday'` from the catalogue, the date from the locale |
| `lib/marketing/format.ts formatFamilies` | the **public** family count on the pricing page and the homepage proof band |
| `lib/purchases/answer.ts` | the "Before you buy" answer, which already took a translator and had only its **amounts** pinned |

`formatFamilies` is the one worth naming. German **swaps** the grouping and decimal
marks, so `"12,000"` on a German page is legible as **twelve** — a public number a visitor
reads as a different number. It now renders `"12.000+"`, and the test pins both.

### `[CLAUDE-1][LOW][TEST]` the fifth guard asserting the solution

`tests/marketing-handled-honesty.test.ts:133` pinned the exact call text
`'familiesNote(t, stats.families)'` and broke the moment that function gained a locale —
a change to a signature, not to the honesty the test exists to hold. It now matches
`/familiesNote\(\s*t\s*,\s*stats\.families/`, so the property survives an argument.

Five now, and the shape is always the same: a guard written against *how* something was
done rather than *what must be true*. The four before this were a dead CSS-class anchor,
an exact-text UPDATE assertion, a five-line window, and a magnitude control keyed to a
number that falls as the work succeeds.

### Where the count stands

**70 = 56 correct** (40 exempt + 16 mechanism) + **11 blocked** on I18N-001 + **3
convertible**, the last of which are in files this pass did not reach. `components/` is at
zero; `app/` is at its floor of 25.

---

## Pass AT — five more places a refused read was reported as an empty world

**Status: FIXED.** Verified from Claude-2's and Claude-4's still-OPEN findings, one of
which carries the best proof in this audit.

### `[CLAUDE-2 → CLAUDE-1][HIGH][STATE]` "No members yet." could never be true

Claude-2's reasoning, which I re-derived from `lib/supabase/auth.ts` before acting:
`getUserContext()` reads `family_members` for **this caller** with
`.eq('is_active', true)`; an empty result returns `{ needsFamily: true }`, and
`requireUserContext` then provisions a family and re-resolves, or redirects to
`/onboarding`. So by the time `app/(app)/family/members/page.tsx` runs its body, the
caller **is** an active member of `ctx.active.familyId`.

A correct read of the same table, same family, same filter therefore returns **at least
one row, always**. `members.length === 0` was reachable only when `data` was `null` — the
error the page never destructured. **There was no state of the world in which "No members
yet." was true**, and a parent whose read was refused was told their household was empty.

That is the strongest version of E-01 in the audit: not a wrong message, an **impossible**
one.

### Two where the empty state changed what the page DID, not just what it said

- **`app/(app)/dashboard/family-access/page.tsx`.** `usernameByMember` is built from an
  unread `child_logins` result, and that map decides between *"reset this child's PIN"* and
  *"give this child a login"*. A dropped error turned every existing login into a
  create-a-login prompt — **a write offered on the strength of a read that did not
  happen.** The error copy says so explicitly, because the risk is not "the list looks
  empty" but "you are about to overwrite".
- **`components/modules/recipes-module.tsx addToGrocery`.** A failed `grocery_lists` read
  fell into `if (!list)` → *offer to create one*. A family with a perfectly good Groceries
  list ends up with **two**, their items split across both. The fix is one branch, and its
  **order** is the whole point: the error case must precede the empty case.

### And one that told the family something false about their own database

`app/(app)/family/permissions/page.tsx` rendered *"Permission rules load from the database
once the policy seed is applied."* over an unchecked read. That reads as a setup step they
have not done — so a parent debugging an **RLS regression** was being pointed at a seed
script that had already run.

### Already fixed, and recorded as such

`app/(app)/family/activity/page.tsx` — Claude-2 filed it OPEN; it now has an `ErrorState`
on `logsError`. Its `members` read still drops its error, but that read is **decoration**
(a name lookup), and the Pass R precedent is to say so rather than guard it and pretend
both matter equally.

### The guard

`tests/a-failed-read-is-never-an-empty-world.test.ts`, 8 cases. It asserts the **property**
— the error is destructured, logged, and rendered — never the call text, because five
guards in this audit have now failed by pinning how something was written. Two cases carry
their weight beyond that:

- **Ordering.** The guard must come *before* anything is derived from the rows, and in the
  recipe flow the error branch must come *before* the empty branch. A page that guards
  after deriving still renders a conclusion drawn from a failed read.
- **The premise is pinned.** The `/family/members` argument rests entirely on
  `requireUserContext` guaranteeing an active membership. That contract is now asserted in
  `lib/supabase/auth.ts` directly, so if it ever changes, the reasoning behind the guard
  fails loudly instead of quietly becoming false.

Reverting the members page and the recipe flow fails 3 of 8, naming both.

---

## Pass AU — two primitives that documented a guarantee they did not hold

**Status: FIXED** (two), **BLOCKED with the reason corrected** (one).

### `[CLAUDE-2 → CLAUDE-1][LOW][A11Y]` `Field` called itself "fully accessible"

Its own docstring said so. The error is rendered with `role="alert"`, so it is
**announced once** when it appears — and then the control reported nothing. A user who
tabs back to the field, or reaches it any way other than at the instant the error
appeared, is told the field is fine. WCAG 3.3.1 asks the **field** to identify itself as
in error; a message sitting near it is not the same thing.

**Fixed centrally, not at 124 call sites.** `Field` now clones the render prop's element
to apply `aria-invalid` and an `aria-describedby` pointing at the message (or the hint when
there is no error), so every consumer is correct without one of them being touched. Three
properties make that safe, and each has a case:

- **A call site that sets either attribute itself wins** — the explicit value is never
  clobbered.
- **A render prop returning something other than a single element** (a fragment, a
  conditional pair) is **left exactly as it was** rather than guessed at. The second
  argument exists for those, and the test proves the render prop receives it.
- **A healthy field must not report itself invalid** — `aria-invalid` is absent, not
  `"false"`.

### `[CLAUDE-3 → CLAUDE-1][LOW][INPUT]` `*` is a wildcard to PostgREST and neither sanitizer knew

Both `lib/services/search/index.ts sanitizeQuery` and `lib/ai/activity.ts safeSearchTerm`
state their purpose as stopping a query that would *"quietly match far more than the person
typed"* — and both missed `*`.

**The reason they made the same omission is worth keeping**: `*` is **not a SQL wildcard**.
It is PostgREST's own spelling of `%` in a `like`/`ilike` value, so a character class
written against the LIKE grammar — which is what both of these are — does not contain it.
Two sanitizers written independently made the identical mistake because they were both
written correctly against the wrong grammar. A search for `*` became `%%%%` and returned
every row the caller could see.

### `[CLAUDE-4 → CLAUDE-1][LOW][EDGE-CASE]` the 31st allowance — blocked, and Claude-4's alternative does not work

Verified exactly as filed: `nextRunDate` reads the day-of-month off `fromIso`, which after
the first run is the **already-clamped** date, so 2026-01-31 → 02-28 → 03-28 → 04-28 …
A parent who sets "the last day of the month" gets it three days early for the rest of the
child's life.

Claude-4 offered *"store the intended day-of-month on the rule **or derive it from the
rule's `created_at`**"*. **The second does not work**, and that is worth recording so
nobody tries it:

- `created_at` does not move when a parent **edits** the rule to a different day, so an
  edited rule would clamp to the wrong anchor forever.
- `updated_at` moves on **every** unrelated edit (an amount change) **and on every run**,
  since the runner writes `next_run_on` — so it is not an anchor at all.

`allowance_rules` has no other candidate column (`id, family_id, child_wallet_id,
amount_cents, cadence, split, is_active, next_run_on, last_run_on, created_by` + stamps).
The parent's intended day is **not recoverable from anything currently stored**, so this
needs a column, which is a migration, which is the owner's and gated behind **F-001**.
Recorded there rather than half-built — an `anchorDay` parameter nobody can supply is the
same lie as an optional locale nobody passes.

---

## Pass AV — the question a destructive click never asked, and the language it asked it in

**Status: FIXED** (19 sites + one shared primitive), **NAMED AND PINNED** (21 + 26).

### `[CLAUDE-2 → CLAUDE-1][MEDIUM][UX]` a single tap deleted a record, and there was no primitive to ask with

Claude-2 filed this as LOW against two modules. Verified exactly as described, then
**measured the class instead of fixing the two cited sites** — and the measurement moved
the severity and found a second defect underneath it.

**40 destructive clicks across 27 files** reach a delete with nothing on the path that
asks. Six are the scan reading a toggle as a delete (`vote`, `castVote`, `logDose` clear a
row to write another); **34 are real**.

**The severity is not uniform, so the fix is not a sweep.** What separates them is what is
lost and whether it comes back:

- A weather city, a packing item, a gift idea, a leftover: one tap to re-add.
- An insurance policy carrying the member ID, group and RX BIN/PCN numbers **and the card
  photos**; an uploaded warranty document; a contractor's quote; a vaccination record; a
  guardian routing rule. None of those is re-keyable from memory, and two of them are a
  file the family no longer has anywhere.

Sixteen handlers in the second group now ask; the twenty-one in the first are listed by
name in the guard as deliberately unconfirmed. Blanket-adding a confirmation to all 34
would have made the trivial ones worse for no gain and buried the ones that matter.

**There was no primitive to route them through.** Claude-2's fix said *"route both through
the shared `Modal` confirm the codebase already uses"* — the codebase has an excellent
accessible `Modal`, but no confirmation built on it. The 32 places that do ask call raw
`window.confirm()`. So `components/ui/confirm.tsx` is new: a `ConfirmProvider` mounted in
the **authenticated** layout (not the root — that would put its strings and the Modal's in
the scope every marketing page ships) and a `useConfirm()` returning
`(request) => Promise<boolean>` that never rejects and settles `false` on every exit.

Two decisions in it are deliberate and are the opposite of what the neighbouring
primitive does:

- **Outside the provider it falls back to `window.confirm`, where `useToast` throws.** The
  property this exists to hold is that a destructive click *asks*; a forgotten provider
  should cost the styling, not the question. Returning `false` instead would have been
  worse than either — every delete button in that subtree would become a silent no-op that
  still reported success.
- **It is called `askConfirm` at the call sites, not `confirm`.** Nine of the ten files it
  was adopted into still contain `window.confirm` calls elsewhere. Binding the name
  `confirm` would have shadowed the global, and `if (confirm('…'))` against a
  promise-returning function is **always truthy** — every one of those remaining dialogs
  would have silently stopped gating anything.

**`Modal` needed one fix to make nesting honest.** A confirmation opens on top of the
dialog whose Delete button was pressed (`WarrantyModal.removeFile`). Both listen on
`document`, so one Escape dismissed **both**, and closing the inner one lifted the scroll
lock while the outer was still open. `Modal` now keeps a stack and only the top-most dialog
answers keys.

### `[CLAUDE-1][MEDIUM][I18N]` I18N-004 — 32 confirmations ask in English regardless of the reader

Found by reading what the *confirmed* sites say, which is the only way it could have been
found: it is a third defect the hardcoded-locale ratchet is structurally blind to, for the
same reason as I18N-002 and I18N-003 — **there is no locale in the source to count.**

```tsx
confirm(`Delete “${m.title}” with all its tasks and boxes? This cannot be undone.`)
confirm(`Delete ${m.name}? This also removes its schedules and dose history.`)
```

A German reader is asked, in English, to authorise something irreversible. That is worse
than a mis-grouped number: a number rendered oddly is still legible, and this is a question
the reader may simply not be able to read — gating the one class of action that cannot be
taken back. **32 calls across 26 files.**

The count had to be measured rather than taken from the first grep, which reported 44
files. Eighteen of those already pass a `t()` lookup — they ask in the reader's language
and only through the browser's unstyled dialog, which is a smaller and different problem.
Listing them would have been a false accusation *and* a weaker guard: a genuinely new
English literal added to one of the eighteen would have passed silently.

Two of them were the audit's own exhibit and are fixed in this pass:
`notes-module.tsx` asked `confirm('Delete?')` — untranslated *and* uninformative — twice.
All three of its asks now go through the primitive. The remaining 26 files are listed by
name in the guard, which fails when a new one appears — and when a listed one is fixed
without being struck off.

### The instrument, and why it pins names rather than a number

`tests/a-destructive-click-asks-first.test.ts` holds both inventories **by name**. This is
the ratchet lesson applied deliberately: a count falls as the work succeeds, which turns
the scanner's blind spots into false assurance. A named list fails in both directions — a
new unconfirmed click, **and** a listed one that quietly started asking without being
struck off.

It also has a not-blind control that asserts by name that the scan still reaches
`weather-module::removeCity` and `voting-module::vote`, and no longer reports the two sites
the audit named. Three planted defects were each caught: removing one adopted guard went
red in three independent assertions; a new English `confirm()` literal in an unlisted file
went red in the fourth.

**One thing the instrument got wrong first, and it was me reading it, not the scan.** The
first run appeared to miss `billing-module.tsx` — the file Claude-2 explicitly cited — and
I spent a debugging round inside the AST walk looking for the blind spot. Every piece
worked in isolation because there was no blind spot: I had piped the sorted output through
`tail -40`, and `billing-module` sorts near the top. The scanner was honest; the reading of
it was not.

### Two claims I nearly shipped that the schema refused

The body text for `deleteSchedule` and `deleteAccount` was going to say the dose history
and the transactions went with them. **Both are `ON DELETE SET NULL`** — `medication_doses.schedule_id`
(`00261`) and `transactions.account_id` (`0006`). The rows survive, unlinked. Checked
before writing, so the copy now says that, which is both accurate and the more reassuring
thing to read.

---

## Pass AW — I18N-004 closed: thirty-two confirmations that now ask in the reader's language

**Status: FIXED** (32 of 32).

Every English `confirm()` literal in `app/` and `components/` now goes through the
primitive from Pass AV. 22 keys across the seven base catalogues; the guard's
`ENGLISH_ASKS` inventory is empty and stays empty.

### The copy was accurate. Only its language was wrong.

Nine of the thirty-two made a claim about what else the delete takes with it, and
**every one was checked against the schema before being translated**:

| claim | FK | verdict |
|---|---|---|
| a medication takes its schedules and dose history | `medication_schedules.medication_id`, `medication_doses.medication_id` — both CASCADE | true |
| a move takes its tasks and boxes | `move_tasks.move_id`, `move_boxes.move_id` CASCADE | true |
| a project takes its materials and quotes | `project_materials.project_id`, `project_quotes.project_id` CASCADE | true |
| a career profile takes every application and résumé | `job_applications.profile_id`, `resume_versions.profile_id` CASCADE | true |
| a language goal takes every card and session | `vocab_cards.goal_id`, `language_sessions.goal_id` CASCADE | true |
| a trip takes its checklist | `trip_items.trip_id` CASCADE | true |
| a calendar feed takes its imported events | `calendar_events.feed_id` CASCADE (`0045`) | true |
| deleting a location makes its items lose their location | `inventory_items.location_id` **SET NULL** | true — and it is the one that is *not* a cascade |
| routine events already on the calendar stay | `calendar_events` has no template FK | true |

Nine for nine. That is worth stating beside Pass AV, where the **same check caught
two claims I was about to write that were false**. The check is what makes either
result worth anything; nine confirmations are not evidence that the check was
unnecessary.

### A count that could not be translated, and was not faked

`inventory-module` said *"{n} item{s} will lose their location."* `translate()` has
no plural machinery — it interpolates `{param}` and nothing else. Three options:
build an `Intl.PluralRules` layer for one string, ship a German plural that is
wrong half the time, or **say the same true thing without a count**. The body is
now *"Anything stored there loses its location. The items themselves are kept."* —
count-independent, grammatical in all seven, and it adds the reassurance the
original did not have.

### Four more guards asserted the solution rather than the property — nine now

`career`, `language`, `moving` and `projects` write-boundary tests each pinned
`/if \(!confirm\(/`. All four went **red on a change that made the behaviour
stricter**: the ask moved to a shared, localised, accessible dialog.

They are rewritten to the property they meant — **nothing is awaited before the
question** — which is what a confirmation has to mean. A handler that fires its
request and then asks has not asked. That is also the assertion the new guard uses
for all 32, so the local and global guards now say the same thing.

Nine instances of this mistake across the audit, always the same shape: a guard
written against **how** something was done rather than **what must be true**.

### Two things my own tooling got wrong

- **The converter was not idempotent.** `language-module` and `medications-module`
  were already adopted in Pass AV, and the script added a *second*
  `const askConfirm = useConfirm()` to each. `tsc` named it (TS2451, cannot
  redeclare). A generated binding needs an existence check, not just a
  within-this-run set.
- **`tests/` is outside the repo's lint scope.** `npm run lint` is `next lint` with
  no `--dir`, so it never reaches the test tree — where three ESLint **errors**
  had been sitting unseen. Two were mine from Pass AU
  (`tests/a-field-reports-its-own-state.test.ts`: `children` passed as a prop, and
  a component factory with no `displayName`). The `displayName` one is fixed. The
  other **is not a defect and is now marked as such**: rewriting it the way the
  rule asks — `createElement(Field, props, render)` — does not compile, because
  `Field`'s children IS a render prop, a function of `(id, aria)`, and
  `createElement`'s third parameter is typed as `ReactNode`. `tsc` said so the
  moment I "fixed" it. The line carries a disable with that reason instead. The
  third error, `tests/school-sports-desk.test.ts:359` assigning to `module`, is not
  mine and is recorded rather than touched.

---

## Pass AX — Guardian's safety vocabulary, and a gate that documented a guarantee it did not hold

**Status: FIXED** (33 of 45 + 3 more found in passing), **BLOCKED** (11), **EXEMPT** (1),
plus the gate itself wired into CI.

### `[CLAUDE-2 → CLAUDE-1][MEDIUM][I18N]` the reason a call was blocked was in English

Verified exactly as filed — `node scripts/i18n-scan.mjs --list lib/guardian` still
reported **45 hardcoded strings across 7 files** — and then split by **reading the
callers rather than counting the call**, which is the only thing that decides whether
a string is convertible:

- **33 are pure UI label maps.** `TRUST_LABELS`, `ROUTING_MODE_LABELS` +
  `_DESCRIPTIONS`, `SCAM_TYPE_LABELS` have **no consumer outside five client
  components** — call history, the rules editor, routing settings, the contact
  list, the dashboard. Every one has a translator two lines up. They now hold
  catalogue KEYS and the components resolve them, which is the repo's own pattern
  (`lib/marketing/consent-ui.ts`, gated as `marketing-lib-copy` for exactly this).
- **11 are blocked on I18N-001, and the trace is worth keeping.**
  `runDecisionPipeline` builds `reason` from `rules.ts`, `explainTrustDecision` and
  the seasonal note; the **Twilio voice/SMS/WhatsApp webhooks** persist it into
  `communications.ai_decision_reason`; `call-history.tsx:190` renders it verbatim
  weeks later. A webhook has no reader and no locale — the same shape as
  `lib/emails/chore-reminder.tsx` and the trip-intel calendar descriptions.
  `learning.ts` is the same by a different route: a cron writes suggestion titles
  into rows.
- **1 is exempt.** `ai-screen.ts:192`'s `'Unknown'` sits inside a prompt to the
  model. The model is its reader.

### The scanner understates the file it reports on

`trust.ts` shows 7 findings, and they are all the label map. It does **not** report
`explainTrustDecision` (`:103-115`), which builds seven English sentences —
*"{who} is in your Immediate Family — always rings through."* — because they are
interpolated templates rather than copy parked in a data structure. So the
module's real English count is higher than any number the gate will ever print.
Recorded rather than silently absorbed: this is the third time this audit that a
scanner's shape, not its threshold, is what limits it.

### Renaming the maps was the safety property, not tidiness

Changing `TRUST_LABELS`'s **values** to keys in place would have compiled
everywhere and rendered `guardian.trustBlocked` at every site whose author forgot
a `t()`. Renaming to `TRUST_LABEL_KEYS` makes the compiler visit all eighteen.

That mattered immediately. `rules-editor.tsx:179` was
`rule.condition_trust_levels.map(t => \`${TRUST_ICONS[t]} ${TRUST_LABELS[t]}\`)` —
**the callback parameter is named `t`, shadowing the translator** the line now
needs. Wrapping in place would have called a `TrustLevel` string as a function.
The parameter is `lvl` now.

### Three more English literals, found by being in the file

`guardian-dashboard.tsx` rendered a bare `'Handled'` fallback and a `SCAM` badge,
and `call-history.tsx` appended `(${n}% confidence)` — which is not only English
but puts the `%` where en-US puts it; fr-FR and it-IT space it differently and
it-IT puts the word first. All three are keys now.

### Two English strings I changed and then changed back

I first wrote **"Tax / Government Scam"** and **"Health Insurance Scam"** for all
seven locales, because "IRS" and "Medicare" are US agencies that mean nothing to a
Dutch or Italian reader. That is right for six of them and **wrong for en-US**: it
would have changed the words an American family already recognises in order to fix
a problem they do not have. en-US keeps *IRS / Government Scam* and *Medicare
Scam*; the other six say the same thing in terms their reader has.

### `[CLAUDE-1][MEDIUM][CI]` the i18n gate was never run

`scripts/i18n-gate.mjs` opens: *"Runs every entry in GATED_SURFACES and fails if
any of them has regained a hardcoded string… Nothing else in the build would
notice, so this does."* `npm run i18n:gate` exists in `package.json` and appears in
**no workflow**. Nine surfaces declared themselves translated and the promise was
checked by nobody — the same defect as Pass AU's two primitives, one layer up.

It now runs in CI directly after Lint, with
`tests/the-i18n-gate-is-actually-run.test.ts` holding three properties: CI invokes
it, every declared surface actually scans clean, and the scanner still reports a
label put back into a gated map.

**My first not-blind probe passed, and I nearly took that as proof.** I planted
`export const PLANTED = 'Suspected Spam Caller'` in `trust.ts` and the gate stayed
green. The scanner reads copy parked in data structures and in markup, not every
string literal — so a bare top-level const is outside it. Re-planted **in the shape
the defect actually took**, a label inside the `Record<>`, it went red immediately.
The control in the guard is the second plant, and the first one's blind spot is
written into the test beside it rather than left for someone to rediscover.

---

## Pass AY — the digest reached the first fifty families, and answered 200

**Status: FIXED** (the recipient read, the silent skip, the time budget, both guards),
**BLOCKED** (the resume cursor — needs a column).

### `[CLAUDE-4 → CLAUDE-1][HIGH][CORRECTNESS]` `listUsers()` is one page of fifty

Claude-4 filed this as part of a MEDIUM performance finding. Verified, and **the
severity is higher than filed, in two directions**.

`supabase.auth.admin.listUsers()` with no arguments does not return the user table.
It returns the first page — **fifty users** — and like the unbounded PostgREST
select `lib/supabase/read-all.ts` exists for, it says nothing about it. The
difference is that PostgREST's ceiling is a thousand rows and GoTrue's is fifty.

**It is not two call sites, it is three.** `lib/server/notification-emails.ts:66`
has the same read, and its comment says *"Mirrors the weekly-digest cron's
approach"* — the defect was copied on purpose, which is exactly why it needed a
named helper rather than three local fixes.

**And the reporting made it invisible.** The digest's

```ts
const adminEmail = emailByUserId.get(adminMember.user_id);
if (!adminEmail) continue;     // not a send, not a failure — not anything
```

so a family past the fiftieth auth user was dropped **without incrementing
`failed`**, and the route answered `200 { sent: N, failed: 0 }`. A cron reporting a
clean run it did not have is the class this audit has been closing since F-009 — and
here the counter existed and simply did not cover the case.

Both crons now report `skipped` alongside `sent` and `failed`. *"Nobody was due"*
and *"nobody could be reached"* are no longer the same response.

### `readAllAuthUsers` mirrors `readAll`'s doctrine, and one rule is specific to this API

Stop on an **empty** page, never on a short one — a short page is equally the
signature of a server-side cap. Added to that:

**Do not trust `nextPage`.** supabase-js parses the page number out of the `Link`
header with `.substring(0, 1)` (auth-js `GoTrueAdminApi.listUsers`), so **page 10
arrives as page 1**. A helper built on `nextPage` would loop or stop early at
exactly the scale where it starts to matter. This one counts pages itself, dedupes
by id (offset paging over a table people are signing up to hands the same user
back twice), and reports an *incomplete read* rather than a plausible prefix if it
hits its page cap.

### `maxDuration` raises the ceiling; only a cursor removes it

Neither cron declared one, so both ran under the platform default — on the order of
tens of seconds, which at 2–4 sequential round trips plus an email per family is
roughly **forty families**. `maxDuration = 300` takes that to roughly a thousand.

**That is a raised ceiling, not a solved problem, and it should not be recorded as
one.** The loop walks `order('id')` with no checkpoint, so a run killed mid-loop
serves the same prefix every week and never reaches the tail — a stable, invisible
partition of the customer base. The fix is a resume cursor (`last_digest_at` on
`families`, or a `digest_runs` table), which is a **migration, and therefore the
owner's, gated behind F-001**. Recorded there rather than half-built.

Not done either: hoisting the per-family `loadCompareLine` reads into one cohort
query. It is a real optimisation and it is not what is dropping families.

### `[CLAUDE-4 → CLAUDE-1][MEDIUM][TESTING]` the guard was a spell-checker

Filed exactly right. `tests/digest-cron-read-boundary.test.ts` held nine
`expect(<file text>).toContain('<identifier>')` assertions and never imported either
route. Claude-4 reasoned that three real regressions would leave it green; all three
now go red, each failing exactly one case:

| reverted | fails |
|---|---|
| the recipient read back to one page | the two pagination cases |
| `if (!email) { skipped++; … }` → `continue;` | the could-not-reach case |
| `else failed++` dropped | the 502 case |
| the body of the auth-error branch emptied, condition kept | the 500 case |

Both routes are now driven: `tests/digest-cron-read-boundary.test.ts` covers
chore-reminders, `tests/the-weekly-digest-reaches-every-family.test.ts` the digest,
and `tests/every-auth-user-not-the-first-fifty.test.ts` pins the helper's paging
rules plus the rule that nothing reaches for a bare `listUsers()` again. **No test
was deleted** — the file that was vacuous was rewritten in place, which is what the
finding asked for.

**Claude-4's third point stands as filed and is the reason this was worth doing:**
the pagination defect was *structurally invisible* to the old guard. No string in
it mentioned recipients, pages or counts. A guard can only fail on what it looks at.

---

## Pass AZ — five of the six named sites were fine, and the real one was a layer down

**Status: FIXED** (the shared helper + one route), **CORRECTED** (five false positives),
**VERIFIED-OPEN** (two, each needing a design decision rather than a mechanical edit).

### `[CLAUDE-2 → CLAUDE-1][MEDIUM][RESILIENCE]` the census counted a shape, not a behaviour

Claude-2 counted **47 pages** with a raw `Promise.all` over Supabase reads, named six
as the worst, and called the fix *"mechanical — `Promise.all` → `settleAll` at each
site"*. The evidence was three signals: a `Promise.all`, no `settle` import, and no
`.error` substring.

**I read the six. Five are false positives**, and the reason is the same in each
case: they solved the problem another way, which is exactly what makes all three
signals fire.

| site | why it is already safe |
|---|---|
| `dashboard/dining` | a local `safe()` — `try { (await q).data ?? [] } catch { [] }` around each query, so nothing ever rejects into the batch |
| `dashboard/planning` | its own `async function safe<T>` doing the same |
| `dashboard/food` | `makeDegradeRead('food')`, the shared version, which additionally **logs** every failure |
| `guardian` | **already uses `settleAll`** and reads all eight errors — the `.error` signal missed it because the bindings are named `commsError`, `scamsBlockedError`, … |
| `(marketing)/blog` | `getAllPosts` / `getFeaturedPost` / `getCategoryCounts` each `try`/`catch` internally, and the catch is more careful than `settleAll` would be — it re-throws Next's static-bailout signal first |

Only **`referrals`** of the six is genuinely exposed.

### The recommended fix is not mechanical, and applying it blindly would make pages worse

Two reasons, both worth keeping:

1. **`settleAll` only helps a page that then ACTS on the error.** For a page that
   ignores it, the conversion trades a visible failure — the error boundary, which at
   least tells the reader something broke — for a **silent empty world**, which lies.
   That is the defect class this audit has spent Passes AT and AU closing. Measured:
   of 81 `Promise.all` batches in `app/`, **five** destructure an error and use it.
2. **A batch that mixes a query with a domain helper cannot be settled without
   deciding the degraded value.** `admin/marketing/settings` batches a settled query
   with `getAIConfigView(supabase)`; `wallet/allowance` batches three settled queries
   with `resolveFamilyPlanLevel(...)`. `settleAll` would type those as
   `AIConfigView | SettledFallback`, and what the page renders in the second case is a
   design question, not a rename.

### The real defect was one layer down, in a shared helper

`lib/supabase/chunked-in.ts` `readInChunks` says of itself:

> *"The first error wins and the rows gathered so far are still returned, which
> matches how the single-request version behaves for callers that log the error and
> render what they have."*

and then batched its chunks with `Promise.all`. One rejected chunk rejected the whole
read, the caller received nothing, and its `if (error)` branch never ran — **the
sentence above was false in precisely the outage it was written for.** Another
primitive documenting a guarantee it did not hold, and one fix covers all five
callers rather than five page-level edits.

**The compiler made the fix honest.** Settling means a transport rejection arrives as
`{ message }`, which is not the caller's `Err`, and `tsc` refused the change until the
return type said so. Widening it to `Err | { message: string } | null` is the truthful
signature; no caller needed changing, and any future one that reaches for a
PostgrestError-only field is now a compile error rather than a runtime `undefined`.

Also converted: `app/api/ai/health/coach/route.ts`, whose four grounding reads are raw
queries and whose `groundingError` check already exists — so settling is a strict
improvement there with no new silent-empty-world risk. Its own comment says *"A
refused read is not an empty medical record"*; a transport rejection meant that check
never ran.

### Verified open, and why each is not a rename

- **`app/(app)/referrals/page.tsx`** — `getReferralConfig` does a bare read with no
  catch and returns a `ReferralConfig`, not `{ data, error }`. There is a
  `getReferralConfigResult` that returns the error, so the fix exists; what the page
  shows a family when their referral code cannot be read is a design decision.
- **`app/api/blog/save/route.ts`** — two raw queries with no error handling at all.

> **Correction, Pass BB.** I over-called `referrals`. Reading its helpers,
> `listReferralsForFamily` **throws on purpose** — *"Fail closed: the referrals page
> is source-of-truth. A swallowed read error would show 'no referrals yet' when the
> list is merely unreadable"* — and `getOrCreateReferralCode` throws too. The page is
> deliberately fail-closed, so a `Promise.all` rejection reaching the error boundary
> is the same destination every other read failure already has. **The `Promise.all`
> is not the defect there**, which makes it the sixth false positive in that census
> and the first one that was mine. What IS a defect on that page is recorded below.

### And my own guard from Pass AY was wrong in a way worth writing down

`nothing reaches for an unpaginated listUsers again` matched raw file text, so it went
red on the **helper's own header comment**, which names the API it exists to replace.
It passed every time I ran it while writing, and failed on the next run — because
`git ls-files` cannot see an untracked file, and the helper only entered the scan once
it was committed. **A guard that reads source as text has to read code as text**; it
strips comments now, and the reason is written beside it.

---

## Two CI failures I caused, and the rule that would have caught both

`038eb514` (Pass AW) and `ca72c250` (Pass AY) each went red on
`Typecheck · Lint · Test · Build`. Both are mine, both were already fixed on the next
head by the time the wake arrived, and neither is a flake. They are recorded here
because they share a cause worth naming.

### `038eb514` — `TS2769`, from an edit made after the typecheck

Pass AW's validation ran `tsc` and then `lint`. Lint named two errors in a test file
I had written the pass before, I fixed them, re-ran **that file's tests and lint**,
and committed. The `children`-prop fix does not compile — `Field`'s children is a
render prop and `createElement`'s third parameter is typed `ReactNode` — and `tsc`
had already run, so nothing said so.

I found it myself in the next pass and reverted to the render-prop form with the
reason written beside it, so `0fd6bf95` is clean. But the push went out with a claim
of "tsc clean" that was true of the code I typechecked and not of the code I pushed.

### `ca72c250` — a guard whose input the commit itself changed

Pass AY's guard scans `git ls-files` for a bare `listUsers()`. It passed every time I
ran it while writing, and failed on CI, because **`git ls-files` cannot see an
untracked file**: the helper it was going to match — whose header comment names the
API it exists to replace — only entered the scan when `git add` tracked it.

That is the sharper of the two. The test did not change and the file did not change;
**committing changed the test's input.** Any guard that enumerates the repository
through git has a different input before and after staging, and validating before
staging therefore validates a different repository than CI sees.

### The rule

**Stage first, then validate, then commit.** `git add -A` before the last full run, so
the gate sees exactly the file set CI will, and so no edit can slip in between the
gate and the push. Both failures fall out of that ordering, from opposite directions:
one was an edit after the gate, one was a file the gate could not see.

Neither needed a comment on the PR under the drive-to-green rules — each already had
a pushed fix on a later head before its wake was read — but "superseded" is not the
same as "not my defect", and the count is two.

---

## Pass BA — a rate limit each lambda kept to itself, and a comment that said otherwise

**Status: FIXED** (seven call sites across six routes, plus the false claim).

### `[CLAUDE-3 → CLAUDE-1][MEDIUM][SECURITY]` verified, and it is six routes, not four

`lib/server/rate-limit.ts` is a module-scope `Map` and says so in its own header:
*"Good for a single instance / dev; swap for Upstash Redis in multi-instance prod."*
On a serverless deployment every cold instance starts empty and concurrent instances
share nothing, so "30 per minute" is 30 per minute **per instance** — and the number
of instances is the caller's to raise, by sending in parallel.

Claude-3 named four routes. The scan finds **six** (seven call sites): `recipes/search`
and `blog/search-index` are the two it missed. All seven now go through
`enforceRequestRateLimit`, which is what 26 other routes already use.

**Claude-3's severity analysis is right and worth preserving rather than restating
louder.** The *token-guessing* half of the claim is not exploitable — a link token is
32 CSPRNG bytes stored as a SHA-256 and compared with `timingSafeEqual`, so the
keyspace is the defence. What is real is unbounded **cost**: every accepted
`/api/assistant` POST reads the family and calls a model.

### The comment was wrong twice, so correcting it once would not have been enough

```
// Rate limited by IP BEFORE the token lookup, so an attacker cannot use this
// endpoint to test guessed tokens at speed.
```

The mechanism could not provide that property **and** it is not the property that
matters. A correction that only swapped the limiter would have left a sentence
pointing the next reader at the wrong threat; one that only fixed the prose would
have left the gate per-lambda. The replacement names both: what it now does, and
what it is actually for.

### Four more raw `rateLimit(` calls that are NOT defects

`app/api/ai/route.ts`, `ai/chat`, `ai/gift` and `sync/feeds/[token]` each call the
in-memory limiter and then `rateLimitDb` on the same path — the helper's body,
hand-inlined. Checked before touching them, and left alone.

### The guard is per-handler, because per-file would not have caught this

`app/api/mkt/consent/route.ts` has two exported handlers. A file-level scan sees a
durable limiter in the file and passes both; the AST walk asks whether the durable
check is in **the same function** as the in-memory one. Proved by reverting only the
`GET` handler: it goes red naming `route.ts:72` while `POST` stays green.

### An existing guard caught a real regression in my fix, and it was the right guard

`tests/alexa-request-verification.test.ts` asserts that `verifyAlexaRequest` comes
**before** `createServiceClient()` — the route proves the request is Alexa's before it
touches the database. Dropping `enforceRequestRateLimit(createServiceClient(), …)` at
the top of the handler broke that: an **unverified** request would have caused a
database write.

That is not a guard asserting a spelling; it is the ordering property the route was
built around, and my change violated it. The fix is better than what I first wrote:
the gate is now **split around the signature check** — the cheap per-instance bucket
first, because it touches nothing, and the durable `rateLimitDb` call after
verification. Both properties hold, and the reason is written at the split.

### One route is exempt, and the exemption is argued rather than assumed

`app/api/blog/search-index/route.ts` keeps the per-instance limiter. It answers with
`s-maxage=300` and takes **no query string**, so a scripted hammer is served by the
CDN and the origin sees roughly one request per five minutes per edge location: the
cache is the bound and the map is belt-and-braces behind it. Converting it would put
a **service-role client and a database write on an unauthenticated marketing path**,
to protect a read that is already cached — a worse trade than the one it fixes.

I had converted it, and reverted it on that reasoning rather than on the shape. The
guard carries the exemption by name **with a case that re-checks the argument**: if
the cache header or the no-query-string property goes, the exemption fails and the
route needs the durable limiter like every other.

### Three existing guards pinned the spelling, and one of my replacements did too

`assistant-bridge` matched `'rateLimit(\`assistant'` and `blog-search-index` matched
`'rateLimit('`; both went red on a change that made the routes stronger. Rewritten to
the properties they meant — the limit runs before the token lookup; the route is
bounded, and by what.

**And my own replacement regex was wrong for a reason worth keeping**: I wrote
`/[Rr]ate[Ll]imit\([^)]*\`assistant:/`, and `[^)]*` stops at the `)` of
`createServiceClient()` — which is *inside* the argument list it was meant to cross.
Bounded on the backtick instead.

### And I repeated the not-blind-control mistake, in the same pass that fixed it

The first version of the control asserted that at least **ten** routes still hold a
bare `rateLimit(` — a number that FALLS as the work succeeds. Converting seven took
it to four and the control went red, so finishing the job looked identical to the
scanner breaking. That is the sixth instance of this exact error in the audit, and
the second time I have written it *after* recording the lesson. It asserts by name
now: the four routes that hand-inline the correct pattern and are not going away.

---

## Pass BB — closing my own two, and one of them was not the defect I said it was

**Status: FIXED** (both), **CORRECTED** (my own Pass AZ note), **RECORDED** (one
residue that needs a client change).

### `app/(app)/referrals/page.tsx` — the one read that broke the page's own stance

Not the `Promise.all`. That page fails closed everywhere by design (see the
correction above), so a rejection goes where every other read failure already goes.

The defect is `wasReferred`, which **dropped its error** and handed the panel
`alreadyReferred: false`. That is not an absence of data, it is a claim about the
family: one that HAD been referred was offered the "enter a code" box again, and the
write behind it can only fail with `already_referred`. It now reads the error and
throws with a reason, which is what its neighbours on the same page do.

### `app/api/blog/save/route.ts` — a toggle that re-read the fact it had just written

Three defects, and the middle one has teeth.

1. `Promise.all` over the count and the this-reader's-save reads: a transport
   rejection rejected the batch, which on POST happened **after the write had
   landed** — so the bookmark existed and the caller got a 500.
2. Both errors were dropped. `count: 0` over an unreadable aggregate claims nobody
   saved the article. `saved: false` over an unreadable row claims something about
   **the reader**, and that is the one that costs them something: the heart renders
   empty for an article they have saved, and the toggle behind it is
   insert-then-delete-on-conflict, so their next tap **removes the bookmark**.
3. POST re-read the state it had just written to decide what to report. A read that
   failed after a write that succeeded reported the opposite of what happened.

Fixed in that order: `settleAll`; GET answers **503 rather than a state it could not
read** (the client's `r.ok ? r.json() : null` then leaves its own state alone); and
POST derives `saved` from **the branch it took**, consulting `saveState` for the
count only — reported as `null` rather than `0` when unreadable, which the client
already handles by keeping its last good number.

### The residue, recorded rather than half-built

The heart's client state starts at `saved: false`. During an outage at first paint,
GET's 503 leaves it there, so a saved article still shows an empty heart and a tap
still unsaves. Closing that needs a **three-state heart** — saved, not saved,
unknown — which is a client change on a marketing surface, and the failure needs an
outage at exactly first paint. Named here rather than built, and the server no longer
*asserts* the wrong state, which is the half that was a lie.

---

## Pass BC — a dead export whose docstring was the defect

**Status: FIXED** (deleted), with **half the finding corrected as stale**.

### `[CLAUDE-4 → CLAUDE-1][LOW][DEAD-CODE]` verified dead, and the reason it mattered is right

`rg childSpendableCents` across `app/`, `lib/`, `components/`, `tests/` and
`mobile/src` returns the definition and nothing else. Claude-4 called the impact
*"none today"* and then named the part that is not nothing:

> *"it carries … a comment that would invite a future caller to trust it for a money
> decision."*

The docstring said **"This is what a card authorization is checked against in real
time."** Verified false: an authorization goes through `reserveCardAuth` →
`wallet_reserve_card_auth`, called from `lib/stripe/webhook.ts:182`, and that RPC
re-checks the balance **in SQL under a per-child lock** — the whole point being that
two concurrent authorizations cannot each approve against the same money. A
TypeScript sum taken outside that lock cannot give the same answer. A future caller
trusting the sentence would have had a race, not a balance.

Deleted rather than re-commented: a correct comment on code nobody calls is still an
invitation. The reason is left in its place so the next person does not re-add it.

### Half the finding is stale, and saying so is the point of re-verifying

Claude-4 wrote that it *"carries the same unbounded read as `bucketBalanceCents`"*.
**Both are paged now** — `childSpendableCents` used `readAll` at the time I read it,
and `bucketBalanceCents` carries a comment explaining the `db-max-rows` cap in
detail. Somebody fixed that half between the filing and now. The guard keeps a case
on it so the fix stays.

### The guard asserts code, because prose could not tell a claim from a warning

My first version matched the false docstring's wording — and went red on **the
comment I had just written to explain why that docstring was wrong.** A regex cannot
distinguish a claim from a warning about the claim, and the property was never about
wording: it is that the approve/decline decision comes from the reservation. So the
case now reads the webhook's authorization branch and asserts the decision is
derived from `reserved`, with no summed balance in it.

That is the same shape as the `listUsers` guard two passes ago — a text scan
tripping over prose — and the third time in this audit that a guard of mine had to
be moved off words and onto code.

---

## Pass BD — eighty-nine forms that stayed live while their action ran

**Status: FIXED** (88 of 89), **EXCLUDED with the reason** (1).

### `[CLAUDE-2 → CLAUDE-1][LOW→MEDIUM][FORMS]` the count is exactly right; two things around it are not

`<form action={serverAction}>` does not disable itself while the action runs, and a
server action is not idempotent unless someone wrote it to be. My independent scan
returns **89**, the same number Claude-2 filed. Two corrections came out of
re-measuring rather than re-counting:

**Seven of the 39 files are not under `app/(app)/admin/marketing/`**, where the
finding placed all of them — and four are family-facing: the purchase-answer retry,
the new-mission form, the social inbox and the media library, plus
`components/sync/provider-controls.tsx`. That matters because *"bounded: this is the
internal admin console, one or two operators, behind the admin authz gate"* is the
reason it was filed LOW. The purchase one is a **retry of an AI answer**, so a
double-click there costs a second model call rather than a second approval — checked
before saying so, and the distinction is why it is not HIGH either.

**Thirty-four of the eighty-nine had no `<button type="submit">` at all.** They use a
bare `<button>`, which inside a form **is** a submit button by HTML default. A scan
for the explicit spelling sees 54 and misses those — my own first adoption pass
converted 54 in 89 forms and the arithmetic is what gave it away. Any of those a
developer intended as a non-submit was already submitting; making them
`<SubmitButton>` states what they have always done.

### One form is excluded, on what it does rather than what it is called

`components/admin/filter-bar.tsx` is `method="GET"`. It writes nothing and a second
submit re-runs a query, so there is no double-write to prevent. The guard excludes
GET forms **as a class** rather than naming the file, because the property is about
mutation.

### Why the primitive is its own client component

`useFormStatus` reports the status of the form the calling component is rendered
**inside**. A hook at page level — the component that renders the `<form>` — returns
`pending: false` forever. So `components/ui/submit-button.tsx` is a client component
that lives in the form's children, disables on `pending`, and sets `aria-busy` so the
state is announced rather than only visible.

Every submit in a multi-action form disables together, which is right: one of them is
running.

### The recommended mechanism does not exist in this repo, and a test said so

Claude-2's fix was *"one shared `<SubmitButton>` using `useFormStatus()` (React 19 /
Next 15 both support it)"*. **That premise is false here.** `package.json` declares
`react: ^18.3.1` and `react-dom: ^18.3.1`, and `useFormStatus` arrived in React 19 —
`require('react-dom').useFormStatus` is `undefined`.

I wrote the direct import anyway, it compiled, and four tests went red with
`useFormStatus is not a function`. **That is not a harness artifact**: it is the
honest signal that this repo has two react-doms.

- **Production works.** Next 15.5.25 bundles its own React 19
  (`next/dist/compiled/react-dom`, where `useFormStatus` IS a function) and aliases
  `react-dom` to it for App Router code.
- **Tests do not.** vitest resolves the hoisted `react-dom@18.3.1`, so every
  component test in this repo renders against a **different React than production**.

So the hook is resolved once at module load and the button degrades to a plain submit
where it is absent. That keeps the production behaviour and lets the suite run, and
the guard pins the reason — including a check on the declared `react-dom` version, so
the shim announces itself as removable the moment the split is closed rather than
outliving it.

### `[CLAUDE-1][MEDIUM][ARCHITECTURE]` the declared React does not describe what production runs

Filed as a finding in its own right, because the form button is only where it
surfaced. `next@^15.5.25` with `react@^18.3.1` is a peer mismatch Next papers over by
compiling its own copy. The consequences are not limited to one hook:

- Any React 19 API is invisible to code resolved against the root React, which is
  what **1,226 test files** do.
- A component test asserting React 18 behaviour can pass while production renders
  under 19.

**Not fixed here, deliberately.** The repair is either upgrading the declared React to
19 or aliasing `react-dom`/`react` in `vitest.config.ts` to Next's compiled build, and
both change what every rendering test runs against. That is its own pass with its own
verification, not a side effect of a submit button.

### The not-blind control is planted in both shapes

Explicit `type="submit"` **and** the bare `<button>`, because the implicit one is
precisely what a scan of the obvious kind cannot see — and this pass exists because
that blind spot was in my own first attempt.

---

## Pass BE — ARCH-001 measured, and the measurement does not say what it looks like it says

**Status: VERIFIED** (the split is real), **BLOCKED on its own pass** (the repair),
**and one number deliberately NOT reported as a finding.**

### The split, confirmed from both sides

| | version | who runs it |
|---|---|---|
| `node_modules/react`, `react-dom` | **18.3.1** | vitest, and anything resolving the hoisted copy |
| `next/dist/compiled/react`, `react-dom` | **19.2.0-canary-0bdb9206** | the App Router, i.e. production |

`package.json` declares `react: ^18.3.1` with `next: ^15.5.25`. Next 15 wants React
19 and papers over the mismatch by compiling its own. `require('react-dom').useFormStatus`
is `undefined`; `require('next/dist/compiled/react-dom').useFormStatus` is a function.
That is how Pass BD found it — the filed fix named a React 19 hook, the import
**compiled**, and the tests were the only thing that objected.

### The experiment, and the trap in reading it

I aliased `react`, `react-dom`, `react-dom/server`, `react-dom/client` and both JSX
runtimes in `vitest.config.ts` to Next's compiled build, ran the suite, and restored
the config. Result: **43 files / 641 tests failed.**

**That number is not "641 assertions that disagree with production", and recording it
as one would have been the whole mistake.** The failures classify as:

```
24 ×  Objects are not valid as a React child (found: object with keys {$$typeof, …})
10 ×  Cannot read properties of null (reading 'useState' / 'useContext')
```

Both are the signature of **two React copies coexisting**, not of React 19 semantics:
an element minted by one copy is unrecognisable to the other, and a component reached
through the second copy has a null dispatcher. My alias covered the entry points I
listed and evidently not every path that resolves React — so the experiment measured
**my own incomplete alias**, and says nothing yet about how many tests would disagree
with React 19 once the resolution is consistent.

What it does establish, which is worth having:

- The repair is **not a config line**. Every React-resolving path has to move together,
  transitive dependencies included, or the cure is worse than the split.
- Until it is done, the suite's green is evidence about **React 18**, and production
  renders under a **19 canary**. That is a real gap in what the 1,227 files prove —
  stated as a gap, not as a count.

### Why this is recorded rather than fixed

Changing what every rendering test runs against, on a branch carrying nine other
passes, is not something to bundle. It needs its own pass: move the resolution
wholesale, then read the failures that survive — **those** would be the real finding,
and only then is there a number worth writing down.

---

## Pass BF — native push had no transport, and three places said it did

**Status: FIXED** (the claim), **BLOCKED on credentials** (the capability).

This closes a gap I named in my own status board long ago — *"push/APNs + calendar-feed
integration seams"* — and never came back to. No other worker had reached it.

### `[CLAUDE-1][HIGH][INTEGRATIONS]` the send targeted an API Google decommissioned in 2024

`lib/server/push.ts` POSTed `https://fcm.googleapis.com/fcm/send` with an
`Authorization: key=<FCM_SERVER_KEY>` header — the FCM **legacy** HTTP API. Google
shut it down on **2024-06-20**, together with the server keys that authenticated it.

**Probed rather than recalled**, because a date from memory is not evidence:

```
$ curl -sS -o /dev/null -w '%{http_code}' -X POST https://fcm.googleapis.com/fcm/send \
    -H 'authorization: key=AAAA-not-a-real-key' -d '{"to":"probe"}'
404
```

404 from Google's own frontend, not 401. A 401 would have meant *"alive, bad
credential"* and my claim would have been wrong; 404 means the path is gone.

### The dead send was the harmless half

It could only fail, and a failure was counted as a failure. Three other things were
not harmless:

1. **`pushConfigured()` returned `native: true` whenever that dead key was set**, so
   `/admin/marketing/push` and `/api/push/test` told an operator native delivery was
   configured and working.
2. **`docs/mobile.md` step 4 instructed them to set it** — *"Set `FCM_SERVER_KEY` so
   `lib/server/push.ts` delivers to native tokens"* — an instruction that cannot
   succeed, and following it turned every native send from a counted `skipped` into a
   counted `failed`.
3. **The environment registry documented it as a live conditional credential**, with a
   source line pointing at the dead branch.

All three now say the same true thing. Native devices still register and their tokens
are still stored; every native send is counted as **skipped**, which is what it is —
the device is reachable, we have no way to reach it.

### Not built, and why that is the right call

Reinstating native delivery means FCM **HTTP v1**: a service-account JSON, an OAuth2
token minted against `https://oauth2.googleapis.com/token`, and POSTs to
`…/v1/projects/<id>/messages:send`. This repo has none of those credentials, so the
path could not be exercised even once. **Building it blind would recreate exactly what
was here before** — an untestable integration that reports itself working. The shape
is written into the module so the next person starts from the right API rather than
rediscovering the 404.

### Removing the call moved a file off an audited list, and the list noticed

`tests/external-fetch-boundaries.test.ts` keeps a roster of files that reach a fixed
external provider and must do so behind an explicit timeout wrapper. `lib/server/push.ts`
was on it, and deleting the FCM call made it fail — correctly: the file no longer
contains `fetchExternal` because it no longer contains a fetch.

Struck off **with the reason**, and the half of the rule that still bites is kept
rather than dropped alongside the entry: *no bare `fetch(`* is true of every server
file whether or not it currently calls one. An entry removed from a roster silently is
how a roster stops meaning anything.

### `[CLAUDE-1][LOW][TESTING]` a flaky test, and the discipline of not calling it one

Validating this pass, `tests/library-assistants-pre-migration-render.test.ts` failed
in the full run and again in the isolated run straight after it — then passed **6/6**
in isolation once the machine was quiet. That is the definition of flaky, and the
audit's own rule is that *"flake is not a root cause"*, so I measured rather than
re-ran until green.

- Failing isolated run: **9.8s** for the file. Passing runs: **5.1–5.2s**.
- Six cases, each doing a real SSR render, against vitest's **5s default per-test
  timeout**. The margin is thin enough that CPU pressure breaches it.

Two hypotheses checked and **discarded before writing them down**: the two tests
sharing a name across the file's two `describe` blocks do not share leaked state
(there is a `beforeEach` reset), and the file declares no `concurrent`.

Each case now carries an explicit 30s budget. **Stated as a mitigation, not a
confirmed diagnosis** — the original failure's error text was overwritten before I
could re-read it, so "slow render hit the default timeout" is the best-supported
cause and not a proven one. The comment says so, and says to capture the message
first if it ever fails again.

**This also names a false-negative mode in my own gate.** I push on a clean full-suite
run; a test that can fail under load means that gate can go red for a reason that is
not the change — and, worse, could have gone green on a run where a genuinely broken
test happened to pass. Worth knowing about every "1,228 files green" in this audit.

### And my own guard anchored on the wrong occurrence

The case asserting the native branch counts a skip sliced
`push.indexOf('// Native FCM/APNs')` to `push.indexOf('} catch {')` — and `} catch {`
first appears inside `ensureVapid`, eighty lines **above**. The slice was empty and
the case passed on nothing until I asserted its length. Searching forward from the
marker fixes it. Same family as the binding-in-the-wrong-function mistakes earlier in
this audit: an anchor that matches an earlier occurrence than the one meant.

---

## Pass BG — a public feed that answered 200 with someone else's calendar deleted

**[CLAUDE-1][HIGH][INTEGRATIONS] `app/api/sync/feeds/[token]/route.ts:60` discarded
`readAll`'s error and published whatever rows it had gathered. — FIXED**

The second half of a seam I named on my own status board long ago and had never
closed. No other worker reached it: Claude-2 does not audit route handlers,
Claude-3's integration sweep stopped at the OAuth adapters, Claude-4's flow work
covers the in-app calendar and not the subscription.

### Why a partial read is worse here than anywhere else in the repo

Forty-odd `readAll` sites in this codebase; roughly a third drop the error. On a
page that renders a list, that is a display bug — the user sees less than there
is and reloads. This one is different in kind, and the difference is the ICS
protocol, not the code:

> **A subscriber does not merge a feed. It reconciles against it.**

Apple Calendar, Outlook, Google ("From URL") and Alexa treat the feed as the
authoritative statement of that calendar's contents. An event that was present
last poll and is absent from this 200 is an event the client **removes from the
user's calendar**. So the failure mode was not "the feed looks short". It was:

- a transport blip on page two of a 1,500-event calendar →
- `readAll` returns 1,000 rows **and** the error →
- the route reads only `rows` and serves them with `200 text/calendar` →
- every subscribed device deletes the other 500 appointments, silently →
- the next successful poll puts them all back.

An appointment that vanishes and reappears costs more trust than one that never
loaded, because the family stops believing the calendar rather than the network.

### The asymmetry that made this findable

`app/api/cron/calendar-feeds/route.ts:26` — the **other side of the same seam**,
reading the same way through the same helper — does check:

```ts
if (error) {
  console.error('Calendar-feed cron read failed:', error);
  return NextResponse.json({ error: t('…') }, { status: 500 });
}
```

The inbound half was careful; the outbound half was not. An isolated omission on
the one route where it costs the most.

### Fix

Destructure `error: eventsError` and answer **503 with `Retry-After: 300` and
`Cache-Control: no-store`** rather than publish a short feed. 503 is the honest
answer because it leaves every subscriber holding the copy it already has —
which, for a reconciling client, is the *only* non-destructive response to "I
could not read the calendar". The reasoning is written into the route so the
next person to touch it does not reintroduce the destructure.

### A second, quieter deletion instruction — measured, left as designed

`{ max: 2000 }` is a **silent** ceiling: `readAll` returns exactly 2,000 rows and
`error: null`, so a calendar holding more publishes a truncated feed with no
failure anywhere. That is the same deletion instruction by another route.

I did not raise it, because the ordering makes it safe and the ordering is the
reason: the read is `.order('starts_at', { ascending: true })`, so the cut falls
at the far end of a 400-day horizon, where the rolling window recovers it on a
later poll. That safety is **load-bearing and undocumented** — reorder this read
by `id` (which reads like a harmless stability tweak, and `id` is already the
tiebreaker on the next line) and the cut lands on arbitrary events: next week's
dentist appointment as readily as a birthday fourteen months out. So the guard
pins the ordering as a property, not the ceiling as a number.

### Guard — `tests/a-calendar-feed-never-publishes-a-short-list.test.ts`

Drives the real handler against a fake PostgREST that can fail mid-page.

| Case | Asserts |
| --- | --- |
| healthy read | 200, `text/calendar`, every UID present |
| **page two fails** | **not 200**; 503 + `Retry-After: 300` + `no-store`; body carries no `BEGIN:VCALENDAR` and none of the 1,000 rows it *did* hold |
| 1,500 events, nothing failing | 200 with `evt-0` **and** `evt-1499` — **not blind**: the 503 is keyed on the error, not on a multi-page read |
| ordering | first `.order()` on the events read is `starts_at` ascending |
| unknown token | 404 preserved |

**Planted and proven**: with the fix stashed, the route answered **200** and the
second case went red while the other four stayed green. The control case is the
one that matters here — an earlier version of this guard would have passed on any
route that 503'd unconditionally.

---

## Pass BH — the retry module had one caller, and it was not the forty-seven that needed it

**[CLAUDE-1][MEDIUM][ARCHITECTURE] `lib/ai/retry.ts` is applied at 1 of 48 eligible
provider call sites. — OPEN (measured; fix designed, built and reverted unfinished)**

Recorded rather than shipped. The fix was written, the guard was planted and
proven, and then **three existing tests went red**; resolving each on its merits
is the rest of this pass, and none of it is work to rush. Nothing was pushed.

### The measurement

| | |
| --- | --- |
| `withBackoff` call sites outside its own module | **1** — `lib/ai/structured.ts:110` |
| `provider.complete(...)` call sites in `app/` + `lib/` | **47**, none retried |
| retry anywhere else in the chain | **none** — `fetchExternal` has no retry, `OpenAIProvider` has none internally |
| `new OpenAIProvider(` construction sites | **3**, all in `lib/ai/provider.ts` (2) and `lib/ai/routing.ts` (1) |

`lib/ai/retry.ts` is 141 careful lines — full-jitter exponential backoff,
abort-aware through every sleep, an explicit non-retry list (401, 402, 404,
`insufficient_quota`) — and its own header names its intended callers:

> *"Only wrap calls with no side effects: `complete()` without tools,
> `structuredCompletion()`, embeddings, classification."*

Forty-seven of those never reached it. So on a 429 — the most common provider
failure by a wide margin, and one that clears in milliseconds — the family gets
`describeAIError`'s

> *"The AI engine is busy right now (rate limit). Wait a few seconds and try again."*

which is the application asking a person to do by hand the thing the module was
written to do automatically. **Same class as BC-01**: a correct, well-documented
mechanism that nothing calls.

### The fix, as built (reverted; rebuild from here)

`lib/ai/retrying-provider.ts` — a plain delegate applied at the three
construction sites, so no call site changes:

```ts
export function retryingProvider(provider: AIProvider): AIProvider {
  return {
    id: provider.id,
    model: provider.model,
    complete: (input) => withBackoff(() => provider.complete(input), { signal: input.signal ?? null }),
    structuredCompletion: (input) => provider.structuredCompletion(input),
    runTools: (input) => provider.runTools(input),
    runToolsStream: (input) => provider.runToolsStream(input),
  };
}
```

**What is deliberately NOT wrapped matters more than what is.**

- `complete` — wrapped. Side-effect-free *by construction*: it posts one chat
  completion and **returns** any `toolCalls` for the caller to execute; it never
  executes them. (All 47 sites happen to pass `tools: []`, but the safety does
  not rest on that.)
- `structuredCompletion` — not wrapped. `lib/ai/structured.ts` already runs it
  through `withBackoff`, inside a two-pass repair loop. Nesting would be 3 × 3 ×
  2 = **eighteen paid provider calls for one planner decision**.
- `runTools` / `runToolsStream` — not wrapped, and this is load-bearing. Both
  **execute** tools, and the failures worth retrying (429, 5xx, a dropped socket)
  are exactly the ones where the first attempt may already have reached OpenAI
  and had effects before the response was lost. A blind retry double-creates the
  calendar event. Those paths get at-most-once from the `ai_tool_calls`
  idempotency ledger, not from here.

An explicit delegate was chosen over a `Proxy` **because** the exclusions are the
point: a Proxy forwards everything transparently and would hide the one thing a
reader needs to see. `tsc` catches a method omitted from the delegate, since the
return type is `AIProvider`.

### A second finding, measured in passing: the attempt budget is honest only for fast failures

`OPENAI_TIMEOUT_MS` is **60_000** and the AI routes declare **`maxDuration = 60`**.
So on those routes a first attempt that *times out* has already spent the whole
platform budget — the function is killed before a second attempt could return.

This is **not** a reason to withhold the retry: a 429 or a 5xx comes back in
milliseconds, which is the case it exists for, and the timeout case is left
exactly as it was. It **is** a reason not to reach for a bigger `attempts` number
later expecting more resilience, and it means `lib/ai/structured.ts`'s existing
3 attempts are, on a 60-second route, effectively 1 whenever the provider hangs.

### Guard — planted and proven, then removed with the fix

`tests/a-transient-provider-failure-is-retried-not-shown.test.ts` drove the real
`getProvider()` / `providerFromConfig()` seam against a mocked `fetchExternal`
that scripts one response per attempt — deliberately not calling the decorator
directly, because the defect was never in `withBackoff`; it was in nothing
reaching it. Seven cases: a 429 then a 200 (2 fetches); a 401 (1 fetch, no
retry); a 503 (exactly 3, the budget); `runTools` on a 429 (**1**);
`structuredCompletion` on a 429 (**1**, no double-wrap); `id`/`model` survive
the decoration; a mid-flight abort stops further attempts.

**Proven**: with the decorator unwired, **2 failed and 5 passed** — the five
being precisely the exclusion and identity controls, which is what makes them
controls rather than restatements of the fix.

### Why this is OPEN and not FIXED — the three that went red

1. **`tests/provider-stub.test.ts:135`** — `expect(await resolveProviderForTask('plan')).toBeInstanceOf(OpenAIProvider)`.
   A delegate is not an instance. The test's *intent* ("returns the real provider,
   not the scripted stub") still holds; its *assertion* is narrower than its
   intent. The honest repair asserts the discriminator directly — `provider.id`
   is `'openai'`, not the stub's `'scripted'` — which is **stronger**, because it
   also catches a decorator that drops `id`. It must be argued as that, not
   quietly relaxed.
   **And it is a correction to my own method**: I cleared this seam with
   `grep -rn "instanceof OpenAIProvider"`, which cannot see vitest's
   `toBeInstanceOf` matcher form. I reported "no instanceof checks" from a search
   that structurally could not find them. The suite caught what my grep did not.
2. **`tests/ai-observability-coverage.test.ts:371`** — asserts
   `readFileSync('lib/ai/routing.ts')` contains the literal
   `return new OpenAIProvider(`. A source-text pin on a line the fix rewrites.
   Its surrounding comment is explicit that the floor of three silent files is
   deliberate and that `lib/ai/routing.ts` "builds an OpenAIProvider and hands it
   back without ever calling one" — still true after the change, so the
   *property* survives and only the *spelling* does not. Needs re-expressing
   against the property.
3. **`tests/ai-prompt-injection.test.ts`** — *"the obedient provider makes no
   write call."* **Not caused by this change at all.** I wrote it up as the one
   that might be telling the truth about the fix; it is not, and this paragraph
   is the correction. Diagnosed after reverting: it fails **`Test timed out in
   5000ms`**, not on an assertion, **with the tree clean at `b756f1e2`** — and
   3/3 in isolation, so it is not the Pass BF flake either. See below.

### A pre-existing failure the full suite cannot see — and the reason it cannot

**[CLAUDE-1][LOW][TESTING] `tests/ai-prompt-injection.test.ts` passes in the full
suite and fails 3/3 standalone. — OPEN**

Measured on a clean tree at the pushed commit:

| run | result | duration | of which transform |
| --- | --- | --- | --- |
| full suite (1,229 files) | **pass** | 229s total | shared |
| standalone ×3 | **fail**, timeout at 5,000ms | 6.16s / 5.88s / 6.03s | **4.47s / 4.15s / 4.21s** |

The mechanism is visible in that last column. The case does its imports **inside
the test body** —

```ts
it('fences the hostile title, …', async () => {
  const { buildContext } = await import('@/lib/ai/context/builder');
```

— so module transform is charged to the test's own 5s budget. Across a full run
vitest's transform cache is already warm from the other files that import the
same modules, and the case finishes well inside it; alone, ~4.2s of transform
lands inside the budget and ~0.8s of actual work tips it over.

**This is the inverse of Pass BF's flake, and worth keeping the pair.** There the
file passed alone and failed under load; here it passes under load and fails
alone. What they share is a 5-second default that was never chosen for these
cases. The consequence here is sharper than a red CI run, because CI is *green*:
the failure appears only to a developer running the one file they are debugging,
which is the exact command that situation calls for.

**Fix** (not applied — outside this pass, and a green suite is not the place to
land a test change unannounced): hoist the imports to module scope like the rest
of the file's siblings, or give the case an explicit budget. Hoisting is better —
it removes the cost from the measurement rather than widening the ruler.

### Where to pick it up

Rebuild the module above, rewire the three construction sites, restore the guard,
then work failures **#1 and #2** — both stale assertions, both to be argued
rather than relaxed. **#3 is not part of this pass**; it is the separate
standalone-timeout finding recorded immediately above.

---

## Pass BI — the worker wrote the privacy rule down, then cached photos against it

**[CLAUDE-1][CRITICAL][SECURITY] `public/sw.js` served one account's private family
photos to the next account on the same device. — FIXED**

Cross-referenced to the master control document on `main`:
**SEC-001** (cache-disclosure half) and **SUPPORT-98FD1D4C44AD**.

### Not duplicated work — the half the other agent could not take

The Codex agent's SEC-001 record already contains an *executed* RED regression for
this exact behaviour: *"A synthetic `/_next/image` response marked `private,
no-store` is retained in `bubaly-v4`; logout clears session cookies and
partitioned query storage but leaves the image. After B is installed, offline
lookup returns A's bytes with fetch count unchanged at one."* Their record then
says, explicitly: **"No source repair is included; SUPPORT-98FD1D4C44AD advances
only to IN PROGRESS."**

SEC-001's other half — making the media bucket private — needs SQL and provider
configuration, which their cycle is fenced from and which no repository change
can substitute for. **The cache half needs neither.** It is one file, and
`public/sw.js` is byte-identical on `main` and on this branch, so the repair
lands without depending on the 198-commit merge that is currently blocked.

### The defect

`public/sw.js` opens with the PRIVACY INVARIANT (M-023):

> authenticated HTML is NEVER written to Cache Storage. Cached pages persist
> unencrypted after logout and would be served offline to whoever next opens the
> app on a shared/family device

The navigation branch honours it. The asset branch, twenty-four lines below,
cached anything whose `destination` was `image`/`style`/`script` the moment it
came back 200. **The reason was written out in full, two dozen lines above the
code that ignored it.**

Three facts turn that into cross-account disclosure:

1. **`/_next/image` is same-origin**, so `if (url.origin !== self.location.origin) return;`
   never saw it — and it is the optimizer proxy in front of private family media.
2. **The read is cache-first** (`caches.match(request).then((cached) => cached || fetch(...))`),
   so once an image is in `bubaly-v4` it is served with **no network request at
   all**. Nothing server-side can deny it — not RLS, not a signed URL's expiry,
   not a revoked session.
3. **Logout does not clear Cache Storage.** The entry outlives the session that
   was permitted to see it.

On the shared family device this product is built around, account B was served
account A's photos. Severity Critical stands on the product's own core use case.

### Fix — two rules, because neither covers the other

```js
const PRIVATE_DIRECTIVE = /(^|,)\s*(private|no-store)\s*(,|$)/;
function saysPrivate(res) { … }                 // rule 1
function isShareableAsset(request, url) {
  if (url.pathname === '/_next/image') return false;   // rule 2
  return request.destination === 'style' || … ;
}
```

Rule 1 alone does **not** close it, and this is the part worth reading twice:
family media is uploaded with `cacheControl: 31536000` (their own inventory
records this for Photos and CreateMemory), so the optimizer can return a private
photo marked `public, max-age=31536000, immutable`. **A header-respecting worker
would have cached it.** Rule 2 is what actually holds: what `/_next/image`
proxies is chosen by the page, not by the worker, so the worker cannot treat its
output as public. Its responses are still held by the browser's own HTTP cache
and the CDN — both partitioned and cleared with the session, as Cache Storage is
not — so the offline cost is near zero.

### Guard — `tests/a-private-photo-does-not-outlive-the-session-in-the-worker-cache.test.ts`

**Drives the real handler.** The worker source is loaded into a synthetic scope
with a fake CacheStorage and a counting `fetch`, and its `fetch` listener is
dispatched — because the existing guard for this file
(`tests/mobile-sw-auth-cache.test.ts`) asserts **source text** (`expect(sw).toContain(…)`)
and would have passed throughout this defect's entire life.

| case | asserts |
| --- | --- |
| private optimized image | not persisted (their RED repro) |
| **the disclosure itself** | account B is served from the **network**, not A's bytes; **two** fetches, not one |
| optimizer calls it public | still not persisted — the case rule 1 alone would miss |
| app's own CSS + icon | **still cached** — not blind |
| cached asset re-requested | **one** fetch — caching still works |
| any asset marked private | not persisted — the header rule is general |

**Planted and proven**: with the worker stashed back to its broken state, **4 of 6
failed** and the 2 that passed were exactly the two not-blind controls — which is
what makes them controls rather than restatements of the fix.

### Still open on SEC-001, and not claimed here

The bucket itself is still public (migration `0216`), consumers still publish
public URLs, and unguessable object names are still the only protection on the
object store. **That half is untouched by this fix and SEC-001 must stay FAIL.**
What changes is that the device-local, logout-surviving, server-undeniable copy
is gone. The remaining exposure needs a URL you already hold; it no longer needs
only the device.

Their record's `signOutBrowserSession` purge-on-logout belt-and-braces is *not*
included: that function arrived in the 198 commits on `main` that this branch
cannot merge without a permission it does not have.


### BH-02 closed in Pass BI — the cost removed, not the ruler widened

`tests/ai-prompt-injection.test.ts` failed again in the full suite during Pass BI's
validation, which refines the earlier reading: it is not "passes under load, fails
alone" but simply **a test body carrying ~4 s of module transform against a 5 s
budget**, which tips over whenever the machine is busy either way.

Four of its five `await import(...)` calls sat inside test bodies with no reason to
be deferred — the file has no `vi.mock` at all. They are now static imports. The
fifth is left dynamic **on purpose**: it follows a `vi.doMock`, which only affects
imports that come after it, so hoisting that one would silently unmock the turn.

| | test body | transform |
| --- | --- | --- |
| before | 5.70 s / 5.43 s / 5.56 s — **timeout at 5 s** | 4.47 / 4.15 / 4.21 s |
| after | **178 ms / 174 ms / 172 ms** | moved to module load |

Standalone: **3/3 pass**. No timeout was added and no assertion was touched — the
thirty-fold drop in the body is the evidence that the cost was transform rather
than the test.

---

## Pass BJ — a child could rewrite the screening that protects them

**[CLAUDE-1][HIGH][SECURITY] `guardian_contacts` and `guardian_member_profiles`
took writes from any household member, child included. — FIXED (repo; unapplied)**

Cross-referenced to the master control document on `main`: **AUTHZ-005** (❌ FAIL,
High). Their record: *"Pending database policy repair; additional action checks
alone cannot prevent direct database writes. Existing no-new-SQL constraint
remains in force."* Writing a migration file is a **repository** change, not a
production mutation, so that fence is theirs and not mine — the standing rule
here is only that agents must not *apply* migrations to production, and 0318 is
left unapplied exactly like 0296–0301.

### The defect, in the application's own words

`01370_ai_call_guardian.sql` gave both tables
`FOR ALL TO authenticated USING (is_family_member(family_id))`. `FOR ALL` covers
INSERT, UPDATE and DELETE, so the rule deciding who may change a child's
protection asked only whether the caller was in the household — and the child is
in the household.

`app/(app)/guardian/actions.ts` on `main` already says so:

> RLS on the guardian tables is family-scoped (any member), and children have
> real logins, so these server actions are the authorization boundary: only a
> family manager (parent/adult) may change safety config.

Both halves are true, and together they are the defect. **A server action is not
a boundary against a JWT holder.** Children have real logins; a request to
`/rest/v1/guardian_contacts` never passes through `app/` at all. A teen wanting
an unscreened line to a stranger needed one HTTP request, not a defeated UI.

What the two tables actually hold: per-contact **trust levels**, and each
member's per-band **routing modes** — `default_mode_unknown` being the one
applied to a caller the household has never seen. They are the configuration of
the AI Call Guardian, whose entire purpose is protecting a child from scam and
grooming contact. `0215` hardened the routing *rules* table and stopped there,
which is why this survived that pass.

### Fix — `0318_guardian_safety_config_is_manager_only.sql`

Writes require `can_manage_family()` — the repo's existing predicate
(`0003`: `role in ('parent','adult') and is_active`), the same set as
`isManager()` in `lib/constants/roles.ts`, so **nothing is granted that a manager
did not already have through the server actions**. Reads are unchanged: a child
may still see their own configuration, which is what the Guardian screens render.

Split into explicit INSERT/UPDATE/DELETE rather than another `FOR ALL`, so the
next reader cannot mistake a write policy for a read one the way `FOR ALL`
invited here. UPDATE carries **both** `USING` and `WITH CHECK`: without the
latter a manager could relocate a row into another family — the S-01 shape.

### Proof — replayed, not reasoned

- **315 migrations applied, 0 failed** on a throwaway PG16 (`verify-pg.sh up`).
- **24/24 boundary probes pass on a fresh database**, including the new
  `docs/audit/guardian-safety-config-is-managers-only-check.sql`. The runner
  globs, so it is picked up without registration.
- The probe asserts both directions and the `WITH CHECK` half, and **carries its
  own negative control**: it restores `01370`'s permissive `FOR ALL` inside the
  transaction, re-runs the child's escalation, and *requires that it now
  succeeds*. A boundary check that has never been shown to fail is decoration.

### Two mistakes of mine, recorded because they cost runs

1. **`g` is not a hex digit.** I used `…0000g1` as a mnemonic for "guardian" and
   every UUID literal was invalid. Caught immediately by the probe.
2. **I invented column names instead of reading them.** `phone_e164` and
   `display_name` and `routing_mode` do not exist; the real columns are `phone`,
   `name` and the seven `default_mode_*` bands, and `trust_level` is an enum
   whose value is `trusted_friend`, not `trusted`. Fixed by querying
   `information_schema` and `pg_enum` rather than guessing again.

A third thing looked like a regression and was not: `child-login…-check.sql`
failed on the *second* suite run. Its own fixtures had leaked from my repeated
manual iteration on the throwaway database; my probe's rows (`d3`/`d4`) were
absent, so the leak was not mine. Re-bootstrapping and running the suite once —
which is what CI does — gives **24/24**. Recorded rather than quietly re-run.

---

## Pass BK — WITHDRAWN: I duplicated work `main` had already done

**[CLAUDE-1][CRITICAL][SECURITY] `allowance_rules` took writes from the child it
pays. — REAL, but ALREADY FIXED on `main`. My migration and probe were deleted.**

The defect was real and I reproduced it on a replayed database:

```
update public.allowance_rules set amount_cents = 100000, next_run_on = current_date;
-> UPDATE 1     ($5.00/week became $1,000.00, scheduled for today)
```

**But it was not new, and filing it as new was my error.** `main` already carried
`0306_money_instructions_are_not_member_writable.sql`, which closes it — found
the same way (*"Measured on a replayed database … the child INSERTED an allowance
rule of 100000 cents a week pointing at their own wallet"*) and fixed **better**,
with *restrictive* policies that AND with the union of the permissive ones so no
future permissive policy can grant past them. `main` also already has a probe,
`money-instruction-write-check.sql`, covering the same table with the same value.

### The mistake, which is the part worth keeping

I searched `main`'s control document for open **❌ FAIL** rows, found no row for
`allowance_rules`, and concluded nobody had looked at it. **A thing can be absent
from the failure list precisely because someone repaired it.** "Not listed as
broken" and "not looked at" are different claims and I collapsed them. The check
I should have run first — and did run, too late — is one `git grep` for the table
name across `main`'s migrations.

Deleted: `0319_allowance_rules_are_not_self_served.sql` and
`docs/audit/allowance-rule-is-not-self-served-check.sql`.

### What survives is the method, not the finding

The sweep is still worth having. `167` tables share the permissive
`FOR ALL … is_family_member` shape — a policy **default**, and right for most of
them (`habit_logs`, `game_results`, `family_polls`, `dining_out`). Narrowed to
sensitive subjects with no restrictive guard: **22**.

Classified by the real test — *does the application's own write path enforce
something RLS does not?* —

- **six carry the defect**: `babysitter_payments`, `babysitter_profiles`,
  `compliance_disclosures`, `gift_links`, `gift_payments`, `vacation_documents`;
- **ten are correct by design**, the write path being a client component going
  straight to the browser Supabase client (`medication_doses` checked
  individually: no server action, no role gate, so the permissive policy *is* the
  intended boundary);
- **five have no app write path this sweep could find** —
  `family_emergency_contacts`, `family_emergency_plans`, `guardian_suggestions`,
  `vacation_emergency_contacts`, `vacation_medical_information`. Either something
  outside `app/`, `lib/` and `components/` writes them, or nothing does. Silence
  is not evidence either way.

**None are repaired, and after this pass none should be touched before checking
`main`'s `0296`–`0317` first** — which is exactly the step I skipped.

### And that census was also wrong on its first run

It printed **basenames**, so three different `actions.ts` files collapsed into
one label: it reported four defects instead of six, filed `vacation_documents`
under "no write path", and marked `gift_payments` ungated when its wallet path
gates on `isManager`. An identifier that is not unique is not an identifier, and
a census keyed on one fails in the reassuring direction.

### The one correction to earlier work that still stands

W-01 and W-02 closed the allowance **double-pay race** and never asked who may
set the **amount**. That observation remains true and is worth keeping even
though someone else acted on it first: auditing a mechanism is not the same as
auditing its inputs.

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

---

## [CLAUDE-1][HIGH][FRONTEND / DATABASE] A member could vote twice in the family meal vote

- **Where:** `components/modules/meals-module.tsx` (`castVote`), schema
  `supabase/migrations/0055_meal_votes.sql`
- **Problem:** `castVote` clears the member's prior pick and inserts the new one:

  ```ts
  // One ballot per member: clear any prior pick, then record this one.
  await sb.from('meal_vote_ballots').delete().eq('vote_id', …).eq('member_id', selfId);
  const { error } = await sb.from('meal_vote_ballots').insert({ … });
  if (error) return toastError(…);
  success('Vote recorded');
  ```

  The insert's error is checked. **The delete's is discarded** — statement
  position, so whatever it resolved with goes nowhere.
- **The database does not backstop it, and the reason is exact.**
  `meal_vote_ballots_once` is `UNIQUE (option_id, member_id)` — one ballot per
  member per **option**, not per **vote**. A member switching from option A to
  option B inserts a *different* key, so the constraint never fires. The
  comment's invariant ("one ballot per member") is enforced **only** by that
  unchecked delete.
- **Impact:** a failed clear plus a successful insert leaves the member holding
  ballots on both options, while the toast says "Vote recorded". The panel
  tallies

  ```ts
  tally(opt) = ballots.filter(b => b.option_id === opt).length
  total      = ballots.length
  ```

  so that member adds one to each of two meals **and two to the denominator** —
  one person deciding a family's dinner twice, for two different dinners.
- **Recommended fix:** applied at the application layer — the clear is checked
  and a failure aborts before inserting. Verified load-bearing: restoring the
  statement-position delete fails two cases.
- **Status:** FIXED (application). Schema **OPEN** — see below.

**OPEN, deliberately not done here:** the constraint that would actually express
the invariant is `UNIQUE (vote_id, member_id)`, which would make the database
refuse a second ballot regardless of what the client does. That is a migration,
and two other workers are actively adding migrations (0314–0317) and editing the
ledger and `PENDING_PROD_MIGRATIONS.md`. Adding a competing one is how two
workers collide on a version number. Recommended for whoever owns the ledger
next; the application fix closes the user-facing defect in the meantime.

### The guard shape behind this find

`tests/claimed-writes-that-did-not-land.test.ts` forbids exactly this — "a write
whose result is discarded, followed by something that claims it happened" — and
scans `app`, `lib` **and** `components`. It did not catch this one because its
`WATCHED` map is **enumerated by table**: 12 tables, chosen as each instance was
found. `meal_vote_ballots` is not among them.

That is the **enumerated-with-no-scan** shape again (third sighting, after
`whole-table-reads-are-not-capped` and the i18n `GATED_SURFACES`). A sweep for
statement-position writes across the tree finds **34 tables** outside the watched
set. Most are legitimately fire-and-forget — `activation_events`,
`social_usage_events`, `home_ai_logs`, `dashboard_layout_events` — which is
precisely why the guard is enumerated rather than universal, and why the 34 are
**not** 34 findings. Triaged by hand for a *claim* following the write:

- `components/modules/meals-module.tsx` — **the finding above.**
- `app/(auth)/actions.ts:147` — clears the login throttle after a successful
  child sign-in. Discarded, and the comment claims "a genuine kid never carries
  a stale lock". But it fails **safe** (too strict, never too lenient), and the
  security-critical direction is already checked:
  `if (!(await recordFailure())) return …`. LOW.
- `components/modules/messages-module.tsx:204` — a per-row read-receipt fallback.
  A receipt that does not stick; no claim is made to the user. LOW.

---

## [CLAUDE-1][HIGH][UX / ACCESSIBILITY] `aria-modal` was a promise eleven overlays made and none kept

- **Where:** `components/app/{account-closed-gate,trial-paywall-gate,app-lock-gate,app-shell,command-bar,blog-launcher,ai-orb}.tsx`,
  `components/marketing/exit-intent.tsx`, `components/ui/camera-capture.tsx`,
  `components/guardian/{contact-list,rules-editor}.tsx`
- **Problem:** `aria-modal="true"` tells assistive technology that everything
  outside the element is **inert**. Declaring it without making it true is worse
  than a plain `<div>`: a screen-reader user is told to ignore a background their
  keyboard can still reach, and nothing tells them otherwise.
- **Evidence, measured across all eleven:**

  | | focus trap | Escape | focus restore |
  |---|---|---|---|
  | all eleven | **0 / 11** | 5 / 11 | 1 / 11 |

  **Not one trapped Tab.** Three are full-screen gates — a paywall, a lock
  screen, a closed-account gate — which is where it matters most: a gate whose
  Tab key walks into the application behind it is not a gate.
- **Recommended fix:** applied. The behaviour is extracted to
  `lib/a11y/use-dialog-behavior.ts` and **`Modal` uses it too** — one
  implementation, not two. All eleven adopt it while keeping their own layout.
  A gate passes no `onClose`: Escape does nothing and the trap still holds,
  which is the correct shape — `aria-modal` has to be true even when there is
  nothing to close.
- **Status:** FIXED. `tsc` clean, build compiles, 13,905 tests pass, lint
  unchanged at its three pre-existing warnings.
- **Proved load-bearing:** removing the hook from `command-bar` turns the new
  guard red, naming the file.

### This is the premise gap, and the clearest instance of it

`tests/modal-a11y-contract.test.ts` is a **good** guard. It pins the shared
Modal's dialog contract in detail and would catch any regression in it. It could
not see any of these eleven, and the reason is structural rather than careless:

> Modal coupled the **behaviour** (focus in, Tab trap, Escape, scroll lock,
> focus restore) to its own **chrome** (backdrop, title bar, close button,
> bottom-sheet layout). A camera viewfinder, a command palette, a slide-over
> drawer and three full-screen gates could not take the chrome — so they took
> **neither**.

*A guard on the blessed helper says nothing about the path taken to avoid it,*
and coupling behaviour to chrome is what creates that path. The fix is therefore
not only "adopt the helper" but "make the helper adoptable".

**Five existing guards went red when the behaviour moved out of `modal.tsx`** —
`modal-a11y-contract`, `mobile-overlay-safe-area`, `mobile-overlay-dialog-a11y`,
`blog-launcher-frame`, `consent-preference-centre-focus`. That is them working,
and it is worth recording as the cost of source-text assertions: they pin an
*address*, not a property. Each now asserts that the component **delegates** and
that the hook **implements**, so the contract follows the behaviour.

**A fourth scan matched its own prose.** The first version of the new guard
reported `consent-manager.tsx`, whose hand-rolled dialog had *already* been
replaced with `<Modal>` earlier in this audit — it matched the paragraph
explaining that fix. Excluding comments is now a case in the guard itself. Three
previous scans in this audit made the identical mistake (the Node version check,
the consent `aria-modal` scan, and this one), which is enough to call it a
standing hazard rather than a coincidence.

**Self-audit of the above, and a defect it found.** `useDialogBehavior` keys its
effect on `open` and bails when the ref is not attached yet. The **app-lock
gate** was adopted with a literal `true`, and it returns early while unlocked
(`if (!enabled || unlocked) return <>{children}</>`). So the effect ran once on
mount, found no dialog, and — `true` never changing — never ran again. **A gate
that locks after mount had no focus trap at all**: the one overlay of the eleven
where a trap matters most, adopted in a way that silently did nothing.

Fixed by threading the real condition (`enabled && !unlocked`, the same one the
scroll lock beside it uses). The other five adopters passing `true` were checked
individually — each renders its dialog on every pass, where `true` is correct.
The hook's doc now names this case, because the failure is invisible: no error,
no warning, just a dialog that quietly is not modal.

This is the third defect in this audit found by auditing my own work, after the
`server-only` guard that closed a hole which was never open and the test that
asserted the defect it was named for.

---

## [CLAUDE-1][HIGH][DATABASE / BACKEND] The family timezone was free text, and a typo put the household on UTC

- **Where:** `lib/validation.ts` (`createFamilySchema`), `components/modules/family-module.tsx`,
  `app/(app)/admin/actions.ts`
- **Problem:** `families.timezone` is the zone every wall-clock answer the app
  gives a family is computed from. The column is `text not null default 'UTC'`
  **with no CHECK**; the family settings field is a free-text `<Input>` with
  placeholder "America/Chicago"; the onboarding schema accepted any non-empty
  string; the admin create action validated the owner's **email** and not the
  zone.
- **Evidence, measured:**

  ```
  instant 2026-09-19T01:30Z
  America/Los_Angeles   day 2026-09-18   offset -420 min
  Mars/Olympus_Mons     day 2026-09-19   offset    0 min   ← identical to UTC
  ```

  Every reader goes through `Intl.DateTimeFormat`, which throws on an unknown
  zone — and every call site catches and degrades to UTC **deliberately**, so a
  bad zone cannot crash a page. The two together make a bad zone
  **indistinguishable from UTC, silently and permanently.**
- **Impact:** a parent typing "Central", or fat-fingering "Amercia/Chicago",
  moved their whole household onto Greenwich time: routines on the wrong local
  day, "today" wrong, and the medication-reminder day bounds wrong — the exact
  failure the fix two findings earlier in this file was about. The form said
  "Family profile updated".
- **Recommended fix:** applied to all three write paths, through
  `isValidTimezone` — **which already existed** in `lib/time/zoned.ts` and was
  used in exactly one place, the marketing recurring-ads schema. *Sixth instance
  in this audit of "the correct implementation existed and had not reached this
  call site."*
- **Status:** FIXED. 13,913 tests pass, build compiles, i18n gate clean (two new
  strings added to all seven populated catalogues).
- **Proved load-bearing:** reverting the schema refine fails two cases.

**The asymmetry.** `previewCalendarImportSchema` in the same file has validated
its timezone all along — its comment reads *"malformed supplied input must not
guess"* — on a value that is **presentation-only and never stored**. The
stricter rule was on the throwaway copy and the looser one on the durable
record. Its inline `try { new Intl.DateTimeFormat(...) }` is now the shared
helper too, so there is one definition rather than two.

**A correction to the obvious reading, measured rather than assumed.** I began
by writing that "CST" would fall back to UTC. It does not: `Intl` **accepts**
"CST", "EST" and "US/Central" as legacy fixed-offset aliases. They resolve to
zones that **never observe DST**, which is a different and subtler
wrong-wall-clock outcome for a family that meant `America/Chicago`. They are not
rejected — they are real zones, and refusing a string `Intl` accepts would break
anyone using one deliberately — and the guard states this rather than leaving
the next reader to assume it is covered.

**OPEN:** a `CHECK` constraint on `families.timezone` is the durable fix, since
the settings form writes to PostgREST directly from the browser and client-side
validation is defence in depth rather than enforcement. That needs a migration,
and two other workers are actively on the ledger, so it is recorded for whoever
owns it next rather than raced for a version number.

---

## [CLAUDE-1][VERIFIED HEALTHY][SECURITY] The SSRF surface — audited call by call, no finding

Recorded as a **negative** result, in full, so the next auditor does not
re-derive it.

A server that fetches a URL a user chose is a request the user gets to aim:
at `169.254.169.254` it reads cloud instance credentials, at a private address
it reaches services nothing else can. This repository defends it, and defends
it *properly* — the parts most implementations get wrong are the parts this one
gets right:

- `validatePublicCalendarUrl` **resolves** the hostname (`dns.lookup`) and
  rejects the **resolved addresses**, not merely the literal — link-local
  (incl. `0xa9fe0000`, the metadata range), loopback, RFC1918, CGNAT,
  multicast, TEST-NETs, IPv4-mapped IPv6, `metadata.google.internal`;
- credentials in the URL (`url.username || url.password`) are refused;
- `fetchPublicText` fetches with **`redirect: 'manual'`** and **re-validates
  every redirect target**, so a public host cannot 302 the fetch onto a
  private one;
- responses are size-bounded and time-bounded.

**Every call site audited:** nine server-side `fetch()` calls take a
non-literal URL. Family calendar feeds → `fetchPublicCalendarText`; library RSS
→ `fetchPublicFeed`; weekend curated feeds → `fetchPublicCalendarText`;
Ticketmaster, SeatGeek, OpenAI, TheMealDB → constant hosts with only a path or
query varying; the health probe → the Supabase URL from env.

**Two things that look like findings and are not:**

- `safeFeedUrl` and `normalizeFeedUrl` check **protocol only**, unlike
  `isSafePublicUrl`. They are *normalizers*, and the real guard wraps them —
  `lib/library/ingest.ts` says so in its own comment. Not three competing SSRF
  guards.
- `isSafeReturnPath` (open redirect) has one importer. Both redirect consumers
  are covered — the step-up page by it, `auth/callback` by
  `safeInternalRedirect`. Two helpers for one rule is duplication worth noting,
  not a hole.

**What was added:** `tests/user-urls-are-fetched-through-the-guard.test.ts`,
because nothing stopped the next route from writing bare `fetch(userUrl)` beside
the guard — the same premise gap that produced the `useRealtimeQuery` and
`aria-modal` findings. It pins **two** properties: the rule (a non-constant
fetch URL goes through the guard or is named with the reason its host is fixed)
**and the guard's own substance** (it resolves rather than parses, blocks the
link-local range, re-checks redirect targets, refuses credentials). Verified
load-bearing both ways: a probe route calling `fetch(searchParam)` turns it red,
and so does changing `redirect: 'manual'` to `'follow'`.

---

## [CLAUDE-1][HIGH][SECURITY / UX] Thirty-nine writes reported success for a change the database refused

Full record in `finalaudit.md` Pass K. Summary: browser-direct UPDATE/DELETE on
the forty-four manager-only tables reported success when RLS had filtered them.
Proven on Postgres 16 — `UPDATE 0` / `DELETE 0` with **no error**, while INSERT
raises 42501. All thirty-nine now `.select('id')` and treat zero rows as a
refusal. Guard: `tests/a-refused-write-is-not-a-success.test.ts`.

Plus five on the trust surface, where the claim is about **access**:
`tests/a-revoke-that-revoked-nothing.test.ts`.

## [CLAUDE-1][VERIFIED HEALTHY] The modules Section C named, audited

- **locator-module** — writes through server actions that enforce `isManager`
  server-side; `member_id` comes from the session, never client input; reads are
  bounded (`location_events` `.limit(120)`) and error-checked. `is_sharing: true`
  on every position write looked like sharing re-enabling itself and is not —
  its only caller is the "Share now" button.
- **paperwork-module** — server actions only, no browser-direct writes.
- **trust actions** — ten of eleven call the shared `managerCtx()`; the
  eleventh (`createSharingPresetAction`) delegates to `createDelegationAction`
  deliberately, so the manager check, the expiry check and the domain filter
  stay in one place. Its comment says why, and it holds.
- **RLS is enabled on every health table checked** — `symptom_logs`,
  `health_goals` (via a `DO` block in 00801), `appointments`, `health_metrics`,
  `workout_logs` (via the generic sweep in 0004). A plain grep for
  `ENABLE ROW LEVEL SECURITY` returns **zero** for all five, because every one
  is enabled through dynamic SQL — recorded so the next sweep does not read that
  zero as a finding.

## [CLAUDE-1][MEDIUM][SECURITY — OWNER DECISION] Two medical tables are member-writable while their neighbours are manager-only

- **Where:** `immunizations` (0069), `health_visits` (0068)
- **Evidence:** both carry `FOR ALL … USING (is_family_member(family_id))`. On
  the **same page** (`/dashboard/medical`), `medical_profiles`,
  `health_providers` and `insurance_policies` are manager-only, and
  `medications` was made manager-only by 0309. The page gate is
  `requireFeature`, a **subscription** check, not a role check — so a child on a
  qualifying plan reaches it.
- **So:** any family member, including a child, can insert, edit or delete a
  sibling's vaccination record and medical visit history, while the same child
  cannot touch a medication or an insurance policy.
- **This is NOT the 0309 shape.** Neither module gates its UI on `isManager`, so
  the interface and the database **agree** — there is no hidden button making a
  promise the database does not keep. It is an asymmetry, not a lie.
- **Status: OPEN, owner decision.** Whether a teenager logging their own vaccine
  should be allowed is a product judgement, and closing it needs a migration —
  which two other workers are actively holding. Recorded with the evidence
  rather than changed unilaterally. This is the shape 0309's own header named:
  *"a class fixed where somebody remembered and left open where nobody did."*

## OPEN — measured, recorded, not changed

- **Sixteen server actions** write manager-only tables without verifying a row
  and then return `ok: true` (`wallet/actions.ts` ×4, `concierge/actions.ts` ×3,
  `account/actions.ts` ×2, `economy/actions.ts` ×2, `locator/actions.ts` ×3,
  `admin/actions.ts`, `assistants/actions.ts`). Outside the permission surface a
  stale id is a refresh prompt rather than a false claim about access, and each
  needs its own judgement about what zero rows should mean there.
- **The three document deletes remove the storage object before the row**, so a
  refused row delete leaves a row pointing at a file that no longer exists.
  Verification now makes it visible; reversing the order is the real fix and is
  a behaviour change worth deciding deliberately.

---

## Pass BF superseded — `main` built the transport I declined to build blind

`tests/native-push-does-not-claim-a-transport-it-lacks.test.ts` is **deleted**,
and the reason matters more than the deletion.

Pass BF found that `lib/server/push.ts` POSTed the FCM **legacy** endpoint, which
Google decommissioned on 2024-06-20 (probed: that URL answers **404**, not 401).
I removed the dead send, made every native attempt a counted `skipped`, corrected
`pushConfigured()` and `docs/mobile.md`, and wrote that guard to hold the honest
state. I explicitly declined to build FCM HTTP v1 — *"building it blind would
recreate exactly what was there before: an untestable integration that reports
itself working."*

`main` built it: `lib/server/native-push.ts` implements **FCM HTTP v1** (service
account, OAuth2 token minted per send window, `…/messages:send`) **and APNs
HTTP/2** with token auth, plus `tests/native-push-provider.test.ts`.

So the guard now asserts a falsehood. It pinned *"native push has no transport"*;
native push has one. Its two failures on the merge —
`expected -1 to be greater than -1` and `docs/mobile.md` no longer containing
`messages:send` — are the guard correctly detecting that its own premise died.

**This is a deletion, not a quarantine.** The distinction is the one this audit
has held throughout: a test is never removed to make a suite green, but a test
whose subject no longer exists is not evidence, it is a false claim kept alive by
inertia. `main`'s `native-push-provider.test.ts` covers the real implementation,
so nothing is left unguarded. Same call as Pass BF's own striking of `push.ts`
from the external-fetch roster once it no longer contained a fetch.

The finding itself was correct and remains so: the legacy endpoint was dead, the
admin console did say native delivery was configured when it was not, and the
docs did instruct an operator to set a key that could not work. Someone else
finished it, which is the better outcome.

---

## The merge, and why the migration collision was settled by the probes

`main` had moved **198 commits** and the branches collided **six ways** on
migration versions `0296`–`0301` — both sides had independently numbered six
different files into the same six slots. Left alone that is the F-020 defect
class exactly: two migrations at one version.

Filenames suggested which of mine were redundant. **Filenames are not evidence**,
so the resolution was made empirical instead: drop the three whose *subject*
`main` already covered, renumber the three that were unique, replay every
migration on a throwaway PG16, and let the boundary probes say whether anything
had been lost.

| my file | verdict | why |
| --- | --- | --- |
| `0296_social_access_delete_matches_grant` | **kept** → `0319` | `main` has no delete policy on `social_access_permissions` at all; AUTHZ-003 was still FAIL there |
| `0297_family_credentials_write_boundary` | **dropped** | `main`'s `0296` covers it and goes further |
| `0298_invites_update_pins_what_it_grants` | **dropped** | `main`'s `0298` covers it |
| `0299_child_logins_write_boundary` | **dropped** | `main`'s `0297` covers it |
| `0300_audit_logs_says_who_wrote_it` | **kept** → `0320` | no equivalent on `main` |
| `0301_family_erasure_indexes` | **kept** → `0321` | no equivalent on `main` |

**Final state: 334 migrations applied, 0 failed, and 46/46 boundary probes pass
on a fresh database.** That is the proof the three drops lost nothing — each
dropped migration's probe still passes, which it could only do if `main`'s
version enforces the same boundary.

### The probe that refused to pass, and was right to

`family-credential-write-boundary-check.sql` failed the first sweep with:

> a child can no longer READ a credential — **O-02 has been addressed**; update
> finalaudit.md and this probe

That is a line I wrote to fail *on purpose*. The write half was fixed while the
read half stayed open — a child could still see the family's stored passwords and
card PINs — and rather than let a half-fixed finding read as fixed, the probe
asserted the open state so that closing it would break the build and force the
document to be updated. **`main`'s `0296` closed the read half.** The probe
caught the exact moment O-02 died. Its assertion is now inverted rather than
deleted: a child must not be able to read a credential, and a regression fails it
again.

### Two false alarms, both mine, both worth naming

`child-login-mapping-is-managers-only-check.sql` failed twice mid-session and
both times it was **leaked fixture state from my own repeated manual runs** on
the throwaway database, not a regression — its rows persisted across my
iteration while my probes' rows did not. On a fresh bootstrap, which is what CI
does, it passes. The lesson is narrow and real: a probe harness that is
`begin; … rollback;` per file is only clean if you actually re-bootstrap between
exploratory runs, and "it failed after I changed something" is not the same as
"my change broke it".

---

## Pass AY superseded — the same helper, built twice, and theirs is wired to more

`lib/supabase/read-all-auth-users.ts` and
`tests/every-auth-user-not-the-first-fifty.test.ts` are **deleted**.

Pass AY found that `supabase.auth.admin.listUsers()` with no arguments returns
**one page of fifty** and says nothing about it, so the weekly digest and the
chore reminders silently dropped every family whose admin sat past that page —
without counting a failure. I wrote `readAllAuthUsers` to page it and wired three
sites.

`main` independently found the same thing and wrote `listAllAuthUsers`
(`lib/server/list-all-auth-users.ts`), carrying the same load-bearing insight in
its own words — *"An EMPTY page is the end. A short page is not: the server may
have clamped per_page, and treating its cap as the end of the list is the defect
this exists to prevent."*

Theirs wins on both counts that matter:

- **Reach.** It is imported by **four** production files —
  `app/(app)/admin/actions.ts`, both crons, and `lib/server/notification-emails.ts`.
  Mine reached three and, after the merge, was imported by nothing except its own
  test: dead code kept alive by its guard.
- **Coverage.** `tests/auth-user-list-is-complete.test.ts` has **eight** cases to
  my five, including ones I did not write: *"never calls listUsers without an
  explicit page size"*, *"refuses to report a partial list as complete when the
  page guard trips"*, and a second block asserting **the production callers
  themselves** ask for every user — which is the part that actually keeps the
  defect from coming back at a new call site.

Checked before deleting, not after: I read their test's cases first and confirmed
it covers the clamped-short-page property my guard existed for. **A guard is only
safe to remove once its replacement is shown to assert the same thing** — the
rule that stopped me deleting anything else in this merge.

The finding was right and is now held by a better instrument than mine.

---

## Pass BA corrected by the merge — I put a service-role write in front of the auth check

**[CLAUDE-1][HIGH][SECURITY] `/api/assistant` and `/api/assistant/alexa` ran a
durable, service-role-backed rate limiter BEFORE the caller was authenticated.
— FIXED by adopting `main`'s design.**

Pass BA's claim was *"all seven now use `enforceRequestRateLimit`"*, and on these
two routes that was the wrong instrument in the wrong place.

`enforceRequestRateLimit` takes the **service-role client** and writes a ledger
row. Placed above the token check it means:

- an **unauthenticated** request causes a **service-role write** — the caller
  makes the server act as the service role before proving anything; and
- **429 becomes the answer to a request that was never authenticated**, so the
  401 boundary is reachable only when the limiter happens to let the request
  through.

On `/api/assistant` it sat above the token check outright. On the Alexa route it
sat after signature verification but **before the access token was read**, so a
signed request carrying no token still caused the write — the same defect one
step later, which is exactly how I missed it.

`main` had deliberately kept both routes on the cheap in-memory `rateLimit`, and
its `tests/middleware-assistant-boundary.test.ts` pins the property directly:
a missing token must reach 401 with `createServiceClient` **never called** and
zero service reads. That guard is what caught this.

**Main's design is taken.** Not because the merge made it convenient — because
mine is unproven in production and demonstrably mis-placed, and its guard states
the boundary more sharply than my own did. What I had actually built was a
narrower version of the very defect I fixed in the Alexa pass and wrote up as a
lesson: *"putting `enforceRequestRateLimit(createServiceClient(), …)` at the top
meant an UNVERIFIED request wrote to the DB."* I wrote that down and then did it
again on the route next door.

### The cost is recorded rather than hidden

An in-memory limiter is **per serverless instance**, and the number of instances
is the caller's to raise by sending in parallel — so "30 per minute" is 30 per
minute per lambda. That is a real limit and both routes now say so in place,
along with where the durable version belongs: **after `resolveAssistantLink`,
keyed on the caller**, so the write is only ever made for a request that has
already proved who it is. Improvising that during a merge is how the first
version went wrong; it is left as a recorded decision for its own pass.

**Verified:** `tests/middleware-assistant-boundary.test.ts` and
`tests/alexa-request-verification.test.ts` — **70/70**.

## Pass BL — two ratchets crossed in the merge, and neither had been broken

The merge left two i18n ratchets red, and the tempting reading of both was
"drift". It was wrong both times, and the reason is structural rather than
lucky: **each ratchet is one agent's instrument, and the merge pointed it at the
other agent's code for the first time.**

| instrument | born on | ceiling measured against | what it now measures |
|---|---|---|---|
| `tests/i18n-ungated-surface-ratchet.test.ts` | `main` | main's tree alone (2,811) | main **+** this branch's `app/` and `components/` |
| `tests/hardcoded-locales-only-go-down.test.ts` | this branch | this branch alone (70 / 16) | this branch **+** 198 commits of main's `lib/` |

Neither number moved because someone wrote a careless string. Both moved
because the instrument is now aimed at code it had never scanned — the same
*shape* as the "stricter scanner" case the surface ratchet already names as the
one legitimate reason to raise a ceiling. That file now names this as a second
reason, explicitly, rather than leaving someone to argue it into existence.

### The method, and the reading that nearly landed

Hold ONE scanner fixed and vary the tree. Today's scanner over three trees:

    617355b2  this branch's pre-merge tip     2,823
    origin/main                               2,811
    HEAD      the merge                       2,823

So the merge added **nothing**; this branch was already at 2,823 alone.

**The first run of that measurement said 2,846 / 2,835 / 2,823 and pointed the
conclusion backwards** — it made the merged tree look like an improvement on
both parents. The cause is worth writing down: I archived only `app` and
`components` out of each tree, because those are the two paths `scanPaths` is
given. But the scanner also reads `lib/i18n/messages/INVARIANT.txt` — the file
that says "Bubaly" and the other proper nouns are not to be translated — and a
**missing invariant file falls back to an empty set without a word**. Both
historical trees were therefore scored with every proper noun counted as a
finding. That is the same trap this file already records one costume earlier
(2,343 vs 2,812): two numbers from two differently-configured scanners say
nothing about the code. I walked into it again from the other side.

### The twelve, classified — none was new untranslated copy

- **5 were date-format PATTERN KEYS** (`'MMM d'`, `'MMM d, yyyy'`) passed as
  `absolutePattern` from five UI call sites. Both are in `PATTERNS`, so they
  already routed through `Intl.DateTimeFormat(code, options)` — the scanner was
  reading a mechanism as copy. **Removed anyway, and not to buy five off a
  ceiling:** `fmtDate` answers an *unmapped* pattern by falling through to
  date-fns `format()`, which carries no locale, so a typo (`'MMM D'`) would have
  failed nowhere and quietly shipped English month names to eleven locales. The
  option is now `absoluteWithYear?: boolean` — which is what the type's own
  comment said all seven callers were choosing between.
- **1 was `label: 'The AI assistant'`**, the only one of eleven `assertAIAccess`
  callers passing a label. Now derived from `FEATURE_CATALOG_BY_KEY[featureKey]
  .label`, so an upgrade prompt names the feature the way the plan page it sends
  the reader to names it. `'ai-requests'` is itself labelled `'Ask Bubaly'`, so
  the other ten read exactly as before.
- **6 are `guardian/page.tsx` read-failure diagnostics** — and these were **not
  converted**, on purpose. The ceiling already accepts the same class from main:
  command-center's `'open chores'`, `'meal plans'`, `'expiring docs'` and the
  equivalents on calm and activity are all inside the 2,811. Every one renders
  as `` `${label}: ${describeReadError(error)}` `` and that second half is a
  Postgres string nothing can translate, so a translated label reads
  *"Mitgliederprofile: relation … does not exist"*. Converting one page of six
  leaves two conventions for one diagnostic — the half-conversion this audit has
  refused since Pass Z. Recorded as **I18N-006**, a class, to be closed as one.

**2,823 − 6 = 2,817.**

### The locale ratchet: six new sites, all mechanism, none converted

Same method, three trees; it reproduces **70 / 16** on `617355b2` exactly, which
is what earns the delta any trust, and `origin/main` alone scores **247** — the
number this file started at, because none of the conversion work exists there.
The delta is four files and **three did not exist on this branch at all**:
`lib/display/ambient.ts` (+2), `lib/meals/week.ts` (+2, new on main),
`lib/social/schedule-time.ts` (+1) and `lib/social/scheduled-publish.ts` (+1).

All six are engines, and the reason is worth recording: **main's authors had
already reached for the locale wherever a person reads the output.** Each module
carries both halves, correctly split. `ambient.dayPart()` wraps `.format()` in
`Number(...)` and does arithmetic on it; `meals/week.ts` builds a `YYYY-MM-DD`
key that `calendarDate()` re-parses against `/^\d{4}-\d{2}-\d{2}$/` with a
non-null assertion — a non-Latin numbering system fails the regex and the `!`
throws; `schedule-time.ts` is the `ics-time.ts` constructor-as-validity-probe
already in the ratchet's header. `components/` **held at zero through 198
commits of main**, and `app/` held at its floor of 25.

**One gap found and recorded rather than closed.** `scheduled-publish.ts:25`
calls `.format(instant)` purely to force a `RangeError` on a bad timezone and
discards the string. The mechanism pin identifies a bare probe by the *absence*
of `.format` after the constructor, so the ceiling counts this site and the pin
cannot see it — which is why the ceiling moved +6 and the pin +5. Widening the
signal list to catch it would start catching real display formatters, and a pin
that drifts up on false positives has stopped being a pin.

**Verified:** both ratchets green (8/8), `npm run -s i18n:gate` clean across all
declared surfaces, `npx tsc --noEmit` clean,
`tests/one-time-ago-and-it-follows-the-reader.test.ts` 12/12.

## Pass BM — the correction to Pass BA: I removed the limiter instead of moving it

`tests/no-route-gates-on-a-per-instance-limit.test.ts` went red after the merge
with exactly two findings, and both were mine:

    app/api/assistant/alexa/route.ts:49
    app/api/assistant/route.ts:52

That guard is **my own**, written on this branch and absent from `main`. Its
claim is that an in-memory `rateLimit()` with no durable partner in the same
handler "is per-lambda, so it is not a gate". In Pass BA I found a real defect —
a durable, service-role-backed limiter sitting **above** the auth check, so an
unauthenticated request caused a service-role write and 429 could answer a
request that had proved nothing — and I fixed it by **deleting the durable
half** and adopting main's in-memory-only design.

That was half a fix. The ordering defect was real and the deletion did close it,
but the correct move was to relocate the limiter, not remove it — and I had
already written that down in Pass BA's own record: *"a durable per-caller limit
belongs after `resolveAssistantLink`, keyed on the caller."* I wrote the remedy
into the comment and then did not apply it, and my own guard is what caught the
gap. This is the second time in this audit that the fix for a defect was already
written in the file that had it.

### What the pair now is

Two limits, and which one sits where is the design:

- **In-memory, first, before any service client exists.** A cheap pre-filter
  that bounds how many unauthenticated requests reach the one indexed SELECT.
  It cannot be durable *here* — that is precisely the Pass BA defect.
- **Durable, after `resolveAssistantLink`.** Keyed on `link.id`, so the key is
  the **principal** rather than an IP, which a caller can spread across hosts
  and a link id they cannot. This is what bounds the expensive half —
  `answerAssistant` reads the family and calls a model — across instances
  instead of per lambda.

`failOpen: true`, argued rather than defaulted. If the limiter itself cannot be
read the choice is between refusing every family's assistant and falling back to
the in-memory bound. Failing open degrades to exactly the behaviour these routes
had before the durable half existed; failing closed turns a rate-limit outage
into *"Bubaly is not responding"* in every kitchen. The in-memory limiter is
still in front, so open here is bounded, not unbounded.

### Two guards contradicted, and the reconciliation is written down not slipped in

`tests/middleware-assistant-boundary.test.ts` is **main's**, and its fake client
asserted the route's only call is the `assistant_links` read — a count of 1. A
legitimate post-auth limiter makes it 2. The two guards cannot both hold as
written, which is the same collision the storage namer hit in this merge.

The count is not a security property; it was a *proxy* for one. Every assertion
that carries the actual boundary — `mocks.admin` never called, `reads` empty on
a missing token, `reads` length 1 on an unknown token, and the same on an
unverified Alexa envelope — is **untouched**. What changed is that the happy
path now asserts the two calls **and their order**, `['assistant_links',
'rpc/rate_limit_hit']`, which is stricter than the count it replaces: it pins
that the limiter is charged *after* the link resolves rather than merely that
some second call exists.

Two things were *added*, not relaxed. The mock now matches the RPC by **shape**
— method, key prefix, that the key ends in the resolved link id, the limit and
the window — rather than tolerating a second pathname. And a new case proves the
gate actually gates: with the RPC answering `allowed: false`, `/api/assistant`
returns 429 with `Retry-After: 42` and Alexa speaks its refusal, and neither
reaches the model.

Answering the RPC in the mock rather than letting it throw is itself load
bearing, and it is why the first run of this was nearly worthless: `rateLimitDb`
fails **open** here, so a mock that threw would have been indistinguishable from
a limiter that allowed the request, and the case would have passed whether or
not the call was ever made.

**Planted and proven.** With `if (!durable.ok)` neutralised to `if (false &&
!durable.ok)` in both routes — a regression that keeps the round trip and
ignores the verdict — both new cases go **red**; restored, 19/19 green.

### Recorded, not fixed here

`app/api/ai/gift/route.ts:31` constructs a service client and calls
`rateLimitDb` **before** reading its token — the same shape as the Pass BA
defect, on an unauthenticated gift-link path. It is outside this pass and has no
boundary guard of its own; it needs the same relocation and a guard that pins it.

**Verified:** `no-route-gates-on-a-per-instance-limit`,
`middleware-assistant-boundary` and `alexa-request-verification` — **76/76**
(was 74; the two new cases are the difference). `npx tsc --noEmit` clean.
