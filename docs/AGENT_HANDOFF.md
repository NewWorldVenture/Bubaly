# Agent Handoff — Bubaly / FamilyOS

Living context doc so another agent can continue without re-deriving everything.
Last updated after PR #87. Keep this updated as you ship.

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
- **Migrations**: `supabase/migrations/00NN_name.sql`. **Next number: 0049.**
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

Latest migration applied to prod: **0050**. Next migration number: **0052**.
(0050 dedup index applied; **0051 `checkout_sessions` still needs applying** to prod.)

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
