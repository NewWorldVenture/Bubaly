# Agent Handoff — Bubaly / FamilyOS

Living context doc so another agent can continue without re-deriving everything.
Last updated after PR #87. Keep this updated as you ship.

> **Session update (2026-06-22c, branch `claude/lp-public-renderer`):**
> - **Public-site wiring #54 DONE — landing pages now render publicly.** Admin
>   could author `marketing_landing_pages` but nothing served them; built the
>   public renderer + made them publishable end-to-end.
> - **Public route** `app/(marketing)/lp/[slug]/page.tsx` (service-role read, only
>   `published` + non-deleted pages) renders headline/subhead/body paragraphs +
>   a CTA. Client `tracker.tsx` fires a session-deduped **view** beacon on mount
>   and a **conversion** beacon on CTA click → `POST /api/lp/track`.
> - **Migration `0053_landing_metrics.sql`** — atomic `bump_landing_metric(slug,
>   metric)` (SECURITY DEFINER, counts only published pages; EXECUTE granted to
>   `service_role`, revoked from anon/authenticated/public). **Apply to prod.**
> - **Admin** (`/admin/marketing/landing-pages`): create form now captures CTA
>   label/href (stored in `metadata`); each card has a **Publish/Unpublish**
>   toggle (`setLandingPublished`) + a "View" link. Pages start as drafts.
> - **Pure helper** `lib/marketing/landing.ts` (`landingCta` w/ safe-href guard,
>   `bodyParagraphs`, `normalizeSlug`) + tests `tests/marketing-landing.test.ts` (8).
>   Added `/lp` + `/api/lp/track` to `middleware.ts` PUBLIC; `bump_landing_metric`
>   added to `database.types.ts` Functions.
> - **NEXT: public-site wiring #55 — Forms.** `marketing_forms` (fields jsonb) +
>   `marketing_form_submissions` exist with admin authoring but no public render/
>   submit. Build a public form renderer + a `POST` endpoint that inserts a
>   submission (service-role) and calls `fireAutomationEvent('form_submitted', …)`
>   — mirror the contact form + this landing-page PR (service-role read/write,
>   middleware PUBLIC, beacon/endpoint pattern).

