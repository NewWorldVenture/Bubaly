# Agent Handoff — Bubaly / FamilyOS

Living context doc so another agent can continue without re-deriving everything.
Last updated after the Meal Voting PR. Keep this updated as you ship.

> **Session update (2026-06-23c, branch `claude/billing-robust`): self-serve billing.**
> Families can now upgrade/downgrade tiers and switch monthly↔annual **in-app**
> (no Stripe-portal round-trip), plus schedule/undo a cancel-to-Free. All synced
> to Supabase via the existing Stripe webhook.
> - **Migration `0067_subscription_cancel.sql`** — adds
>   `subscriptions.cancel_at_period_end boolean` (**apply to prod**). The webhook
>   (`app/api/webhooks/stripe/route.ts` `upsertSubscription`) now writes it.
> - **Pure logic** `lib/billing/plans.ts` (10 tests): `PLAN_META`, `slugToStripePlan`,
>   `stripePlanFor`, `classifyChange(currentSlug,target) → new|current|upgrade|
>   downgrade|switch_interval`, `annualSavingsPct`. Plan slugs: `basic`/`basic_annual`/
>   `plus`/`plus_annual` (+ legacy `family*`→basic); annual slugs end `_annual`.
> - **`POST /api/billing/change-plan` { plan: StripePlan }** — if a live Stripe sub
>   exists (active/trialing/past_due) it updates the sub item's price in place with
>   `proration_behavior:'create_prorations'` and clears any scheduled cancel; on
>   Free it falls back to Checkout (returns `{url}`). Parent-only (`isAdmin`).
> - **`POST /api/billing/cancel` { resume?: boolean }** — sets/clears
>   `cancel_at_period_end` (downgrade to Free at period end / resume). Parent-only.
> - **UI** `components/modules/billing-module.tsx`: subscription loads live
>   (realtime on `subscriptions` + reload after each change). New `PlanManager`
>   (replaces `UpgradePlans`) — monthly/annual toggle + per-tier button computed by
>   `classifyChange` (Choose/Current/Upgrade/Downgrade/Switch). `changePlan`/`setCancel`
>   call the routes with toasts; scheduled-cancel banner with one-tap Resume;
>   "Payment & invoices" still opens the Stripe portal.
> - **Stripe env (prod):** `STRIPE_PRICE_{BASIC,PLUS}_{MONTHLY,ANNUAL}`,
>   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. The Stripe customer portal is now
>   only needed for "Payment & invoices"; upgrade/downgrade/switch don't depend on it.

> **Session update (2026-06-22h) — FAMILY FOOD OS, PHASE 4: Meal Voting.**
> - **Shipped:** family meal voting. Propose options (from the vault and/or free-text) →
>   members vote yes/maybe/no per option → close to pick the winner → add winner's
>   ingredients to the grocery list.
> - **Migration `0055_meal_votes.sql`** — `meal_votes`, `meal_vote_options`,
>   `meal_vote_ballots` (family-scoped RLS `is_family_member`; one ballot per member/
>   option). **APPLIED TO PROD + verified.** Types added to database.types.ts.
> - `lib/recipes/voting.ts` (pure, 5 tests): `tallyVotes` (yes+1/maybe+0.5/no−0.5),
>   `winningOption` (ties → most yes), `summarizeBallots`.
> - `app/(app)/dashboard/recipes/vote/{page,vote-client,actions}.tsx`: create vote,
>   castBallot (upsert), closeMealVote (stamps winner), reopen, addWinnerToGrocery
>   (reuses default grocery list). "Vote" entry in the recipes header.
> - **KNOWN GAP / NEXT:** "Add winner to **meal plan**" not wired — `meal_plans.meal_id`
>   → `meals` table, NOT `family_recipes`, so it needs a bridge (create a `meals` row
>   from the recipe, or add a `recipe_id` column to `meal_plans`). Also: parent-only
>   gating for create/close (currently any member); deadlines/weighted/anon modes;
>   "AI suggest compromise meal". Then **post-meal ratings** (next big pillar) →
>   pantry+barcode → vault OCR → admin provider settings → tier-gate/meter AI.

> **Session update (2026-06-22g) — FAMILY FOOD OS, PHASE 3: "What can we make tonight?"**
> - **Shipped:** AI suggests dinner from the family's OWN saved vault (always cookable),
>   with an optional free-text constraint ("we have chicken & rice", "quick", "no dairy").
> - `lib/recipes/suggest.ts` (pure, 4 tests): `buildSuggestPrompt` (lists vault id/name/
>   ingredients, JSON-only) + `parseSuggestions` (keeps only valid, de-duped vault ids).
> - `POST /api/recipes/suggest { constraint? }` — auth + rate-limited; loads up to 80 vault
>   recipes (favorites first), `resolveProvider().complete(maxTokens 600)`, returns picks
>   that map back to real recipes. **No migration.**
> - UI: "Tonight?" button in the recipes header → modal with constraint box + tappable
>   picks that open the recipe (`recipes-module.tsx`).
> - **NEXT (food OS):** pantry table + barcode (Open Food Facts) to power true
>   "use what we have"; then meal voting → ratings → vault OCR → admin provider settings;
>   tier-gate/meter AI (recipe transform + suggest are rate-limited only).

