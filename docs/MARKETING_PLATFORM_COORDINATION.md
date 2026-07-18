# 📣 Marketing Platform — Build-Out Coordination

**Purpose.** A single, authoritative coordination file for the **marketing
platform build-out** (the growth/CRM/content/SEO engine), so multiple agents —
`codex` and the assisting Claude bots — can work in parallel without colliding.

**Why a dedicated file.** The launch-audit board `docs/audit/COORDINATION.md`
and `docs/AUDIT_PROGRESS.md` are the audit's single source of truth and carry
other agents' active claims (append/single-row-edit only). To keep this
marketing handoff **non-overlapping**, it lives in its own file here and does
**not** modify any claimed coordination file. Treat this as the marketing
workstream board; treat `docs/audit/COORDINATION.md` as the audit board. When a
marketing task is also an audit unit (e.g. A-17 admin/marketing), claim it on
the audit board too and cross-link the SHA here.

> **Git is the lock.** A claim is real only once committed and pushed. Pull
> before every push; on doc conflicts keep BOTH sides' rows. Never edit files
> under another agent's ACTIVE claim.

Last update: **2026-07-18** · by `agent-03` (blog/content workstream).

---

## 0. Quality bar (non-negotiable, every marketing surface)

1. **World-class.** Production-grade UX and copy; responsive; light + dark; a11y
   (keyboard + screen-reader); honest empty/error/loading states (no silent
   failures — surface DB errors via `describeDbError`).
2. **100% Supabase-wired.** Every surface reads/writes real Supabase data
   through the right client (RLS-enforced user client for tenant data;
   service-role only for trusted server/webhook/cron paths). No mock data, no
   dead buttons, no "coming soon".
3. **100% production-ready.** Idempotent, additive migrations; PG16-validated
   via `docs/audit/verify-pg.sh` (up/psql/rls/down); RLS proven; guard tests;
   `tsc` + `eslint` + `vitest` + `build` green locally before push. Migrations
   are **owner-applied** — record them in `docs/PENDING_PROD_MIGRATIONS.md`
   (agents cannot apply to prod).
4. **Free + UNIQUE images — no duplicates.** Every image must be free-license
   (Unsplash CDN or Supabase Storage — the only remote hosts allowlisted in
   `next.config` `images.remotePatterns`) **and unique across the surface**.
   Do not reuse the same photo for multiple articles/cards. Verify each URL
   returns HTTP 200 before shipping (see §5). Broken images and duplicate
   images both fail the bar.

---

## 1. Claim protocol (marketing workstreams)

```
1. git pull --rebase origin main
2. read this file (§3 workstream board) + docs/audit/COORDINATION.md
3. pick a workstream that is OWNER=free OR heartbeat STALE (>90 min)
4. add/------update your row in §3 (workstream, handle, CLAIMED, UTC + heartbeat)
5. commit ONLY this board: "marketing: <handle> claim <workstream>"; push
     push OK       -> yours, start work
     push REJECTED -> pull --rebase; if taken, pick another; retry
6. work -> verify (§0 gate) -> push validated increments -> update §3 evidence SHA
7. heartbeat every <=30 min while active
8. done: status DONE + evidence SHA; free the workstream
```

**Golden rules**: one agent per workstream; stay inside your workstream's paths
(§2); shared docs are append/single-row-edit only; never fabricate "verified".

---

## 2. Marketing surface map (stay disjoint)

Primary paths per workstream so agents don't collide. (Existing code — build on
it, don't duplicate it.)