> **Session update (2026-06-22b, branch `claude/onboarding-journey`):**
> - **Customer onboarding journey built out.** The wizard already captured Email +
>   First/Last name + Contact phone (→ `profiles`, #90) and family name + timezone
>   (→ `families`). Added a new **"About your family"** step (now 4 steps:
>   About you → Name your family → About your family → Add members) capturing
>   household adults/children, kids' ages, goals (multi-select chips), state/ZIP,
>   and **how-did-you-hear-about-us attribution**.
> - **Migration `0052_family_onboarding.sql`** — `family_onboarding` (one row per
>   family; RLS `is_family_member`, marketing reads via service role). **Apply to
>   prod after merge** (0042/0043 already applied by the user).
> - **Marketing wiring:** new **`onboarding_completed`** event trigger
>   (`lib/marketing/automation-triggers.ts` + default welcome copy);
>   `saveFamilyDetailsAction` upserts the row, stamps `completed_at`, and fires it
>   via `fireAutomationEvent(createServiceClient(), …)` (best-effort, deduped by
>   familyId). An active workflow with that trigger now sends a real welcome.
> - **Pure helpers** `lib/onboarding/family.ts` (`FAMILY_GOALS`, `REFERRAL_SOURCES`,
>   `cleanGoals`, `cleanReferralSource`, `parseChildAges`, `householdSummary`) +
>   `familyDetailsSchema` in `lib/validation.ts`; tests `tests/onboarding-family.test.ts` (8).
> - **NEXT:** (1) Let families edit these details later in **Settings** (mirror the
>   #91 profile edit; reuse `family_onboarding` + a `saveFamilyDetailsAction`-style
>   update). (2) Build the admin **"onboarding_completed" welcome workflow** in
>   `/admin/marketing/automation` so the trigger actually has a workflow to run.
>   (3) Use `family_onboarding.goals`/`referral_source` to seed **Segments** +
>   **Personalization** (marketing roadmap).

> **Session update (2026-06-22, branch `claude/family-missions`):**
> - **Merged to main:** Marketing Pillar 3 **Loyalty & Rewards** (PR #94, migration `0042_loyalty.sql` — 5 tables, service-role engine `lib/loyalty/server.ts`, admin console `/admin/marketing/loyalty`).
> - **In review (PR #96):** **Family Missions** — AI chore proof/validation/dispute + gamification, **extending** the existing `chores`/`chore_assignments`/`rewards` system (not a rebuild). Migration `0043_chore_missions.sql` (chore config columns; `chore_submissions`, `chore_ai_validations`, `chore_disputes`, `chore_approval_events`, `kid_progress`, `badges`/`member_badges`; private `chore-proof` bucket). `lib/chores/{ai,logic,server}.ts`; pages `/missions`, `/missions/new`, `/kids/submit/[id]`.
> - **Provider change:** `lib/ai/provider.ts` now supports **vision** (optional `images:[{media_type,data}]` on a user message → base64 blocks). Backward compatible.
> - **AI safety rule honored:** chore validation degrades to `parent_review_required` on any failure (never auto-rejects); safety flags force human review.
> - **Run in Supabase after each merge:** `0042_loyalty.sql`, then `0043_chore_missions.sql` (both idempotent, validated twice on Postgres 16).
> - **Family Missions backlog (future PRs):** reward-store UX, allowance/wallet page, insights charts, parent AI assistant + fairness engine, gamification UI (XP ring/leaderboard/quests), video-frame validation, chore-event notifications, tier feature-flags, recurrence auto-spawn.

## Product & stack
- **Bubaly / FamilyOS** — a family operating system. Next.js 15 App Router + TS +
  Tailwind + Supabase (Postgres/Auth/Storage/RLS) + Stripe + Anthropic/OpenAI AI.
- Deployed on **Vercel**. **Canonical domain is `www.bubaly.com`** (brand: "Bubaly").
  `bubaly.com` 308-redirects to `www.bubaly.com`. Legacy `theagoras.com` redirects to
  `www.bubaly.com` (see Domains section).
- Route groups: `app/(app)` (authed product), `app/(marketing)` (public), `app/(app)/admin` (super-admin console).
- Tiers: **Free (level 0)**, **Family Basic (1)**, **Family+ (2)**. `lib/constants/plans.ts`.

## Deploy status (was blocked, now OK)
- The Vercel account is now on **Pro**, so the old Hobby **100-deploys/day** cap that
  was freezing production is **resolved**. Pushes to `main` promote to production again,
  and `www.bubaly.com` serves the latest build. (History: many PRs piled up in `main`
  unable to deploy until the upgrade.)
- Still good practice: **batch work into tight single-commit PRs** (one feature per PR)
  to avoid superseded builds and keep diffs clean.

## Domains
- **Canonical: `www.bubaly.com`** (HTTP 200). `bubaly.com` → 308 → `www.bubaly.com`.
- `theagoras.com` is legacy. App-level redirect added in `next.config.mjs` (#80):
  host `(www\.)?theagoras\.com` → `https://www.bubaly.com/:path*` (308 permanent).
  NOTE: that redirect only fires once the domain is actually attached to this Vercel
  project. If `theagoras.com` shows `DEPLOYMENT_NOT_FOUND`, attach/redirect it in
  Vercel → familyos project → Settings → Domains (or point it at www.bubaly.com there).

## Git workflow (IMPORTANT — the branch is shared & gets polluted)
- Designated dev branch: **`claude/funny-darwin-gkmptm`**. Never push to `main` directly
  except when the user explicitly authorizes it.
- The shared branch accumulates already-squash-merged history, which makes huge messy
  PR diffs. **Always build each PR clean:**
  ```bash
  git fetch origin main && git reset --hard origin/main
  # ...make changes...
  git add -A && git commit -m "..."
  MY=$(git rev-parse HEAD)
  git fetch origin main && git reset --hard origin/main
  git cherry-pick "$MY"
  git diff --stat origin/main..HEAD   # verify ONLY your files
  git push -u origin claude/funny-darwin-gkmptm --force-with-lease
  ```
- Then create PR via GitHub MCP tools (repo `NewWorldVenture/FamilyOS`), squash-merge.
- Commit trailer to use:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BVdGmgvtEjp4ZSqcES7ThJ`.
- Do NOT put the model id in commits/PRs/code. The user has a standing instruction here
  to push PRs to main aggressively (build → PR → squash-merge).

## Applying Supabase migrations (Postgres ports are blocked; use the Management API)
- Direct DB connections time out (network policy). **HTTPS works.** Use the Supabase
  Management API with a Personal Access Token (PAT).
- Helper script `/tmp/sbq.mjs` (recreate if missing): POSTs SQL to
  `https://api.supabase.com/v1/projects/{REF}/database/query` with `Authorization: Bearer $SBP_TOKEN`.
  - Project REF: `ltcxlbipiihclxwioyqj`
  - PAT: a Supabase PAT (`sbp_…`) — ask the user for it; do NOT commit it anywhere.
  - Apply a file: `SBP_TOKEN='sbp_...' node /tmp/sbq.mjs supabase/migrations/00XX.sql`
  - Ad-hoc:       `SBP_TOKEN='sbp_...' QUERY="select ..." node /tmp/sbq.mjs`
  - Returns `HTTP 201 []` on success. Verify policies via
    `select policyname, cmd from pg_policies where tablename='...'`.
  - `/tmp/sbq.mjs` body: read `SBP_TOKEN` + `SBP_REF` (default the REF above) + SQL from
    `process.argv[2]` file or `QUERY` env; POST to the URL above; print status + text.
- Migrations are idempotent (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, enum
  guards). Always apply the migration to prod after merging the migration file.

## Conventions
- **Migrations**: `supabase/migrations/00NN_name.sql`. **Next number: 0053.**
  Helpers available in DB: `public.is_family_member(family_id)`, `public.is_super_admin()`,
  `public.set_updated_at()` trigger fn, `gen_random_uuid()`.
- **Family-scoped tables** (member data): RLS pattern —
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` then a single
  `FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (...)`,
  OR split select/insert policies. See `0043_wishlists.sql`, `0046`, `0047`, `0048` for templates.
- **Admin/marketing tables** (business-wide): RLS ENABLED with **NO policies** →
  service-role only. Access via `lib/marketing/admin.ts` `requireMarketingAdmin()`
  (returns service client + actor, super-admin gated). See `0013_marketing.sql`.
- **Types**: hand-maintained in `lib/database.types.ts`. Add each new table as a
  `T<Row, Insert, Update>` entry. `& Stamps` adds created_at/updated_at.
- **Nav**: `lib/constants/navigation.ts` `APP_NAV_GROUPS` (items have `minLevel`).
  Locked items render greyed with a lock and open the tier-aware `UpgradeModal`
  (`components/app/upgrade-modal.tsx`, takes `requiredLevel`). Add icon to the lucide import line.
- **Route gating**: `lib/constants/plans.ts` `ROUTE_PLAN_LEVEL` (0/1/2) AND
  page-level `requirePlanLevel(1|2)` (redirects to `/dashboard/billing?upgrade=1&need=N`).
  Free pages use `requireUserContext()`.
- **Client modules**: `useApp()` gives `{ familyId, userId, role, members, selfMember, isSuperAdmin, planLevel }`.
  `useRealtimeQuery({ table, familyId, deps, fetcher })`. `createClient()` for writes.
  UI: `Modal`, `Input/Textarea/Field/Select`, `Button`, `Avatar`, `PageHeader`,
  `LoadingBlock/ErrorState/EmptyState`, `useToast()` → `{ success, error }`.
- **Pure logic** goes in `lib/<feature>/*.ts` with vitest tests in `tests/*.test.ts`.

## Verify before every PR
```bash
npx tsc --noEmit
npx next lint --file <changed files>
npm run build            # must show "Compiled successfully" + your route
npx vitest run tests/<your>.test.ts   # full suite currently 363 passing
```

## Gotchas
- `useSearchParams()` in a client component needs a `<Suspense>` boundary at the page
  (see `app/(app)/dashboard/billing/page.tsx`).
- A shared Supabase query builder across two tables unions their columns and breaks
  typing — write a separate function per table (see `quick-capture.tsx`).
- Do NOT import the `server-only` `lib/ai/settings.ts` from client components — use the
  client-safe `lib/ai/models.ts` for `AIEngine`/`AI_MODELS`/`AIConfigView`.
- Recipe field is `name` (not `title`). `family_photos.uploaded_by` is a USER id;
  map via `member.user_id`. `chore_assignments` completion = `approved_at` not null.
- Never commit secrets (the auto classifier blocks it). API keys/PATs stay in chat/env.

## Shipped so far (this initiative)
- Marketing pillars (parallel/earlier): Surveys, Reviews, Referrals (#59–#61).
- #67 tier-aware UpgradeModal · #68 tier-aware billing deep-link
- #69 Family Announcements (mig 0046) · #70 Event RSVP + event detail (mig 0047)
- #71 Family Activity Feed (read-time) · #72 Quick Capture FAB
- #73 handoff doc · #74 Smart Birthday & Anniversary Center (mig 0048, `family_dates`)
- #75 Family Readiness Snapshot (read-time; teases Plus)
- #76 handoff refresh · #77 Family Memory Timeline (read-time: milestones+trips+photos)
- #78 Customer Health & Churn scoring (admin marketing; read-time over MarketingCustomer)
- #79 Configurable AI engine (Claude/Anthropic OR ChatGPT/OpenAI) + admin UI for keys
- #80 Domain canonicalization: `theagoras.com` → `www.bubaly.com` (next.config redirect)
- #81 Removed "Loved by N families" social-proof badge from the marketing hero
- #82 handoff regen · #83 support@bubaly.com everywhere · #84 finished AI-engine wiring (briefing/weekly/flyer)
- #85 A/B Testing pillar (mig 0049 `ab_experiments`+`ab_events`; admin UI + `/api/ab/track` + significance engine)
- #86 Lead Scoring (read-time over contact-form tickets; `lib/marketing/lead-score.ts` + `/admin/marketing/leads`)
- #87 Lifecycle journeys runner: `lib/marketing/automation-runner.ts` + `/api/cron/automations` (daily)
- #88 Event-driven automation triggers (mig 0050 dedup index): `fireAutomationEvent`
  (`lib/marketing/automation-events.ts`) fires `form_submitted`/`email_opened`/
  `email_clicked`/`payment_completed` in real time from the contact form, Resend
  webhook, and Stripe `checkout.session.completed`. Shared step executor extracted
  to `lib/marketing/automation-steps.ts`; pure trigger registry/dedup in
  `lib/marketing/automation-triggers.ts`. Reserves the run row first
  (ON CONFLICT DO NOTHING) so redelivered webhooks can't double-send.
- #89 Abandoned-checkout automation (mig 0051 `checkout_sessions`): the checkout
  route records each opened Stripe session; the webhook marks it completed; a new
  cron `/api/cron/checkout-abandoned` (every 6h) fires `checkout_abandoned` for
  pending sessions past a 60-min grace (≤24h old) and marks them abandoned so it
  never re-fires. Pure selection in `lib/billing/checkout-abandonment.ts` (tested).
  This completes all event-driven triggers (the deferred one from #88).
- #90 New-customer onboarding journey (NO migration — reuses `profiles`): added a
  first "Tell us about you" step to the onboarding wizard capturing First/Last
  name, Contact phone, and Email before the family steps. `saveOnboardingProfileAction`
  (`app/onboarding/actions.ts`) upserts `profiles` (full_name/display_name/phone/email)
  and syncs `family_members.display_name`; `createFamilyAction` now seeds the parent
  member name from that profile. Wizard is now 3 steps (About you → Name family →
  Add members); `/onboarding` page is a server component that prefills from
  `profiles`/auth. Pure name/phone helpers in `lib/onboarding/profile.ts` (tested);
  `onboardingProfileSchema` in `lib/validation.ts`.
- #91 Editable account profile in Settings (NO migration): "Your profile" now edits
  First/Last name + Contact phone (email read-only) via `updateMyProfileAction`
  (`app/(app)/actions.ts`) — updates `profiles` + syncs `family_members.display_name`,
  reusing the onboarding helpers. Settings module loads `profiles` client-side to
  prefill. `profileUpdateSchema` in `lib/validation.ts`. Closes the loop on the
  onboarding-captured contact info so it stays current.
- #92 Fix "new row violates RLS for profiles" on onboarding/profile save (NO
  migration): `profiles` rows are created by the `handle_new_user` SECURITY
  DEFINER trigger, so an app-level upsert is the FIRST RLS-scoped write to that
  table — and `INSERT ... ON CONFLICT` evaluates the INSERT `WITH CHECK
  (id = auth.uid())` policy, which was failing in prod. Fix: new
  `lib/server/profiles.ts` `saveUserProfile(userId, …)` performs the write with
  the **service-role client after the caller is authenticated** (getUser on the
  cookie client), scoped strictly to that userId — RLS bypassed safely, no
  client-trusted identity. Both `saveOnboardingProfileAction` and
  `updateMyProfileAction` now route through it. GOTCHA for future writes: prefer
  this validated-service-role pattern for `profiles` upserts; the table's RLS
  insert path is effectively untested because the trigger normally creates rows.
- #93 Lock onboarding email for Google sign-ins (NO migration): `/onboarding`
  page derives `emailLocked` from `auth.user.app_metadata.providers` (includes
  'google') and passes it to the wizard, which renders the email field
  `readOnly` + greyed (kept `readOnly` not `disabled` so it still submits).

## Lifecycle journeys / automation runner — added in #87
- The `marketing_automation_workflows` admin UI already existed; #87 adds the **runner**
  that actually fires them. `runAutomations()` evaluates active workflows whose trigger is
  schedule-evaluable (`customer_created`, `customer_inactive`, `payment_failed`,
  `high_value_detected`) against the customer snapshot, executes steps, and records a
  `marketing_automation_runs` row per family (deduped by `subject_key` = familyId, so each
  (workflow, family) runs once).
- `send_email` steps send via Resend; other actions (notify_admin/apply_tag/…) are recorded
  but not yet executed. Event-driven triggers (form_submitted, email_opened, checkout_abandoned)
  are intentionally skipped — they need app-event instrumentation (next follow-up).
- Cron: `/api/cron/automations` (Bearer `CRON_SECRET`), daily `0 13 * * *` in vercel.json.
- Pure matching logic `subjectsForTrigger` is unit-tested.

Next migration number: **0054**. Applied to prod by the user: through **0043**
(0042 loyalty, 0043 chore missions). **Still needs applying to prod:** any of
0044–0051 not yet run, plus **0052 `family_onboarding`** and **0053
`landing_metrics`**. Verify with `select max(...)`/`\dt` before assuming a
migration is live.

## A/B Testing — added in #85
- Admin: `/admin/marketing/experiments` (create experiments with variants + metric,
  start/pause, declare winner; results table with rate/lift/two-proportion significance).
- `lib/marketing/ab.ts` (pure, tested): `assignVariant` (deterministic FNV hash → sticky,
  even split), `computeABResults` (two-proportion z-test, p-value, lift), `leadingVariant`.
- Tracking: `POST /api/ab/track { experiment, variant, kind: exposure|conversion, visitorId }`
  — service-role insert into `ab_events`, only records for `running` experiments, deduped by
  a unique (experiment, visitor, kind) index. To USE in a surface: call `assignVariant` to
  pick a variant, render it, and `fetch('/api/ab/track', …)` on exposure + on conversion.
  (Instrumenting specific pages/CTAs is the remaining glue — engine + admin are done.)

## AI engine (configurable provider) — added in #79
- **Choose the AI engine + set API keys at `/admin/ai`** (super-admin only; linked from
  Admin → Settings). Stores config in `app_settings` key `ai_provider`
  `{ provider, model, anthropicKey, openaiKey }`. Keys are write-only (masked; blank
  field keeps the existing key). No migration — reuses `app_settings` (service-role).
- `lib/ai/provider.ts`: `AnthropicProvider` + `OpenAIProvider` (raw fetch, no SDK dep),
  `providerFromConfig()`, `getProvider()` (env fallback), and **`resolveProvider()`**
  (async; reads settings via service client → falls back to env).
- `lib/ai/models.ts`: client-safe `AIEngine`, `AI_MODELS`, `AIConfigView`.
- `lib/ai/settings.ts` (server-only): `getAIConfig` (real keys), `getAIConfigView`
  (masked), `setAIConfig`.
- **Wired through:** all provider-based AI routes use `await resolveProvider()` (briefings
  via provider, conflict, home AI, marketing AI, social, accident, import) AND the main
  assistant `app/api/ai/chat/route.ts`.
- `complete()` takes an optional `maxTokens` (default 1024) — set it for long JSON outputs.
- **AI wiring is now complete (#84):** `briefing` + `weekly-briefing` go through
  `resolveProvider()`. `flyer` stays on the Anthropic SDK on purpose (PDF/vision input is
  Anthropic-specific) but reads the admin-configured Anthropic key/model via `getAIConfig`
  and returns 503 with a clear message if no Anthropic key is set. If you switch the engine
  to OpenAI, flyer still needs an Anthropic key (or build an OpenAI-vision path; note: no PDF).
- To use ChatGPT: `/admin/ai` → pick **ChatGPT (OpenAI)**, choose a model (gpt-4o…),
  paste the OpenAI key, Save. Env fallbacks: `OPENAI_API_KEY`, `AI_PROVIDER=openai`, `AI_MODEL`.
  (The OpenAI account/key must have active billing or calls 401/429.)

## Marketing Platform — vision, pillar map & roadmap

### Vision
A self-serve, AI-assisted **growth platform** that lives inside the super-admin
console (`/admin/marketing/*`) and powers Bubaly's own acquisition, activation,
retention, and reputation — without paying for HubSpot/Klaviyo/Ahrefs. Every
pillar is **real and wired to Supabase** (no mock data): admins author/configure
in the console; engines (cron + event-driven) execute; the public marketing site
(`app/(marketing)`) and the product surface the results. The bar: each pillar is
production-grade, honest (never shows "sent/published/won" unless it truly
happened), and instrumented (A/B + automation events where it makes sense).

### Marketing-table conventions (READ BEFORE ADDING A PILLAR)
- **Business-wide tables** (not family data): name `marketing_*` (or a clear
  domain noun like `surveys`, `reviews`, `loyalty_*`, `referral_*`, `ab_*`).
  RLS **ENABLED with NO policies** → service-role only. All access goes through
  `lib/marketing/admin.ts` `requireMarketingAdmin()` (returns `{ supabase:
  serviceClient, actorId, actorEmail }`, super-admin gated) and writes are
  audited via `logMarketingAudit(supabase, {action, resource, resourceId?, …})`
  → `marketing_audit_logs`. Template: `0013_marketing.sql`, `0020`, `0021`.
- **Standard columns:** `id uuid pk`, `status text CHECK(...)`, `metadata jsonb`,
  `created_by/updated_by uuid → auth.users`, **soft delete `deleted_at`**, and
  `created_at/updated_at` with the `set_updated_at()` trigger. Multi-step
  structures (funnel steps, automation steps, form fields) live as `jsonb` on the
  parent row.
- **Family-readable marketing tables** (a family sees its own slice): use
  `is_family_member(family_id)` for SELECT only, writes still service-role — e.g.
  `loyalty_accounts/transactions/redemptions`, public `reviews`, `referrals`.
- **Types:** hand-add each table to `lib/database.types.ts` as `T<Row,Insert,Update>`.
- **Pure logic** (scoring, significance, dedup, selection) → `lib/marketing/*.ts`
  with vitest tests. Engines run via `/api/cron/*` (Bearer `CRON_SECRET`, scheduled
  in `vercel.json`) and/or event-driven (`fireAutomationEvent`).

### Branch strategy (one pillar = one clean PR)
`git fetch origin main && git checkout -b claude/marketing-<pillar> origin/main` →
build → **verify** (`tsc --noEmit`, `next lint`, `next build`, `vitest run`, and
validate the migration **twice** on a throwaway Postgres 16 cluster for
idempotency + RLS/CHECK) → draft PR (`mcp__github__create_pull_request`) → mark
ready → **squash-merge** → apply the migration to prod (Supabase Management API,
see migration section; **next number: 0054**) → update this doc's pillar row +
its NEXT step. Keep each PR to one pillar.

### Pillar map (✅ shipped · 🟡 partial · ⬜ not built)

| Pillar | Status | Tables (migration) | Key fields | Admin route | NEXT |
|---|---|---|---|---|---|
| Segments | ✅ | `marketing_segments` (0013) | kind(dynamic/static), rules jsonb, member_keys[] | `/admin/marketing/segments` | Materialize dynamic rules against live customers for campaign targeting |
| Campaigns | ✅ | `marketing_campaigns` (0013) | objective, channel, type, status, segment_id, budget_cents, kpis | `/admin/marketing/campaigns` | Roll up per-channel results (email/sms/ads) into campaign KPIs |
| Email | ✅ | `marketing_email_campaigns` (0013) | subject, body_html, status, recipients/opens/clicks/bounces, provider_ref | `/admin/marketing/email` | Real send to a segment via Resend + opens/clicks from the Resend webhook |
| SMS | 🟡 | `marketing_sms_campaigns` (0020) | message, status, recipients/delivered/replies/opt_outs | `/admin/marketing/sms` | Wire a real SMS provider (Twilio) + STOP opt-out → `marketing_suppressions` |
| Social | 🟡 | `marketing_social_posts` (0020) | platform, content, link, status, scheduled_at | `/admin/marketing/social` | Publish via the product Social Command Center connectors (honest: only on provider confirm) |
| Ads | 🟡 | `marketing_ad_campaigns` (0020) | platform, budget/spend_cents, impressions/clicks/conversions, utm | `/admin/marketing/ads` | Pull spend/perf from Meta/Google Ads APIs (manual entry only today) |
| Content calendar | ✅ | `marketing_content_items` (0013) | kind, brief, body, status, publish_at | `/admin/marketing/content` | "Publish to blog" → create a `blog_posts` row from an approved item |
| SEO | 🟡 | `marketing_seo_pages`, `marketing_seo_keywords` (0013) | path/score/issues; keyword/intent/source/status | `/admin/marketing/seo` | First-party only today → see **Competitor/Keyword/Backlink** below |
| AEO | ✅ | `marketing_aeo_questions` (0013) | question/answer, pattern, clarity_score, status | `/admin/marketing/aeo` | Emit JSON-LD FAQ schema on public pages from `answered` Q&As |
| Funnels | 🟡 | `marketing_funnels` (0020) | steps jsonb, status | `/admin/marketing/funnels` | Compute real step conversion from `ab_events`/page analytics (steps are descriptive today) |
| Landing pages | ✅ | `marketing_landing_pages` (0020), `bump_landing_metric` (0053) | slug, headline, subhead, body, published, views, conversions, metadata.cta_* | `/admin/marketing/landing-pages` + public `/lp/[slug]` | A/B-test headline/CTA variants via `assignVariant` + `/api/ab/track`; per-page conversion goals |
| Forms | 🟡 | `marketing_forms`, `marketing_form_submissions` (0020) | fields jsonb; submission payload | `/admin/marketing/forms` | **Public embed + submit endpoint (see wiring TODO #55)** — fire `form_submitted` |
| Automation / lifecycle | ✅ | `marketing_automation_workflows`, `marketing_automation_runs` (0020), dedup idx (0050), `checkout_sessions` (0051) | trigger, steps jsonb, subject_key | `/admin/marketing/automation` | Execute non-email actions (notify_admin/apply_tag) — recorded but not run (#87) |
| Customers | ✅ | read-time over contact tickets / Stripe (no table) | MarketingCustomer snapshot | `/admin/marketing/customers` | Persist a `marketing_customers` table for tags/notes instead of read-time only |
| Customer Health & Churn | ✅ (#78) | read-time | churn score over snapshot | `/admin/marketing/health` | Trigger a win-back automation when score crosses a threshold |
| Lead Scoring | ✅ (#86) | read-time (`lib/marketing/lead-score.ts`) | score over contact-form tickets | `/admin/marketing/leads` | Persist scores + route hot leads into an automation |
| A/B Testing | ✅ (#85) | `ab_experiments`, `ab_events` (0049) | variants, metric, exposure/conversion | `/admin/marketing/experiments` | **Instrument real surfaces** — call `assignVariant` + `/api/ab/track` on a CTA |
| Surveys / NPS / CES / CSAT | ✅ (Pillar 1) | `surveys`, `survey_responses` (0040) | kind(nps/ces/csat), questions jsonb; score/answers | `/admin/marketing/surveys` + public `/s/[slug]` | Auto-route detractors (NPS ≤6) into a follow-up automation |
| Reviews & Reputation | ✅ (Pillar 2) | `reviews`, `reputation_settings` (0041) | rating, status, reply; platform URLs, min_public_rating | `/admin/marketing/reviews` + public `/reviews`, `/reviews/new` | Email/SMS review-request blast to happy customers |
| Referrals | ✅ (#39) | `referral_codes`, `referrals` (0039) | code, reward, status | `/admin/marketing/referrals` + `/referrals` | Auto-credit Loyalty points on a `referred→converted` transition |
| Loyalty & Rewards | ✅ (Pillar 3, #94) | `loyalty_settings/rewards/accounts/transactions/redemptions` (0042) | points/tier ledger; catalog | `/admin/marketing/loyalty` | Family-facing rewards browse/redeem page + hook signup/referral/review → `awardPoints` |
| Suppressions | ✅ | `marketing_suppressions` (0021) | email/phone, reason | (enforced at send) | Honor across every real send path (email today; SMS/push next) |
| Settings / Audit / Assistant / Analytics | ✅ | `marketing_settings`, `marketing_audit_logs` (0013) | k/v; actor/action/resource | `/admin/marketing/{settings,audit,assistant,analytics}` | — |

### Remaining pillars to build (⬜ — the growth backlog)
Each is a clean PR following the conventions above. Suggested order top-to-bottom.

1. **Public-site wiring (TODOs #54 & #55).** The data already exists.
   - **#54 Landing pages → public renderer. ✅ DONE** (branch
     `claude/lp-public-renderer`, mig 0053). `/lp/[slug]` renders published pages,
     CTA + body; `tracker.tsx` beacons view/conversion → `/api/lp/track` →
     `bump_landing_metric`. Admin has CTA fields + Publish/Unpublish.
   - **#55 Forms → public embed + submit. ⬜ NEXT.** `marketing_forms` (fields jsonb) +
     `marketing_form_submissions` exist with admin authoring but no public
     render/submit. Build a public form renderer + `POST` action that inserts a
     submission (service-role) and calls `fireAutomationEvent('form_submitted', …)`
     — mirror how the existing contact form already fires that event.
2. **Asset Library (DAM)** ⬜ — `marketing_assets` (kind image/video/doc/brand,
   storage_path, tags[], dimensions, alt, usage refs) + a **private storage
   bucket** `marketing-assets`. Picker reused by Email/Social/Content/Landing.
   NEXT after build: thumbnail generation + "where used" backrefs.
3. **Video** ⬜ — `marketing_videos` (provider youtube/vimeo/upload, url/storage_path,
   poster, captions, transcript, status). Embeds in content/landing; transcript
   feeds AEO/SEO. Pairs with Asset Library.
4. **Personalization** ⬜ — `marketing_personalization_rules` (audience match jsonb
   like Segments, slot/key, content variant, priority). Server resolves the
   best-match variant per visitor/segment for hero/CTA/landing slots; record
   exposures via the A/B `/api/ab/track` plumbing.
5. **Push (marketing)** ⬜ — distinct from transactional web-push (`push_devices`,
   0035, already used for product notifications). Add `marketing_push_campaigns`
   (title, body, url, segment_id, status, sent/clicked) and send via the existing
   web-push/VAPID path to opted-in devices; honor `marketing_suppressions`.
6. **Exit-intent** ⬜ — `marketing_exit_intent` (offer headline/body/CTA, audience
   rules, trigger config, impressions/conversions). Client trigger on the public
   site (mouseleave/scroll-velocity), shown once per visitor; A/B-instrumented.
7. **Affiliate / Partner program** ⬜ — distinct from Referrals (customer-to-
   customer). `affiliates` (partner, payout terms, status) + `affiliate_clicks` +
   `affiliate_conversions` with attribution windows and a payout ledger. Public
   `?ref=` capture + a partner dashboard.
8. **Competitor / Keyword / Backlink intelligence** ⬜ — upgrades SEO from
   first-party-only. `marketing_competitors` (domain, notes, tracked terms),
   `marketing_keyword_research` (volume/difficulty/CPC from an external API),
   `marketing_backlinks` (source/target/anchor/first_seen/lost_at, monitoring).
   Requires an external data provider (DataForSEO/Ahrefs/SerpApi) — gate behind a
   configurable key in `marketing_settings` and **degrade honestly** (show
   "connect a data source" when unset; never fabricate metrics).

### Public-site wiring TODOs (detail — tracked as #54/#55)
The marketing **builders ship before their public surfaces**. As of now, the
admin can fully author landing pages and forms, but the public site does not yet
render or accept them — this is the single biggest "looks done but isn't wired"
gap. Close it via items 1.#54 and 1.#55 above. Same caution applies to any future
builder: ship the public renderer/endpoint in the same PR as the authoring UI, or
record it here as a wiring TODO so it isn't mistaken for complete.

## Backlog (prioritized, each a clean PR)
1. Event-driven automation triggers (form_submitted, email_opened/clicked,
   checkout_abandoned) — instrument app events to fire workflows in real time.
   (Scheduled lifecycle journeys done #87; A/B #85; lead scoring #86.)
2. Broader UX brief (Phases 3/4/5/9/11): mobile-first polish, theme-token audit,
   Family Command Center home, AI-native touches, performance.
- (DONE #84) Finish AI-engine wiring: briefing/weekly-briefing → resolveProvider; flyer
  reads admin Anthropic key.

## How to continue (quick start for the next agent)
1. Read this whole file. Recreate `/tmp/sbq.mjs` if missing (see migration section);
   ask the user for the Supabase PAT.
2. Pick the top backlog item. Build it following the conventions above.
3. Verify (tsc/lint/build/vitest), apply any migration via the Management API,
   then clean single-commit PR → squash-merge to main.
4. Update this doc's "Shipped"/"Backlog"/migration number after each PR.

## Reference
- Source UX/IA brief and the marketing-platform brief are in the session history.
- GitHub: repo `NewWorldVenture/FamilyOS`, use `mcp__github__*` tools (load via ToolSearch).
- Tests live in `tests/`; CI runs Typecheck·Lint·Test·Build + E2E smoke on PRs.