> **Session update (2026-06-22f) — FAMILY FOOD OS, PHASE 2: AI Recipe Actions.**
> - **Shipped:** transform any saved recipe into a new vault variant — healthier,
>   cheaper, higher-protein, lower-sodium, kid-friendly, gluten-free, dairy-free,
>   vegetarian, vegan, liver-friendly.
> - `lib/recipes/ai-actions.ts` (pure, 6 tests): `RECIPE_AI_ACTIONS` catalog,
>   `buildTransformPrompt` (JSON-only, "don't claim to treat disease", conservative
>   allergies), `parseTransformResult` (lenient JSON → vault shape; auto-appends an
>   "amounts/nutrition are estimates" note + a non-medical disclaimer for health actions).
> - `POST /api/recipes/transform { recipeId, actionId }` — auth + rate-limited (12/min),
>   loads recipe (RLS), `resolveProvider().complete(maxTokens 1800)`, saves a NEW
>   `family_recipes` row (`ai_generated`, `source_provider:'bubaly_ai'`, `source_recipe_id`
>   = original id, `tags:['ai:<action>']`). **No migration.**
> - UI: "AI Remix" chip bar in the recipe detail modal (`recipes-module.tsx`).
> - Added `ai_generated`/source fields to `family_recipes` Insert type in database.types.
> - **NEXT (food OS):** (1) tier-gate AI actions + meter monthly usage (`requirePlanLevel`
>   / a usage counter) — currently only rate-limited. (2) "What can we make tonight?" +
>   pantry-based search. (3) USDA/Open Food Facts providers (nutrition+barcode). Then meal
>   voting → ratings → pantry → vault OCR → admin provider settings (see Phase-1 block).

