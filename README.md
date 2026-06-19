# FamilyOS

**Run your family like a calm, connected team.** An AI chief of staff for the household — calendar, chores, meals, grocery, school, sports, health, home maintenance, documents, notes, goals, and an AI assistant that takes real action.

> Build status: this repo currently ships **Phase 1–2 complete** (architecture + full database). The web app, marketing site, mobile app, and notification workers are scaffolded and being built on top of this foundation. See "Roadmap" below for exactly what is wired vs. pending — no guesswork.

## Stack
Next.js 15 (App Router) · TypeScript · Tailwind · Supabase (Postgres + Auth + Storage + Realtime) · provider-agnostic AI (Anthropic/OpenAI/Gemini) · Vercel · Expo (mobile, later phase).

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
  ai/provider.ts                swappable LLM interface (Anthropic impl included)
  ai/actions.ts                 AI tool calls -> real Supabase writes (family-scoped)
  database.types.ts             typed schema (regenerate with `npm run db:types`)
middleware.ts                   session refresh + protected-route guard
```

## Security model (the important part)
- **RLS is enabled on all 32 tables.** Every household table is gated by `is_family_member(family_id)`, a `SECURITY DEFINER` helper that prevents recursion and guarantees **no row ever crosses a family boundary**.
- Managers (`parent`/`adult`) gate invites, billing, and member management via `can_manage_family()` / `is_family_admin()`.
- The service-role key is server-only (webhooks, cron, push dispatch). The browser only ever uses the anon key, so the AI assistant physically cannot read another family's data.
- Documents live in a **private** Storage bucket; serve via signed URLs only.

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

## Roadmap (remaining phases)
- **3–4** Web app shell + marketing site (Home, Features, Pricing, Security, FAQ, etc.)
- **5–6** Auth + onboarding + family dashboard (glassmorphism, dark-default + light toggle)
- **7** Module UIs: calendar, chores, meals, grocery, health, home, documents, notes
- **8** AI assistant route (`/api/ai`) streaming + executing `lib/ai/actions.ts`
- **9** Expo mobile app (shared design tokens)
- **10** Notification workers (push + email) for due chores/meds/events/expiring docs
- **11–14** Tests (Vitest + Playwright), GitHub Actions CI, Vercel config, hardening
