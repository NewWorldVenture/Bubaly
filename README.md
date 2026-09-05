# Bubaly

**Run your family like a calm, connected team.** An AI chief of staff for the household — calendar, chores, meals, grocery, school, sports, health, home maintenance, documents, notes, goals, and an AI assistant that takes real action.

> Build status: **every roadmap phase (1–14) is implemented** — architecture + database, the marketing site and web app shell, auth/onboarding/dashboard, all module UIs, the streaming AI assistant, native mobile (Capacitor shell **and** an Expo app on shared design tokens), notification workers, tests, CI, Vercel config, and hardening. See "Roadmap" below for where each phase lives — no guesswork.

## Stack
Next.js 15 (App Router) · TypeScript · Tailwind · Supabase (Postgres + Auth + Storage + Realtime) · provider-agnostic AI (Anthropic/OpenAI/Gemini) · Vercel · **Capacitor** native shells for iOS/iPadOS/Android.

## Mobile apps (iOS, iPadOS, Android)
Bubaly ships natively via **Capacitor** (one codebase, wrapping the hosted, Supabase-wired app) plus an installable **PWA** — no feature drift between web and mobile. Alongside the shell, **`mobile/` is a native Expo app** (expo-router, Supabase auth in the Keychain/Keystore, the family's daily loop — Today, Calendar, Chores, Grocery, Assistant) built on the **same design tokens as the web** (`design/tokens.json`, dark default + light toggle) and talking to the assistant through `/api/ai` with a bearer token. Push notifications are fully wired to Supabase (`push_devices` + `lib/server/push.ts`, delivered through the notification engine). See **[docs/mobile.md](docs/mobile.md)** for setup, build, and release. Building the `.ipa`/`.aab` requires a Mac with Xcode / Android Studio; native push requires Firebase/APNs credentials.

## What's in here now
```
supabase/
  migrations/
    0001_extensions_enums.sql   enums + extensions
    0002_tables.sql             all 32 tables, FKs, indexes
    0003_functions_triggers.sql RLS helpers, profile/family bootstrap, updated_at
    0004_rls.sql                RLS enabled on EVERY table + policies (family isolation)
    0005_rpcs.sql               accept_invite(), grocery_from_meal_plan()
  seed.sql                      5 families, 25 members, 100 events, 100 chores,
                                100 grocery items, 50 meals, 50 maintenance, 50 school/sports,
                                50 reminders, 25 documents, sample AI conversation
  config.toml
lib/
  supabase/client.ts            browser client (RLS as user)
  supabase/server.ts            server + service-role clients
  supabase/bearer.ts            bearer-token client + context (mobile / scripts)
  ai/provider.ts                swappable LLM interface (Anthropic impl included)
  ai/actions.ts                 AI tool calls -> real Supabase writes (family-scoped)
  ai/assistant-engine.ts        the agentic assistant: context + tools + SSE/JSON transports
  security/csp.mjs              Content-Security-Policy composition (next.config.mjs)
  database.types.ts             typed schema (regenerate with `npm run db:types`)
app/api/ai/route.ts             canonical assistant endpoint (SSE + JSON, cookie or bearer)
design/tokens.json              shared design tokens (web CSS/Tailwind + Expo), typed by design/tokens.ts
mobile/                         Expo app (expo-router) on the shared tokens — see docs/mobile.md
middleware.ts                   session refresh + protected-route guard
```

## Security model (the important part)
- **RLS is enabled on all 32 tables.** Every household table is gated by `is_family_member(family_id)`, a `SECURITY DEFINER` helper that prevents recursion and guarantees **no row ever crosses a family boundary**.
- Managers (`parent`/`adult`) gate invites, billing, and member management via `can_manage_family()` / `is_family_admin()`.
- The service-role key is server-only (webhooks, cron, push dispatch). The browser only ever uses the anon key, so the AI assistant physically cannot read another family's data.
- Documents live in a **private** Storage bucket; serve via signed URLs only.
- A site-wide **Super Administrator** (currently `daniel.hughen@gmail.com`, see `supabase/migrations/0008_super_admins.sql`) is the one exception to family isolation: `/admin` checks `is_super_admin()` (a `SECURITY DEFINER` function matched against an allowlist table no client can read directly) and, only then, uses the service-role client for genuine cross-family oversight. Add more admins via `insert into public.super_admins (email) values (...)`.

## Local setup
```bash
npm install
cp .env.example .env.local          # fill in Supabase + AI keys
supabase start                      # local stack (Docker)
supabase db reset                   # applies migrations + seed.sql
npm run db:types                    # regenerate full lib/database.types.ts
npm run dev
```

## Deploy
1. Create a Supabase project; copy URL + anon + service-role keys.
2. `supabase link --project-ref <ref>` then `supabase db push` (applies migrations). Run `seed.sql` in the SQL editor if you want demo data.
3. Create a private Storage bucket named `documents`.
4. Push to GitHub; import the repo in Vercel.
5. Add all `.env.example` variables to Vercel project settings.
6. Set Supabase Auth redirect URLs to your Vercel domain.


**Cron jobs.** `vercel.json` only declares once-a-day schedules, because Vercel's
Hobby plan rejects any deployment whose crons run more often ("Hobby accounts
are limited to daily cron jobs"). The real cadences (every 5/15 min, hourly,
every 2–6 h) are driven by `.github/workflows/cron-dispatch.yml` →
`scripts/cron-dispatch.mjs`, which needs the repository secret `CRON_SECRET`
(same value as the Vercel env var) and optionally the variable
`CRON_BASE_URL`. On Vercel Pro you can copy the schedules from
`scripts/cron-dispatch.mjs` back into `vercel.json` and disable the workflow.

**Build memory.** `npm run build` runs Next with a 4 GB heap (`node
--max-old-space-size=4096`); the type check of the generated route types needs
more than Node's default on 7–8 GB builders.

## Roadmap (all phases shipped)
Every phase below is implemented and gated by CI. Where each one lives:

| Phase | Scope | Where it lives |
| --- | --- | --- |
| **1–2** | Architecture + full database (RLS on every table) | `supabase/migrations`, `SCHEMA_tables.sql`, `lib/database.types.ts` |
| **3–4** | Web app shell + marketing site (Home, Features, Pricing, Security, FAQ, blog, guides, compare…) | `app/(marketing)/*`, `app/(app)/layout.tsx` |
| **5–6** | Auth + onboarding + family dashboard (glassmorphism, dark default + light toggle) | `app/(auth)/*`, `app/onboarding`, `app/(app)/dashboard`, `components/theme/*` |
| **7** | Module UIs: calendar, chores, meals, grocery, health, home, documents, notes (and many more) | `app/(app)/dashboard/{calendar,chores,meals,grocery,health,home,documents,notes}` |
| **8** | AI assistant route — `/api/ai` streams SSE (or returns JSON) and executes `lib/ai/actions.ts` plus the assistant toolbox, trust-wrapped per role | `app/api/ai/route.ts`, `lib/ai/assistant-engine.ts`, `lib/ai/action-tools.ts` (`/api/ai/chat` remains the web client's original endpoint) |
| **9** | Expo mobile app on shared design tokens (Supabase auth in secure storage, Today/Calendar/Chores/Grocery/Assistant, bearer-authenticated `/api/ai`) — plus the Capacitor shell + PWA | `mobile/`, `design/tokens.json`, `docs/mobile.md` |
| **10** | Notification workers (push + email) for due chores, medications, events, expiring documents/renewals | `app/api/cron/notifications`, `lib/server/notifications.ts`, `lib/server/push.ts`, `lib/server/notification-emails.ts` |
| **11–12** | Tests: Vitest unit suite (700+ files) + Playwright e2e (public, a11y, authenticated, mobile device matrix, CSP) | `tests/`, `tests/e2e/`, `vitest.config.ts`, `playwright.config.ts` |
| **13** | GitHub Actions CI (typecheck · lint · test · build · isolated-Supabase e2e · Expo typecheck) + Vercel config (crons, headers) | `.github/workflows/ci.yml`, `vercel.json`, `next.config.mjs` |
| **14** | Hardening: RLS everywhere, rate limits, bounded request bodies, HSTS, X-Frame-Options, Content-Security-Policy, cron auth, super-admin allowlist | `lib/security/csp.mjs`, `middleware.ts`, `lib/server/*`, `PRODUCTION_READINESS_REPORT.md` |