> **Session update (2026-06-22e, branch `claude/funny-darwin-gkmptm`) — FAMILY FOOD OS, PHASE 1:**
> Big spec: build the world's best family recipe/meal-plan/grocery/nutrition/voting/
> rating system. It's HUGE (21 sections) — being built incrementally. **What already
> existed:** `family_recipes` vault (ingredients/instructions Json shaped as
> `{name,quantity,unit}[]` / `{step,text}[]`), `meal_plans`/`meal_plan_*`, `grocery_lists`/
> `grocery_items`, `pantry`?, the `RecipesModule` UI, and AI recipe endpoints.
> - **PHASE 1 SHIPPED (this PR): Recipe Discovery + provider architecture + save-to-vault.**
>   - `lib/recipes/providers/{types,themealdb,index}.ts` — provider registry; **TheMealDB**
>     (free/keyless) implemented; `searchAllProviders` merges+dedupes. Add new adapters
>     here (usda, openFoodFacts, spoonacular, edamam, fatsecret, localSupabase) — all must
>     be OPTIONAL (env-gated `isEnabled()`), keys server-side only.
>   - `lib/recipes/normalize.ts` (pure, tested) — `normalizeThemealdb`, `normalizeInstructions`,
>     `normalizeMeasure` → `NormalizedRecipe` matching the vault shape.
>   - `GET /api/recipes/search?q=` (auth+rate-limited, server-side; strips raw_payload).
>   - `/dashboard/recipes/discover` (mobile-first search + cards + Save to vault); "Discover"
>     button added to `RecipesModule` header.
>   - **Save** (`discover/actions.ts`): re-fetches from provider server-side, copies into
>     `family_recipes` with full provenance, deduped by (family, provider, source id) so it
>     survives provider outages. **Migration `0054_recipe_sources.sql`** added source_provider/
>     source_recipe_id/attribution/license_notes/imported_at/raw_payload to family_recipes —
>     **APPLIED TO PROD + verified.**
> - **NEXT (food OS roadmap, priority order):**
>   1. **More providers** — USDA FoodData Central + Open Food Facts (keyless/free, nutrition +
>      barcode), then Spoonacular/Edamam/FatSecret (env-key-gated stubs already planned).
>   2. **AI recipe actions** on a saved recipe ("make healthier/cheaper/higher-protein/
>      gluten-free/kid-friendly", scale servings, estimate missing nutrition) via
>      `resolveProvider()` — mark nutrition as ESTIMATES + non-medical disclaimer.
>   3. **Family meal voting** (new tables `meal_votes`/`meal_vote_options`/member votes;
>      parent creates options → family votes → winner → add to meal plan → grocery list).
>   4. **Post-meal ratings** (1–5 + tags + AI "Family/Kid/Parent score" + repeat probability;
>      feed back into recommendations). 5. **Pantry** (barcode via Open Food Facts, "use soon",
>      "recipes from pantry"). 6. **Recipe Vault upload/OCR** (image/PDF → AI structure → review).
>      7. **Admin provider settings** (`recipe_provider_settings`) for enable/keys/limits.
>   - Reuse existing `meal_plans`/`grocery_lists`. Gate advanced AI/limits by tier
>     (`requirePlanLevel`). Every external recipe must keep source/attribution/license.

> **Session update (2026-06-22d, branch `claude/funny-darwin-gkmptm`):**
> - **Two-way calendar sync — "super easy connect" UX.** A full sync platform
>   already exists (migrations 0018/0019/0045): Google OAuth two-way
>   (`/api/sync/google/*`, only provider implemented in `lib/sync/providers/`),
>   encrypted tokens, conflict engine, ICS feeds (`calendar_feeds` + nightly
>   `/api/cron/calendar-feeds`), and a published Bubaly feed
>   (`/api/sync/feeds/[token]`, `lib/sync/feed-token.ts`).
> - **This PR** added `lib/calendar/providers.ts` (pure, tested): a provider
>   catalog (Google, Apple/iCloud, Outlook/MS, Schoology, Google Classroom,
>   Canvas, TeamSnap, generic ICS) each with step-by-step "where to find your
>   ICS URL" + placeholders; plus `webcalUrl`/`httpsUrl`/`addToCalendarLinks`
>   (Google/Outlook/Apple one-click subscribe links for OUTBOUND).
> - **Rebuilt `components/dashboard/calendar-sync-panel.tsx`** into a guided
>   provider grid: pick a provider → Google shows one-click two-way OAuth +
>   read-only fallback; others show exact steps + a paste-the-URL field. Inbound
>   uses the existing `addCalendarFeed` action (ICS, auto-refreshed nightly).
>   Lives in Settings (`components/modules/settings-module.tsx`). No migration.
> - **NEXT (calendar):** (1) **Outbound section in the panel** — surface the
>   family's published Bubaly feed URL with copy + the `addToCalendarLinks`
>   buttons (need to get/create the family feed token; see `lib/sync/feed-token.ts`
>   + `sync_calendars.feed_enabled` / `/api/sync/feeds/[token]`). (2) **Implement
>   more real two-way providers** beyond Google: Microsoft Graph (Outlook) and
>   Apple CalDAV — `lib/sync/providers/` only has `google.ts`; capabilities matrix
>   in `lib/sync/capabilities.ts` already lists them. (3) Add provider presets to
>   the main `/dashboard/sync` hub too (currently capability-matrix only).

> **Session update (2026-06-22d, branch `claude/loving-mccarthy-e1ahq8`):**
> - **Public-site wiring #55 DONE — marketing Forms now render & accept submissions
>   publicly.** Admin could author `marketing_forms` (fields jsonb) but nothing
>   served them; built the public renderer + submit endpoint, mirroring the #54
>   landing-page PR. **NO migration** (tables `marketing_forms` /
>   `marketing_form_submissions` already exist; service-role writes bypass RLS).
> - **Public route** `app/(marketing)/f/[id]/page.tsx` (service-role read, only
>   `status='active'` + non-deleted forms with ≥1 field) renders the form via a
>   client `form-renderer.tsx`. Optional `metadata.{title,description,submit_label,
>   success_message}` customise it. Pages are `robots: noindex` (utility pages).
> - **Submit endpoint** `POST /api/forms/submit { formId, values }` — rate-limited
>   (10/min/IP), validates server-side, inserts a `marketing_form_submissions` row
>   (service role), and fires `fireAutomationEvent('form_submitted', …)` deduped by
>   `eventSubjectKey('form_submitted', [formId, submissionId])` (best-effort).
> - **Pure helper** `lib/marketing/forms.ts` (`parseFormFields` w/ type inference for
>   legacy label/key fields, `validateSubmission`, `submissionEmail`/`submissionName`,
>   `inputType`/`fieldAutoComplete`) + tests `tests/marketing-forms.test.ts` (10).
>   Added `/f` + `/api/forms` to `middleware.ts` PUBLIC.
> - **Admin** (`/admin/marketing/forms`): each form card now shows an Active/Archived
>   pill, a "View public form" link (`/f/<id>`) when active, and an Activate/Archive
>   toggle (`setFormStatus`). New forms are created `active` (live immediately).
> - **NEXT: Asset Library (DAM)** — `marketing_assets` (kind image/video/doc/brand,
>   storage_path, tags[], dimensions, alt, usage refs) + private bucket
>   `marketing-assets`; picker reused by Email/Social/Content/Landing. (Then Video,
>   Personalization — see "Remaining pillars to build" below.) This completes the
>   public-site wiring gap (#54 + #55); future builders must ship their public
>   surface in the same PR.

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

> **Tier & Features — ONE unified system (updated 2026-06-23b, branch
> `claude/pricing-from-tiers`).** ⚠️ A duplicate was briefly introduced (PR #110:
> a `feature_settings` table + `/admin/tiers` + `lib/features/catalog.ts`) and has
> now been **removed/consolidated** onto the canonical system below. Do NOT
> reintroduce a second one.
> - **Canonical store:** `app_settings` key **`feature_tiers`** (sparse overrides),
>   resolved against **`lib/constants/feature-catalog.ts`** (`FEATURE_CATALOG`,
>   each entry has `key`, `label`, `section`, `defaultTier`, optional `href`).
> - **Pure logic** `lib/features/tiers.ts`: `resolveFeatureTiers`, `isFeatureAvailable`,
>   `featuresAtTier`/`featuresIncludedInPlan`, and (new) **`tiersByHref`**,
>   **`featureAccessByTier(tier,planLevel,isSuperAdmin)→visible|locked|hidden`**,
>   `morePermissiveTier`. Tier semantics: Free→all; Basic→Basic+Plus (locked for
>   Free); Plus→Plus only; Off→hidden for all (super-admins preview). Tests in
>   `tests/feature-tiers.test.ts`.
> - **Server** `lib/server/feature-tiers.ts`: `getResolvedFeatureTiers` (by catalog
>   key) + **`getFeatureTiersByHref`** (by route, request-`cache`d) + `setFeatureTier`.
> - **Admin page:** **`/admin/tier-features`** (page + `tier-features-client.tsx` +
>   `actions.ts`). Its `setFeatureTierAction` writes `app_settings` and
>   `revalidatePath('/pricing')` + `revalidatePath('/dashboard','layout')`.
>   `/admin/tiers` now just **redirects** here.
> - **Drives the whole platform:**
>   - **Nav** (`app-shell.tsx` `resolveItems`) hides Off, locks below-tier, drops
>     emptied groups — fed by `featureTiers` (href→tier) on `AppProvider` (built in
>     `dashboard/layout.tsx` + `family/layout.tsx` via `getFeatureTiersByHref`).
>   - **Routes**: `requireFeature('<href>')` (`lib/supabase/auth.ts`) resolves the
>     tier by href → Off `notFound()`, else redirect to billing. Top-level gated
>     pages + `auto`/`home` layouts use it; `auto/*`+`home/*` subpages keep
>     `requirePlanLevel(1)` as a floor. **Every `requireFeature` href MUST exist in
>     `FEATURE_CATALOG`** (else the route is treated as ungated). Verify with the
>     coverage check before shipping.
>   - **Pricing** (`/pricing`, force-dynamic) reads `getResolvedFeatureTiers` and
>     renders the admin-controlled matrix; `pricing-content.tsx` `router.refresh()`s
>     on a 20s interval + on tab focus so an open page updates **in real time**.
> - **To gate a NEW feature:** add it to `FEATURE_CATALOG` (with `href`) → it
>   auto-appears in `/admin/tier-features` + the pricing matrix; gate the page/layout
>   with `requireFeature('<href>')`.

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
- **Migrations**: `supabase/migrations/00NN_name.sql`. **Next number: 0068.**
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
- **Route gating (Supabase-backed, admin-controlled)**: gate a page/layout with
  **`requireFeature('<route href>')`** (`lib/supabase/auth.ts`) — it resolves the
  feature's effective tier by href via `getFeatureTiersByHref` (`app_settings`
  override → `FEATURE_CATALOG` default), `notFound()`s on Off, else redirects to
  `/dashboard/billing?upgrade=1&need=N`. The href MUST exist in `FEATURE_CATALOG`.
  Super-admins bypass. `requirePlanLevel(1|2)` still exists (numeric floor / legacy);
  `ROUTE_PLAN_LEVEL` is documentation only. (See the unified Tier & Features block above.)
- **Client modules**: `useApp()` gives `{ familyId, userId, role, members, selfMember, isSuperAdmin, planLevel, featureTiers }`.
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

Next migration number: **0068**. (0051–0066 on main; 0067 = subscription_cancel this session.) **Still needs applying
to prod** (verify what's live first with `select max(...)`/`\dt`; all idempotent):
0044–0066 as applicable, plus **0052 `family_onboarding`** and **0053
`landing_metrics`**. (NOTE: the Tier & Features system uses **no table** — it
stores overrides in `app_settings['feature_tiers']`. The earlier `feature_settings`
migration was deleted when the duplicate was consolidated away.)

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

## Marketing Platform ("HubSpot competitor") — branch `claude/marketing-platform`
**Long-lived feature branch — do NOT merge to main until it "comes together."** Build
incrementally here, commit often, keep it building. Vision: a full marketing OS
(CRM → revenue) modeled on HubSpot/Klaviyo/Semrush etc.

### Conventions for marketing tables (business-wide, NOT family-scoped)
- Table lives in a new migration; **RLS ENABLED, NO policies** → service-role only.
- All admin reads use `createServiceClient()`; all writes go through a server action
  guarded by `requireMarketingAdmin()` (`lib/marketing/admin.ts`) which returns the
  service client + actor and gates super-admin. Log via `logMarketingAudit(...)`.
- Pages: `app/(app)/admin/marketing/<name>/page.tsx` (server component, `dynamic =
  'force-dynamic'`, `robots: { index: false }`); add to `SUBNAV` in
  `app/(app)/admin/marketing/layout.tsx`. Input class:
  `h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm`; primary btn:
  `h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90`.
- Pure logic in `lib/marketing/<feature>.ts` + vitest tests.

### Built on this branch so far
- **#52 CRM + Sales Pipeline (cornerstone)** — mig `0056_crm.sql`: `crm_contacts`
  (first/last/email/phone/company, lead_status, lifecycle_stage, lead_source,
  family_id, owner_id) + `crm_deals` (contact_id, name, amount_cents, stage,
  close_date). Pure logic `lib/marketing/crm.ts` (stages, `dealsByStage`,
  `openPipelineValueCents`, `weightedPipelineValueCents`, `winRate`, `formatCents`;
  10 tests). Pages `/admin/marketing/crm` (contacts + add form) and
  `/admin/marketing/pipeline` (stage board, add/advance/delete deals). Actions in
  `app/(app)/admin/marketing/crm/actions.ts`. Nav: CRM + Pipeline added to SUBNAV.
  **Migration 0054 must be applied to prod when this branch merges.**
- **#53 Proposals / Quotes** — mig `0057_crm_quotes.sql`: `crm_quotes` (contact_id,
  deal_id, title, status [draft/sent/accepted/declined/expired], amount_cents,
  valid_until, sent_at, responded_at). Pure logic `lib/marketing/quotes.ts`
  (status lifecycle, `isExpired`/`effectiveStatus`, `summarizeQuotes`; 8 tests).
  Page `/admin/marketing/proposals` (stats, new-quote form, send/accept/decline/
  delete). Actions `proposals/actions.ts`. Nav: Proposals. **Apply 0055 at merge.**
- **#54 Customer Intelligence (Visitor Tracking + Attribution + CDP-lite)** — mig
  `0058_visitor_intelligence.sql`: `mkt_visitors` (anonymous_id CDP spine,
  contact_id stitch, session_count), `mkt_sessions` (source/medium/campaign,
  landing_path), `mkt_touchpoints` (kind touch|conversion). Ingest:
  `POST /api/mkt/track` (service-role; upserts visitor, records session +
  touchpoint). Pure logic `lib/marketing/attribution.ts` — 4 models (first/last/
  linear/position-based), `creditForVisitor`, `attributeConversions`,
  `conversionCount` (11 tests). Page `/admin/marketing/intelligence` (visitor/
  session/conversion stats, top channels bar, attribution-by-model grid). Nav:
  Intelligence. **Apply 0056 at merge.** NEXT: wire `/api/mkt/track` calls into
  the marketing site (UTM capture on landing + a conversion call on signup), and
  stitch `contact_id` when a visitor identifies (set on signup/contact-form).
- **#55 Reputation & Trust (Testimonials + Case Studies)** — mig
  `0059_reputation.sql`: `testimonials` (author, quote, rating, is_published,
  sort_order) + `case_studies` (title, slug UNIQUE, industry, customer_name,
  summary, result_metric, is_published). Pure logic `lib/marketing/reputation.ts`
  (`slugify`, `publishedOnly`, `clampRating`; 5 tests). Page
  `/admin/marketing/reputation` (both sections: add/publish-toggle/delete). Actions
  `reputation/actions.ts`. Nav: Reputation. **Apply 0057 at merge.** NEXT: render
  published testimonials/case-studies on the public marketing site (read via
  service client in a server component, `publishedOnly`).
- **#56 Asset Library (DAM)** — mig `0060_marketing_assets.sql`: `marketing_assets`
  (name, kind [image/video/document/brand], storage_path, mime_type, size_bytes,
  width/height, alt_text, tags text[], metadata, deleted_at) + a **private
  `marketing-assets` Storage bucket** (50 MB/file, NO storage.objects policies →
  service-role only; admin mints short-lived signed URLs for image previews).
  Pure logic `lib/marketing/assets.ts` (`assetKindFromMime`, `formatBytes`,
  `parseTags`, `sanitizeAssetName`/`buildAssetPath`, `assetsByKind`; 7 tests).
  Page `/admin/marketing/assets` (upload form, stats, kind-grouped gallery with
  previews + inline edit alt/tags + delete). Actions `assets/actions.ts`
  (`uploadAssetAction` uploads to the bucket then inserts, rolling back the
  orphaned object on insert failure; `deleteAssetAction` removes the file then
  soft-deletes the row). Nav: Assets. **Apply 0058 at merge.** NEXT: (1) a
  reusable **asset picker** component for Email/Social/Content/Landing authoring;
  (2) image **dimensions + thumbnail** capture on upload (width/height columns
  exist, currently null); (3) **"where used" backrefs** so deletes warn.
- **#57 Video Marketing** — mig `0061_marketing_videos.sql`: `marketing_videos`
  (title, provider [youtube/vimeo/upload], video_id, url, storage_path,
  poster_url, captions_url, transcript, duration_seconds, status [draft/
  published], tags[], metadata, soft-delete). Pure logic `lib/marketing/video.ts`
  (`parseVideoUrl` for YouTube/Vimeo variants, `embedUrl`, `thumbnailUrl`,
  `formatDuration`, `publishedOnly`; 8 tests). Page `/admin/marketing/video`
  (add by URL OR pick an uploaded video asset from the Asset Library; gallery
  with YouTube thumbnails, publish toggle, delete). Actions `video/actions.ts`
  (`saveVideoAction` parses the URL or resolves the asset's storage_path;
  `toggleVideoPublishAction`; `deleteVideoAction` soft-deletes — the underlying
  asset stays in the library). Nav: Video. **Apply 0059 at merge.** NEXT:
  (1) public **embed component** that renders `embedUrl()` in content/landing
  pages (the consume side; admin/catalog is done); (2) **JSON-LD VideoObject**
  schema on pages that embed a published video (transcript → AEO/SEO);
  (3) auto-fetch **duration + poster** via the YouTube/Vimeo oEmbed API.
- **#58 Blog Platform (publish pipeline)** — **NO migration** (bridges existing
  `marketing_content_items` → existing `blog_posts`, mig 0010, which already
  powers the public `/blog` + `/blog/[slug]`). Pure logic
  `lib/marketing/blog-publish.ts` (`contentBodyToBlocks` plain-text→BlogBlock[],
  `estimateReadingMinutes`, `deriveExcerpt`, `blogSlugify`, `normalizeCategory`,
  `buildBlogPost`; 8 tests). Actions `content/actions.ts`: `updateContentAction`
  (edit body + workflow status + `metadata.blog` {slug,category,author,excerpt,
  featured,tags}), `publishContentToBlogAction` (upsert `blog_posts` keyed by
  slug → marks the item `published`, stamps the slug back), `unpublishBlogPostAction`.
  `/admin/marketing/content` now edits the body/blog-meta inline and has a
  **Publish to blog** button; the published list links to the live post + can
  Unpublish. NEXT: (1) a rich-text/markdown editor (today the body is plain text
  with `#`/`**…**` → h2); (2) **JSON-LD Article** schema on `/blog/[slug]`;
  (3) image/cover via the **Asset Library** picker.
