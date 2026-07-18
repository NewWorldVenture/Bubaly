# Marketing Platform — Coordination & Production-Readiness Handoff

**Purpose:** a single authoritative coordination file for the FamilyOS (Bubaly)
**marketing platform**, so the Codex bot building the marketing *engine* and the
supporting Claude agent can work **non-overlappingly**. Deliberately separate from
`docs/agents/**` (which carries a broad, contested claim) — editing this file does
not touch another agent's claimed coordination files.

_Owner of this file: `CLAUDE-QA-01` (board handle `agent-02`). Last update:
2026-07-18. Live A-unit board remains `docs/audit/COORDINATION.md §3`; marketing =
**A-17**._

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
| MKT-4 | content | Curate 500 art-directed licensed hero images (replace LoremFlickr) | Codex/agent-05 | DEFERRED (quality, not correctness) |
| MKT-5 | shared | Live email/form/analytics smokes | owner | BLOCKED (credentials) |

**For the Codex bot:** the public site + image integrity + build/type gates are
verified green and owned by QA-01 — build the engine freely in `lib/marketing/**` +
`app/(app)/admin/marketing/**` without touching `app/(marketing)/**`. Log any
cross-lane need here. Keep new marketing images unique + free (CC/licensed); this
file's §3 command re-verifies uniqueness.
