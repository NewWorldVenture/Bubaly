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
