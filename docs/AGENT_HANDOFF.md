# Agent Handoff — Bubaly / FamilyOS

Living context doc so another agent can continue without re-deriving everything.
Last updated after PR #75. Keep this updated as you ship.

## Product & stack
- **Bubaly / FamilyOS** — a family operating system. Next.js 15 App Router + TS +
  Tailwind + Supabase (Postgres/Auth/Storage/RLS) + Stripe + Anthropic AI.
- Deployed on **Vercel** at **theagoras.com / bubaly.com** (the brand is "Bubaly").
- Route groups: `app/(app)` (authed product), `app/(marketing)` (public), `app/(app)/admin` (super-admin console).
- Tiers: **Free (level 0)**, **Family Basic (1)**, **Family+ (2)**. `lib/constants/plans.ts`.

## ⚠️ CRITICAL: deploy is blocked (read first)
- The Vercel account is on the **Hobby plan → 100 deployments/day**, and it's
  **exhausted**. New pushes to `main` build but **do not promote to production**,
  so changes are NOT visible on bubaly.com even though they're correctly in `main`.
- Error seen in Vercel: `api-deployments-free-per-day` ("more than 100, try again in 24h").
- **Workarounds (user must do — no Vercel token in this env):**
  1. Alias the latest *built* deployment to the domain via Vercel CLI
     (`vercel alias set <deployment-url> www.bubaly.com`) — an alias is NOT a new
     deployment, so it bypasses the cap. (Preview deployments carry preview env vars.)
  2. Upgrade to Vercel Pro (lifts the cap).
  3. Wait ~24h for reset, then promote.
- **Because of this cap, BATCH work into tight single-commit PRs** (one feature per PR).
  Do not push many commits rapidly — each spawns deployments and superseded builds.

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
- Do NOT put the model id in commits/PRs/code. Only create PRs when asked (the user
  has standing instruction here to push PRs to main aggressively).

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
- Migrations are idempotent (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, enum
  guards). Always apply the migration to prod after merging the migration file.

## Conventions
- **Migrations**: `supabase/migrations/00NN_name.sql`. Next number after **0047**.
  Next number after **0048**.
  Helpers available in DB: `public.is_family_member(family_id)`, `public.is_super_admin()`,
  `public.set_updated_at()` trigger fn, `gen_random_uuid()`.
- **Family-scoped tables** (member data): RLS pattern —
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` then a single
  `FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (...)`,
  OR split select/insert policies. See `0043_wishlists.sql`, `0046`, `0047` for templates.
- **Admin/marketing tables** (business-wide): RLS ENABLED with **NO policies** →
  service-role only. Access via `lib/marketing/admin.ts` `requireMarketingAdmin()`
  (returns service client + actor, super-admin gated). See `0013_marketing.sql`.
- **Types**: hand-maintained in `lib/database.types.ts`. Add each new table as a
  `T<Row, Insert, Update>` entry. `& Stamps` adds created_at/updated_at.
- **Nav**: `lib/constants/navigation.ts` `APP_NAV_GROUPS` (items have `minLevel`).
  Locked items render greyed with a lock and open the tier-aware `UpgradeModal`
  (`components/app/upgrade-modal.tsx`). Add icon to the lucide import line.
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
npx vitest run tests/<your>.test.ts
```

## Gotchas
- `useSearchParams()` in a client component needs a `<Suspense>` boundary at the page
  (see `app/(app)/dashboard/billing/page.tsx`).
- A shared Supabase query builder across two tables unions their columns and breaks
  typing — write a separate function per table (see `quick-capture.tsx`).
- Recipe field is `name` (not `title`). `family_photos.uploaded_by` is a USER id;
  map via `member.user_id`. `chore_assignments` completion = `approved_at` not null.

## Shipped so far (this initiative)
- Marketing pillars (parallel/earlier): Surveys, Reviews, Referrals (#59–#61).
- #67 tier-aware UpgradeModal · #68 tier-aware billing deep-link
- #69 Family Announcements (mig 0046) · #70 Event RSVP + event detail (mig 0047)
- #71 Family Activity Feed (read-time, no schema) · #72 Quick Capture FAB
- #73 this handoff doc · #74 Smart Birthday & Anniversary Center (mig 0048, `family_dates`)
- #75 Family Readiness Snapshot (read-time, no schema; teases Plus)

Latest migration applied to prod: **0048**. Next migration number: **0049**.

## Backlog (prioritized, each a clean PR)
1. **Family Memory Timeline** (Free) — milestones/trips/achievements. Could be
   read-time (derive from photos/events/trips) or a small `family_milestones` table.
2. Marketing pillars still open from the earlier brief: Customer Health & Churn
   scoring, A/B testing, Lead scoring, lifecycle journeys.
3. Broader UX brief (Phases 3/4/5/9/11): mobile-first polish, theme-token audit,
   Family Command Center home, AI-native touches, performance.

## How to continue (quick start for the next agent)
1. Read this whole file. Recreate `/tmp/sbq.mjs` if missing (see migration section);
   ask the user for the Supabase PAT.
2. Pick the top backlog item. Build it following the conventions above.
3. Verify (tsc/lint/build/vitest), apply any migration via the Management API,
   then clean single-commit PR → squash-merge to main.
4. Update this doc's "Shipped"/"Backlog"/migration number after each PR.
5. Remind the user about the Vercel deploy cap if they expect to see changes live.

## Reference
- Source UX/IA brief and the marketing-platform brief are in the session history.
- GitHub: repo `NewWorldVenture/FamilyOS`, use `mcp__github__*` tools (load via ToolSearch).
- Tests live in `tests/`; CI runs Typecheck·Lint·Test·Build + E2E smoke on PRs.
