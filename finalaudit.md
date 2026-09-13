# Bubaly — Final Audit

Ten audits of bubaly.com, kept in one file because one file is the record.

They ran over **different surfaces** and none supersedes another:

| Pass | Surface | Findings | Numbering |
|---|---|---|---|
| **A — Public surface** | marketing pages, SEO and crawler contract, robots/sitemap, headers, titles, i18n payload, plan entitlement, role entitlement | 20 | `F1`–`F20` |
| **B — Data layer** | Supabase reads and writes, RLS and grant boundaries, nightly jobs, the build/data-cache boundary, calendar-day correctness, query plans, money concurrency, and the audit's own probes | 19 | `F-001`–`F-019` |
| **C — Write honesty** | every place a write's result is discarded and something downstream then claims it happened: audit trails, emergency notifications, provider disconnects, the unsubscribe, scheduler counters | 8 | `C-01`–`C-08` |
| **D — Server-action authorization** | every export of every `'use server'` module: whether it establishes who is calling, and whether authenticating a caller actually constrains which family they may write to | 0 | — |
| **E — Read honesty** | the mirror of C: a read whose error is discarded, where something downstream then treats the absence it returns as a fact | 1 | `E-01` |
| **F — Public API routes** | every `route.ts` under a PUBLIC middleware prefix, which reaches the handler with no session: does it authenticate itself, and does it only claim what it can support | 2 | `F-a`, `F-b` |
| **G — RLS completeness** | all 491 tables in a real replayed catalogue: is RLS on, and is any policy a blanket `true` | 0 | — |
| **H — Storage object paths** | the Storage buckets Passes A–G never looked at: which are public, and what protects an object in one | 1 | `H-01` |
| **I — Role boundaries** | the question Pass D left open: not who is calling or which family, but which ROLE — can a child reach what a parent decides | 1 | `I-01` |
| **J — What the AI may do** | the 94-tool registry: does a tool that declares it cannot write actually not write, given that the write gate believes the declaration | 0 | — |

**Where they touch, stated plainly.** Passes A and B meet in only two places:

- **The production migration ledger** is the same blocker in both — Pass A's
  **F5** and Pass B's **F-001**. A reaches it from the CI workflow (the access
  token cannot link the project), B from the database (the ledger records only
  `0001–0003`, so the baseline guard halts the push). Both are true, both are
  the same wall, and both need the same credentialed operator.

  Three findings in this file are still open, and only this one is a blocker:
  the ledger (A's **F5** / B's **F-001**) and A's **F6** both need a
  credentialed operator, and A's **F19** is a pricing decision for the owner
  rather than a defect.
- **The sitemap** appears in both, and they are *different defects*. Pass A's
  **F1**/**F3**/**F14** are about which URLs it listed — 435 that answered 404,
  the homepage twice, nine that canonicalise elsewhere — fixed on `main` by
  #526. Pass B's **F-012** is about the file being *stale*: correct URLs, but a
  six-day-old copy of the blog served from Next's build Data Cache, and frozen
  for a year. #526's URL work and F-012's freshness fix are both in the current
  file, and neither pass would have found the other's defect.

**Pass C shares a surface with Pass B and no findings with it.** Both read
Supabase writes; B asked whether the right rows are written and who may write
them, C asked a narrower question — when a write is refused, does anything
notice? Run against `main` after B's fixes, C found eight instances B had not
recorded, and B found none of C's. The one place they nearly met is
`lib/server/push.ts`: C-08's prune counter was ALSO found independently on the
`codex/final-production-audit-20260912` branch, which is the only duplicate
across all three passes and is noted at C-08.

**Pass D found nothing, and that is the finding.** It is recorded in full
because a pass that reports zero has to be at least as well evidenced as one
that reports eight — otherwise "we checked" and "we could not see" read the
same on the page. What it checked is a surface none of A, B or C covered: every
export of a `'use server'` module is an HTTP endpoint with its own action id,
callable without the component that normally calls it. 487 of them exist. The
pass is at Pass D below, together with the false-positive class that nearly got
33 non-defects reported as findings.

Everything else is disjoint.

---

# Pass A — Public surface (F1–F20)

Full audit of bubaly.com: what was checked, what was found, what was fixed, and
what remains — with an owner for every remaining item. Every finding here was
reproduced against the live site or the real code path before being written
down; nothing is inferred from a filename or a comment.

**Audit status: reopened, then complete again.** Twenty findings, and the
arithmetic stated exactly rather than approximately:

| | |
|---|---|
| **Fixed in code** | **14** — F2, F4, F7, F8, F10, F11, F15, F16, F17, F18, F20 from this audit; F1, F3, F14 on `main` via #526, whose sitemap implementation superseded mine and which I withdrew in its favour |
| **Closed without a code change** | **4** — F9 (a decision, with the design and the numbers recorded), F12 (recorded; the fix is not worth its risk), F13 (correct as built — fail-closed routing), F19 (a pricing decision the owner has to make; the numbers are below) |
| **Blocked on credentials** | **2** — F5 (Supabase access token *and* the ledger baseline gate) and F6 (`CONTACT_CENTER_INBOUND_SECRET` + MX records) |

One further observation was **disproved and withdrawn** after re-checking: a
reading that two pages shipped no metadata, which was my own extraction bug.

Nothing is left unexamined or unassigned.

- **Audit opened:** 2026-09-13
- **Audit closed:** 2026-09-13
- **Reopened:** 2026-09-13 — F7 was not a one-off but a *shape*: an entitlement
  stated where a user can see it and absent where it is enforced. Every paid
  feature was re-checked for that shape. It recurred four more times: in a
  nightly cron (F15), across 24 pages and their shared write path (F16), in the
  documentation that describes the tiers (F17), and behind 20 endpoints — 14
  under `/api/ai` and six outside it (F18)