- **#59 Personalization Engine** — mig `0062_personalization.sql`:
  `marketing_personalization_rules` (name, slot, match jsonb, variant jsonb,
  priority, status [active/paused], soft-delete). Pure engine
  `lib/marketing/personalization.ts` (`ruleMatches` — source/medium/campaign/
  segments/paths/countries/returning/minSessions, ALL must hold; `matchSpecificity`;
  `resolveSlot`/`resolveVariant` — priority desc → specificity desc → oldest; 8
  tests). Server resolver `lib/marketing/personalization-server.ts`
  (`resolvePersonalization(slot, ctx)` reads active rules via service role →
  resolves). Page `/admin/marketing/personalization` (create rule with audience
  match + variant fields, grouped by slot, pause/activate, delete). Actions
  `personalization/actions.ts`. Nav: Personalization. **Apply 0060 at merge.**
  NEXT: **wire real surfaces** — call `resolvePersonalization('home_hero', ctx)`
  in the marketing hero / pricing CTA / landing slots (build `ctx` from the
  `mkt_*` visitor cookie + UTM params from #54), render the variant, and fire an
  exposure to `/api/ab/track`. (Engine + admin are done; instrumentation is glue,
  mirroring the A/B pillar's remaining step.)
- **#60 Marketing Push Notifications** — mig `0063_marketing_push.sql`:
  `marketing_push_campaigns` (title, body, url, segment_id [future targeting],
  audience, status [draft/sending/sent/failed], recipients/sent/failed/skipped/
  clicked counts, sent_at, soft-delete). **Reuses** `lib/server/push.ts`
  (`sendPushToUsers`, VAPID/FCM) + `push_devices` (mig 0035). Pure logic
  `lib/marketing/push.ts` (`selectPushRecipients` dedupe + suppression filter,
  `deliveryRate`, `canSendPush`, `summarizePush`; 5 tests). Page
  `/admin/marketing/push` (create draft, Send broadcast, stats incl. opted-in
  device count, honest "push not configured" banner when VAPID/FCM keys are
  missing — sends still record but devices are skipped). Actions
  `push/actions.ts`: `sendPushCampaignAction` reserves status='sending' (no
  double-send), resolves opted-in `push_devices.user_id`, maps user→email via
  `profiles`, excludes `marketing_suppressions` emails, fans out, records counts.
  Nav: Push. **Apply 0061 at merge.** NEXT: (1) **segment targeting** (the
  `segment_id` column + 'segment' audience exist; resolve a segment's members →
  user_ids); (2) **click tracking** (append a tracked param to the url + an
  endpoint that bumps `clicked`); (3) a scheduled/cron send option.
- **#61 Exit-Intent Popups** — mig `0064_exit_intent.sql`:
  `marketing_exit_intent` (name, headline, body, cta_label/href, match jsonb,
  trigger_config jsonb {mode mouseleave|scroll, delayMs, scrollPercent},
  priority, status, impressions/conversions, soft-delete) + SECURITY DEFINER RPC
  `bump_exit_intent(p_id, p_metric)` (service_role only). **Fully wired end-to-end.**
  Pure logic `lib/marketing/exit-intent.ts` (reuses personalization `ruleMatches`;
  `normalizeTrigger`, `resolveExitIntent`, `conversionRate`, `summarizeExitIntent`;
  4 tests). Server resolver `exit-intent-server.ts`. **Public:** client
  `components/marketing/exit-intent.tsx` (mounted in `app/(marketing)/layout.tsx`)
  resolves via `POST /api/exit-intent/resolve` (UTM/path/returning ctx), arms
  mouseleave/scroll trigger, shows once per visitor/week (localStorage), and
  beacons impression/conversion → `POST /api/exit-intent/track` → RPC. Both
  endpoints added to `middleware.ts` PUBLIC (`/api/exit-intent`). Admin
  `/admin/marketing/exit-intent` (create offer + trigger + audience, stats,
  pause/activate, delete). Nav: Exit-Intent. **Apply 0062 at merge.** NEXT:
  (1) A/B-test offer variants via `assignVariant`; (2) richer triggers
  (idle-time, scroll-velocity); (3) per-offer frequency cap beyond the global
  weekly once.
- **#62 Affiliate Management** — mig `0065_affiliates.sql`: `affiliates` (code,
  commission_rate, status) + `affiliate_referrals` (status pending/converted/
  paid/void, commission_cents). Pure logic `lib/marketing/affiliates.ts`
  (`normalizeAffiliateCode`, `clampRate`, `commissionCents`, `summarizeReferrals`,
  `payoutByAffiliate`; 5 tests). Page `/admin/marketing/affiliates` (add, pause/
  activate, pay-out, delete; per-affiliate owed/paid stats). Actions
  `affiliates/actions.ts`. Nav: Affiliates. **Apply 0063 at merge.** NEXT: wire
  `?via=CODE` capture on the marketing site → create `affiliate_referrals` on
  signup/conversion (snapshot commission from the affiliate's rate).

### Already EXISTS in the app (don't rebuild — extend)
Email (`/email`, `marketing_email_campaigns`) · Automation (`/automation`,
`marketing_automation_workflows/runs`, event+scheduled triggers #87/#88/#89) ·
Landing Pages (`marketing_landing_pages`) · Forms (`marketing_forms`,
`marketing_form_submissions`) · SEO+AEO (`marketing_seo_pages/keywords`,
`marketing_aeo_questions`) · Social (`marketing_social_posts`) · SMS
(`marketing_sms_campaigns`) · Ads (`marketing_ad_campaigns`) · Segments
(`marketing_segments`) · Funnels (`marketing_funnels`) · Campaigns
(`marketing_campaigns`) · Content (`marketing_content_items`) · Reviews (#41) ·
Surveys/NPS (#40) · Referrals (#39) · A/B testing (#85, `ab_experiments/ab_events`) ·
Lead scoring (#86) · Customers/health (derived `getMarketingCustomers`) · Suppressions.

### Remaining pillars to build (from the spec screenshots, prioritized)
CRITICAL: CRM ✅ · Sales Pipeline ✅ · Proposal/Quotes ✅ · Visitor Tracking ✅ · Attribution ✅ · CDP-lite ✅ (identity-stitch contact_id on identify = next) · CDP full / unified profile (anonymous_id, device_id →
identity stitching) · Attribution (touchpoints: touchpoint_id, source, campaign) ·
Visitor Tracking (sessions, page_views, visitor_id) · Audience Segmentation (dynamic,
extend `marketing_segments`).
HIGH: Testimonials ✅ + Case Studies ✅ (distinct from reviews) · Asset Library ✅
(`marketing_assets` + private bucket; picker/thumbnails/backrefs = next) · Video
Marketing ✅ (`marketing_videos`; admin/catalog done — public embed + JSON-LD =
next) · Blog Platform ✅ (content_items → blog_posts publish pipeline; no
migration; rich editor + JSON-LD = next) · Personalization Engine ✅
(`marketing_personalization_rules` + server resolver; surface instrumentation =
next) · Push Notifications ✅ (`marketing_push_campaigns`; broadcast send reusing
VAPID/FCM, honors suppressions; segment targeting + click tracking = next) ·
Exit-Intent Popups ✅ (`marketing_exit_intent`; fully wired — public popup on the
marketing site + resolve/track endpoints; A/B variants = next) · Affiliate
Management ✅ (`affiliates` + `affiliate_referrals` with commission tracking +
payout; NEXT: public `?via=CODE` capture + a partner dashboard).
MEDIUM: Competitor Monitoring ✅ · Keyword Intelligence ✅ · Backlink Monitoring ✅
— shipped as Competitive Intelligence (mig `0066_competitive_intel.sql`:
`competitors` + `keyword_intel` + `backlinks`; pure logic `lib/marketing/competitive.ts`
— `normalizeDomain`, `keywordOpportunity` (volume×poor-rank), `summarizeBacklinks`,
7 tests; page `/admin/marketing/competitive` with all 3 sections + add/delete;
nav: Competitive). **Apply 0066 at merge.** NEXT: auto-import from Semrush/Ahrefs
APIs instead of manual entry.
ALL spec pillars are now built. Remaining work = the per-pillar "NEXT" wiring/glue
items (public-site instrumentation): visitor `/api/mkt/track` calls + identity
stitch (#54), public testimonials/case-studies (#55), asset picker (#56), video
embed (#57), personalization surfaces (#59), push segment/click (#60), exit-intent
A/B (#61), affiliate `?via=` capture (#62) — see each pillar's NEXT above.
Each: new table(s) per the field lists in the spec, pure logic + tests, an admin
page + SUBNAV entry, wire to Supabase. Build one pillar per commit on this branch.

### Marketing platform — how to continue
1. `git checkout claude/marketing-platform` (create from main if missing), build the
   next pillar following the conventions above, commit to the branch (do NOT merge).
2. Keep `tsc`/lint/build/vitest green each commit. New migration = next number
   (**0063+**; this branch's marketing migrations are 0054–0062, renumbered to sit
   after main's max). Note it must be applied to prod at merge time, and re-check
   it's still after main's highest migration just before merging.
3. When the platform is "ready to come together," open the PR to main and apply all
   its migrations. Until then it stays on the branch.

---
<!-- Below: the parallel "vision/roadmap" notes from main; kept for context. -->

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
see migration section; **next number: 0068**) → update this doc's pillar row +
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
| Forms | ✅ | `marketing_forms`, `marketing_form_submissions` (0020) | fields jsonb; submission payload | `/admin/marketing/forms` + public `/f/[id]` | Field-type/required authoring UI (renderer infers types today); embed snippet + per-form thank-you redirect |
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
   - **#55 Forms → public embed + submit. ✅ DONE** (branch
     `claude/loving-mccarthy-e1ahq8`, NO migration). `/f/[id]` renders active forms;
     `form-renderer.tsx` posts to `/api/forms/submit` → inserts a submission
     (service-role) + fires `fireAutomationEvent('form_submitted', …)`. Admin has an
     Active/Archive toggle + "View public form" link. Pure helpers in
     `lib/marketing/forms.ts` (tested). This closes the public-site wiring gap.
2. **Asset Library (DAM)** ⬜ — **NEXT.** `marketing_assets` (kind image/video/doc/brand,
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
The marketing **builders ship before their public surfaces**. Landing pages (#54)
and forms (#55) are now both wired end-to-end — the public site renders landing
pages (`/lp/[slug]`) and renders+accepts forms (`/f/[id]` + `/api/forms/submit`).
This "looks done but isn't wired" gap is **now closed**. The standing caution
remains for any future builder: ship the public renderer/endpoint in the same PR
as the authoring UI, or record it here as a wiring TODO so it isn't mistaken for
complete.

## Tier & Features admin (admin-controlled feature gating) — branch `claude/tier-features`
Goal: one admin screen that sets every service's minimum tier (Off / Free / Basic /
Plus) and flows those changes to the pricing page + in-app gating. **NO migration**
(stored in `app_settings` key `feature_tiers`, like the AI config).
- **Catalog** `lib/constants/feature-catalog.ts` — `FEATURE_CATALOG` (~60 services
  with `{key,label,section,defaultTier,href}`); defaults mirror the published
  Free/Basic/Plus comparison grid (the global default offering). 4 sections.
- **Pure logic** `lib/features/tiers.ts` (11 tests): `FeatureTier` =
  off|free|basic|plus, `tierToLevel` (free0/basic1/plus2/off-1), `resolveFeatureTiers`
  (overrides over defaults, ignores unknown/invalid keys), `isFeatureAvailable`,
  `featuresIncludedInPlan`, `featuresAtTier`, `overridesFromResolved`.
- **Server** `lib/server/feature-tiers.ts`: `getFeatureOverrides` / `getResolvedFeatureTiers`
  / `setFeatureTier` (clears override when set back to default) / `resetFeatureTiers`.
- **Admin** `/admin/tier-features` (super-admin; `page.tsx` + `tier-features-client.tsx`
  4-button toggle grid per service + `actions.ts` guarded by getUser+isSuperAdmin →
  service client). Nav: ADMIN_NAV "Tier & Features". Each save revalidates
  `/pricing` + `/dashboard` layout.
- **Pricing wired LIVE**: `app/(marketing)/pricing/page.tsx` resolves the matrix and
  passes `featureMatrix` to `PricingContent`, which renders a new "Every feature, by
  plan" check-matrix table that reflects admin changes immediately (off = hidden).
- **REMAINING (next step):** wire **in-app nav gating** to the same config. The
  catalog rows carry `href`; build a server map `href → tierToLevel(resolvedTier)`
  and have the sidebar (and `requirePlanLevel`/`ROUTE_PLAN_LEVEL`) consult it to
  override the hardcoded `minLevel` in `lib/constants/navigation.ts`. Today the
  admin control + pricing are live; nav still reads the static `minLevel`. (Verified:
  tsc/lint clean · vitest 494 · build OK; `/admin/tier-features` + `/pricing` built.)
- **Account widget shows the subscription tier**: the bottom-left family switcher
  (`components/app/app-shell.tsx` `FamilySwitcher`) now renders
  `{ROLE_LABELS[role]} / {tierLabelForLevel(planLevel)}` → e.g. "Parent / Admin /
  Free Tier", auto-updating to "Basic Tier"/"Plus Tier" on upgrade (`planLevel`
  from `useApp()` reflects the live subscription). Helper `tierLabelForLevel(level)`
  + `TIER_LABEL_BY_LEVEL` in `lib/constants/plans.ts` (tested in plans.test.ts).

## Marketing admin subnav — grouped multi-row tabs
The ~40 `/admin/marketing/*` surfaces were one long horizontal-scroll row. Now a
**grouped, wrapping tab panel** (`app/(app)/admin/marketing/marketing-subnav.tsx`,
client component using `usePathname` for active highlighting). Items are organized
into labelled rows: Overview · CRM & Sales · Audience & Intelligence · Channels ·
Growth · Content & SEO · Reputation & Loyalty. `flex-wrap` chips = no horizontal
scroll, mobile-friendly (label stacks above chips < sm). `layout.tsx` just renders
`<MarketingSubnav />`. **When adding a new marketing page, add its chip to the
right GROUP in `marketing-subnav.tsx`** (the old flat SUBNAV array is gone).

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