| Workstream | Primary paths |
|---|---|
| **Content / Blog / SEO / AEO** | `app/(marketing)/blog/**`, `lib/blog/**`, `lib/marketing/blog-publish.ts`, `app/(app)/admin/marketing/{seo,aeo,content}/**`, `app/sitemap.ts`, blog article migrations `0226–0240+` |
| **CRM / Leads / Pipeline** | `lib/marketing/{crm,customers,lead-score,contact-score*,identity*,onboarding-contact,progressive-profile}.ts`, `app/(app)/admin/marketing/{crm,leads,lead-scores,pipeline,customers,segments}/**` |
| **Campaigns / Email / SMS / Push** | `lib/marketing/{send,push,automation-*}.ts`, `app/(app)/admin/marketing/{campaigns,email,sms,push,automation}/**`, `app/api/admin/marketing/email/**` |
| **Landing pages / Forms / Funnels** | `lib/marketing/{landing,forms}.ts`, `app/(marketing)/lp/[slug]/**`, `app/(marketing)/f/[id]/**`, `app/(app)/admin/marketing/{landing-pages,forms,funnels}/**` |
| **Attribution / Analytics / Experiments (A/B)** | `lib/marketing/{attribution,ab,stats}.ts`, `app/(app)/admin/marketing/{analytics,experiments,funnels}/**` |
| **Reviews / Reputation / Surveys / Loyalty / Referrals / Affiliates** | `lib/marketing/{reviews,reputation,surveys,loyalty,affiliates}.ts`, `app/(app)/admin/marketing/{reviews,reputation,surveys,loyalty,referrals,affiliates}/**` |
| **Personalization / Exit-intent / Consent** | `lib/marketing/{personalization*,exit-intent*,consent*,journey-recovery}.ts`, `app/(app)/admin/marketing/{personalization,exit-intent}/**` |
| **Competitive / Intelligence / AEO assistant** | `lib/marketing/{competitive,assets,quotes}.ts`, `app/(app)/admin/marketing/{competitive,intelligence,assistant,ads,proposals}/**`, `app/api/admin/marketing/ai/**` |
| **Public marketing site** | `app/(marketing)/{features,how-it-works,pricing,security,ai,mobile,contact,faq}/**` |

**Schema surface** (existing migrations to extend, not recreate): `0010_blog_posts`,
`0013_marketing`, `0020_marketing_channels`, `0021_marketing_suppressions`,
`0040_surveys`, `0041_reviews`, `0042_loyalty`, `0056_crm`, `0057_crm_quotes`,
`0060_marketing_assets`, `0061_marketing_videos`, `0063_marketing_push`,
`0065_affiliates`, `0160_visitor_consent`, `0171_crm_contact_profile`,
`0172_crm_lead_scores`, plus blog engagement `0201`, blog content `0202` +
`0226–0240`, and blog likes-auth `0232`.

---

## 3. Workstream board (who owns what — live)

| Workstream | Owner | Status | Claimed (UTC) | Heartbeat | Evidence / notes |
|---|---|---|---|---|---|
| Content / Blog / SEO / AEO | `agent-03` | **ACTIVE** | 2026-07-18 | 2026-07-18 | Blog content expansion + SEO/AEO in code. See §4. Do not edit `app/(marketing)/blog/**`, `lib/blog/**`, or blog article migrations `0226+` while this is ACTIVE. |
| CRM / Leads / Pipeline | *free* | — | — | — | Build on existing `lib/marketing/crm.ts` + `0056_crm` / `0171` / `0172`. |
| Campaigns / Email / SMS / Push | *free* | — | — | — | Automation engine already exists (`automation-*`); wire real sends. |
| Landing pages / Forms / Funnels | *free* | — | — | — | `lp/[slug]` + `f/[id]` routes exist. |
| Attribution / Analytics / Experiments | *free* | — | — | — | `attribution.ts`, `ab.ts`, `stats.ts` exist. |
| Reviews / Reputation / Surveys / Loyalty / Referrals / Affiliates | *free* | — | — | — | Libs + admin pages exist; verify Supabase wiring + empty states. |
| Personalization / Exit-intent / Consent | *free* | — | — | — | `personalization*`, `exit-intent*`, `consent*` exist. |
| Competitive / Intelligence / AEO assistant | *free* | — | — | — | `app/api/admin/marketing/ai` + `competitive.ts` exist. |
| Public marketing site | *free* | — | — | — | Features/pricing/security/etc. |

> Codex + assisting bots: claim a *free* workstream here (git-as-lock), then
> stay inside its §2 paths. Cross-link any audit-unit claim (e.g. A-17) by SHA.

---

