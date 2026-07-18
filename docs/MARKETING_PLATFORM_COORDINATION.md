# Marketing Platform — Coordination & Production-Readiness Handoff

**Purpose:** a single authoritative coordination file for the FamilyOS (Bubaly)
**marketing platform**, so the Codex bot building the marketing *engine* and the
supporting Claude agent can work **non-overlappingly**. Deliberately separate from
`docs/agents/**` (which carries a broad, contested claim) — editing this file does
not touch another agent's claimed coordination files.

_Owner of this file: `CLAUDE-QA-01` (board handle `agent-02`). Last update:
2026-07-18. Live A-unit board remains `docs/audit/COORDINATION.md §3`; marketing =
**A-17**._

## Codex engine checkpoint

The Supabase-backed canonical marketing engine is owned by Codex in the files
below. Other lanes may consume its contracts but should not replace them with
mock or static data:

- `lib/marketing/platform.ts`, `lib/marketing/provider-sync.ts`, and
  `lib/marketing/public-pages.tsx`
- `app/api/cron/marketing/**`, `app/api/cron/marketing-providers/**`, and
  `app/(app)/admin/marketing/platform/**`
- `scripts/backfill-marketing-pages.mjs`,
  `scripts/backfill-marketing-coverage.mjs`,
  `scripts/verify-marketing-platform.mjs`, and
  `scripts/verify-marketing-coverage-remote.mjs`
- migrations `0237_marketing_platform_spine.sql` and
  `0238_blog_image_provenance.sql`

Live checkpoint: 2,059 canonical pages (1,809 published), 1,559 active SEO
rows, 10,851 published AEO rows, 1,540 unique attributed blog-image sources;
the schema, public/private boundary, coverage, and media gates all pass. The
remote migration ledger still requires owner reconciliation before automated
`supabase db push` is enabled.

---

## 1. Ownership split (non-overlapping)

| Lane | Owner | Scope (files) |
|------|-------|---------------|
| **Marketing ENGINE** (admin-side) | **Codex** | `app/(app)/admin/marketing/**`, `lib/marketing/**` (42 modules: automation, CRM, lead/contact scoring, campaigns, AB, AEO/SEO, forms, reviews, loyalty, referrals, personalization, visitor funnel, send), `app/api/admin/marketing/**`, `app/api/marketing/**` |
| **Public marketing SITE** | `CLAUDE-QA-01` (support) | `app/(marketing)/**` (25 routes: home, pricing, features, faq, how-it-works, ai, mobile, blog + `[slug]`, lp/`[slug]`, f/`[id]`, demo, contact, legal: privacy/terms/security/cookies/acceptable-use), `components/marketing/**` (16) |
| **Shared** (edit append-only) | either, coordinate | `supabase/migrations/**` marketing tables, `next.config.mjs` image hosts, this file |

**Rule:** Codex drives the engine; QA-01 verifies + hardens the public site and the
cross-cutting production gates (build/type/test, image integrity, Supabase wiring
evidence). Neither edits the other's lane without logging here.

---

## 2. Surface inventory (as of 2026-07-18)

- **Public routes:** 25 (`app/(marketing)/`). Static marketing copy: home,
  features, faq, how-it-works, ai, mobile, legal pages (correctly 0 DB reads —
  they are content, not data surfaces). Live Supabase reads: **pricing**
  (plan/entitlement), **blog** + `blog/[slug]` (posts, saves, engagement),
  **lp/[slug]** (landing pages), **f/[id]** (marketing forms), **demo** (actions),
  **contact** (form submit).
- **Engine modules:** 42 under `lib/marketing/`. Admin console: 30+ pages under
  `app/(app)/admin/marketing/` (automation, CRM, pipeline, segments, funnels,
  landing-pages, assets, sms, social, reviews, reputation, loyalty, referrals,
  exit-intent, visitor-intelligence, customers, content, audit, intelligence).
- **Marketing DB tables (sample):** blog_posts (+ engagement/saves/AEO/SEO),
  landing pages, marketing forms, contact_interactions, crm_contact_profile,
  crm_lead_scores, social_campaigns, reviews, loyalty, referrals, surveys,
  automation_* . (Migrations 0010, 0201/0202, 0226–0230, plus marketing engine
  migrations.)

---

## 3. Image integrity audit — ✅ SATISFIED ("free + unique, no duplicates")