- **Production head at open:** `f9c4d7a1` (#522)
- **Scope:** public marketing surface, authenticated app surface, API boundary,
  SEO/crawler contract, security headers, build and test health, and the
  operator-owned items inherited from earlier work.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Sitemap advertised 435 URLs that answer 404 (29% of it) | High | **Fixed on main by #526**; my implementation withdrawn in its favour |
| F2 | `robots.txt` omitted 20 authenticated surfaces, `/admin` among them | Medium | **Fixed** — and #526 did *not* cover this |
| F3 | Homepage published twice in the sitemap (`…com` and `…com/`) | Low | **Fixed on main by #526** |
| F4 | The test named for F1's property only grepped source | Medium | **Fixed** |
| F5 | Supabase production migration workflow cannot authenticate | High | **Half closed** — the token reads production again (verified 2026-09-13); the ledger baseline gate remains. See *Production, read for real* |
| F6 | Family email routing not configured (`CONTACT_CENTER_INBOUND_SECRET`, MX) | Medium | **Operator — config** |
| F7 | Family email is gated on the screen only — inbound pipeline has no plan check | Medium | **Fixed** — owner chose Family+ |
| F8 | Page titles doubled the brand (`… — Bubaly · Bubaly`) | Low | **Fixed** |
| F9 | Whole 848 KB i18n catalogue serialized into every page | High (perf) | **Closed — decision recorded** |
| F10 | Seeded placeholder records shown as real customer stories on the homepage and /pricing | High | **Fixed** |
| F11 | Five public pages had no `<h1>` at all | Medium | **Fixed** |
| F12 | The 404 page ships no server-rendered markup | Low | **Closed — recorded, not worth the fix** |
| F13 | An unknown top-level path redirects to login instead of 404 | Low | **By design — no change** |
| F14 | Sitemap lists 9 `/blog?category=` URLs whose canonical points at `/blog` | Low | **Fixed on main by #526** |
| F15 | Family Autopilot (Plus) ran nightly for *every* family — both things that run it had no plan check | High | **Fixed** |
| F16 | 24 of 62 paid features were enforced only by the sidebar padlock — the URL was the bypass | High | **Fixed** |
| F17 | The documented route→tier map disagreed with what is enforced on 19 of 55 routes | Medium | **Fixed** |
| F18 | 20 endpoints behind feature-gated pages had no entitlement check — the fetch was the bypass, mostly on the surface that costs money per call | High | **Fixed** |
| F19 | `AI_MONTHLY_ALLOWANCE` is enforced on 4 of the 39 AI routes; 35 run unmetered | Medium | **Open — a pricing decision, recorded** |
| F20 | A child could delete any chore on the family's board, and mint chores for a sibling | High | **Fixed** |

---

## F1 — The sitemap advertised 435 dead URLs *(High, fixed)*

**What was wrong.** The live sitemap carried 1,508 URLs. 435 of them — 29% —
were of the form `/blog/Seed <uuid>`, and every single one answered **404**.

Sampled 8 seed URLs and 8 real ones; the split was total:

```
404  /blog/Seed b40afaf9-4b6e-43ff-b617-f2e682cca0f8
404  /blog/Seed 0665c96f-735b-4819-906c-38c0ca07a83b     (8/8 seed → 404)
200  /blog/a-simple-system-for-a-calm-approach-to-holiday-hosting
200  /blog/planning-a-road-trip-playlist-a-calm-practical-guide   (8/8 real → 200)
```

They also carried a literal **space** in the path, which is not a valid `<loc>`.

**Root cause.** Two halves of the same system disagreed about what exists.

- `app/sitemap.ts` builds blog entries from `getAllPosts()`, which filters
  through `publicRows` → `isSyntheticBlogSeedSlug`. That filter is correct: run
  against all 435 live slugs it caught **435 of 435**.
- But the sitemap *also* emits `platformEntries` from the `marketing_pages`
  table, which stores a `path` directly and had **no seed filter of any kind**.
  Any published row was emitted verbatim.
- The renderer refuses them: `getPost()` (`lib/blog/posts.ts:196`) begins
  `if (isSyntheticBlogSeedSlug(slug)) return undefined;`, and the page then calls
  `notFound()`.

So `marketing_pages` advertised what `blog_posts` refused to render. The file's
own comment already stated the rule it was breaking: *"a sitemap must never point
at a 404."*

**Fix.** `app/sitemap.ts` gained two exported, unit-tested helpers:

- `isAdvertisablePlatformPath()` — rejects a platform path under `/blog/` whose
  slug the renderer will refuse, applying the *same* predicate the renderer uses,
  so the two cannot diverge again. Also rejects non-rooted paths, which closes an
  absolute-URL row (`https://evil.example/x`) that the old
  `path.startsWith('/')` check already handled but nothing pinned.
- `canonicalSitemapUrl()` — collapses a stored root path of `/` onto the static
  spelling `''` (see F3).

**Verification.** Reverted the fix and re-ran: the two new behavioural cases fail,
and pass again once restored.

## F2 — `robots.txt` omitted 20 authenticated surfaces *(Medium, fixed)*

**What was wrong.** `app/robots.ts` carried the comment *"Authenticated app
surfaces should not be indexed"* above a list of four: `/dashboard`,
`/onboarding`, `/api`, `/auth`.

The authenticated route group holds **22 segments**, and probing production found
**20 gated surfaces absent from that list** — every one answering 307 to `/login`:

```
/account /admin /capture /display /economy /family /feedback /guardian
/home /kids /library /marketplace /missions /money /parent /pay
/referrals /services /settings /wallet
```

`/admin` alone is 80 pages, including the super-admin console.

**Severity, stated honestly.** This is **not** a data leak. Every one of these
redirects to login while signed out, so there is nothing for a crawler to index.
What was wrong is narrower: the stated policy did not match the implementation,
crawl budget was spent discovering them, and — the part that actually matters —
a future route that answers 200 anonymously would have inherited no protection.

**Fix.** `DISALLOWED_APP_PATHS` now names all 24 paths. A new test derives the
segment list from `app/(app)` on disk and fails when a segment is added without a
matching entry, so the list cannot fall behind. A separate case asserts the
public marketing routes are still allowed — `/family-display` is public while
`/family` and `/display` are not, so a naive prefix rule would have taken it down
with them.

**Verification.** Restoring the four-entry list fails 3 of the 6 cases.

## F3 — The homepage was published twice *(Low, fixed)*

The sitemap contained both `https://www.bubaly.com` and `https://www.bubaly.com/`.
`STATIC_ROUTES` spells the root as `''`; a `marketing_pages` row spelled it `/`.
The dedupe keys on the URL **string**, so the two never collapsed. Fixed by
`canonicalSitemapUrl()`; pinned by a test asserting exactly one homepage entry
and, separately, that the whole sitemap contains no duplicate URL at all.

## F4 — The test named for F1's property could not observe it *(Medium, fixed)*

`tests/marketing-sitemap-closed-loop.test.ts` — the file named for this exact
property — never ran the sitemap. All three cases read `app/sitemap.ts` as text
and asserted that certain substrings appeared in it. A grep cannot tell you what
a function emits, which is why a 29%-dead sitemap shipped under a green test.

Demonstrated rather than asserted: against the pre-fix code, **all three
source-grep cases still pass** while the new behavioural ones fail.

The three original cases are kept — they do pin real wiring — and five cases were
added that execute `sitemap()` against a stubbed database and assert on the URLs
it returns. The Supabase stub is a `Proxy`, not a fixed method list, so adding a
`.limit()` or `.range()` to either query cannot silently turn the suite into a
false pass.

## F5 — Production migrations cannot be applied *(High, operator — credentials)*

The **Supabase production migrations** workflow fails on every push:

```
Authorization failed for the access token and project ref pair:
"Your account does not have the necessary privileges to access this endpoint."
```

`Link production project` fails and every apply/verify step after it is
**skipped**, so no migration reaches production.

Two independent blockers, and fixing one alone changes nothing:

1. **The access token lost its privileges.** Not caused by any recent PR — the
   19:16 and 22:24 runs on 2026-09-12 failed identically. It *is* a regression
   though: the 2026-09-07 run got past `link` and read the real production
   catalogue (441 tables, 978 policies). So the token or project ref was revoked,
   rotated, or had its role changed since.
2. **The baseline gate stops it by design.** `hasUnrecordedBaseline` throws while
   `profiles_insert_self` exists without a recorded migration `0004` — exactly
   production's state. `scripts/audit-production-migration-state.mjs` says so
   outright: *"Repairing it is a credentialed operator action."*

Migrations have therefore never been auto-applying; production's schema is
hand-managed per the runbook. **Deliberately not touched** — the repo forbids
agents applying migrations or stamping the ledger.

**Consequence to be aware of:** `docs/PENDING_PROD_MIGRATIONS.md` records the
production ledger as holding only `0001-0003`, and warns that a missing ledger
entry does *not* prove the schema is absent (441 tables exist). So the state of
any given migration in production is genuinely unknown from here.

## F6 — Family email is built but not routed *(Medium, operator — config)*

The code path is complete and merged (#516, #517): addresses are provisioned at
onboarding, the reserved namespace is held back, the inbound webhook is reachable,
and replies go out *as* the family. Two config steps remain, both requiring
credentials this session does not have:

- `CONTACT_CENTER_INBOUND_SECRET` in Vercel
- MX routing for `bubaly.com` → `/api/contact-center/email?key=…`

Current live behaviour is correct for that state: `POST /api/contact-center/email`
answers **401** (verified three times), meaning the route runs and refuses. Before
#516 it answered 307 → `/login`, so the route never executed at all.

## F7 — The family email gate existed only on the screen *(Medium, fixed)*

**Corrected once on re-examination, then resolved.** I first recorded this as "a
Free family is given an address it cannot see", which understated it. Tracing the
whole path found no plan check anywhere except the screen:

| Stage | Gate, before |
|---|---|
| Contact Center screen | `requirePlanLevel(2)` — a bare literal |
| Address provisioning at onboarding | **none** — ran for every tier |
| Inbound webhook | **none** |
| `lib/contact-center/{server,address,provision}.ts` | **none** |

So a **Free** family had a working `@bubaly.com` address that received mail,
filed it, ran the AI concierge over it and auto-replied **as the family**. The
only thing they could not do was open the inbox.

**Resolved: the owner chose Family+.** All three surfaces now read one constant,
`FAMILY_EMAIL_MIN_PLAN_LEVEL` in `lib/constants/plans.ts`. The bare
`requirePlanLevel(2)` is gone — a literal in one file is what let the other two
drift in the first place, so moving the feature between tiers is now a change to
that line rather than a hunt through three files.

Two details that carry the risk:

**Ordering.** Provisioning is gated *before* the webhook, deliberately. Gating
the webhook first would strand mail addressed to an address a family still
holds. With provisioning closed, a family below the line has no address for
anything to arrive at, and the webhook check covers the single case left: an
address issued while the family was Family+ and still resolvable after a
downgrade.

**An unreadable plan is not an unentitled family.** `resolveFamilyPlanLevel`
throws when the subscription read fails, and the webhook catches that separately
and answers **503**, exactly as its other read failures do. Answering 200 would
tell the provider the message was handled — no retry, and no copy of it
anywhere — so a teacher's email would be gone because a database read blipped.
That case has its own test, and reverting the 503 to a 200 fails it.

The same throw sits inside onboarding's provisioning block, which is still
wrapped and still last, so a subscription blip cannot turn a completed signup
into a retry.

Verified non-vacuous three ways: reverting the page to its literal, the webhook's
503 to a 200, and the provisioning gate each fail exactly the case that covers
them.

**One follow-up worth doing when MX is live (F6).** A refused message currently
answers `{ ok: true, skipped: 'plan' }` — acknowledged and logged, matching this
route's existing idiom for a recipient it will not process. A real bounce would
be kinder to the sender, who otherwise learns nothing. Not built here because
nothing is routed to the webhook yet, so there is no live behaviour to preserve
or break.

## F8 — Page titles doubled the brand *(Low, fixed)*

Live on 2026-09-13:

```
<title>Security &amp; Privacy — Bubaly · Bubaly</title>
<title>Contact Bubaly · Bubaly</title>
```

The root layout formats titles with `template: '%s · Bubaly'`, so a title that
already ends in the brand gets it twice. The titles come from the admin SEO store
(`marketing_seo_pages`, read by `getSeoPage`), not from the i18n catalogue —
confirmed: **0** catalogue strings end in "— Bubaly".

That makes correcting the rows the wrong fix: the store is admin-editable free
text, so the next brand-suffixed title reintroduces it. The template owns the
brand, so `titleWithoutDoubledBrand()` now opts a self-branded title out of the
template using Next.js's own `absolute` mechanism.

Only a *trailing* brand counts. "Bubaly — The AI Family Operating System" leads
with the name and still wants the suffix. The regex requires a separator before
the brand, so "Meet the Bubalys" is untouched — pinned by its own case.

`openGraph.title` keeps the plain string: it carries no brand template of its
own and was never doubled.

## F9 — The entire i18n catalogue ships on every page *(High — perf; closed as a decision)*

**Measured, not estimated.** `app/layout.tsx` passes the whole merged catalogue
to `LocaleProvider`, which is a `'use client'` component — so React serializes
all of it into the RSC payload of every page.

| | |
|---|---|
| `/login` HTML | 906,263 bytes raw, **255 KB brotli** |
| of which one RSC script | 870,633 chars — **98%** |
| `en-US.json` on disk | 848.5 KB, 13,449 keys |

Proven rather than inferred from the size match: five strings from sections with
nothing to do with signing in — `wallet`, `kids`, `marketplace`, `guardian`,
`benchmarksPage` — appear **verbatim** in the `/login` HTML, 5 of 5.

### What the public site actually needs

Computed as a transitive import closure from each route group's pages, keeping
client components and everything they import, then collecting every string
literal that is a real catalogue key (not only those inside a `t(...)` call):

| scope | client files | keys | size | share of catalogue |
|---|---|---|---|---|
| marketing | 81 | 324 | 21 KB | **2.6%** |
| auth (`/login`, `/signup`, `/welcome`, `/kid-login`) | 62 | 89 | 5 KB | **0.6%** |
| signed-in app | 1,122 | 8,282 | 442 KB | 55.7% |

So the public marketing site ships **793 KB to deliver 21 KB of value** — the
pages every first-time visitor and every crawler sees.

### The key sets for marketing and auth are provably complete

The danger in pruning is a key a static scan cannot see, which renders as the
raw key (`calendar.addEvent`) in front of a person. For these two groups that
was checked exhaustively rather than sampled:

- **9 dynamic `t(variable)` call sites** across both groups, all of the form
  `t(item.labelKey)`.
- Every one reads from a **static module inside the closure** — `MARKETING_NAV`
  (`lib/constants/navigation`), `VALUE_ROWS`/`VALUE_TIERS`
  (`lib/marketing/value`), the consent categories, and the local `LINKS` map in
  `components/auth/legal-consent.tsx`. None comes from the database or from user
  input.
- Checked directly: **36 of 36** keys reachable through those dynamic sites are
  present in the computed set. **Zero missing.**

### Why it is still not shipped

Two candidate mechanisms, both blocked, and the third disproved outright:

1. **A global client-only subset** (no path detection, one code path, 40%
   saving) is **unsafe, and I disproved it rather than assuming**: **123
   catalogue keys are defined as literals in server components and handed to
   client components as props** — `admins.tab.users`, `supportTickets.tab.open`,
   `runHistory.filterActive`, `familyCfo.subscription`,
   `displaySetup.stepInstallTitle` and 118 more. Every one would render as a raw
   key. The scan could be widened to catch these, but that is whack-a-mole: the
   next unanticipated pattern breaks a page in production.
2. **Scoping by request path** needs the pathname in the root layout, which
   means a header set in `middleware.ts`. That file's own comment documents that
   mishandling its request/response pair causes Supabase to treat a reused
   refresh token as stolen and **revoke the entire session family**. Threading a
   header through its five return points is not verifiable here.
3. **A nested provider** — the cleanest option, and no restructure at all. The
   root layout keeps `LocaleProvider` but is given only the keys every route
   *outside* `app/(app)` can reach; `app/(app)/layout.tsx`, which already
   exists, renders a nested `LocaleProvider` carrying the full catalogue, and
   the inner context simply wins for signed-in pages.

   Measured: the root set is **702 keys — 44 KB of 793 KB (5.5%)**, covering
   marketing, auth, onboarding, library, join, pay, gift, reviews, `/s` and
   offline together. Public pages drop by ~94%; signed-in pages carry the extra
   44 KB, which is the whole cost and is paid behind a login.

   Completeness was checked the same way as before, and **only three keys are
   uncovered**, all in one file:

   ```
   marketingDisplay.mockScheduleTitle  app/(marketing)/family-display/page.tsx
   marketingDisplay.mockAskTitle       app/(marketing)/family-display/page.tsx
   marketingDisplay.mockHandledTitle   app/(marketing)/family-display/page.tsx
   ```

   They are defined in that server page and passed to a client component, so
   the generator must scan non-`(app)` server files for key literals too — the
   same pattern that makes a global subset unsafe, but here it is three keys in
   one file rather than 123 across the admin console.

The common blocker is verification: the entire risk surface of all three is
**client-side hydration**, and a browser cannot run in this environment. Chromium
dies in the proxy relay for every host (see *Method*), so the one thing that
would prove a scoped payload still renders every string cannot be run.

**Recommendation.** Take option 3. Leave the signed-in app on the full catalogue
via the nested provider — it holds 1,122 client files and the 123 server-defined
keys, past what inspection can cover, and it sits behind a login where payload
matters least. Handle the three `marketingDisplay.*` keys, generate the root set,
and add a test that regenerates it and fails on any drift; then the failure mode
reduces to "is a key missing", which is a static property a test can settle
exhaustively without a browser.

That is a deliberate, evidence-backed decision to defer, not an open question:
the measurements, the safety proof, the counterexamples, and the mechanism are
all settled. What remains is a person running it in a browser once.

## F10 — Seeded records presented as real customer stories *(High, fixed)*

Found by crawling the internal links on the live public pages.

The **homepage** and **/pricing** both rendered a section headed **"Family
stories"**, introducing its contents as quotes *"In the family's own words"* —
and the contents were three database seed rows:

```
Seed Case Studies #450   Seed Summary value 450   Seed Result Metric value 450
Seed Case Studies #180   Seed Summary value 180   Seed Result Metric value 180
Seed Case Studies #90    Seed Summary value 90    Seed Result Metric value 90
```

Each linked to a detail page that answered **200** with
`<h1>Seed Case Studies #450</h1>` at `/customers/seed-case_studies-450`.

This is the same class as F1 — seeded rows reaching a public surface — but worse
in kind: F1 published dead links, while this published *invented customers* under
a heading that explicitly claims they are real families.

**Why `is_published` could not have caught it.** The seeder sets `is_published`
true; that flag is exactly what made them public. The rows are identifiable only
by the seeder's slug convention, `seed-<table>-<n>`.

**Fix.** `isSyntheticSeedSlug()` joins `publishedOnly()` in the shared reputation
helpers, so the list readers on both pages exclude them, and
`loadPublishedCaseStudy()` refuses one **before touching the database** so a link
surviving in a cache or a search index cannot still render one. The list and the
detail page agreeing is the whole point — F1 existed precisely because two
readers of the same content did not.

Deliberately narrow: testimonials have no `slug` column at all, so they pass
through untouched, and the guard requires the marker at the *start* of the slug
so a genuine story like `seeds-of-change` or `seed-starting-with-kids` is not
swept up. Both are pinned.

**Still worth doing separately:** the rows remain in the database. The site no
longer renders them, which is the visible outcome, but deleting them is an admin
action (Super Admin → Marketing, or SQL) that this session has no credentials
for.

## F11 — Five public pages had no `<h1>` *(Medium, fixed)*

Verified against production: `/faq`, `/contact`, `/mobile` and `/family-display`
each returned **zero `<h1>` elements**, starting their document outline at `<h2>`.

All four used `SectionHeading` for their **page title**, and that component
hard-coded `h2`. Pages with a hand-rolled hero (`/`, `/pricing`, `/features`)
render exactly one `<h1>` and were unaffected — which is why this only hit the
pages that reused the shared component.

A missing `h1` costs screen-reader users their primary means of orienting on a
page, and removes the strongest on-page relevance signal for search.

**Fix.** `SectionHeading` takes an optional `as="h1"`, defaulting to `h2` so
every existing section heading is unchanged. The five page titles set it. The
class list is identical at either level and a test asserts that — this is a
document-outline fix and those pages must look exactly as they did.

**The fifth page.** The structural test caught `/resources/benchmarks`, which
live probing could never have found: it 404s while its publication flag is off.
Same defect, same fix.

**A vacuous test, caught and fixed.** The first version of the sweep passed even
with the fix reverted. The JSDoc I had just written on `SectionHeading` contains
the literal `as="h1"` as an instruction to callers, so every page importing that
module matched on the comment. Found by reverting one page and watching the test
stay green — precisely the failure F4 is about. The sweep now strips comments
before scanning, and reverting `/faq` correctly fails and names it.

## F12 — The 404 page ships no server-rendered markup *(Low, closed — recorded)*

A dead URL under a public prefix correctly answers **404**, but the response body
contains no rendered content — only an unresolved React Suspense placeholder:

```html
<body><div hidden=""><!--$?--><template id="B:0"></template><!--/$--></div>
```

69 characters of markup, against 6,133 on the homepage. The words "Page not
found" appear exactly once in the response, escaped inside the JSON flight
payload — never as HTML. Confirmed on two separate dead URLs.

So the 404 page is blank until JavaScript loads and hydrates it.

**Scope checked, and it is narrow.** All 17 public pages were measured and every
one ships real markup (6 KB–92 KB). This is specific to the not-found path, not
systemic.

**Severity, honestly.** Visitors with JavaScript — effectively all of them — see
the correct page after hydration, and the HTTP status is already correct, so the
SEO impact is minimal. The cost is a blank screen on a slow connection and
nothing at all without JS. Recorded with evidence rather than fixed, because the
fix touches how `not-found.tsx` resolves translations and the payoff is small;
worth doing deliberately rather than as a drive-by.

## F13 — Unknown top-level paths redirect to login *(By design — no change)*

`/nope` answers **307 → `/login?redirect=%2Fnope`** rather than 404. Paths under
a known public prefix behave correctly: `/blog/nope`, `/features/nope` and
`/customers/nope` all return 404.

The cause is the middleware's allowlist: a path that is not public is treated as
a protected app route. **That is the correct posture** — failing closed is what
keeps an unlisted route from leaking, and the entire `/api/contact-center` and
assistant-bridge history on this codebase is about routes that were *missing*
from an allowlist. The cost is that a typo'd marketing URL lands on a login page
and search engines see a soft 404 instead of a hard one.

Deliberately **not changed**: trading fail-closed routing for a nicer typo
experience is a bad exchange, and weakening auth routing is off-limits. Recorded
so the trade-off is known rather than rediscovered.

---

## F14 — Nine sitemap URLs declare themselves non-canonical *(Low, fixed on main by #526)*

**Not my find.** A parallel audit session raised it on
[#526](https://github.com/NewWorldVenture/Bubaly/pull/526); I verified it
independently before recording it:

```
GET /blog?category=Parenting          -> 200
     <link rel="canonical" href="https://www.bubaly.com/blog"/>
```

`app/sitemap.ts` emits one entry per blog category — 9 of them. Each answers 200
but names `/blog` as its canonical, so the sitemap asks Google to index URLs the
pages themselves declare are not the canonical version. A sitemap entry and a
canonical pointing elsewhere are a contradiction; the entries are dropped from
the index and the crawl budget is spent anyway.

Same family as F1 — the sitemap claiming something the site does not support —
and it is in this audit's scope. I missed it: I checked whether sitemap URLs
**resolved**, which they do, and never checked whether they were **indexable**.
Worth naming as a gap in my method, not just a gap in the sitemap.

**Deliberately not fixed here.** #526 rewrites the same file with a broader
`canonicalUrl()` — trailing-slash normalisation, per-segment percent-encoding,
and refusal of query strings, fragments, non-relative paths and anything
`robots.txt` disallows, reading that disallow list from `robots.ts` so the two
cannot drift. That is a better fix than a second patch of mine would be, and two
PRs rewriting `app/sitemap.ts` in different directions helps nobody.

### Overlap with #526, stated plainly

#526 independently found and fixed F1 (the 435 dead seed URLs) and F3 (the
duplicate homepage). Its approach is broader on URL hygiene; mine has one
property worth preserving in whichever lands second — `isAdvertisablePlatformPath()`
applies **the same predicate the renderer uses** (`isSyntheticBlogSeedSlug`), so
the sitemap and the blog page cannot drift apart again, which is the root cause
F1 actually had.

The rest of this branch — robots coverage, the seeded customer stories, the
missing `<h1>`s, the brand-doubled titles — does not overlap #526 at all.

---

## F15 — Family Autopilot ran for every family on the platform *(High, fixed)*

F7 closed a gate that existed on the Contact Center screen and nowhere in the
pipeline behind it. That is a shape, not an incident, so every paid feature was
re-checked for it. Autopilot had the same one, and worse consequences.

`/dashboard/autopilot` is `requireFeature`-gated, and `resolveAutopilotSuggestionAction`
re-checks the tier before it writes. Both are correct. But the two things that
actually *run* Autopilot checked nothing:

| Entry point | Guard it had |
|---|---|
| `GET /api/cron/autopilot-scan` | none — `from('families').select('id').limit(5000)`, then scan each |
| `POST /api/autopilot/scan` | `requireUserContext()` — a session, not an entitlement |

So the nightly cron ran the full Plus feature for every family on the platform.
`runAutopilotScan` is not a read: for a family that never bought it, it

- wrote behavioural traits to `family_digital_twin_profiles`,
- auto-created `reminders` rows and `grocery_items` (the "auto-executed" path),
- inserted `autopilot_suggestions`, and
- sent push/email through the notifications service.

The gating made that worse rather than safer. A Free family got reminders and
shopping-list entries they did not create, and notifications about them — then
could not open `/dashboard/autopilot` to see where any of it came from, because
the page redirects them to billing, and could not dismiss a suggestion, because
the action returns `accessDenied`. The only surface that explained the writes was
the one they were refused.

### The fix — one resolver, not a fourth copy

`requireFeature` could not be reused here: it resolves the caller's session and
then throws a `redirect`, which a cron has neither of. That is exactly why every
pipeline that *did* check had hand-rolled its own copy of "tier → level →
compare" — `lib/server/ai-access.ts`, `lib/services/trips/confirmation-import.ts`
and `lib/services/onboarding-calendar/access.ts` each hold a different one — and
why the two above simply skipped it.

So the resolution moved into `lib/server/feature-entitlement.ts`, and
`requireFeature` became a wrapper over it. The page guard and the pipelines now
compute entitlement with the same function; they cannot drift again without
someone deleting the call.

Both entry points now refuse, and the interesting part is what they do when the
plan cannot be *read*. `resolveFamilyPlanLevel` throws on a failed subscription
read, and an unreadable plan is not an unentitled family — the F7 lesson,
applied again:

- the cron counts it as a **failure** for that family (502 overall), never a
  skip, so a subscription blip cannot silently stop Autopilot for a paying
  family while the run reports success;
- the route answers **503**, not 403, so a paying family is never told they need
  to upgrade to something they already bought.

### Proof, not a green test

`tests/autopilot-plan-gate.test.ts` drives both real routes against an in-memory
database holding one Free and one Plus household, and asserts which family ids
`runAutopilotScan` was handed. Four mutations were applied to confirm the
assertions bite — the cron gate, the route gate, "unreadable plan → skip", and
"unreadable plan → 403" — and each failed the suite before being reverted. The
one source-reading case in the file is the one claim that *is* about source:
that `requireFeature` no longer holds its own copy of the comparison.

## F16 — Paid features enforced only by the sidebar padlock *(High, fixed)*

The sidebar already refuses every paid feature to a family below its tier.
`featureAccessByTier` returns `'locked'`, and `NavEntry` then renders a padlock
and an upgrade prompt **instead of a link** — never a dead link, deliberately.
So the product tells a Free family, in the UI, that they do not have these.

**24 of the 62 paid features did not check on the server.** Each page called
`requireUserContext()` and rendered. Typing the URL was the entire bypass.

| Tier | Pages |
|---|---|
| Plus | `/dashboard/family-automation`, `family-cfo`, `family-coo`, `family-digital-twin`, `family-emergency`, `family-health`, `family-operations`, `family-school`, `family-stress`, `/missions` |
| Basic | `/dashboard/activity`, `announcements`, `assistant`, `concierge`, `concierge/runs`, `insurance`, `kitchen`, `memories`, `migrate`, `pets`, `readiness`, `social`, `trip-intel`, `/referrals` |

Part of this was already known and written down — `docs/AI_FAMILY_OS_IMPLEMENTATION_MAP.md`
records "Tier/allowance enforcement for AI | **missing** | … no `requireFeature`
on either page" — but only for the two AI pages, and it had not been connected
to the other 22.

### It was not only reading

`lib/family/actions.ts` is the generic write path for eleven family tables. It
checked the signed-in user and, for sensitive tables, the member's role. It did
not check the plan. So a Free family could **write** Plus-feature data:
automation rules, emergency plans and contacts, stress signals, and behavioural
profiles in `family_digital_twin_profiles`.

Nine of those eleven tables now resolve to a feature and are gated through the
same `resolveFeatureEntitlement` the pages use. Two are not, and the omission is
deliberate and commented rather than silent: `family_ai_recommendations` and
`family_milestones` are each rendered by several pages that are not catalog
features at all, so there is no one feature a write to them belongs to, and
guessing would gate a surface nobody decided to gate.

Three further choices worth stating, because each could reasonably have gone the
other way:

- **Delete is not gated.** A family that drops a tier keeps the right to remove
  rows they made. Access is gated; ownership is not.
- **`setRecommendationStatus` and `resolveAutomationRun` are not gated.** Both
  resolve an item that already exists rather than create new use of the feature,
  and gating them would strand a downgraded family's pending items.
- **Super-admins bypass**, exactly as they do on the page, so preview still
  works.

### Two tiers that were themselves the mistake — now free

`/dashboard/migrate` ("Switch to Bubaly", the competitor-import wizard) and
`/referrals` (refer-a-friend) were both Basic in the catalog. The sidebar had
always shown them locked to a Free family, but nothing enforced it until the fix
above — so the day enforcement arrived, a Free family lost the wizard that brings
their data across from a competitor and the page that refers a friend.

Raised here as "the fix is the tier, not the gate", and the owner made that call
on 2026-09-13. **Both are `free` now.** An on-ramp you have to buy before you can
use it is not an on-ramp, and a referral programme switched off for everyone who
has not paid refers nobody.

The `requireFeature` calls stay on both pages. At the free tier they pass
everyone, and if either tier ever moves back, enforcement follows without anyone
having to remember those two pages exist. That is the whole point of the fix: the
tier is now the only thing that decides, and it is one line.

### Proof

`tests/paid-features-enforced-server-side.test.ts`. The sweep is derived from
the catalog rather than a list, so a new paid feature added without a guard
fails it. Comments are stripped before matching — a JSDoc mentioning the guard
is how the F11 sweep went vacuous once already — and one case proves the
detector itself by pointing it at a page that genuinely has no guard. The write
path is exercised for real against an in-memory database: a Free family is
refused and nothing is written, a Plus family's identical write lands, and an
unreadable plan produces a *different* message, because telling a paying family
to buy what they already own is the failure mode that matters.

Three mutations were applied and each failed the suite before being reverted.

## F17 — The documented tier map disagreed with the enforced one *(Medium, fixed)*

`ROUTE_PLAN_LEVEL` in `lib/constants/plans.ts` maps 58 routes to a minimum plan
level. Nothing reads it — `docs/AGENT_HANDOFF.md` says so outright
("`ROUTE_PLAN_LEVEL` is documentation only"). It was maintained by hand.

Of the 55 routes it shares with the enforced catalog, **19 disagreed** — a third
of the table. Not marginally, either: it documented `/dashboard/rewards`,
`/dashboard/sports`, `/dashboard/home` and `/dashboard/briefing` as *cheaper*
than they are enforced, and `/dashboard/chores`, `/dashboard/meals`,
`/dashboard/school` and six others as *dearer*.

That matters because three other documents cite it as fact —
`MARKET_DOMINATION_AUDIT.md` twice, `STRATEGY_WORK_QUEUE.md` once, and
`AI_FAMILY_OS_IMPLEMENTATION_MAP.md` builds an argument on
`ROUTE_PLAN_LEVEL['/dashboard/assistant']=0`. A stale table nothing executes is
still read by people, and by whoever writes the next audit.

The catalog routes are now **derived** from `FEATURE_CATALOG`, so they cannot
drift again. Only the five routes that are not catalog features at all
(`/dashboard`, `/dashboard/settings`, `/dashboard/billing`, `/dashboard/trust`,
`/dashboard/relationship`) are still stated by hand, because the catalog has
nothing to say about them. A test pins that the derivation stays derived: adding
a hand-written entry that contradicts the catalog fails it.

## F18 — Endpoints behind gated pages had no gate *(High, fixed)*

Thirty-nine routes live under `/api/ai`. Every one of them calls a model, which
is the only surface in this application that costs money per request. Of those:

| Guard | Count |
|---|---|
| `assertAIAccess` — feature, tier **and** the monthly allowance | 4 |
| `authenticateAI` — identity only; it resolves a caller and stops there | 5 |
| a hand-rolled `resolveFamilyPlanLevel` comparison | 4 |
| a session and a per-minute rate limit, and nothing else | **26** |

The second row is worth reading twice: `authenticateAI` sounds like the gate and
is not one. Two of the five routes that rely on it — `ai/voice/speak` and
`ai/voice/transcribe` — are model calls.

Fourteen of those 26 sit directly behind a page that `requireFeature` refuses.
`/api/ai/resolve-conflict` serves `/dashboard/conflicts` (Plus).
`/api/ai/briefing` serves `/dashboard/briefing` (Plus). The page refused; the
endpoint behind it did not, and a `fetch` is not harder to send than a URL is to
type.

Each mapping was established by finding the component that calls the endpoint
and the page that hosts it, not by matching names:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `ai/resolve-conflict` | `family/conflict-resolver` | `/dashboard/conflicts` (Plus) |
| `ai/briefing` | `lib/briefing/cache-isolation` | `/dashboard/briefing` (Plus) |
| `ai/assist`, `ai/import` | `modules/inbox-module`, `modules/concierge-module` | `/dashboard/inbox`, `/dashboard/concierge` |
| `ai/chef` | `modules/kitchen-dashboard` | `/dashboard/kitchen` |
| `ai/flyer` | `modules/scan-module` | `/dashboard/scan` |
| `ai/health/coach` | `modules/health-module` | `/dashboard/health` |
| `ai/home/diagnose`, `find-pro`, `forecast` | the three `home/*` clients | `/dashboard/home` |
| `ai/home/utility-savings` | `modules/utilities-module` | `/dashboard/utilities` |
| `ai/savings` | `modules/savings-coach-card` → `subscriptions-module` | `/dashboard/subscriptions` |
| `ai/trip` | `modules/trip-intel-module` | `/dashboard/trip-intel` |
| `ai/auto/accident` | `auto/accident-client` | `/dashboard/auto` |

The same sweep run outside `/api/ai` found six more, most of which also call a
model:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `behavior/insight` | `modules/behavior-module` | `/dashboard/behavior` |
| `weekend/discover` | `modules/weekend-module` | `/dashboard/weekend` |
| `vacations/ai`, `vacations/weather` | `vacations/trip-concierge`, `trip-weather` | `/dashboard/vacations` |
| `social/ai` | `social/studio-form` | `/dashboard/social` |
| `notifications/generate` | `modules/notifications-module` | `/dashboard/notifications` |

All twenty now refuse through `refuseUnlessEntitled`, which resolves through
the same function the page does. The refusal happens **before the rate limiter
and before the provider call**, which the tests pin explicitly: a gate placed
after the model would refuse the family and still have paid for the answer.
`ai/assist` is served by two modules, so it accepts either — requiring both
would refuse someone the page in front of them allows.

Two more were checked and deliberately left alone. `/api/paperwork/capture` and
`/api/paperwork/link` are reached from `/capture`, which is not a catalog
feature, so there is no one feature a call to them belongs to — the same
reasoning that left `family_milestones` open in F16. `/api/assistant` and
`/api/assistant/alexa` are unauthenticated **by design** and correctly so: the
token is the authorization (like the ICS feeds), they rate-limit by IP *before*
the token lookup so the endpoint cannot be used to guess tokens at speed, and
the Alexa one verifies Amazon's signature and answers a bare 403 when it cannot
be proven — with no speech, so a prober learns nothing.

One near-miss worth recording. `components/marketing/switching-band.tsx` appears
in a grep for `/api/ai/flyer`, which looked for a moment like a public marketing
component calling an authenticated AI endpoint. It is a comment citing the route
as evidence that a claim in the copy ships. Checked before it was written down.

`/api/ai/gift` is genuinely public and is *correct*: documented as such,
IP-rate-limited both in memory and durably, scoped to one already-secret gift
token, and read-only. It is the model the other routes should have followed.

## F19 — Most AI endpoints run unmetered *(Medium, open — a pricing decision)*

F18 fixed *entitlement*. It did not fix *metering*, and the two are different
questions.

`lib/server/ai-access.ts` defines `AI_MONTHLY_ALLOWANCE` per plan level and
enforces it — for the **4** routes that call `assertAIAccess`. The other 35 have
at most a per-minute rate limit, which bounds a burst, not a month. A family on any
tier can call `/api/ai/chef`, `/api/ai/meals/plan`, `/api/ai/journal`,
`/api/ai/notes` and twenty more as often as they like, all month, and each call
is a paid model request.

This is **not** written up as a defect to fix, because the fix is a pricing
decision and both directions cost something:

- **Meter them all against the existing allowance.** Simple, consistent, and it
  changes what paying customers can do today — a Basic family that uses the meal
  planner daily would start hitting a wall it has never hit.
- **Meter only the expensive ones.** Truer to cost, and needs per-route budgets
  nobody has set.
- **Leave them unmetered** and accept the exposure, which is what happens now,
  but deliberately rather than by omission.

What is *not* a live risk: every one of these routes requires a session, a
family, and now — where the page is gated — an entitlement. The exposure is a
signed-in family's own usage, not the open internet.

Twelve of the 26 unguarded routes were left ungated by F18 on purpose: they
serve features that are Free (`ai/journal`, `ai/habits`, `ai/meals/plan`,
`ai/notes`, `ai/schedule`, `ai/relationship`, `ai/pantry-chef`), or they fan out
across a dozen modules and would need a per-`kind` mapping (`ai/insights`), or
they are the assistant itself (`ai`, `ai/chat`). For those, metering — not
entitlement — is the right instrument, which is exactly the decision above.

The numbers an owner needs are here; the choice is theirs.

## F20 — A child could clear the chore board *(High, fixed)*

The plan sweeps asked who may use a feature. This one asks who may use it
*within* a family, and it is the same shape with a different subject.

The chores board has four manager-only writes. Two were defended and two were
manager-only on the screen alone:

| Board action | UI | Server |
|---|---|---|
| Approve a submission | `manager &&` | ✅ trigger `chore_assignment_decision_guard` (0223) |
| Pay a chore reward | `manager &&` | ✅ `isManager` in `payChoreRewardAction` + manager-only wallet RLS (0217) |
| **Add a chore** | `manager &&` | ❌ nothing |
| **Delete an assignment** | `manager &&` | ❌ nothing |

Nothing behind the screen agreed. The actions took any signed-in member,
`createChore` and `deleteChoreAssignment` scope by family and not by role, and
the RLS on `chore_assignments` is `is_family_member` for **all four**
operations (migration 0004 applies one membership-only policy set across 21
family tables). So a child could delete any chore on the board — including one
assigned to them — and mint chores assigned to a sibling, with points.

### Why this is the gap and not the design

The team had already reasoned about exactly this class. Migration 0223 closed
`update chore_assignments set status='approved'` by a child, and its own header
calls it "an accountability/integrity forgery, not a money-minting one", the
sibling of the `chore_submissions` forge closed in 0222.

Deleting the assignment reaches the same end from the other direction. A child
who cannot forge *completion* can simply remove the row: the chore is gone from
the board, and so is the record that it was ever owed. Closing one and not the
other is not a decision anyone made — 0223 enumerates the statuses a member may
drive and never mentions the delete.

### The fix, and where it sits

`isManager` in the two server actions, refusing before the service is reached.

The action layer rather than the service, for two reasons. It is where the
screen's claim lives; and it is where `payChoreRewardAction` — the board's third
manager-only write, and the one that moves money — already puts it, so the
board's writes now check in one consistent place. The service stays reachable by
the assistant's path, which the Trust Engine governs separately and which this
audit did not examine.

**Defence in depth is the right follow-up and is deliberately not in this
change.** The repo's own pattern (0222, 0223) is a database trigger alongside the
code check, and a `can_manage_family()` guard on delete would be its natural
sibling. But the migration ledger is the subject of F5: the baseline is
unrepaired and the workflow cannot authenticate, so adding a migration that
cannot be applied would enlarge a backlog that is already blocked. It belongs
with the operator who fixes F5, and is recorded here rather than half-done.

### The open half: who may advance a status

`ChoreRow` carried the comment *"Assignee can advance their own chore's status;
managers can act on any."* Neither half was true. The control renders for every
member regardless of assignee, and `setChoreProgress` scopes by family only — so
any member can advance any chore, including submitting a sibling's chore they
did not do.

That comment is now corrected to say what the code does, rather than the rule
being implemented quietly. Enforcing "assignee, or a manager" is a product
decision: it is a real restriction on a board families may drive
collaboratively, and unlike the delete there is no screen-level claim being
violated — the UI and the server already agree. It needs an owner's call, not a
patch.

### Three candidates checked and cleared

Run against every component that gates UI on `isManager`, the same sweep also
looked at:

- `setLocationSharing` — no role check, and **correct**: it writes only the
  caller's own `member_locations` row. A member turning their own sharing off is
  the point.
- `saveAISettingsAction` — no role check in the action, and **correct**:
  `updateAISettings` refuses a non-manager in the service, one layer down.
- `savePlace` / `deletePlace` / `setGeofenceEnabled` — already `isManager`-gated.

Recording what the sweep cleared matters as much as what it caught: three of the
four plausible instances were already right.

## Reconciliation with #526 — how the sitemap findings actually landed

#526 merged to `main` as `61ad4bb0` while this branch was open, and it rewrote
both files this audit touched. The overlap was predicted and written down before
it happened; this records the outcome.

**F1 and F3: #526's implementation won, and mine was withdrawn.** Its rule is
stronger than the one I shipped. I filtered the registry's `/blog` rows through
the same predicate the renderer uses; #526 observes that the `marketing_pages`
registry is a **path overlay** — a row decorates a path, it is not a claim that
the path resolves — and so lets a registry row mint a URL only for a prefix the
registry itself renders. `/blog` is served from `blog_posts`, so no registry row
can publish a `/blog` URL at all.

That **subsumes** the seed filter rather than duplicating it: if none can
publish a blog URL, none can publish a wrong one. My `isAdvertisablePlatformPath`
and `canonicalSitemapUrl` are deleted; `canonicalUrl()` and
`isRegistryRenderedPath()` do the work, and also cover percent-encoding, query
strings and fragments that mine did not.

One of my tests asserted the behaviour I had built — that a *real* blog path from
the registry is still advertised. Under #526 that is deliberately false. The case
is rewritten to assert the new rule and to say why it inverted, rather than being
deleted.

**F2 was not covered by #526, and still is not.** It kept the four-entry list
(`/dashboard`, `/onboarding`, `/api`, `/auth`). The 20 missing authenticated
surfaces are still this branch's finding, and the fix is now **better placed than
where I first put it**: #526 moved the disallow list into
`lib/marketing/sitemap-urls.ts` and made `canonicalUrl()` refuse any URL beneath
it, so robots and the sitemap cannot contradict each other. Expanding that shared
constant to all 24 surfaces therefore fixes robots **and** stops the sitemap from
ever listing them.

That coupling introduced one hazard worth pinning: the matcher is `=== p` or
`startsWith(p + '/')`. A looser `startsWith(p)` would now drop the **public**
`/family-display` from both robots and the sitemap, because `/family` and
`/display` are both on the list. Verified empirically and pinned by its own test.

---

## Verified healthy (no action)

| Area | Evidence |
|---|---|
| Security headers | CSP with `frame-ancestors 'none'` and `object-src 'none'`, HSTS `max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restricting camera/mic/geolocation to self |
| Public routes | 21 public routes probed; all 200 except the two noted below |
| `/onboarding` 307 | Correct — gated, redirects to login |
| `/resources/benchmarks` 404 | **By design.** Gated on an admin publication flag so an unpublished page is indistinguishable from one that never existed. The sitemap already refuses to list it unless published. Not a defect |
| Page metadata | All 17 public pages carry a real `<title>`, description and canonical. An earlier reading that `/how-it-works` and `/login` had none was **my own extraction bug**, re-checked and withdrawn — both are correct |
| API boundary | Every public-allowlisted API route refuses an unauthenticated request: contact-center email 401, sms/voice/transcription 401 each (with provider-shaped bodies), assistant 401, alexa 403, stripe webhook 400, forms 422. Nothing answered 200 with data |
| Production revision | `/api/build-info` reports `f9c4d7a1…`, matching `main` — production is current |
| Typecheck | `tsc --noEmit` clean |
| Lint | 0 errors (2 pre-existing `exhaustive-deps` warnings, untouched) |
| Test suite | 1,150 files / 13,102 tests passing |
| Security headers | see above — CSP, HSTS, frame/nosniff/referrer/permissions all present |
| Domain redirects | `http://bubaly.com`, `https://bubaly.com` and `http://www.bubaly.com` all 308 to `https://www.bubaly.com`; trailing slash 308s to the canonical path. An initial `000` reading on the apex was a transient blip — it resolved cleanly on all three retries, so it is not reported as a finding |
| Accessibility basics | one `<h1>` per page (after F11), all images carry `alt`, `lang` set, skip link present, single `<main>` landmark |
| Server-rendered content | all 17 public pages ship 6 KB–92 KB of real markup; only the 404 path does not (F12) |
| Programmatic SEO routes | `/compare`, `/guides`, `/alternatives`, `/audiences`, `/questions`, `/glossary` render from `marketing_pages` and simply have no published rows yet — feature built, content pending. Not a defect |
| Unresolved work markers | 38 `TODO`/`FIXME` in source; the substantive ones are migration-gated and explicitly marked "owner approval required", i.e. blocked behind F5. None independently closeable |
| Health endpoint | `status: ok` — env, database ~98ms, auth ~90ms, serviceRole ~508ms |
| Auth gating | All 20 authenticated segments answer 307 to `/login` when signed out |

## What remains, and who owns it

Nothing here is unexamined. Each item is closed with a decision or assigned to
someone who has access this session does not.

| Item | Owner | Next step |
|---|---|---|
| **F5** Supabase migration workflow | Operator | The access token or project ref lost its privileges some time after 2026-09-07. Restore it, **then** repair the ledger baseline — the gate throws by design until `0004` is recorded, and that is explicitly a credentialed operator action. `docs/PENDING_PROD_MIGRATIONS.md` claimed "connectivity works" until this audit corrected it; it now states the failure and that fixing the token alone is not sufficient |
| **F6** Family email routing | Operator | Step-by-step in [`docs/runbooks/family-contact-center-routing.md`](docs/runbooks/family-contact-center-routing.md) — written during this audit because none existed. Set `CONTACT_CENTER_INBOUND_SECRET` in Vercel, redeploy, point `bubaly.com` MX at an inbound-parse provider aimed at `/api/contact-center/email?key=…`. Until then the webhook correctly answers 401 |
| **F10** Seed rows in the database | Operator | The site no longer renders them. Deleting the three `case_studies` rows is a Super Admin action |
| **F9** i18n payload | Engineering | Design settled, safety proven, and the mechanism now needs no middleware or restructure — a nested provider in `app/(app)/layout.tsx` with a 702-key (44 KB) root set. Three named keys to cover first. Needs one person to confirm a marketing page renders in a browser, which this environment cannot do |


## Dependency security — closed, nothing to fix

`npm audit` reports 8 advisories (3 moderate, 5 high). **None of them affect
bubaly.com**, and that was checked rather than assumed: every package was
resolved against the production dependency tree.

| package | in production tree |
|---|---|
| `js-yaml`, `tar`, `brace-expansion`, `browserslist` | no |
| `@xmldom/xmldom`, `vitest`, `@vitest/mocker`, `baseline-browser-mapping` | no |

`npm audit --omit=dev --audit-level=moderate` — the exact command CI runs —
reports **0 vulnerabilities**. All 8 are build and test tooling that never
reaches the deployed artifact.

So there is no site finding here. Upgrading the dev toolchain is ordinary
maintenance, not audit remediation, and worth noting it cannot be done casually:
`npm audit fix` cannot even produce a plan on this tree (it exits with an
internal npm error), so it would mean a hand-managed lockfile rewrite against a
13,000-test suite for no change to what users run.

## Method, and what it could not reach

Findings were established by probing the live site and reading the real code
path, then reproduced before being recorded. Each fix was checked for
non-vacuity by reverting it and confirming the new tests fail.

That discipline paid twice, and both are recorded rather than quietly corrected:

- **A finding withdrawn.** An early reading that `/how-it-works` and `/login`
  shipped no title, description or canonical was my own extraction bug. Both are
  correct. Re-checked and struck.
- **A vacuous test caught.** The first version of the F11 sweep passed with the
  fix reverted, because the JSDoc it was testing contains the literal `as="h1"`.
  Found by reverting a page and watching the test stay green — the same failure
  as F4, in the fix for F11.

**One limitation worth stating plainly, so nothing above is over-read.** No
browser could run in this environment. Chromium launches but every navigation
dies inside the agent proxy relay (`ws_closed_mid_exchange`, 39 bytes received)
for *every* host, including `www.google.com` — so it is the relay, not the site.
`curl` through the same proxy works, and every finding above rests on that or on
the code.

So the following were **not** checked and are not claimed: client-side console
errors, hydration behaviour, visual layout and responsive rendering, and
interactive flows (forms, the consent manager, the language picker). A local
production server was started to close the gap and reproduced the routing
behaviour, but could not exercise data-backed pages — without real Supabase
credentials they answer 500 before reaching the code under test.

This is also the single reason F9 is a decision rather than a fix: its entire
risk surface is hydration, which is precisely what could not be exercised here.

---

# Pass B — Data layer (F-001–F-019)

A running, evidence-based audit of bubaly.com. Every entry records what was
checked, **how**, and what the check actually returned. Nothing is marked closed
on reasoning alone — a finding closes only when a command, probe, or rendered
page demonstrates it, and wherever a fix is claimed the check was also run
against the broken state to prove it was not passing vacuously.

- **Audit head:** `ed85df8a` (main, after Pass A's fixes) + this pass
- **Scope:** 395 pages · 140 API routes · 306 migrations · 1,170 unit-test files
- **Environment:** full local Supabase stack (all 306 migrations replayed), seeded
  anchor household, real browser sign-in.

Two entries in this file record the audit correcting *itself*: F-011 (the helper
written to fix silent truncation had the same defect) and F-015 (a probe granted
itself privileges and left them, so the suite's answer depended on what ran
before it). Both were found by re-checking a closure rather than trusting it, and
F-002 records reasoning that was wrong and what replaced it.

---

## 1. Status summary

| Area | Check | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ clean |
| Lint | `next lint` | ✅ 0 errors (1 pre-existing warning) |
| Unit tests | `vitest run` | ✅ 13,518 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 307 files, no collisions |
| Migration replay | fresh DB, 0 → 307 | ✅ all applied, 0 failed |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 14 probes, fresh 307-migration replay, run 2× | ✅ 14/14 each time (F-015 made it repeatable) |
| Authenticated routes | 353-route crawl | ✅ 351 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
| E2E | 108 specs + 2 gated journeys | ✅ all pass (a journey caught F-006) |
| Nightly jobs | all 11 cron routes exercised end to end | ✅ clean (F-008, F-009, F-010, F-014) |
| Whole-table reads | live PostgREST, 3 real tables | ✅ complete and distinct (F-008, F-011) |
| Row-ceiling honesty | scan of `app/` + `lib/` | ✅ 0 limits above the cap (was 59 — F-013) |
| Notification dedupe | 5 cron runs, duplicate-group count | ✅ no new duplicates (F-014) |
| Public sitemap | 1,049 published posts vs the served file | ✅ 1,049 listed (was 1,048 — F-012) |
| Calendar-day correctness | day keys vs DATE columns, 9 zones | ✅ family zone on every user-facing surface (F-017) |
| Query plans | family-scoped reads at 700k rows | ✅ index scan, was a full scan (F-018) |
| Money under concurrency | 2 simultaneous auths vs one balance | ✅ exactly 1 approves (F-019) |
| Production DB | migration ledger | ⚠️ **blocked — F-001** |

---

## 2. Open findings

### F-001 · Production migration ledger records only `0001–0003` — owner action

**Severity:** high · **Status:** OPEN, cannot be closed from a sandbox
· **Same wall as Pass A's F5**, reached from the database rather than from CI

Production carries 439 tables and 957 policies but a three-row ledger. Every
push to `main` therefore halts at the baseline guard in
`scripts/audit-production-migration-state.mjs` before `supabase db push` runs:

```
{"migrationVersions":["0001","0002","0003"],"tableCount":439,"policyCount":957,
 "requiresBaselineReview":true,"moneyWrites":{"exploitable":false}}
Existing production policies have no recorded baseline migration 0004.
Historical replay is blocked... Repairing it is a credentialed operator action.
```

The guard is correct — it is what keeps the held `0240–0254` bundle
(`docs/PENDING_PROD_MIGRATIONS.md`, unresolved requester-privacy findings) from
auto-applying. **Consequence:** every migration from `0276` on, including
**`0290` below**, replays cleanly in the repo but is *not applied to
production*. Needs an operator following `docs/runbooks/LB-016-…md` §4.

F-001 is the only finding still open. Everything else in this file closed with a
command, probe, or rendered page behind it.

**What this means for what actually shipped.** The code for every fix here is on
`main`. The four migrations are not, and cannot be until an operator runs them,
so two closures are only half-live in production:

| Fix | Code on `main` | Needs migration | State in production until an operator runs it |
|---|---|---|---|
| **F-010** `notifications.related_id` is a key, not a uuid | — | **`0293`** | The column is still `uuid`, so the generic notification pass still rejects every composite dedupe key |
| **F-014** dedupe read batched | ✅ | depends on `0293` | The batching is live, but the read it protects cannot succeed until `0293` lands |
| **F-003** `anon` write grant on the money tables | — | **`0290`** | Still open in production |
| **F-006** privileged-RPC lockdown re-asserted | — | **`0292`** | `0253`/`0204` may still be undone later in the chain |
| Everything else (F-002, F-005, F-007–F-009, F-011–F-013, F-015, F-016) | ✅ | none | Fully live |

The `Supabase production migrations` workflow fails on every push for the reason
Pass A's F5 records, so this is not a matter of waiting — it needs the operator
action in both F5 and F-001. Agents must not apply migrations to production
(`docs/PENDING_PROD_MIGRATIONS.md`), and this one did not.

---

## 3. Closed this pass

### F-002 · Unbounded reads — the survey, and the reasoning in it that was wrong

**Severity:** medium · **Status:** CLOSED (see F-008 and F-013); the honest bound is now enforced, not assumed

243 reads use `.from(...).select(...)` with no `.limit()`, no `.single()` and no
`head:true` count. Classified by what they actually grow with:

- **122 are not family-scoped** — they grow with the whole platform.
- **121 are family-scoped** — they grow with one household.

The genuinely dangerous subset (F-008) is fixed, and a subset this entry had
**wrongly** put in the "accepted" pile is now fixed too — see F-013. The
reasoning that failed was this: a read carrying an explicit `.limit(n)` was
counted as bounded on purpose. For fifty-nine of them `n` was above the server's
row ceiling, which means it was never applied at all; they were unbounded reads
that merely looked deliberate. Re-measuring per family is what exposed it —
single households already hold 6,500 `habit_logs` and 3,709 `graph_entities`, so
"a problem that is not occurring" was not true when this entry was written.

What remains accepted is the reads whose bound is real (`n` at or below the
ceiling) or whose table is small admin/config data. That subset is now guarded
rather than asserted: `tests/no-limit-above-the-row-cap.test.ts` fails on any
`.limit()` above the cap, so the category cannot quietly refill.

---

### F-003 · `anon` held INSERT/UPDATE/DELETE on all five money tables

**Severity:** high (defence-in-depth) · **Status:** CLOSED — migration `0290`

`docs/audit/wallet-write-rls-check.sql` invariant 6 failed against a real
Supabase database:

```
A-08 FAIL: anon holds INSERT on wallet_transactions —
the restrictive guards are `to authenticated` and would not apply
```

The restrictive manager guards from `0254` are `TO authenticated`, and a
restrictive policy only ANDs with requests made **as a role it names** — for an
anonymous request they are simply absent. The grant layer is the only thing
closing that path, and it had never been closed: Supabase's default privileges
grant `arwdDxt` on every new `public` table to `anon`, and no migration revoked
it. All five money tables carried it.

**Not exploitable as found, and `0290` does not claim otherwise.** The only
permissive INSERT policy is also `TO authenticated`, so an anon insert is
refused for want of any permissive policy. Verified directly:

```
set role anon; insert into public.wallet_transactions (...) values (...);
ERROR:  new row violates row-level security policy for table "wallet_transactions"
```

What `0290` restores is the layer that makes that robust: one future permissive
policy written `TO public` — the exact stray shape `0275` had to sweep away —
would otherwise open an anonymous mint path no restrictive guard would catch.
Reads are deliberately left alone; the public gift flow writes through
`createServiceClient()`, so nothing legitimate loses a write.

### F-004 · The money-boundary probe could not catch F-003 in CI

**Severity:** high (false assurance) · **Status:** CLOSED — `pg-bootstrap.sh`

F-003 had been passing in CI for its entire life. `docs/audit/pg-bootstrap.sh`
built its roles by hand and granted `anon` only `SELECT`, so the shim was
**safer than production** — the wrong direction for a boundary harness. The
probe asserted something true of the shim and false of every real database.

The shim now reproduces Supabase's real default privileges, and does it *before*
migrations run, which is when they take effect on a real project — granting
after the migrations would have re-granted exactly what `0290` revokes and
silently undone it.

Proven non-vacuous end to end: re-granting `insert` to `anon` on the shim
reproduces `10/11 passed · FAILED: wallet-write-rls-check.sql`; revoking it
returns `11/11 passed`.

### F-005 · Every blog post not baked in at build time returned 500

**Severity:** high · **Status:** CLOSED

`/blog/none` answered **500** where all twelve sibling content routes answered
404. The server log gives the mechanism:

```
Error: Page changed from static to dynamic at runtime /blog/none, reason: cookies
```

`app/(marketing)/blog/[slug]/page.tsx` declared `revalidate = 3600` with
`dynamicParams = true`, but resolves locale per request through
`getTranslations()` → `cookies()`. Declaring ISR while reading cookies is not a
no-op: Next prerenders the route, sees the cookie read on a later request, and
throws. With `dynamicParams = true` that is a 500 for **every post published
since the last deploy** and for every unknown slug a crawler tries — where 404
is the right answer.

`app/(marketing)/blog/page.tsx` and `app/(marketing)/faq/page.tsx` carry the
same shape; there the served page is the stale prerender and the background
revalidation fails forever, so the page silently stops updating. All three are
now `dynamic = 'force-dynamic'`, which is what a per-request locale actually
means. A sweep confirms no other `revalidate` route reads cookies.

### F-006 · Any signed-in user could claim another household's AI jobs

**Severity:** high (cross-tenant) · **Status:** CLOSED — migration `0292`

`claim_ai_runs` is `SECURITY DEFINER` and scoped to the whole platform, not to a
family. `authenticated` held EXECUTE on it. Acting as an ordinary member of
family A:

```
set role authenticated; set request.jwt.claim.sub = '<member of family A>';
select * from public.claim_ai_runs(10, 60);
-> claimed ids: 00000000-0000-4000-8000-00000000ab01   (a run owned by family B)
```

So any signed-in user could lease AI runs belonging to any other household,
pull them out of the real worker's queue, drive the run state machine across
tenants, and read back the run ids. The same grant was open on
`claim_marketing_generation_jobs` (also to `anon`) and on the three
`loyalty_*` ledger functions.

**This had already been fixed twice.** `0253` revoked `claim_ai_runs` from
public/anon/authenticated and *raised an exception* if the revoke had not taken;
`0204` did the same for the loyalty trio. Both lockdowns were undone later in
the chain: Supabase's default privileges grant EXECUTE on functions straight to
anon and authenticated, so a later `create or replace` (`0263` re-creates
`claim_ai_runs`) hands the grant back. `0253`'s check passed because it verified
**its own moment**, not the final state — which is the only state a database
runs in.

`0292` re-asserts all five at the end of the chain. Verified after the fix: a
member and anon both get `42501 permission denied` through PostgREST, and
`service_role` still executes. The gated E2E journey that asserts exactly this
(`authenticated.spec.ts:150`, "Only the server worker may claim AI jobs") now
passes, having failed before.

### F-007 · The additive-migrations guard flagged a revoke as destructive

**Severity:** low · **Status:** CLOSED

`tests/migrations-are-additive.test.ts` scans for a bare `\btruncate\b`, so
`revoke insert, update, delete, truncate … from anon` in `0290` read as
destructive DDL — though it *removes* the ability to truncate. The guard already
masked one legitimate TRUNCATE (the trigger-event declaration); it now masks the
privilege list of a GRANT/REVOKE too. Both directions are pinned: a revoke is
allowed, and `REVOKE TRUNCATE … ; TRUNCATE TABLE public.history;` is still
rejected, so the mask cannot launder a real statement.

### F-008 · Six nightly jobs silently stopped at 1,000 rows

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

PostgREST answers an unbounded `select()` with at most `db-max-rows` and reports
nothing — no error, no short-read signal. Measured against the live local
project, on real tables, through the real helper:

```
calendar_events  unbounded=1000  readAll=2012  distinct=2012  error=null
graph_entities   unbounded=1000  readAll=3709  distinct=3709  error=null
notifications    unbounded=1000  readAll=1420  distinct=1420  error=null
```

The unbounded read returns exactly 1,000 rows of a 2,012-row table and calls it
the table. `distinct == total` also shows the paged read neither repeats nor
skips a row across page boundaries.

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data:

```
habit_logs        max rows for one family: 6500
pet_care_records                           4000
graph_entities                             3709
calendar_events                            1906
notifications                              1402
```

Six cron jobs read their driving table with no pagination, so past 1,000 rows
each silently did part of its work and reported success:

| Job | Driving read |
|---|---|
| `weekly-digest` | every family |
| `notifications` | every family |
| `push-scan` | every family |
| `chore-reminders` | every open assignment due this week |
| `calendar-feeds` | every subscribed feed |
| `checkout-abandoned` | every pending checkout session |

All six now read through `readAll`. It is deliberately **not** applied where a
bound is correct — an admin list wants a limit, not every row. Nine unit tests
pin the behaviour (see F-011 for the two that matter most).

Verified by running each route end to end against the live stack:

```
weekly-digest        {"sent":0,"failed":1}                        [502]
notifications        {"ok":false,"families":16,"created":100,…}
push-scan            {"ok":true,"families":16,…}                  [200]
chore-reminders      {"sent":0,"failed":1}                        [502]
calendar-feeds       {"ok":false,"feeds":3,"synced":0,"failed":3} [502]
checkout-abandoned   {"pending":0,"abandoned":0,"fired":0}        [200]
```

The 502s are local delivery failures — no real Resend key, fake feed URLs — and
are now *reported* rather than crashing the run (F-009).

### F-009 · A provider error in the mailer took down the whole cron run

**Severity:** high · **Status:** CLOSED — `lib/email.ts`

`sendReactEmail` is typed `Promise<{ ok: boolean }>` and every caller is built on
that: the weekly digest counts a failure per family and moves on. But it only
handled the SDK's `{ error }` return — a *thrown* provider error (network
failure, or a malformed key, which surfaces from inside the client as a bare
`TypeError: b is not a function`) escaped and took the caller with it.
Observed: `GET /api/cron/weekly-digest` → **500**, mid-run, abandoning every
family after the first.

Now wrapped, so the function keeps its contract. After the fix the same route
answers `{"sent":0,"failed":1}` — it completes and reports instead of crashing.
Five unit tests pin it, including the exact `TypeError` shape.

### F-010 · Notification generation failed outright for affected households

**Severity:** high · **Status:** CLOSED — migration `0293`

`notifications.related_id` was typed `uuid`, but three subsystems deliberately
store a **composite dedupe key** in it — that is what the column is for, since
the generic pass skips any candidate whose `(type, related_id, user_id)` already
exists:

```
lib/server/notifications.ts   'moment:<eventId>:<date>'  (so a recurring
                              occurrence pings at most once), 'conflict:<ids>'
lib/services/approvals        .in('related_id', candidates.map(c => c.dedupe_key))
lib/ai/tools/notifications    related_id: z.string().nullish()
```

Postgres rejected every one:

```
Notification generation failed for family 11111111-…:
invalid input syntax for type uuid: "moment:3fd2b8f5-…:2026-09-14"
```

The throw is caught per family, so the cron reported success overall — while
that household received **no notifications at all** from the run, not merely no
moment reminder. Five of sixteen seeded families hit it on one pass.

The column was the outlier: polymorphic, qualified by `related_type`, with no
foreign key and no index, and a read-side helper (`entityIdFrom`) whose job is
to pick the uuid back out of a colon-delimited string. `0293` widens it to
`text` — lossless. Measured before and after on the same cron run:

| | before | after |
|---|---|---|
| uuid errors | 5 | **0** |
| families failing generation | 5 | **0** |
| notifications created | 100 | **117** |
| `push-scan` | 502, `failed: 5` | **200, `failed: 0`** |

---

### F-011 · The fix for F-008 had the same defect it was written to fix

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

Found by comparing `readAll` against `lib/supabase/read-all-pages.ts`, a paging
helper that already existed in the repo and did one thing differently.

`readAll` asked for rows `0–999`, and treated **any page shorter than 1,000 as
the end of the table**. That is only true if the server never returns fewer rows
than the range requests — and returning fewer rows than requested is precisely
what `db-max-rows` does. `db-max-rows` is a per-project setting; 1,000 is the
default, not a guarantee. Against a project set lower, the helper written to
prevent silent truncation reproduced it, and worse — advancing by the range
*requested* rather than the rows *received* also skips the rows in between:

```
table rows:            2011
server cap per page:   500
old loop returned:     500 rows, error=null
households lost:       1511
```

Two rules now hold, and both are pinned by tests that fail without them:

- **Advance by the rows received**, never by the range requested.
- **Stop only on an empty page.** A short page is not proof of the end; it is
  equally the signature of a cap. One extra round trip tells them apart.

A page that reports neither rows nor an error is now a failure rather than an
ending — "no data, no reason" is the exact shape of the truncation being
guarded against.

Three hand-rolled paging loops existed; there is now one. `readAllPages` keeps
its stricter contract (any failure yields *no* rows, so a partial read can never
be mistaken for a household's complete history) and delegates the loop. Its
pre-existing test — *"continues when a server returns fewer rows than the
requested range"* — passes unchanged against the shared implementation, which is
what proves the contract survived consolidation.

### F-012 · The sitemap search engines read was six days stale, and would have stayed stale for a year

**Severity:** high · **Status:** CLOSED — `lib/blog/posts.ts`, `app/sitemap.ts`
· Distinct from Pass A's F1/F3/F14, which were about *which URLs* it listed;
this is about the file being a stale copy. Both fixes are in the current file.

The live sitemap listed **1,048** blog URLs. The database held **1,049**
published posts. One article was simply absent from the file search engines use
to discover content.

It was not a paging bug, an RLS bug, or a missing row. `app/sitemap.ts` was
prerendered, and Next patches `fetch`: for a route it prerenders, the response
goes into the build Data Cache under the route's revalidate. The route declared
none, so the entry was written with Next's "forever" value and no tag able to
clear it. Decoded straight out of `.next/cache/fetch-cache`:

```
url:        …/rest/v1/blog_posts?select=slug,title,excerpt,…&published=eq.true
rows:       1000                     (a second entry held the remaining 48)
revalidate: 31536000                 ← one year
tags:       []                       ← nothing can revalidate it
written:    2026-09-07 23:50
```

1,000 + 48 = the 1,048 in the shipped sitemap. A build on **2026-09-13** served
its blog list from entries written **six days earlier**, and Vercel restores
`.next/cache` between deploys — so redeploying would not have fixed it. Every
article published from that day on would have been invisible in the sitemap for
a year. On a site whose organic surface *is* its blog, that is the whole point
of publishing.

Why it stayed invisible: `getAllPosts` ended in a bare `catch { return []; }`.
The failure had no voice.

Fixed in three parts, each verified:

1. **The reads leave the cache.** The blog's Supabase client passes its own
   `fetch` with `cache: 'no-store'`, so every query this module makes is
   covered — not just the one that was noticed. The blog pages themselves are
   `force-dynamic`, so nothing there was ever cached and nothing there changed.
2. **The route says what it is.** `export const dynamic = 'force-dynamic'` on
   `app/sitemap.ts`. `no-store` alone already forced this, but only by *throwing*
   during Next's trial static render — which is how the third part surfaced.
3. **The catch stops swallowing framework control flow.** `unstable_rethrow(error)`
   runs before the fallback in both readers. Next signals "this route cannot be
   static" by throwing out of the fetch; swallowing it hands Next an empty
   article list and lets it prerender and ship that. It had in fact already
   written such an artifact — a 4,055-byte sitemap with no posts in it.

Because the route now renders per request, it also stopped reading what it does
not use: `getAllPostRefs` selects `slug, published_at` instead of all thirteen
card columns — kilobytes per crawl instead of about a megabyte.

Before and after, against the running production build:

```
before   1048 blog <loc>   audit-fixture-post absent    227,217 bytes
after    1049 blog <loc>   audit-fixture-post present   227,389 bytes, 141–226 ms
```

Also fixed while here: `published_at` alone ordered the paged blog read, and
**717 of the 1,049 published rows share a date with another row**. Two pages are
two separately planned queries, so a tied boundary is free to move between them
— repeating one row and dropping another. The read now orders by
`published_at, slug`.

Four tests pin all of it, and **three of the four fail** when the fix is
reverted (`cache: 'force-cache'`, no `force-dynamic`, no `unstable_rethrow`) —
so the guard is not passing vacuously.

### F-013 · Fifty-nine reads asked for more rows than the server would ever return

**Severity:** high · **Status:** CLOSED — `readAll(…, { max })`

`.limit(n)` for n above the row ceiling is not a bound. It is a silent
truncation wearing the costume of a deliberate choice: PostgREST caps a response
at `db-max-rows` whatever the client asked for, so the number in the source reads
as a considered ceiling in review and returns 1,000 in production.

Measured against the live project, with the app's own numbers:

```
habit_logs       table=6500   asked .limit(5000) → got 1000
graph_entities   table=3709   asked .limit(4000) → got 1000
graph_edges      table=999    asked .limit(8000) → got  999   (under the cap: honest)
```

**Fifty-nine call sites** had written such a limit. What each one was actually
doing:

| Read | Wrote | Got | Consequence |
|---|---|---|---|
| `habit_logs` (AI habit coach) | 5,000 | 1,000 | streaks computed from a sixth of the history |
| `graph_entities` (`loadFamilyGraph`) | 4,000 | 1,000 | the AI reasons over a quarter of the household's graph — under a docstring promising never to present a partial view as current |
| `wallet_transactions` (×5 surfaces) | 2,000–20,000 | 1,000 | balances and the reconciliation page totalled from part of the ledger |
| `ab_events` per chunk | 100,000 | 1,000 | every experiment conversion rate a 1,000-row sample, read as exact |
| `calendar_events` (migration de-dupe) | 5,000 | 1,000 | an import re-adds events it cannot see |
| `transactions`, `mkt_touchpoints`, `marketplace_saves`, … | 2,000–10,000 | 1,000 | counts and sums reported as exact |

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data: `habit_logs` 6,500, `pet_care_records` 4,000,
`graph_entities` 3,709, `calendar_events` 1,906, `notifications` 1,402.

Every site now reads through `readAll`/`readAllAsQuery` with `max` set to the
number its author meant, which is honoured by paging to it. `readAllAsQuery`
answers in the `{ data, count, error }` shape a query answers, so a read inside a
`settleAll([...])` batch swaps one expression and nothing else moves.

`tests/no-limit-above-the-row-cap.test.ts` scans `app/` and `lib/` and fails on
any `.limit(n > 1000)`, with its own non-vacuity case pinning that the scan
catches the pattern and does not fire on a real bound or on prose describing the
rule. Verified after: typecheck clean, 13,108 tests, 353-route crawl with 0
failures, all 11 cron routes complete, and each of the 20 changed pages returns
200.

### F-014 · Notification dedupe failed on every run, so every run re-notified

**Severity:** high · **Status:** CLOSED — `lib/server/notifications.ts`, `lib/services/approvals`

Found by reading the server log after exercising the cron routes:

```
[notifications] dedup read failed { familyId: …, error: { message: 'URI too long\n' } }
[service:approvals] reminder dedupe read failed { familyId: …, error: { message: 'URI too long\n' } }
```

A PostgREST filter travels in the **query string**. Since `0293` (F-010) these
ids are no longer uuids — `related_id` carries a composite dedupe key such as
`moment:<eventId>:<date>` — and a few hundred of them build a request line past
the gateway's limit. Measured, by binary search against the live project:

```
  50 ids → URL  3168 bytes → 200
 100 ids → URL  6268 bytes → 200
 150 ids → URL  9418 bytes → 414
```

The code already named the consequence, in a comment written beside the read:
*"A failed dedup read leaves `seen` empty, so every candidate would pass the
filter and re-insert as a duplicate."* That is exactly what was happening, every
run, unnoticed — because the failure only logs, and the run still reports success.
The damage was measurable in the database: **117 duplicate
`(type, related_id, user_id)` groups holding 1,300 rows.** The approvals path
failed the other way, skipping the family every tick rather than duplicating.

Both reads now batch through `lib/supabase/chunked-in.ts` — the helper that
exists for this exact failure — at 50 ids per request, which the measurement
above puts at ~3 KB.

Proof, on the running production build:

```
before   [notifications] dedup read failed … URI too long   (every run)
after    URI-too-long errors: 0 · dedupe failures: 0
run 1    approvals reminded: 334 across 1 family   ← had been skipped every tick
run 2    approvals reminded: 0                     ← dedupe now suppresses
3 further runs → duplicate groups 117 → 117        ← no new duplicates
```

### F-015 · A probe granted itself privileges and left them, poisoning the suite

**Severity:** high · **Status:** CLOSED — `docs/audit/rls-isolation-check.sql`

The audit's own instrument was unsound, which makes it the most important finding
here: **a probe suite whose answer depends on what ran before it is not
evidence.**

`rls-isolation-check.sql` carried a bare

```sql
grant execute on all functions in schema public to authenticated;
```

so that one call below it could run as `authenticated`. It never revoked it. That
single statement undoes the deliberate revokes in `0204`/`0253`/`0292` and hands
`authenticated` EXECUTE on `claim_ai_runs` and the four loyalty RPCs — **the exact
cross-tenant hole F-006 closed.**

Probes glob alphabetically, so `privileged-rpc-grants-check` (**p**) ran *before*
`rls-isolation-check` (**r**) and passed; every run after that saw a poisoned
database. Observed directly: 13/13, then the same probe failing on a re-run
against the same database, naming all five RPCs. I had previously written that
flip off as my own out-of-order manual SQL. That was wrong — the leak was in the
suite, and saying so is the point of keeping this entry.

Two things were fixed:

1. **The grant is gone.** It was never needed: `CREATE FUNCTION` grants EXECUTE
   to PUBLIC, so `authenticated` can already call that RPC. Verified on a
   pristine 305-migration replay, before any probe ran —
   `has_function_privilege('authenticated', 'marketplace_create_circle', 'EXECUTE')`
   is already true, while all five privileged RPCs read service-role-only.
2. **An assertion that was only true because of the grant was corrected.**
   Invariant 5 matched `sqlerrm ilike '%not authorized%'`, the in-function check.
   With EXECUTE revoked from `authenticated` *and* PUBLIC, Postgres refuses the
   call outright — `42501: permission denied for function` — which is the
   *stronger* boundary, and the probe was reading it as a failure. It now accepts
   either, and still fails if the call SUCCEEDS, which is the thing that must
   never happen.

Now repeat-stable, which it was not before:

```
run 1  == probes: 13/13 passed ==
run 2  == probes: 13/13 passed ==
run 3  == probes: 13/13 passed ==
and after all three, the five privileged RPCs still read
  authenticated=false  anon=false  service_role=true
```

### F-016 · The documented crawl workflow drops a live session cookie into the working tree

**Severity:** low · **Status:** CLOSED — `.gitignore`

`npm run crawl:login` writes `cookies.json` — a real Supabase session cookie for
whatever account signed in — into the repository root, and `crawl:routes` reads
it back. Both are documented workflows and were run several times during this
audit, so the file lands in the working tree routinely. It was **not** gitignored:

```
$ git status --short
?? cookies.json
$ git check-ignore -v cookies.json
(no match)
```

Nothing had committed it, but the next `git add -A` by anyone following the
documented steps would have. Now ignored, with the reason written beside the
entry so it is not "tidied away" later by someone who reads it as a stray
artifact:

```
$ git check-ignore -v cookies.json
.gitignore:36:cookies.json	cookies.json
```

### F-017 · A family's "today" was Greenwich's today, on every surface that shows a day

**Severity:** high · **Status:** CLOSED — `dayKeyInTz` adopted across the
user-facing surfaces; the background remainder is allowlisted with reasons

A DATE column in this schema holds the day on the family's kitchen wall.
`new Date().toISOString().slice(0, 10)` answers the day at Greenwich. Nineteen
files compared one against the other.

This is not an edge case. Measured across every minute of a day:

```
America/Los_Angeles   420 min/day wrong   (29.2%)
America/New_York      240 min/day wrong   (16.7%)
Asia/Tokyo            540 min/day wrong   (37.5%)
Australia/Sydney      600 min/day wrong   (41.7%)
```

For a Californian household that is **every evening from 5pm**.

Proven end to end against the database, at 18:30 on a Sunday in Los Angeles:

```
instant                : 2026-09-14T01:30:00Z
family wall clock      : Sunday, September 13, 2026 at 6:30 PM
the family's today     : 2026-09-13
page's today (UTC)     : 2026-09-14   ← what meal_plans was queried with

  the page rendered  →  "Monday pasta — tomorrow"
  the family was eating →  "Sunday roast — eaten TONIGHT"
```

The same instant rolled `weekStart` forward too, so **"this week" silently became
next week every Sunday evening**.

Three findings within the class were worse than a wrong list:

- **The family display.** A wall-mounted kitchen screen took the *server's*
  midnight (`setHours(0,0,0,0)`), which on a UTC host is 17:00 in California —
  the screen turned over to tomorrow's schedule in the middle of the afternoon,
  every day. It now uses the family's day bounds.
- **Medication reminders.** `generateFamilyNotifications` bounded "doses already
  logged today" at UTC midnight. In California that window opens at 17:00 local,
  so the morning dose looked untaken and the family was reminded again; in Tokyo
  it opens at 09:00 the *previous* local day, so yesterday's dose was mistaken
  for today's and **the reminder never fired**. A missed medication reminder is
  the worse of the two.
- **Allowance scheduling.** A parent setting up an allowance on Sunday evening
  in California had `next_run_on` dated from Monday.

The fix was already written and documented. `lib/services/scope.ts` has carried
`dayKeyInTz` / `zonedDayBoundsMs` all along, and its own header names this exact
bug — *"a household in America/Los_Angeles sees tomorrow's day key for the last
seven hours of every day"*. Four surfaces used it; nineteen never adopted it.
This finding is about adoption, not about inventing a mechanism.

Two helpers were missing and are added: `addDaysToDayKey` and `weekStartDayKey`,
both string-in/string-out so they never touch an instant and cannot be knocked
off by a DST transition. Measured: from local midnight on 26 Oct 2026, adding
seven *fixed* days lands at 23:00 on 1 Nov — a day short of the calendar answer.
The window where that bites is 26–31 Oct, which is precisely why spot-checking
one date misses it.

**Converted:** kitchen, readiness, agents, intelligence, planning, moments,
family-cfo, food, display, wallet actions, and the medication window in
`lib/server/notifications.ts`.

**Not converted, each with its reason**, recorded in the guard's allowlist rather
than left looking overlooked: `lib/network/aggregate-server.ts` (platform-wide
aggregation — UTC bucketing is what a cross-household benchmark should use),
`app/api/cron/wallet-allowance/route.ts` (platform-wide cron; bounded at one day
early for families west of UTC), and five background derivations that take a
`familyId` but no zone, so converting them means threading one through.

`tests/family-day-not-greenwich-day.test.ts` fails on any new surface that builds
a Greenwich day key beside a DATE filter without reaching for the zone helpers,
and a second case fails if an allowlist entry outlives its reason — an allowlist
that rots is how the next regression hides. Reverting the kitchen fix fails it;
restoring it passes. `tests/family-day-key-arithmetic.test.ts` pins the helpers,
including both DST directions.

One correction worth recording: my first two attempts at the DST assertion had
the direction backwards, and I only got it right by measuring across a year
rather than reasoning about it. Spring-forward arrives an hour *late* and stays
inside the right day; it is the autumn transition that lands on the previous
evening.

### F-018 · Nine family-scoped reads were sequential scans of whole tables

**Severity:** medium · **Status:** CLOSED — migration `0294`

A read filtered by `family_id` on a table with no index *leading* on that column
scans the whole table — every other household's rows included. The cost then
grows with the **platform**, not with the family, which is the shape that looks
fine in staging and becomes a page-load problem at scale. RLS sharpens it: the
policies gate on `family_id`, so the predicate is applied to every row on every
read whether or not the application also filters on it.

Measured on `sync_job_runs` loaded with **700,000 rows across 2,000 households**
— a year of quarter-hourly calendar syncs — running the query the sync history
page actually issues:

```
before   Parallel Seq Scan   38,258 buffers   ~46 ms   (46, 48, 46 ms)
after    Index Scan               54 buffers   ~0.30 ms (0.33, 0.30, 0.28 ms)
```

~150× faster, ~700× fewer buffers, and bounded by one family's rows.

Nine tables were in that state, each indexed in the order its page queries, so
one index serves both the filter and the sort:

| Table | Index |
|---|---|
| `sync_job_runs` | `(family_id, started_at desc)` |
| `guardian_routing_rules` | `(family_id, priority)` |
| `social_post_variants` | `(family_id, post_id)` |
| `activation_events` | `(family_id, milestone)` |
| `allowance_rules`, `meal_vote_options`, `meal_vote_ballots`, `move_boxes`, `crm_contacts` | `(family_id)` |

**What was deliberately left alone, and why it matters to the finding.** A first
pass flagged 27 more tables. Checked against `pg_index` rather than against the
migration text, **23 of those already had a leading index** from a `UNIQUE` or
`PRIMARY KEY` declaration on `family_id` — my SQL-text parser simply could not
see those forms. The remaining four — `ai_messages`, `member_badges`,
`marketplace_listing_shares`, `social_publish_jobs` — are each read by
`family_id` *alongside* a primary key or another indexed column, so the other
index already does the selective work and a `family_id` index would buy nothing
and cost write throughput.

So the rule is not "every family-scoped read needs a `family_id` index". It is
"a family-scoped read needs **some** selective index", and only nine had none.

That correction is the reason this closed as a SQL probe rather than a unit
test. `docs/audit/family-scoped-index-check.sql` asserts against `pg_index`,
where a UNIQUE or PK declaration is visible as the index it really creates;
reading the migration SQL for the same fact is what produced 23 false positives.
The probe also proves it can fail — it drops one index inside a transaction,
confirms the assertion notices, and rolls back — because a check that cannot
detect the state it forbids is decoration. Verified: 14/14 probes on a fresh
307-migration replay, twice, with the dropped index still present afterwards.

### F-019 · The money-safety probe asserted concurrency it never tested

**Severity:** medium (instrument) · **Status:** CLOSED — `docs/audit/wallet-concurrency-check.sql`

The product is correct. The *check* was not, and after F-015 that is a finding in
its own right.

`wallet-overspend-check.sql` says it proves `wallet_reserve_card_auth` "counts a
pending hold against the balance (so concurrent auths serialize under its FOR
UPDATE lock)". It runs a fixed **sequential** sequence. Nothing in it ever runs
two authorizations at once, so the single property most worth knowing about a
child's wallet — *you cannot spend the same dollar twice by tapping twice* — was
inferred from the presence of a lock rather than demonstrated.

Raced for real, two `$8` authorizations against a `$10` balance on separate
connections:

```
with FOR UPDATE (the shipped function)
  A-15 OK: 1 of 2 simultaneous $8 authorizations approved against $10; $8.00 held

with FOR UPDATE removed
  A-15 FAIL: 2 of 2 simultaneous $8 authorizations approved against $10 (a=t, b=t)
```

Two approvals is a child spending **$16 of a $10 balance**. So the lock is
load-bearing, the shipped behaviour is right, and that is now evidence instead
of an assumption.

Two things about the probe itself are worth recording, because both are mistakes
I made and then had to correct:

- **The seed cannot live in the `do $$` block.** That block is one transaction,
  its writes stay uncommitted, and a dblink session taking `FOR UPDATE` on those
  rows waits on it forever. The first draft hung exactly that way. The seed is
  now plain top-level statements, which psql commits one at a time.
- **Two plain `dblink()` calls are not a race.** They run one after the other,
  each in its own committed transaction — which proves a hold is counted *across*
  transactions, a weaker claim, and the same kind of overclaim this finding is
  about. It now uses `dblink_send_query` / `dblink_get_result` so both are
  genuinely in flight before either is collected.

Where `dblink` is unavailable the probe SKIPs with a notice rather than failing:
a check that cannot run is not a check that found a problem, and conflating the
two teaches people to ignore red.

Verified: 15/15 probes on a pristine 307-migration replay, and 15/15 twice in a
row on a used one.

## 4. Closed previously (regression-checked this pass)

| ID | Finding | Still closed by |
|---|---|---|
| C-001 | `weekly-digest` read `status`/`assignee_id` off `chores`; filtered `meal_plans` on `planned_for` — every digest skipped | `db:audit:queries` |
| C-002 | Meals AI insight selected `meals.servings` (a `recipes` column) | `db:audit:queries` |
| C-003 | `getUserContext` threw on `AuthSessionMissingError` — expired cookie became a full-page error | `auth-context-error-contract.test.ts` |
| C-004 | A failed `user_preferences` read took down every authenticated page | same test |
| C-005 | 14 chrome-mounting sections had no `error.tsx` | re-verified: every section with a layout has one |
| C-006 | `app_settings` RLS-enabled with no policy since `0023` | `0276` |
| C-007 | OAuth callback bounced a just-signed-in user to `/login` | `auth-callback-boundary.test.ts` |
| C-008 | Sign-out unreachable from two gates (`<a href>` vs POST-only route) | `persistent-login.test.ts` |
| C-009 | `/dashboard/conflicts` emitted unbounded HTML | crawl: renders clean |
| C-010 | Knowledge Center showed English under translated headings | `0277` |
| C-011 | `rpc('public_handled_stats')` undefined — marketing figures silently zero | `0278` |
| C-012 | `privacy-export` failed nightly 00:00–04:00 UTC | suite green |

---

## 5. Reviewed, not a defect

- **Service-role client in `dashboard/settings` and `dashboard/billing`.** Both
  read global, non-secret config (referral config; Stripe fee display) under
  `(app)/dashboard/layout.tsx`, whose `AppFrame` calls `requireUserContext`. No
  user input reaches either query.
- **17 `TODO(migration …)` markers.** Each names a schema change deliberately
  deferred for owner approval — documentation of a boundary, not dead code.
- **1 lint warning** (`react-hooks/exhaustive-deps`), pre-existing.
- **`/gift/<bad token>`, `/pay/<unknown>`, `/s/<unknown>` answer 200.** These
  render an explicit "not found / expired" state rather than a bare 404, which
  is the better answer for a link someone was handed.

---

## 6. Verification log

| What ran | Result |
|---|---|
| `tsc --noEmit` | clean |
| `next lint` | 0 errors, 1 warning |
| `vitest run` | 13,518 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0291 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (fresh 306-migration replay, ×3) | 13/13 every run; the five privileged RPCs still service-role-only afterwards |
| 353-route authenticated crawl | 351 ok · 1 gate redirect · 0 failures |
| unknown-slug probe, 16 public routes | all degrade correctly after F-005 |
| API guard sweep | 140/140 guarded or declared public |
| `authenticated.spec.ts` + `concierge.spec.ts` | both pass (needed `E2E_PROVIDER_STUB=1`) |
| all 6 cron routes, live stack | each completes and reports; no run aborts |
| `readAll` vs live PostgREST, 3 tables | 2012 / 3709 / 1420 rows, all distinct; unbounded returns 1000 |
| old paging loop vs a 500-row server cap | returned 500 of 2011, `error=null` — the defect F-011 closes |
| `/sitemap.xml` on the running build | 1,049 blog URLs (was 1,048), 141–226 ms |
| F-012 guard with the fix reverted | 3 of 4 tests fail — not vacuous |
| `/blog`, `/blog/audit-fixture-post` | 200, 363 ms / 200 |
| all 11 cron routes, live stack | each completes and reports; no run aborts |
| 20 changed pages (wallet, marketplace, admin, dashboard) | 200 each |
| `.limit(n > 1000)` scan of `app/` + `lib/` | 0 remaining; guard fails on a planted one |
| PostgREST request-line limit, binary search | 200 at 6,268 bytes · 414 at 9,418 |
| notifications cron ×5 | URI-too-long: 0 · duplicate groups 117 → 117 |
| pristine replay, grants before any probe | five privileged RPCs service-role-only |
| `git check-ignore cookies.json` | ignored (was untracked and committable — F-016) |
| day-key drift, every minute of a day, 9 zones | LA 29.2% · NYC 16.7% · Tokyo 37.5% · Sydney 41.7% |
| meal-plan read at 18:30 Sunday in LA | rendered tomorrow's dinner; now renders tonight's |
| DST week arithmetic, measured across 2026 | 26–31 Oct: +7 fixed days lands a day short |
| F-017 guard with the kitchen fix reverted | fails — not vacuous |
| `sync_job_runs` at 700k rows / 2,000 households | 38,258 buffers · 46 ms → 54 buffers · 0.30 ms |
| 27 further tables checked against `pg_index` | 23 already indexed via UNIQUE/PK; 4 covered by another index |
| A-14 probe, index dropped in a rolled-back txn | the check detects it — not decoration |
| 2 overlapping $8 auths vs a $10 wallet | 1 approved, $8 held — the lock serializes them |
| the same race with `FOR UPDATE` removed | 2 of 2 approved ($16 of $10) — the probe catches it |
| `run-probes.sh`, pristine replay and used DB | 15/15, and 15/15 twice in a row |

---

# Pass C — Write honesty (C-01–C-08)

One question, asked of every write in `app/` and `lib/`: **when this is refused,
does anything notice?**

The answer was no in more places than it should have been, for one reason that
is invisible to every tool the repository runs. A PostgREST call RESOLVES with
`{ data, error }` and rejects only under `.throwOnError()`. The library's own
source does this:

```js
this.shouldThrowOnError = false;                        // default
if (!this.shouldThrowOnError) res = res.catch((fetchError) => { ... });
```

So `await supabase.from(t).insert(row)` with the result discarded cannot fail
visibly — not on an RLS denial, not on a constraint violation, not on a dead
connection. `tsc` has nothing to say either: awaiting a promise and ignoring its
value is legal. A `try/catch` around one of these looks like error handling and
is not; the catch can only ever see a synchronous throw while the query is being
built.

- **Audit head:** `a041b398` (main, after Passes A and B)
- **Method:** a scan for the shape — statement-position `await …from(t).<mutation>` —
  then one question per hit rather than a blanket fix. 55 hits across 37 files;
  most are genuinely fire-and-forget and are untouched.
- **What promotes a hit to a finding:** something downstream *claims* the write
  landed — a success page, a counter in a response, a row that records the
  outcome, or a screen whose whole job is showing what happened.

Two hits were checked and deliberately left, and the reasons are in the code:
`app/api/blog/like` and `blog/save` discard their toggle deletes but then re-read
the real state and return THAT, so a failed delete reports the truth; and
`app/(auth)/actions.ts` was already correct — its brute-force counter reads its
error and every caller refuses the sign-in when the write fails.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| C-01 | `logAudit`'s catch could never run — every caller lost audit rows silently, plus 10 wallet-audit sites written longhand | High | **Fixed** — #531 `3e05006b` |
| C-02 | An emergency escalation recorded `push_sent: true` for a notification that was never written | High | **Fixed** — #531 |
| C-03 | Three more urgent notification writes failed silently — a Guardian screening call, an urgent message, a voicemail | High | **Fixed** — #531 |
| C-04 | "Account disconnected and access revoked" shown when neither had happened | High | **Fixed** — #532 `ed85df8a` |
| C-05 | A family routine could be wedged permanently by one transient write failure | High | **Fixed** — #532 |
| C-06 | Twelve provider-sync writes discarded their errors; both tables are read by surfaces people act on | Medium | **Fixed** — #532 |
| C-07 | An unsubscribe that was never recorded still said "Unsubscribed" | High | **Fixed** — #536 `a041b398` |
| C-08 | Three counters reported work that did not happen — push prune, trust audit, card authorization | Medium | **Fixed** — #536 |

Nothing in Pass C is open. Every fix is on `main` and verified live.

---

## C-01 — `logAudit` could not report a failed audit write *(High, fixed)*

`lib/server/audit.ts` wrapped its insert in `try/catch` and logged from the
catch. Per the mechanism above, that line had never run and could not run, so
every audit-write failure across **all 14 callers it had at the time** was silent
by construction: a child login created, a PIN reset, an admin action, an
onboarding step — none recorded, nobody told. (It has 17 today: the fix also
converted three sites that were writing `audit_logs` longhand and discarding the
error, which the wallet-only sweep could not see.)

The same shape was written out longhand at **ten wallet-audit call sites**,
including the credit and debit paths in `lib/wallet/server.ts`, so a transfer, a
card spend, a card issue or a claimed Pay-ID could complete with no audit row at
all. `app/(app)/money/actions.ts` already did it correctly through a local
helper, which is the shape the rest should have had.

Both now read the error. The wallet helper is shared as `logWalletAudit`, and all
**14** wallet-audit sites go through it — the 10 that discarded their error plus
the four that were already correct, so there is one implementation rather than
two idioms and eight silent copies. It deliberately does **not** fail the caller:
by the time it runs the money has already moved, and refusing a completed
transfer because its log failed would turn a bookkeeping problem into a financial
one.

**Proof:** `tests/audit-write-failures-are-visible.test.ts`, built on a fake
client that RESOLVES with an error the way PostgREST does. Against the original,
the case that matters fails with *"a refused audit write produced no output at
all"*.

## C-02 — An emergency escalation recorded a push that never happened *(High, fixed)*

The sharpest instance in the pass, because it did not merely stay silent — it
wrote down the opposite of what happened. `app/api/guardian/escalate/route.ts`:

```ts
try {
  await supabase.from('notifications').insert({ ... });
  pushSent = true;
} catch { /* non-fatal */ }
```

The insert resolves rather than throwing, so a refused write never reached the
catch and `pushSent = true` ran anyway. That value is not cosmetic: it is written
into the `guardian_escalations` row as `push_sent` and returned to the caller. An
emergency escalation was therefore recorded, permanently, as having alerted the
parents when nothing had been written — and the audit trail of the emergency
asserted it too.

`pushSent` now becomes true only on the no-error branch.

## C-03 — Three more urgent notification writes were silent *(High, fixed)*

The same dead catch on a Guardian screening call, an urgent Contact Center
message and an urgent voicemail. Each wrapped its insert in `try/catch` with a
`console.error` that could not run, so an urgent message reached nobody and left
no trace of having failed. All three now read the error.

**Deliberately not done here:** routing these four through the `notify()` service,
which would also give them dedupe, recipient resolution and an urgent-flagged
quiet-hours bypass. That is the right destination, but it is a larger change on
Guardian emergency paths that could not be exercised end to end from the audit
environment. Making the failure visible is the part that should not wait.

## C-04 — "Account disconnected and access revoked", when neither had happened *(High, fixed)*

Both sync disconnect routes discarded the result of the delete that **is** the
disconnect, then redirected unconditionally:

```ts
await admin.from('sync_accounts').delete().eq('id', account.id);
...
return NextResponse.redirect(new URL(`...?disconnected=1`, ...));
```

`disconnected=1` renders *"Account disconnected and access revoked."* So a
refused delete left the row in place — the account still connected, still syncing
on the next run — and told the member their access was gone. Of every write in
the pass this is the one whose failure may least be reported as success: being
told access was revoked is exactly what stops someone checking again.

The provider-generic route also claimed revocation in three cases where none
happened — no adapter, no refresh token to present, or `revokeToken` throwing
into `.catch(() => {})`. Best effort is a fine design; saying it worked is not.

The delete's error now answers a `danger` banner saying access has **not** been
revoked, and a disconnect that could not withdraw the grant says so and points
the member at the provider.

## C-05 — A routine that fires once and then never again *(High, fixed)*

`app/api/cron/family-routines/route.ts`, at the end of the fire loop, updated
`next_run_at` and discarded the result. That write is the only thing that moves a
rule off the occurrence it just handled. Refused, `next_run_at` keeps a `due_at`
that has already passed — so the next tick selects the same occurrence, collides
`23505` on the reservation, and hands it to `releaseWedgedOccurrence`, which
returns immediately because that guard is for reservations that never became a
request **and this one did**. Nothing else advances the rule.

One transient error and the family's routine is wedged for good, on a tick that
reported `ok: true`. It now reports the rule in `problems`.

`armPendingRoutines` had the same shape with a different cost: `armed += 1` ran
unconditionally after its update, and `armed` exists — its own comment says so —
*"so a quiet tick is distinguishable from a broken one."*

**Proof:** three behavioural cases in `tests/cron-family-routines.test.ts`; the
in-memory harness now lets one specific update resolve with an error, so the
wedge is reproduced rather than asserted about.

## C-06 — Twelve provider-sync writes discarded their errors *(Medium, fixed)*

`sync_audit_logs` and `sync_provider_errors` were written longhand at twelve
sites, every one discarding the result. Neither is telemetry nobody reads:

| table | read by | cost of a lost write |
|---|---|---|
| `sync_audit_logs` | `/dashboard/sync/history` | a gap in the member's account history — and `disconnect` is one of its actions, so the missing row is the one someone goes looking for |
| `sync_provider_errors` | admin sync page, `.eq('is_fatal', true)` | a broken integration looks healthier than it is, on the screen used to decide whether to act |

Both now go through `logSyncAudit` / `logSyncProviderError`. **Two callers
deliberately do not**, because they do something with the failure the helper
cannot express — the cron route counts audit failures into its response, and
onboarding throws, treating a connection it cannot produce a receipt for as
failed. Both are exempt by name with a reason, and the test checks the reason
still holds.

## C-07 — An unsubscribe that was never recorded still said "Unsubscribed" *(High, fixed)*

`app/api/marketing/unsubscribe/route.ts`:

```ts
await supabase.from('marketing_suppressions').upsert({ email: clean, reason: 'unsubscribe' });
return page('Unsubscribed', `${clean} will no longer receive marketing emails…`, true);
```

That upsert **is** the unsubscribe — `lib/marketing/send.ts` drops an address from
a campaign only by finding its row. The result was discarded and the page
promises, unconditionally and with a tick and a 200, that the mail stops. A
refused write sent a person away believing they had opted out, and the next
campaign mailed them anyway.

What makes this a gap rather than the house style is that every other path
touching this table already treats the write as load-bearing:

| path | on failure |
|---|---|
| `lib/marketing/send.ts` | **throws and abandons the whole send** if it cannot even *read* suppressions — it would rather mail nobody than risk mailing someone who opted out |
| `app/api/webhooks/resend/route.ts` | answers **503** so a bounce/complaint write is retried |
| the unsubscribe a person clicks | said "✓ Unsubscribed" |

Both machine-facing paths are rigorous. The one path where a human is told
something was the one that did not check.

The status is not cosmetic either: `POST` here is the **RFC 8058 one-click
endpoint**, and a 2xx is what tells Gmail or Yahoo the opt-out was honoured.
Answering 200 on a failed write spends the provider's only signal on a promise
that was not kept. It now answers 503 and says the mail may still come — the only
wording that gives the reader a reason to try again.

The route had no test at all before this; the existing `marketing-unsubscribe`
spec covered only the token helpers, which is how it survived.

## C-08 — Three counters that counted what did not happen *(Medium, fixed)*

- **`lib/server/push.ts`** incremented `result.pruned` after a delete whose error
  was discarded. A dead endpoint (404/410) that cannot be removed is retried on
  every later notification, spending a send each time and reporting itself
  cleaned up each time. *This is the pass's one duplicate: the same defect was
  found independently on `codex/final-production-audit-20260912`. Both fixes are
  the same; `main`'s also logs which device failed.*
- **`lib/trust/server.ts`** said `// Explainable audit trail — always recorded.`
  above an insert that discarded its result, so it was not always recorded. That
  table is what `dashboard/trust` renders (the last forty decisions, with actor,
  capability, decision and reason) and what `api/privacy/export` cites. A lost row
  is a decision the family **cannot see**, including a denial or one that needed
  their approval. Deliberately still non-fatal: callers act on the returned
  decision, and failing one because its explanation failed to log would take the
  AI layer down, denials included.
- **`lib/stripe/webhook.ts`** recorded a card approve/decline "best-effort" and
  silently. Best-effort is right and must stay — Stripe has already been told, and
  throwing would answer the webhook non-2xx and have Stripe redeliver a decision
  that is already final. Silence is not right, because the admin Stripe page and
  the assistant both answer *"why was this declined"* from those rows.

---

## How Pass C is kept closed

Four guards, **45 cases**, each proved load-bearing by reverting the fix and
watching the matching case fail alone:

| guard | cases | what it holds |
|---|---|---|
| `tests/audit-write-failures-are-visible.test.ts` | 14 | `audit_logs` / `wallet_audit_logs` are never written longhand with the result discarded |
| `tests/sync-write-failures-are-visible.test.ts` | 16 | the two sync tables go through the helper, the disconnect reads its delete, and the page can render "not revoked" |
| `tests/claimed-writes-that-did-not-land.test.ts` | 9 | the prune counter (driven behaviourally), the trust and Stripe rows, and a sweep over four tables |
| `tests/marketing-unsubscribe-route.test.ts` | 6 | the real route: 503 and no claim when the write fails, 200 and the claim when it lands |

Each sweep names the offending **file and line** when a new instance appears, so
the next one fails on the way in rather than being found by a later audit.

---

# Pass D — Server-action authorization (0 findings)

One question, asked of every export of every `'use server'` module: **does this
establish who is calling — and does authenticating them actually constrain what
they can write?**

The surface matters because a server action is not a function call. Every export
of a `'use server'` module is compiled into an HTTP endpoint with its own action
id, and the client can invoke it directly. The component that normally calls it
is not a gate; neither is the page's own access check. Whatever the action does
for a caller who reached it by other means is what it does.

- **Audit head:** `a7ed83c5` (main, after Passes A, B and C)
- **Surface:** 127 `'use server'` modules · 487 exported async actions · 114 of
  them in modules that hold a **service-role** client
- **Why the service-role modules are the ones that matter:** the user client is
  checked by RLS, so a forged id is refused by the database whatever the action
  does. The service client is checked by nothing.
- **Result:** 12 candidates, all 12 cleared against the code. A second, sharper
  sweep for cross-tenant writes returned 2, both correct. **No findings.**

## The false-positive class that nearly produced 33

This is recorded because the intermediate result was wrong in a way that looked
authoritative, and the same mistake is available to anyone who repeats this
audit with the obvious tool.

A text scan finds an action's body by taking the first `{` after its parameter
list. That is not the body when the return type contains an object:

```ts
export async function issueCardAction(input: {
  childWalletId: string; type: 'virtual' | 'physical'; …
}): Promise<Result<{ cardId: string }>> {
  const ctx = await requireUserContext();   // ← the guard, on line 3
```

Brace matching walks the parameters, then takes the next `{` — which opens
`{ cardId: string }`, **inside the return type**. The extracted "body" is a type
literal containing no guard, so the action is reported unguarded while its third
line is `await requireUserContext()`. Every action annotated with an object type
in its return position was flagged this way.

Three formulations of the scan returned **33**, then **48**, then **52**
candidates — the count moving with the regex rather than with the code, which is
the tell. Parsing the modules with the TypeScript compiler instead returned
**12**, and found 15 modules and 50 actions the text scan had missed entirely.
None of the 33 was ever reported as a finding; the correction is here so the
number is not mistaken for a result later.

## The 12 candidates, and why each cleared

| Action | Why it is not a finding |
|---|---|
| `app/(app)/dashboard/inbox/actions.ts:inboxRequestText` | Not an endpoint in the meaningful sense: a pure string composer over its own arguments, exported so a test can pin it without a database. Reads nothing, writes nothing |
| `app/(auth)/actions.ts:stitchIdentityAction` | Authenticates via `supabase.auth.getUser()` and returns early when there is no user — the sweep's guard list did not include the bare property form |
| `app/(auth)/actions.ts:childSignInAction` | A sign-in cannot require a session. Rate-limited by IP and throttled per username via `child_login_throttle`, checked *before* the password path and even for unknown usernames, so it is not a lookup oracle |
| `app/gift/actions.ts:submitGiftPledgeAction` | Public by design; the unguessable link token **is** the authorization. Rate-limited, pledges written `pending` a parent's approval, pending pledges per link capped at 25 |
| `app/reviews/new/actions.ts:submitReviewAction` | Public review form, rate-limited; writes `pending` unless the rating clears the configured auto-approve threshold |
| `app/s/[slug]/actions.ts:submitResponseAction` | Public survey, respondents may be anonymous; the slug must resolve to a live, active, non-deleted survey and the score must sit inside that survey's own scale |
| `app/onboarding/actions.ts:previewCalendarImportAction` | Authenticates, then writes nothing at all — the value-first preview step is computed in memory |
| `app/onboarding/actions.ts:saveFamilyDetailsAction` | Authenticates, then writes through the **user** client. Verified against the policy rather than the comment: `0052_family_onboarding.sql:39` is `FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))`, so the `WITH CHECK` refuses a forged `familyId` |
| `app/onboarding/actions.ts:resetOnboardingAction` | Authenticates, then every service-role write is keyed on `auth.user.id` — it cannot address another account |
| `app/onboarding/actions.ts:finalizeOnboardingAction` | Authenticates and fails closed on the auth error before any write |
| `app/onboarding/calendar-actions.ts:startCalendarConnectionAction` | `auth.getUser()`, then `verifyOnboardingOwner`, then `assertOnboardingCalendarAccess` — twice, the second time against the family it just prepared |
| `app/onboarding/calendar-actions.ts:previewConnectedCalendarAction` | `auth.getUser()`, then the `sync_accounts` read is scoped `.eq('user_id', auth.data.user.id)`, so another user's `accountId` resolves to nothing |

## The sharper question: authentication is not authorization

"Does it have a guard" is the weaker of the two questions. `requireUserContext()`
answers *who is calling*; it does not answer *which family they may touch*. An
action that authenticates and then hands a **caller-supplied** family id to the
**service** client has no boundary left — RLS is not in the path.

A second sweep looked for exactly that: an exported action that constructs a
service client and keys a read or write on a `family_id` whose value traces back
to its own parameters. Two hits, both in `app/(app)/admin/actions.ts`:

| Action | Verdict |
|---|---|
| `adminCreateUserAction` | `assertSuperAdmin()` with an early return, before anything else. Cross-family is the point of the admin console, and the action is audited via `site_admin` |
| `adminSetFamilyPlanAction` | Same gate, same early return; audited, and the plan is validated against `ASSIGNABLE_PLANS` |

Both are correct. The rest of the 114 either take the family from the
authenticated context or go through the user client.

## How Pass D is kept closed

`tests/server-action-authorization.test.ts` — **8 cases**, the two sweeps above
plus four that prove the detector can see.

| what it holds | how |
|---|---|
| Every action in a service-role module reaches a guard, or is on `PUBLIC_BY_DESIGN` with a written reason | AST walk, resolving guards transitively through same-module helpers |
| A caller-supplied family id reaching the service client is super-admin gated | the parameter-to-`family_id` dataflow sweep, reported with file, line and the parameter it traced to |
| The public allowlist cannot rot | a stale entry fails; so does a reason under 40 characters, because an unexplained exemption is how the next one gets added |
| The detector is not blind | four synthetic modules, including the exact return-type-brace shape that defeated the text scan |

Both sweeps report nothing today, which is the condition under which a guard is
easiest to get wrong — a sweep that cannot see is indistinguishable from a clean
codebase. So each was proved load-bearing against the real code:

- Replacing `requireUserContext()` in `issueCardAction` with a literal made the
  first sweep fail naming `app/(app)/money/actions.ts:109  issueCardAction`, and
  only that.
- **Downgrading** `assertSuperAdmin()` to `requireUserContext()` in
  `adminSetFamilyPlanAction` left the first sweep green — it has a guard — and
  failed the second, naming the three lines where `input.familyId` reaches the
  service client. That is the case the weaker question misses, and it is caught.

Both mutations were reverted; `git status` and `tsc --noEmit` confirm the tree is
unchanged apart from the new test.

---

# Pass E — Read honesty (E-01)

Pass C asked, of every write: *when this is refused, does anything notice?* This
asks the same question of **reads**, and it is the same library fact in the other
direction. A PostgREST read also resolves with `{ data, error }`, so

```ts
const { data } = await supabase.from('trust_policies').select('id')…;
```

cannot fail visibly. `data` comes back `null` — which is exactly what "there is
no such row" looks like. The two are indistinguishable to the code that follows.

- **Audit head:** `2608b556` (the branch, after Passes A–D)
- **Surface:** 210 reads across 101 tables discard their error
- **What promotes a hit to a finding** — narrower than Pass C's, deliberately:
  a rendered empty state is usually a survivable degradation, so a hit counts
  only when the absence is treated as a **fact** and something is decided on it.
  Most of the 210 render; one decides.

Two were checked closely and are correct as they stand. `resolveEntitlement`
(`lib/server/entitlement.ts`) drops the error on its `family_members` read and
falls back to *unlocked, level 0* — and says so in its doc comment. That is the
free tier, the least privilege it can grant, so the failure direction is
conservative. `submitReviewAction` drops the error on `reputation_settings` and
therefore leaves `autoMin` null, which sends the review to **pending**
moderation rather than publishing it. Both fail in the safe direction.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| E-01 | Turning Autopilot off could leave it on, and every retry made it worse | High | **Fixed** — this branch |

---

## E-01 — The autopilot dial could report success without taking effect *(High, fixed)*

`setConciergeAutopilotAction` is the family-facing switch for whether Bubaly acts
on its own: `auto` → `allow`, `ask` → `require_approval`, `off` → `deny`. Its
doc comment says it writes **ONE** system trust policy. It did not enforce that.

```ts
const { data: existing } = await sb
  .from('trust_policies').select('id')
  .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle();

if (existing?.id) { /* update that row */ } else { /* INSERT a new policy */ }
```

The read's error was discarded, so a refused read returned `data: null` and the
`else` branch ran. Four facts compound from there, each verified rather than
assumed:

1. **Nothing in the schema stops a duplicate.** `0093_trust_engine.sql` gives
   `trust_policies` two indexes, `idx_trust_policies_family` and
   `idx_trust_policies_domain` — both non-unique. There is no unique key on
   `(family_id, name)`.
2. **Two rows change the answer.** The insert hard-codes `priority: 10`, so a
   duplicate ties with the original. `lib/trust/engine.ts:283` filters the
   matching policies, sorts by `b.priority - a.priority`, and takes
   `matching[0]`. `Array.prototype.sort` is stable, so a tie is resolved by
   **list position**.
3. **List position was undefined.** `loadTrustInputs` selected the policies with
   no `ORDER BY`, and a Postgres select without one has no guaranteed row order.
   So which of the two governed could differ between two identical requests.
4. **It ratcheted.** Once two rows exist, `.maybeSingle()` *itself* fails. From
   postgrest-js's own source:

   ```js
   if (this.isMaybeSingle && Array.isArray(data)) {
     if (data.length > 1) {
       error = { code: 'PGRST116', ... };
       data = null;
   ```

   `data` is set to null **and** an error is set. With the error discarded, every
   later save read null again and inserted yet another policy. The dial could
   never take effect again through the UI — and returned `{ ok: true }` each time.

The consequence is the reason this is High rather than Medium. A parent who set
Autopilot to **off** could be left with a stale `allow` still deciding whether
Bubaly executes accepted plans unattended. This is proved rather than asserted:
the guard evaluates the real engine with the two policies in each order and gets
`allow` one way and `deny` the other, from the same two rows.

### The fix, and why it is shaped this way

The read is gone. The update is keyed on the **filter** rather than on an id read
back, and the insert runs only if the update matched nothing:

```ts
const { data: updated, error: updateError } = await sb.from('trust_policies')
  .update({ effect, enabled: true })
  .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME)
  .select('id');
if (updateError) { …log…; return { ok: false, error: updateError.message }; }
if ((updated ?? []).length === 0) { /* insert */ }
```

This is both the fix and the **repair**. It moves every row of that name, so any
duplicates already in a family's database converge to the same effect and the
engine's choice between them stops mattering. That property is required, not
incidental: the production migration ledger is gated (Pass A **F5** / Pass B
**F-001**), so a corrective unique index cannot currently be applied there, and
the fix has to work on unmigrated data.

`loadTrustInputs` now also orders the policies —
`.order('priority', …).order('created_at', { ascending: false })` — so a tie
between any two policies resolves the same way twice, newest first. That closes
the general case behind E-01 rather than only the autopilot instance of it.

A unique index on `(family_id, name)` remains the right belt-and-braces once the
ledger is repaired. It is **not** required for the fix above to hold.

## How Pass E is kept closed

`tests/autopilot-dial-takes-effect.test.ts` — **9 cases**.

| what it holds | how |
|---|---|
| Every policy of that name is moved, not one id read back | asserts the update's filters carry `family_id` + `name` and **no** `id`, with two rows present |
| A refused write reports failure | the decisive case: the dial returned `ok: true` on a write nobody checked |
| A refused read is never read as "no policy yet" | asserts no insert follows a failed update |
| Each dial position maps to the effect the engine obeys | `auto`/`ask`/`off` → `allow`/`require_approval`/`deny` |
| Non-managers are refused before any write | no update, no insert |
| **Why a leftover row mattered** | drives the real `evaluateAction` with both orderings and shows the same two rows give opposite answers — then shows convergence makes order irrelevant |
| The load is ordered | fails if the `.order()` calls are dropped from `lib/trust/server.ts` |

Proved load-bearing by reverting each fix: restoring the original
read-then-branch fails **5 of the 9**, and dropping the `.order()` calls fails
the ordering case alone.

One correction worth recording, because it nearly became a wrong finding. The
first version of the engine fixture returned `deny` for *both* orderings, which
would have read as "deny always wins" — a safe engine and no finding. It was
neither: the fixture used an actor of kind `'ai'`, and `policyApplies` matches a
`subject_kind: 'ai'` policy against an actor of kind **`'ai_agent'`**. Both
policies were being filtered out and the result was the *fallback* deny, which
the decision's `basis: 'fallback'` said plainly. The fixture was wrong, not the
engine. Checking `basis` rather than `effect` is what separated the two.

---

# Pass F — Public API routes (F-a, F-b)

Middleware is the outer session boundary, but a route under a `PUBLIC` prefix is
deliberately *outside* it: the request reaches the handler with no session at
all. So two questions, asked of each one — does it **authenticate itself**, and
does it **only claim what it can support**?

- **Audit head:** `799dd633` (the branch, after Passes A–E)
- **Surface:** 140 `route.ts` files; **98** sit under one of the 24 public `/api`
  prefixes in `middleware.ts`
- **Authentication result:** 94 of 98 have a self-authentication path; the
  remaining 4 were read individually and all 4 are correct. **No finding.**
- **Honesty result:** **2 findings**, both on routes the earlier passes could
  not see — and the reason they could not see them is itself recorded below.

## Authentication: 4 candidates, 4 cleared

| Route | Why it is not a finding |
|---|---|
| `/api/health` | Documented as booleans, latency and missing-var **names** only. Verified against the code rather than the comment: `checkRequiredEnv` returns `{ ok, missing }` where `missing` is `REQUIRED_ENV.filter(…)` — names, never values |
| `/api/build-info` | Returns one build-time literal. No request input, no lookup |
| `/api/exit-intent/resolve` | Public marketing offer; IP rate-limited at 60/min, bounded body, no family data |
| `/api/blog/unsubscribe` | Token-authorized after all — `?token=` is validated as a UUID and matched against `unsubscribe_token`. The sweep's pattern list simply lacked that column name |

The first sweep reported **43** bare routes. That was wrong for one reason worth
keeping: it read each route's own text, and **24 cron routes hold their check in
a shared helper**, `hasCronAuthorization` from `lib/server/cron-auth`. Resolving
imports two levels deep took 43 → 4. This is the same failure as Pass D's
return-type brace: a scan that does not follow the code reports the shape of its
own pattern.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F-a | The blog unsubscribe confirmed an unsubscribe that was never written, and blamed the reader's link for a failed read | High | **Fixed** — this branch |
| F-b | Activating emergency mode discarded the only record of who activated it | High | **Fixed** — this branch |

---

## F-a — "You've been unsubscribed" over a row that still said subscribed *(High, fixed)*

`/api/blog/unsubscribe` discarded **both** results:

```ts
const { data } = await supabase.from('blog_subscribers')
  .select('id, status').eq('unsubscribe_token', token).maybeSingle();

if (data && data.status !== 'unsubscribed') {
  await supabase.from('blog_subscribers').update({ status: 'unsubscribed', … }).eq('id', data.id);
}
home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
```

Two different lies, from one route:

- **A refused update** still redirected to `unsubscribed=1`, whose banner reads
  *"You've been unsubscribed from blog updates."* The row still said subscribed,
  so the next digest goes out to them. This is C-07 exactly, on a second route.
- **A refused lookup** produced `data: null`, indistinguishable from "no such
  token", and was reported as `invalid` — *"That unsubscribe link doesn't look
  right"*. A real subscriber holding a real link, told the link was wrong.

Both results are now read. A failure redirects to a third state, `error`, and
the blog page renders it — *"we couldn't complete that just now, so you may still
receive blog emails"* — because a route that redirects to a state the page cannot
show has moved the problem rather than fixed it.

## F-b — Emergency mode could be activated with no record of who did it *(High, fixed)*

`activateEmergencyAction` writes the `trust_audit_logs` row that is the **only**
record of who turned emergency mode on and why. Its result was discarded:

```ts
await (await ledgerWriter(supabase)).from('trust_audit_logs').insert({ … });
```

Emergency elevation, by the file's own comment, *"outranks every deny, policy and
risk tier"* — it is the most powerful state the trust engine has. A refused
insert left a family with a live elevation and nothing saying who started it, on
the two surfaces built to answer that question: `dashboard/trust` renders these
rows and `api/privacy/export` cites them.

The fix reads the error and logs the family, the kind and the activating member.
It is deliberately **non-fatal**, for a reason specific to this action: the
`emergency_sessions` insert above has already succeeded, so the elevation *is*
live. Returning an error to a parent mid-emergency invites them to activate it
again, which is worse than a missing log line. It must not fail; it must not be
silent either.

## Why Pass C missed both — a hole in its own guard

Both instances are exactly the class Pass C swept for, on tables Pass C was
watching in one case. They survived because of how its sweep matched:

```js
if (!new RegExp(`^\\s*(?:void\\s+)?await\\s+[\\w.]*\\.from\\('${table}'\\)`).test(line)) return;
```

It required `.from('t')` on the **same line** as the `await`. Both offenders
break the chain across lines — `await supabase` ⏎ `.from('blog_subscribers')`,
and `await (await ledgerWriter(supabase)).from(…)`, which `[\w.]*` cannot match
either way. The sweep reported clean over both.

This was found honestly rather than by inspection: `blog_subscribers` was added
to the watched set, the fix was reverted to check the guard was load-bearing —
**and it still passed**. That vacuous pass is what exposed the hole.

The sweep now joins an eight-line window and cuts at the statement end before
matching. Re-run against the same tree it immediately found **F-b**, which no
pass had seen. A guard that cannot see the common formatting of the thing it
forbids is decoration.

## How Pass F is kept closed

| guard | cases | what it holds |
|---|---|---|
| `tests/public-route-write-honesty.test.ts` | 8 | drives the real route: confirms on a landed write, `error` on a refused write, `error` (not `invalid`) on a refused lookup, `invalid` only for a genuinely unknown token, no DB call for a malformed token, idempotent on an already-unsubscribed row, and the page can render the third state |
| `tests/claimed-writes-that-did-not-land.test.ts` | 10 | the multi-line-aware sweep, now over **five** tables |

Proved load-bearing by reverting: restoring the original route fails the two
cases that matter — the refused write and the refused lookup — and leaves the six
that describe unchanged behaviour passing.

**Noted, not fixed:** `endEmergencyAction` writes no audit row at all. Ending an
elevation is arguably as worth recording as starting one, but that is a missing
feature rather than a discarded result, and inventing scope mid-pass is how an
audit stops being checkable. Recorded here instead.

---

# Pass G — RLS completeness (0 findings)

RLS is the only thing standing between one family's rows and another's, because
the grant layer deliberately does not: hosted Supabase ships
`alter default privileges in schema public grant all on tables to anon,
authenticated, service_role`, and `docs/audit/pg-bootstrap.sh` reproduces exactly
that so the probes test the real posture. **488 of 491 tables grant `anon` full
DML.** That is not a finding — it is the model — but it does mean a single table
with RLS off, or one blanket policy, is the whole boundary gone.

- **Method:** not a text scan. A real replay — Postgres 16.13, `pg-bootstrap.sh`,
  **307 migrations applied, 0 failed** — then `pg_catalog` asked directly.
- **Result:** **491 of 491** public tables have `relrowsecurity` set. Zero
  exceptions. The repo's 15 existing boundary probes pass on that same fresh
  replay, 15/15.

## Why this pass is a replay and not a grep

The first attempt counted `ALTER TABLE … ENABLE ROW LEVEL SECURITY` in the
migrations and reported **129 tables unprotected**. The real answer is **zero**.
Two reasons, both invisible to a pattern:

- `0093_trust_engine.sql` writes `ALTER TABLE public.trust_policies     ENABLE
  ROW LEVEL SECURITY;` — aligned with **multiple spaces**, which a
  single-space pattern does not match.
- Several migrations enable RLS dynamically:
  `execute format('alter table public.%I enable row level security;', t)` over an
  array of names. No static reader can follow that.

CI's own comment already says this, about a different check: *"only a real
catalog is trustworthy … `0261` drops a unique constraint through `execute
format(...)`, which no static reader can follow."* This was the fourth
pattern-based miscount in this audit — after Pass D's 33/48/52, Pass F's 43, and
Pass C's blind sweep — and the one where a wrong number would have been most
alarming. Recorded so the 129 is not mistaken later for something that was ever
true.

## What was newly checked, and what it found

"RLS is on" is not the property anyone cares about: RLS with a policy whose
`USING` or `WITH CHECK` is literally `true` permits everything. The existing
`wallet-write-rls-check.sql` forbids that on the **money** tables. Nothing asked
it of the other ~480.

Asked now, across all 491, **six** policies are unconditional, and all six are
correct:

| policy | verdict |
|---|---|
| `admin_users`, `support_tickets` → `service_role` | `service_role` bypasses RLS anyway; a `true` policy naming only it grants nothing new |
| `badges` → authenticated, read | the badge catalogue — identical for every family |
| `feature_flags` → authenticated, read | flag names and states; no family column |
| `meal_ideas` → PUBLIC, read | the seeded recipe catalogue |
| `service_descriptions` → anon + authenticated, read | public marketing copy, served by the public `/api/services/descriptions` route |

No family-scoped table has one. **No finding.**

## How Pass G is kept closed

`docs/audit/blanket-policy-check.sql` (**A-16**), picked up automatically —
`run-probes.sh` globs `docs/audit/*-check.sql` precisely so a probe added today
runs today without anyone registering it.

| what it holds | how |
|---|---|
| No table outside a named reference-data allowlist carries an unconditional policy | one `pg_temp` function defines the rule, so the invariant and the self-test cannot drift apart |
| The four exemptions stay visible | each is listed with the reason it is exempt, and the probe prints the count — adding a fifth is a decision made in this file, not a side effect of writing a policy elsewhere |
| Service-role-only policies are not false positives | excluded explicitly, because `service_role` bypasses RLS regardless |
| **It can detect what it forbids** | plants a blanket `to authenticated using (true)` policy on `calendar_events`, asserts the rule finds it, rolls back, then asserts the plant is gone |

Probe suite after this addition: **16/16 passed.**

The self-test is the part that matters. Every invariant in this pass currently
reports clean, which is exactly the condition under which a broken check is
indistinguishable from a healthy system — the same reason Pass D's guard carries
four synthetic modules.

---

# Production, read for real (2026-09-13)

F5's first blocker is gone. The owner restored the access token's privileges, and
the **read-only** schema audit — `supabase-schema-audit.yml`, which applies
nothing and is `workflow_dispatch` only — was run against production to check
rather than assume. It had last succeeded on 2026-09-05, before the token broke.

Run [34780188088](https://github.com/NewWorldVenture/Bubaly/actions/runs/34780188088),
step *"Read catalog metadata and migration history"*: **success**. That is the
exact step that previously died at `supabase link`. It returned:

```json
{"migrationVersions":["0001","0002","0003"],"tableCount":440,"policyCount":973,
 "requiresBaselineReview":true,
 "moneyWrites":{"openWrites":[],"unguarded":[],"rlsDisabled":[],"noWritePolicy":[],
                "absent":[],"rlsKnown":true,"exploitable":false}}
```

## The wallet mint boundary is closed in production — verified, not inferred

This document has carried the LB-016 finding with an explicit caveat: a
production metadata audit reported that `wallet_transactions` might still hold a
**permissive INSERT policy** beside the manager-only one — the shape that lets
any family member, a child included, submit a `completed` `credit` and create
spendable funds — and that *"the audit returned policy hashes rather than
expressions, so the exact live condition is still unverified."*

It is now verified. Against live production:

- `exploitable: **false**`
- `openWrites: []` · `unguarded: []` · `rlsDisabled: []` · `noWritePolicy: []`
- all ten money tables — `family_wallets`, `child_wallets`, `wallet_buckets`,
  `wallet_transactions`, `wallet_rules`, `financial_accounts`, `transactions`,
  `budgets`, `bills`, `savings_goals` — return
  **"CLOSED - every write is manager-gated"**
- `rlsKnown: true`, so this is read state rather than an assumption

The highest-severity open question about production money is answered, and the
answer is that the boundary holds.

## What the same read makes newly measurable

Production reports **440 tables and 973 policies**. A clean replay of the repo's
migrations — performed for Pass G on Postgres 16.13, 307 migrations, 0 failures —
produces **491 tables**.

That gap of roughly **50 tables** is the ledger blocker stated as a number rather
than a caveat. `requiresBaselineReview` is still `true` and the recorded history
is still `0001`–`0003`, so the schema has been hand-managed and has drifted
behind the migration set. This document previously said only that *"a missing
ledger entry does not establish that the corresponding schema or feature is
absent"* — which remains true, and is why the direction matters: the count is
what production actually has, so tables the repo defines and production lacks are
features that cannot work there.

**What this does not license.** Nothing here applies a migration or stamps the
ledger; both remain human-owned per `docs/PENDING_PROD_MIGRATIONS.md`, and the
baseline gate is still doing its job by refusing. The remaining F5 work is
unchanged and is step 2 of two: reconcile the ledger against the live catalogue,
verifying each migration's objects before stamping, because a missing entry is
not proof the objects are missing.

## F5 step 2, asked of production rather than guessed (2026-09-13)

With the token working, the repo's own sanctioned path was run in its
**read-only** mode — `supabase-forward-release.yml` with `apply: false`, which
executes `apply-production-forward-release.mjs` with no flags and skips the
verify step entirely. Nothing was applied and nothing was stamped.

It refuses, and names the reason
([run 34781290560](https://github.com/NewWorldVenture/Bubaly/actions/runs/34781290560)):

```
Production forward release is held: repository migrations outside the pinned
0240-0254 release: 00260_display_layouts.sql, … 0294_family_scoped_read_indexes.sql
```

**71 migrations** sit outside the reviewed window. The release manifest was
pinned when `0240`–`0254` was the frontier; `main` is now at `0294`. So the
blocker has moved: it is no longer the access token, and it is no longer only
the baseline gate. The sanctioned apply path is pinned to a release that no
longer describes the repository.

That is the gate working as designed rather than a fault — `assertPreflight`
also refuses on a partially-applied ledger, on a release table that exists
without its migration, and on any boundary drift. But it means **step 2 cannot
be performed by running the existing workflow**. Someone has to re-pin the
manifest, in reviewed tranches, across those 71 migrations. That is a review
decision about what may touch production data, which is precisely the decision
this repository reserves for a human, and it is why nothing here attempted it.

**Worth noticing in that list:** the migrations interleave two numbering
schemes — five-digit names (`00260_display_layouts.sql`,
`01050_calendar_events_rls_repair.sql`) among four-digit ones (`0255`–`0294`).
Lexically `00260` sorts *before* `0255`, so the two families do not order the way
their numbers suggest. Recorded as an observation, not a finding: the five-digit
names appear to be the older scheme and sorting first may well be historically
correct. Anyone re-pinning the manifest should confirm that rather than assume
it, because the apply order is what a replay depends on.

---

# Pass H — Storage object paths (H-01)

Passes A–G asked their questions of **tables**. Nothing asked them of
`storage.objects`, and a family's photos do not live in a table.

Seven buckets exist. Three are private (`documents`, `chore-proof`,
`marketing-assets`); four are public (`avatars`, `marketplace-photos`,
`feedback-attachments`, `family-media`).

`family-media` being public is a **known, owner-tracked decision**, and
`0216_family_media_bucket.sql` states it plainly: consumers resolve attachments
with `getPublicUrl`, existing rows in `family_photos` / `family_messages`
already store public URLs, so flipping the bucket to private would break every
stored link, and hardening reads to signed URLs is tracked separately. That is
not re-litigated here.

What that decision implies, and the migration does not say, is the finding.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| H-01 | Four of six upload sites named objects with a millisecond timestamp, in a bucket where the path is the only access control | High | **Fixed** — this branch |

---

## H-01 — An enumerable name in a public bucket *(High, fixed)*

While the bucket is public, Supabase serves
`/storage/v1/object/public/family-media/<path>` to **anyone** — no session, no
RLS. The family-scoped `SELECT` policy 0216 adds governs the *authenticated*
Storage API; it is not in the path of a public URL. So the object path is the
entire access control.

Six places upload here. They did not agree on what a path is for:

| site | path | |
|---|---|---|
| `photos-module.tsx` | `${familyId}/${folder}/${crypto.randomUUID()}.${ext}` | unguessable |
| `create-memory.tsx` | `${familyId}/photos/${crypto.randomUUID()}.${ext}` | unguessable |
| `closet-module.tsx` | `${familyId}/closet/${Date.now()}.${ext}` | **enumerable** |
| `inventory-module.tsx` | `${familyId}/inventory/${Date.now()}.${ext}` | **enumerable** |
| `messages-module.tsx` | `${familyId}/messages/${Date.now()}.${ext}` | **enumerable** |
| `reminders-module.tsx` | `${familyId}/reminders/${Date.now()}.${ext}` | **enumerable** |

A millisecond timestamp is not a secret. The family id is the only other
component, and it is known to every current **and former** member. A day holds
86.4M timestamps across three or four plausible extensions, and real uploads
cluster into narrow windows, so a bounded scan finds them.

The consequence is about people rather than arithmetic: **removing someone from
a family did not stop them reading its closet, home-inventory, message and
reminder attachments — or discovering new ones as they were added.** Message
attachments are the sharpest of the four. Photos and Create-Memory, the two
sites whose authors clearly thought about this, were already right; the
disagreement between them is what made it visible.

### The fix

`familyMediaPath(familyId, kind, fileName)` in `lib/storage/family-media.ts` —
one place that decides this, which all six sites now call. It keeps the family id
as the first segment, because 0216's INSERT policy is
`is_family_member((storage.foldername(name))[1])` and an upload whose first
segment is not the family is refused.

Deliberately **not** a migration: nothing here changes the bucket, and existing
objects keep their stored paths, so no stored link breaks. That matters because
the production migration ledger is gated (F5) — this had to be fixable without
it, and it is.

**It does not close SEC-001.** Objects uploaded before this remain enumerable,
and the bucket is still public. The real fix is still signed URLs, which is the
owner's tracked work. This removes the part that needed no migration and should
not have waited for one.

## How Pass H is kept closed

`tests/family-media-paths-are-not-guessable.test.ts` — **8 cases**.

| what it holds | how |
|---|---|
| The helper is unguessable | 500 paths, no collision; no epoch-shaped run of digits; at least 32 characters of unique segment |
| The family folder stays first | or 0216's INSERT policy refuses every upload |
| No site builds its own path | a sweep over every file that touches the bucket, failing with the file and line |
| No uploader reaches for `Date.now()` | the specific defect, named separately so the reason survives |
| The sweep can see | a synthetic good and bad line, because a pattern that never matches passes forever |

Proved load-bearing by reverting one site to `${Date.now()}`: two cases fail,
naming `components/modules/closet-module.tsx:415`.

One existing test needed changing rather than satisfying.
`tests/family-media-persistence.test.ts` asserted the literal string
`crypto.randomUUID` inside each component — the right invariant written as an
implementation detail, which a move into a shared helper necessarily breaks. It
now asserts the components call `familyMediaPath()`, the same correction made
once before in this repository when `wallet-money-action-boundaries` pinned a
local helper by name. Its third file, the marketplace uploader, writes to a
different bucket and still rolls its own, so it keeps the original assertion.

---

## Observed and not fixed: a CI check that passes on cache luck

`tests/e2e/marketing-public.spec.ts:11` — *"the mobile menu becomes usable when
its client code is ready"* — failed once on #510's merge head and passed on a
cold re-run. The mechanism is worth recording, because the next person to see it
will otherwise call it a flake and re-run, which is what happened here.

The test intercepts `/_next/static/*.js` to hold hydration back, then asserts it
actually held something:

```ts
await slowPage.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async (route) => { heldScripts += 1; … });
await slowPage.goto('/', { waitUntil: 'commit' });
await expect.poll(() => heldScripts).toBeGreaterThan(0);   // failed: 0
```

`beforeEach` has already navigated the `page` fixture to `/`, and the test then
opens `context.newPage()`. Both share one `BrowserContext`, so the chunks can be
served from that context's HTTP cache with **no network request** — the route
handler never fires and `heldScripts` stays 0. Playwright's own retry reuses the
same context, which is why `Retry #1` reproduced it rather than clearing it; a
fresh CI container, with a cold cache, passed.

So the assertion measures *whether a request happened*, which depends on cache
state the test does not control. It is not wrong about the behaviour it targets —
a menu that stays inert until its code arrives — it is just not reliably
exercising it. Roughly one run in some number silently tests nothing, and
occasionally fails outright.

**Not fixed here, deliberately.** It is green, it belongs to no finding in this
document, and changing a passing test on someone else's branch to satisfy a
hypothesis is how an audit starts widening into work nobody asked for — the same
reason `endEmergencyAction`'s missing audit row is recorded above rather than
built. The fix, when someone wants it, is one line: open the slow page in a
**fresh context** (`browser.newContext()`) rather than `context.newPage()`, so
the interception is deterministic. That strengthens the test rather than
relaxing it, which is the only acceptable direction.

---

# Pass I — Role boundaries (I-01)

Pass D asked two questions and said plainly that it was not asking a third. It
established *who* is calling (`requireUserContext`) and *which family* they may
write to (the cross-tenant sweep). It did not ask which **role**. For a family
product that is the sharpest version of the question: can a child reach what a
parent decides?

- **Surface:** 487 exported server actions; **311** mutate a table; **213** of
  those reach no role gate at all.
- **Why 213 is not 213 findings:** most are participation, not governance — a
  child adding a grocery item, logging a chore, writing their own
  `user_preferences`. And the app layer is often not where the boundary lives.

## The boundary is in the database, and mostly it is right

Of the 130 distinct tables written without an app-layer role gate, **none** has
a restrictive write policy — the money tables, which do, never appear, because
their actions *are* role-gated. The 172 permissive write policies on the rest
are `is_family_member(family_id)`: any member, a child included.

So the question became which of those tables are governance rather than
participation. Checked individually, the governance ones are gated in the
database, and gated well:

| table | write policy | verdict |
|---|---|---|
| `family_members` | `can_manage_family(family_id)` on insert, update **and** delete | a child cannot change membership or roles |
| `invites` | `can_manage_family`, plus an update clause letting the invited person accept their **own** invite by matching their JWT email | exactly right |
| `parent_approvals` | insert `is_family_member AND status='pending' AND decided_by IS NULL AND decided_at IS NULL`; update/delete `can_manage_family` | a child may **ask** but cannot **decide**, and cannot forge a pre-approved row |
| `subscriptions` | `is_family_admin(family_id)` | plan changes are the parent's |

`parent_approvals` is the one worth singling out: the insert policy does not
merely check membership, it pins the *shape* of the row a member may create. That
is the defense this pass went looking for, implemented one layer lower than the
app.

So the alarming-sounding number is mostly the app layer correctly declining to
duplicate a check the database already enforces.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| I-01 | A social restriction could be removed by the person it restricted | Medium | **Fixed** — `0295`, this branch |

---

## I-01 — The one table whose verbs disagreed *(Medium, fixed)*

`social_access_permissions` is an **override** table. `lib/social/access.ts`
resolves a caller's social role as *"an explicit row wins; otherwise fall back to
a default derived from their household member role"*, and those defaults
(`lib/social/roles.ts`) are:

```
parent -> admin              adult -> marketing_manager
teen   -> content_creator    everyone else -> read_only
```

An override is therefore the mechanism for holding someone **below** their
default. `0034` gated who may create one — and did not gate who may remove one:

```
insert / update : is_family_admin(family_id) OR social_has_permission(family_id,'manage_access')
delete          : is_family_member(family_id)          ← any member
```

Deleting the row restores the higher default. So a member pinned to `read_only`
could lift their own restriction: an adult back to `marketing_manager`, which
carries `publish_posts`, `schedule_posts`, `approve_posts` and `manage_settings`
— back to posting on the family's connected social accounts. A teen pinned to
`read_only` returns to `content_creator`.

**No application code deletes from this table**, which is why it is invisible
from the app — and why it did not matter. Every member holds a JWT and can issue
the delete straight to PostgREST. `access.ts` says as much in its own header:
*"RLS is the backstop."*

`0295_social_access_delete_matches_grant.sql` makes delete carry the same
condition as insert and update. Nothing else changes: members keep `SELECT`, and
an admin can still remove an override.

**Not applied to production.** The migration is authored and replays clean in
sequence, but production's ledger is gated (F5) and applying is the owner's.

## How Pass I is kept closed

`docs/audit/social-access-symmetry-check.sql` (**A-17**) — five assertions,
behavioural rather than structural, picked up automatically by the glob in
`run-probes.sh`.

| what it holds | how |
|---|---|
| A restricted member cannot delete their own override | seeds a parent and an adult pinned to `read_only`, acts **as the adult**, and requires the delete to affect 0 rows |
| An admin still can | the positive control — a guard that refuses everyone proves nothing about a boundary |
| The three write verbs agree | compares the policy expressions directly, so a future change to one verb alone fails here |
| **It detects the state it forbids** | restores `0034`'s permissive delete inside a transaction and requires the member's delete to succeed — if the old policy no longer lets them through, the probe says so and fails |
| It leaves no trace | asserts the planted policy is gone after rollback |

Verified on a **fresh** bootstrap rather than the database it was developed
against: **308 migrations applied, 0 failed, 17/17 probes pass.**

---

# Pass J — What the AI may do (0 findings)

Bubaly acts on a family's behalf, so the last surface worth asking about is what
the assistant itself is allowed to do.

The design is sound and worth stating before the question. `lib/ai/tools/registry.ts`
is a **closed set** — `executeTool` looks a name up and denies anything absent,
so a hallucinated `finances.transferMoney` is refused rather than attempted. Every
tool carries a domain, a capability, a risk tier and a schema, and writes go
through `evaluateTrust` with an `approval_requests` row when the household's
policy says so.

- **Surface:** **94 tools — 48 declaring `readOnly: true`, 46 declaring `false`.**
- **The question:** `readOnly` means *"the tool cannot change anything"*, and
  `execute.ts` **skips the write gate** for such a tool — no `evaluateTrust`, no
  approval, and `trailActionFor()` returns `null`, so nothing reaches the
  household trail either. The gate believes what each tool says about itself.
- **Result:** all 48 are honest. **No finding.**

## What was actually checked, and one false positive worth keeping

A first sweep reported `routines.list` — declared `readOnly: true` — as reaching
a mutation through `listRoutines()`. It does not. `listRoutines` is a pure
`.select()`; the `.update(` belonged to **`setRoutineEnabled` beneath it**, and
the sweep had taken a fixed 1,500 characters after the function signature rather
than the function's actual body.

That is the fifth pattern-based miscount in this audit, and the guard below is
written to make it the last of its kind here: bodies come from the TypeScript
parser by brace matching, and one of the five cases pins `routines.list`
specifically as clean, so the false positive cannot come back silently.

## How Pass J is kept closed

`tests/readonly-tools-cannot-write.test.ts` — **5 cases**.

| what it holds | how |
|---|---|
| The registry is actually being read | floors on tools parsed, read-only tools, and write tools — a sweep over an empty registry passes forever |
| No read-only tool reaches a mutation | its handler, plus every function it calls one level into the project's own imports |
| It fires on an inline write | a planted `readOnly` tool that deletes in its own handler |
| **It fires on a write reached through a helper** | the harder half — handlers delegate, so a check that read only the handler would miss a tool whose service call does the writing |
| It does not mistake a pure read for a write | `routines.list` pinned clean, so the character-window false positive is a regression test rather than a memory |

Proved load-bearing against the real registry rather than only against planted
input: flipping `routines.create` to `readOnly: true` fails the sweep with
*"routines.create (lib/ai/tools/routines.ts) writes via createRoutine() in
lib/services/routines/index.ts"*.

**Also re-audited here:** `app/api/blog/search-index/route.ts`, a new **public**
route that landed on `main` after Pass F's sweep had run. Checked against the
same criteria: it sits under the public `/api/blog` prefix, is IP rate-limited at
60/min, and serves only published posts — `getAllPosts()` goes through
`fetchAllPublishedRows` **and** `publicRows`, so the claim in its comment holds
against the code. Its degradation to an empty index is logged, with the comment
citing the stale-sitemap defect (**F-012**) that once hid behind that same catch.
Clean.