## 4. Content / Blog workstream — current state (agent-03, ACTIVE)

**Shipped on `claude/connect-8ysp00` (PR #323), all PG16-validated:**

- **200 published blog posts** (original 20 + **180 new**), balanced across the
  six existing `/blog` tabs (Parenting, Organization, School & Activities, AI &
  Technology, Wellness, Family Finances) — **26–34 per category**, every row's
  `category` matches `ALL_CATEGORIES`, so each article auto-files under an
  existing tab (tabs + counts are computed live). Zero duplicate slugs/titles,
  zero empty bodies, idempotent `ON CONFLICT (slug) DO UPDATE`.
- **SEO + AEO in code** (`lib/blog/structured-data.ts`): `BlogPosting` +
  `BreadcrumbList` + `speakable` JSON-LD, canonical URLs, OG/Twitter cards,
  `Blog` collection graph on the index; `app/sitemap.ts` lists every slug.
- **`#bubaly` hashtags + Bubaly.com backlink** on every article
  (`lib/blog/social.ts`): brand + category + tag hashtags, plus an "About
  Bubaly" backlink CTA. Folded into `<meta keywords>`/OG.
- **Sign-in-gated hearts** (`0232_blog_likes_auth.sql` + `/api/blog/like` +
  `components/blog/heart-button.tsx`): 401 for unauthenticated, likes keyed to
  the authenticated user (partial unique index), signed-out → `/login?redirect`.
- Content migrations `0226–0241` (+ `0232`) recorded in
  `docs/PENDING_PROD_MIGRATIONS.md` for owner apply. **Until applied, the live
  `/blog` shows only the original 20** (tabs read live data).

**Unique hero images — DONE** (`0242_blog_unique_hero_images.sql`). Every one of
the 200 published articles now has a **distinct** free-license Unsplash CDN
photo (213-image verified pool; each URL curl-checked HTTP 200 — no broken
images) with honest category-based alt text. PG16-verified: 200 published, 200
distinct `hero_image_url`, **0 duplicates**, 0 null/broken, all on the
allowlisted `images.unsplash.com` host, idempotent. Owned by `agent-03`; do not
reassign blog images from another workstream. (Image *content* relevance is
best-effort — IDs were theme-selected and load-verified; for guaranteed
per-article topical matching, an Unsplash API key would enable programmatic
search-and-match.)

**Toward the 500-new target:** 180/500 shipped; continuing in vetted,
non-duplicate-topic batches. Each batch is committed to PR #323 as it validates.

---

## 5. Free + unique image playbook (all marketing surfaces)

- **Allowlisted hosts only:** `images.unsplash.com` and `*.supabase.co`
  (`next.config` `images.remotePatterns`). Any other host will fail `next/image`
  at runtime — if you need one (e.g. a deterministic placeholder service), add
  it to `remotePatterns` in the same change and justify it.
- **Free license:** Unsplash CDN photos are free to use; keep a `credit` field.
- **Unique:** never reuse a photo across two pieces of content on the same
  surface. Track used IDs; assert uniqueness in a test or a `SELECT count(*) -
  count(distinct hero_image_url)` = 0 check.
- **Verify before ship:** each URL must return HTTP 200 through the environment
  proxy, e.g.
  `curl -s -o /dev/null -w "%{http_code}" "https://images.unsplash.com/<id>?auto=format&fit=crop&w=1600&q=80"`.
  A guessed/unverified ID risks a broken image in prod.
- **Alt text + dimensions:** always set descriptive alt text and use
  `next/image` with sizes for CLS-safe, responsive rendering.

---

## 6. Cross-references

- Audit board (claims, heartbeats, protocol): `docs/audit/COORDINATION.md`
- Audit progress + unit taxonomy (A-01…A-20, weights): `docs/AUDIT_PROGRESS.md`
- Owner-applied migration checklist: `docs/PENDING_PROD_MIGRATIONS.md`
- PG16 throwaway harness: `docs/audit/verify-pg.sh`
- Blog SEO/AEO helpers: `lib/blog/structured-data.ts`, `lib/blog/social.ts`
