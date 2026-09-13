# Bubaly — Final Audit

Full audit of bubaly.com: what was checked, what was found, what was fixed, and
what remains — with an owner for every remaining item. Every finding here was
reproduced against the live site or the real code path before being written
down; nothing is inferred from a filename or a comment.

**Audit status: complete.** Fourteen findings, and the arithmetic stated
exactly rather than approximately:

| | |
|---|---|
| **Fixed in code** | **9** — F2, F4, F7, F8, F10, F11 from this audit; F1, F3, F14 on `main` via #526, whose sitemap implementation superseded mine and which I withdrew in its favour |
| **Closed without a code change** | **3** — F9 (a decision, with the design and the numbers recorded), F12 (recorded; the fix is not worth its risk), F13 (correct as built — fail-closed routing) |
| **Blocked on credentials** | **2** — F5 (Supabase access token *and* the ledger baseline gate) and F6 (`CONTACT_CENTER_INBOUND_SECRET` + MX records) |

One further observation was **disproved and withdrawn** after re-checking: a
reading that two pages shipped no metadata, which was my own extraction bug.

Nothing is left unexamined or unassigned.

- **Audit opened:** 2026-09-13
- **Audit closed:** 2026-09-13
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
| F5 | Supabase production migration workflow cannot authenticate | High | **Operator — credentials** |
| F6 | Family email routing not configured (`CONTACT_CENTER_INBOUND_SECRET`, MX) | Medium | **Operator — config** |
| F7 | Family email is gated on the screen only — inbound pipeline has no plan check | Medium | **Fixed** — owner chose Family+ |
| F8 | Page titles doubled the brand (`… — Bubaly · Bubaly`) | Low | **Fixed** |
| F9 | Whole 848 KB i18n catalogue serialized into every page | High (perf) | **Closed — decision recorded** |
| F10 | Seeded placeholder records shown as real customer stories on the homepage and /pricing | High | **Fixed** |
| F11 | Five public pages had no `<h1>` at all | Medium | **Fixed** |
| F12 | The 404 page ships no server-rendered markup | Low | **Closed — recorded, not worth the fix** |
| F13 | An unknown top-level path redirects to login instead of 404 | Low | **By design — no change** |
| F14 | Sitemap lists 9 `/blog?category=` URLs whose canonical points at `/blog` | Low | **Fixed on main by #526** |

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