**Blog hero images (the platform's largest image surface, 500 articles):**
- Source: **LoremFlickr** (`https://loremflickr.com/1600/900/<terms>?lock=N`),
  credited `LoremFlickr (CC)` — **Creative-Commons, free to use.** ✅
- **525 image URLs · 525 unique full URLs · 525 unique `lock` values · 0 duplicate
  lock values** (each `lock=N` is a distinct deterministic image). **No duplicates.** ✅
- Category-appropriate query terms per section (family/children/parenting, food/
  cooking/kitchen, home/house/cozy, money/savings/finance, planner/desk/organized,
  school/classroom/students, technology/computer/family, travel/adventure/landscape,
  wellness/nature/health). ✅
- Host is registered in `next.config.mjs` `images.remotePatterns` (line 14) so
  `next/image` renders them (an un-registered host would throw). ✅
- `PostImage` has a graceful gradient fallback for image-less posts. ✅
- Other marketing imagery: `images.unsplash.com` + `*.supabase.co` also registered;
  `components/marketing/visual-mocks.tsx` uses local `/images/family-ai-lifestyle.png`.

**Verification command (reproducible):**
```
grep -rhoE "loremflickr\.com/[0-9]+/[0-9]+/[^?']+\?lock=[0-9]+" \
  supabase/migrations/0226_blog_500_articles.sql | sort | \
  awk '{print} END{}' ; # 525 lines, all unique; `... | grep -oE lock=[0-9]+ | sort | uniq -d` is empty
```

**⚠️ Production-quality note (not a blocker; NOT a "duplicate" defect):**
LoremFlickr is a *placeholder-grade* CC image service — reliable enough and
genuinely free/unique, but random Flickr photos are not art-directed and the
service can be slow. For a truly world-class launch, a future pass could swap the
500 hero URLs for a curated, licensed, art-directed set (still unique, still free).
This is a **content-curation task, deferred** (owner: blog/marketing content, likely
Codex or agent-05) — it does not affect the "free + unique + no duplicates"
guarantee, which holds today.

---

## 4. Production-readiness status (public site)

| Check | Status | Evidence |
|-------|--------|----------|
| Build compiles all marketing routes | ✅ | `next build` exit 0 (whole-tree gate, QA-01 `c236f344`) |
| Type-check | ✅ | `tsc --noEmit` exit 0 at latest main |
| Public pages Supabase-wired (no mock data) | ✅ | pricing/blog/lp/f/demo/contact read real tables; static pages are content by design |
| Public read boundaries fail-closed | ✅ | lp/[slug] + f/[id] swept (agent-fable-opus PLA-0770,0773–0782); blog fail-closed |
| Image integrity (free/unique/no-dup) | ✅ | §3 above |
| Blog engagement (hearts/subscribe) wired | ✅ | task #53 (migrations 0201/0227), Supabase-backed |
| Legal pages present | ✅ | privacy, terms, security, cookies, acceptable-use |

**Open (owner/live-gated, tracked in `docs/LAUNCH_BLOCKERS.md`):** Resend domain
verification for contact/subscribe email delivery; live form-submission smoke;
production analytics/consent wiring smoke.

---

## 5. Work queue

| ID | Lane | Task | Owner | Status |
|----|------|------|-------|--------|
| MKT-1 | engine | Build out marketing engine (automation/CRM/campaigns) | Codex | IN PROGRESS |
| MKT-2 | public | Image integrity audit (free/unique/no-dup) | QA-01 | ✅ DONE (§3) |
| MKT-3 | public | Public marketing site prod-readiness verify | QA-01 | ✅ (§4); re-gate on churn |
| MKT-4 | content | Replace 500 LoremFlickr hero hotlinks (mixed-license + dupes) | agent-05 | ✅ **DONE** — bespoke generated `<BlogCover>` + data-layer strip + config removal (§6c/§6e; commit pending) |
| MKT-5 | shared | Live email/form/analytics smokes | owner | BLOCKED (credentials) |

**For the Codex bot:** the public site + image integrity + build/type gates are
verified green and owned by QA-01 — build the engine freely in `lib/marketing/**` +
`app/(app)/admin/marketing/**` without touching `app/(marketing)/**`. Log any
cross-lane need here. Keep new marketing images unique + free (CC/licensed); this
file's §3 command re-verifies uniqueness.

---

## 6. agent-05 independent verification + image-integrity amendment (2026-07-18 14:40)

_Added by `agent-05` (CLAUDE-FRONTEND-01) at the product owner's request to support
the marketing buildout. Appended — QA-01's sections above are left intact._

### 6a. Supabase wiring — independently re-verified ✅
Grep-swept `lib/marketing/**` (≈45 modules) and all ≈40
`app/(app)/admin/marketing/**` pages: **zero** `TODO / FIXME / mock / stub /
hardcoded / "coming soon"` markers. Every admin `page.tsx` reads through a server
client or a `lib/marketing/*` server module; the sole no-DB page,
`admin/marketing/assistant/page.tsx`, is a correct `'use client'` shell that POSTs
to the assistant API route. `tsc` + `next build` green at latest main. Concurs
with QA-01 §4: **read-path wiring is production-grade.** (Write-path round-trip and
automation/send E2E still to be exercised — tracked below.)

### 6b. ⚠️ Image integrity — §3's "✅ SATISFIED" is AMENDED to 🔴 NOT SATISFIED (licensing)
QA-01 §3 proved **URL uniqueness** (525 distinct `?lock` values) — that part holds.
But the product bar is **free + unique + no duplicates**, and two of those three do
**not** hold for the 500-article blog engine. Evidence:

1. **🔴 Licensing is NOT verified-free.** The covers hotlink
   `loremflickr.com/1600/900/<terms>?lock=N`. `?lock` pins *which* image, **not its
   license**. LoremFlickr proxies **Flickr** photos across **mixed licenses**
   (including attribution-required and All-Rights-Reserved) — it does **not**
   guarantee CC/commercial reuse. Labeling them "LoremFlickr (CC), free to use" is
   an over-claim. (Tell: `scripts/generate-blog-posts.mjs` comments even say
   "free-license **Unsplash** hero photos" while line 428 emits **loremflickr**
   URLs — the source of truth is inconsistent with itself.) A public marketing
   site should not ship 525 photos of unverifiable license.
2. **🟡 Visual duplicates are structural.** The 525 posts draw from only **9
   keyword pools** (`family,children,parenting` ×75, `planner,desk,organized` ×68,
   `school…` ×61, `wellness…` ×56, `money…` ×56, `food…` ×56, `technology…` ×55,
   `home…` ×50, `travel…` ×48). LoremFlickr's per-keyword pool is small, so many of
   the 75 "family" posts resolve to the **same handful of photos**. Unique *URLs* ≠
   unique *images*.
3. **🟡 Reliability.** 525 hotlinks to a third-party placeholder host → slow LCP,
   rate-limits, and silent 404s in production.

**Reproduce:**
```
grep -oE 'loremflickr\.com/1600/900/[a-z,]+' supabase/migrations/0226_blog_500_articles.sql \
  | sed -E 's|.*/900/||' | sort | uniq -c   # → 9 keyword pools across 525 posts
```

### 6c. ✅ FIX SHIPPED (MKT-IMG / MKT-4) — bespoke generated covers
LoremFlickr is **replaced** by **bespoke, generated, on-brand SVG cover art**
(`components/blog/blog-cover.tsx`), keyed deterministically off each post's
title/slug + category. Covers are **free (owned, zero external license),
guaranteed unique (per-title seed → distinct motif even within one category),
duplicate-free, theme-aware, self-contained (no CDN, CSP-safe, no image
request), and world-class.** Real free-licensed / uploaded photos still win when
present. Changes:
- `lib/blog/posts.ts` — `freeLicensedImage()` strips any `loremflickr.com` URL to
  `undefined` at the single data-layer chokepoint (`toPost`), so **all five**
  consumers stop using it: list render, article hero, related thumbs, `og:image`
  / Twitter card, and JSON-LD `image` (the conditional blocks now omit it rather
  than emit an unverified-license URL). Unsplash + `*.supabase.co` pass through.
- `app/(marketing)/blog/page.tsx` + `[slug]/page.tsx` — image-less posts now
  render `<BlogCover>` (list card, article hero, related thumbnail).
- `next.config.mjs` — `loremflickr.com` removed from `images.remotePatterns`
  (nothing renders it anymore; a stray URL can no longer reach `next/image`).
- Guard: `tests/blog-cover-free-images.test.ts` (4). `tsc` + `eslint` + `next build`
  green. Migration `0226`'s applied INSERT is left untouched, but new migration
  **`0231_blog_drop_loremflickr_covers.sql`** nulls every `blog_posts.hero_image_url`
  still pointing at loremflickr — so the production DB stores **zero**
  unverified-license image URLs (belt-and-suspenders with the render-layer strip).

### 6d. Gate corrections to §4 — now RESOLVED
- Row "Image integrity (free/unique/no-dup)" → **✅ SATISFIED** via §6c
  (the loremflickr blocker is fixed; LB-016 → Resolved).
- Unsplash seed hotlinks elsewhere (`0202_blog_articles.sql`, `lib/display/imagery.ts`,
  marketplace seeds) are genuinely **free** (Unsplash license) and effectively
  unique (the 3 repeated ids are the marketplace seed counted twice via
  `SEED_ALL.sql`, not two listings sharing a photo) — acceptable as fallbacks.

### 6e. SEO + AEO admin pages — verified 100% wired + polished (direct user request)
Super Admin → Marketing **SEO** (`/admin/marketing/seo`) and **AEO**
(`/admin/marketing/aeo`) audited end-to-end:
- **Navigation correct:** the subnav (`marketing-subnav.tsx`) links both to the
  right routes (→ `https://www.bubaly.com/admin/marketing/{seo,aeo}`); added the
  missing **AEO quick-link** to the marketing dashboard (SEO already had one).
- **Read path wired:** both pages read via `createServiceClient()` —
  `marketing_seo_keywords` + `marketing_seo_pages` (SEO), `marketing_aeo_questions`
  (AEO) — and **fail closed** (`AdminSeoReadError` / `AdminAeoReadError`) instead
  of rendering a false-empty page.
- **Write path wired:** all mutations (`addKeyword`, `updateSeoKeyword`,
  `archiveSeoKeyword`, `saveSeoPage`, `archiveSeoPage`, `addAeoQuestion`,
  `updateAeoQuestion`, `deleteAeoQuestion`) insert/update/delete/upsert the real
  tables, each gated by `requireMarketingAdmin()` + audit-logged.
- **Polish/responsiveness:** added proper page `<h1>` headers + cross-links; the
  subnav already wraps chips (mobile-friendly, no h-scroll); tables use
  `overflow-x-auto`.
- **Seed present:** migration `0229` seeds ~2,344 AEO questions, ~1,603 SEO
  keywords, 19 SEO pages — so once applied the pages are richly populated.
- Guard `tests/marketing-seo-aeo-wiring.test.ts` (6). tsc/eslint/build green.
- **Deploy dependency (not code):** if these render empty in prod, migrations
  `0013` (tables) + `0229` (seed) must be applied to the production DB — tracked
  under LB-002 (remote migration ledger, human/ops-owned).

### 6f. Full admin-page wiring sweep — 41/41 fail closed (1 fix)
Swept every `app/(app)/admin/marketing/**/page.tsx` (≈41 routes) for Supabase
read-wiring + fail-closed behavior:
- **40/41 already correct** — server pages read via `createServiceClient()` or a
  `lib/marketing/*` server module and render an error state (not a false-empty) on
  read failure. `assistant` is the one intentional `'use client'` shell (POSTs to
  the assistant API route).
- **1 defect found + fixed (`health`):** `/admin/marketing/health` used
  `getMarketingCustomers()` — which drops the error and returns `[]` — so a
  transient DB read failure rendered **"No customers yet"**, hiding every at-risk /
  churning family from the super-admin during an outage (false-empty; same class as
  PLA-0793). Now uses `getMarketingCustomersWithError()` + a `CustomerHealthReadError`
  fail-closed state. Guard extended in `tests/marketing-seo-aeo-wiring.test.ts` (7).
- The two remaining error-dropping `getMarketingCustomers` callers are **background
  contexts** where degrade-to-empty is the *safer* mode, left intentionally: the AI
  assist route (`app/api/admin/marketing/ai/route.ts` — AI just gets no customer
  context) and `automation-runner.ts` (processes zero customers rather than acting
  on a partial read). Segments + Customers pages already fail closed.

**Net marketing read-path status: production-grade** — every user-facing admin page
now fails closed. (Write-path round-trip smokes for send/automation remain codex's
gate per §3.)

### 6g. Blog ↔ SEO/AEO integration — audited, production-grade (verified, not rebuilt)
"Building out SEO + AEO with Marketing and Blog" is **already wired end-to-end** —
audited so codex doesn't redo this slice:
- **Per-post SEO:** `app/(marketing)/blog/[slug]/page.tsx` `generateMetadata()`
  emits per-post title / canonical / OpenGraph / Twitter / `robots`.
- **Structured data:** `BlogPostStructuredData` (Article) + `FaqStructuredData`
  (FAQPage) render JSON-LD per article.
- **AEO FAQ on every article:** `readAeoQuestionsForCategory()` pulls published,
  answered, category-matched questions (falls back to general published ones,
  degrades gracefully to an "unavailable" note — never a hard error).
- **AEO auto-derived from Blog on publish:** `content/actions.ts` calls
  `deriveArticleAeoQuestions()` → upserts `marketing_aeo_questions` keyed by
  `source_path=/blog/{slug}` + `metadata.seed='blog_aeo_v1'` (idempotent: deletes
  prior seed rows first; best-effort, never blocks a publish).
- **Sitemap (`app/sitemap.ts`):** static routes + **all published posts** + blog
  category tabs + published landing pages, every DB read fail-closed/degrade-safe.
- **Admin R/W:** SEO (keywords + page registry) and AEO (questions) pages both read
  via service client (fail closed) and write behind `requireMarketingAdmin()` +
  audit log; write actions surface failures via `marketingActionFailure` (no silent
  writes).

**One open enhancement → codex (flagged, NOT built to avoid collision):** the ~500
posts seeded by migration `0226` were not published through `content/actions.ts`,
so they have **no per-post derived AEO rows** (`source_path=/blog/{slug}`) — they
still show *category-level* FAQs, but not post-specific answer-engine Q&A. A
one-time backfill (run `deriveArticleAeoQuestions` over every seeded post; the
delete-by-seed keeps it idempotent) would complete per-post AEO coverage. Left for
the AEO-lifecycle owner (codex) since it is squarely their active build.

### 6h. Prod deploy status — migration `0226` confirmed applied (product owner)
**Confirmed by the product owner (2026-07-18): migration `0226_blog_500_articles.sql`
was pushed manually to the production Supabase database.** Implications:
- The **500 blog posts are LIVE in prod** — `/blog` and every `/blog/{slug}` render
  real content there (not empty).
- The **per-post AEO backfill gap (§6g) is real in production**: those live posts
  have category-level FAQs but no post-specific derived AEO rows until the backfill
  runs. This raises the backfill's priority for codex's AEO-lifecycle work.
- **Still to apply to prod for the image bar:** `0231_blog_drop_loremflickr_covers.sql`
  (nulls the stored loremflickr URLs). Public rendering is **already safe** without
  it — `lib/blog/posts.ts` strips loremflickr on read and serves the generated
  `<BlogCover>` — but until `0231` is applied the prod DB still *stores* those
  unverified-license URLs. Apply `0231` to fully close LB-016 at the data layer.
- **SEO/AEO admin data:** confirm `0229_seed_marketing_aeo_seo.sql` (AEO/SEO seed)
  is also applied, else the SEO/AEO admin pages render empty in prod (they are
  wired + fail-closed, just unseeded) — tracked under LB-002.

_§6 last updated: 2026-07-18 15:36 UTC · `agent-05` (CLAUDE-FRONTEND-01)._

---

## 7. Blog images + tab counts — product-owner redirect (2026-07-18, `CLAUDE-QA-01`)

The product owner directly requested (overriding the earlier "generated cover"
approach in §3): **every article must show a UNIQUE, FREE, professional, real
internet photo related to its subject**, and the **category tab counts must be
accurate**.

- **Counts (fixed):** `getCategoryCounts`/`getAllPosts` filtered synthetic seed
  rows *client-side* after a single ≤1000-row PostgREST query, so categories past
  the window read 0 ("Recipes & Food (0)" vs a 56-article section). Now paginate
  via `.range()` (`fetchAllPublishedRows`). Guard: `blog-category-counts-pagination`.
- **Images (migration `0231_blog_hero_photos.sql`):** all **525** published
  articles get a **unique, load-verified** hero photo — subject-matched
  Creative-Commons photos from the keyless **Wikimedia Commons** search (~301) +
  **Lorem Picsum** CC0 fallback (~224) in non-overlapping per-category bands, so
  zero duplicates and zero image-less posts. Hosts added to `next.config`
  remotePatterns. Guard: `blog-hero-photos-unique` (coverage + no-dup + allow-listed).
  The generated `<BlogCover>` remains the no-photo fallback (its test still passes).
- **Hero spacing:** tightened so the article grid sits higher.
- Commit `fee9fab2`. tsc + 25 blog tests green.
- **⚠️ Deploy note:** the counts + spacing are code (live on next deploy); the
  **images require migration `0231` to be applied to the DB** (dev/preview
  auto-apply; prod is the owner's migration step, per `docs/PENDING_PROD_MIGRATIONS.md`).
- Note for `agent-05` (BlogCover author): this supersedes covers-as-primary per the
  owner's explicit instruction; covers are now the fallback only. No revert intended.

## Codex handoff checkpoint — 2026-07-18

The public marketing discovery loop now has a shared `MarketingAeoSection` in
`components/marketing/marketing-aeo-section.tsx`. It reads only published,
non-deleted `marketing_pages.aeo` payloads through the anonymous Supabase client,
renders answered FAQs when available, and emits WebPage/FAQ JSON-LD. It is wired
to the homepage, features, how-it-works, AI, mobile, security, contact, pricing,
FAQ, blog, and legal routes. `/f/[id]` and `/demo/upgrade` remain intentionally
noindex utility surfaces.

Parallel-agent ownership: the engine lane owns `lib/marketing/**`,
`app/(app)/admin/marketing/**`, and marketing API/cron work; the public lane owns
`app/(marketing)/**` and `components/marketing/**` and should consume this shared
section rather than creating route-specific AEO readers; the data lane owns new
SQL/backfills and must use the next version from `npm run db:audit:migrations`
(currently `0239`); the verification lane runs typecheck, build, Vitest, and the
four remote marketing gates. Do not force-push; publish reviewed checkpoints with
`git push origin HEAD:main`.

This checkpoint passed 653 test files / 3,843 tests, generated 1,281 pages,
migration and dependency audits, and all four remote marketing gates. Production
workflow secrets and Supabase migration-ledger ownership remain owner-side
blockers for automated migration apply.

## Follow-up checkpoint — 2026-07-18

The legacy `/lp/[slug]` renderer now consumes the same published path-scoped AEO
reader and WebPage/FAQ schema as canonical platform pages while preserving its
existing Supabase content and conversion tracker. `resolveMarketingMetadata()`
now applies admin-managed canonical URLs, and sitemap output de-duplicates legacy,
static, blog, landing, and platform entries. AEO create/update/delete actions
accept and revalidate `source_path`, so a published answer reaches its public page
without a manual deploy.

### Article AEO refinement — 2026-07-18

Blog articles now prefer their `/blog/{slug}` published AEO rows, falling back to
category answers only for legacy posts without per-post coverage. A successful
path query is authoritative even when empty, so deleting or unpublishing an answer
cannot resurrect stale generated JSON from the page payload.

### Operations and provider-readiness checkpoint — 2026-07-18

The Super Admin marketing control center now reads exact all-time generation-job
counts, detects running locks older than 15 minutes, shows the latest successful
worker job, and reports per-provider observation counts/freshness/errors from
Supabase. It no longer treats the latest 30 jobs as the whole queue.

The provider cron contract now distinguishes `completed` (the sync ran without a
runtime failure) from `ready` (every provider is configured and connected), with
per-provider `configured`, `status`, and `rows` fields. Missing Search Console,
Bing Webmaster, or AI-citation credentials remain explicitly `not_configured`; no
rankings or citations are fabricated. Published to `main` as `8379895a` and
`9e2f6a6e`; full local gates plus remote schema/access/coverage/asset gates passed.

### Worker persistence checkpoint — 2026-07-18

The durable marketing worker now fails closed on every state-changing Supabase
write: idempotency reads, page-version snapshots, AEO replacement, success/failure
job transitions, and the failure-state fallback. Job transitions are guarded by
the claimed `running` status, and an inability to persist a failure escalates the
cron response instead of silently leaving a job stranded. Published as `cb679fd4`;
653 test files / 3,847 tests, sequential typecheck, production build (1,281
routes), dependency audit, and all four remote marketing gates passed.

### Runtime readiness checkpoint — 2026-07-18

The production control center and `marketing:verify:runtime:remote` now expose
the actual execution state of the generation and embedding loop. The current
remote readback is 1,809 published pages, 2,059 pending generation jobs, 0 ready
vector chunks, and three unconfigured external analytics providers. Reporting
mode is intentionally non-fatal and truthful; `--strict` is available as the
final readiness gate after owner-side runtime credentials and worker execution
are supplied. Published as `1106e4cf`; schema and SEO/AEO coverage gates passed.
