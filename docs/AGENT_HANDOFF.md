# Agent Handoff — Bubaly / FamilyOS

_Last updated: 2026-06-22 by the Claude agent session `claude/connect-8ysp00`._

This doc lets another agent pick up cleanly. It captures the repeatable build
pipeline, the current in-flight work, and the exact next steps.

---

## 1. Repo & environment facts

- **Product:** Bubaly (formerly "FamilyOS"), a family operating-system web app. Production: `https://www.bubaly.com`.
- **Stack:** Next.js 15 (App Router) + TypeScript + Tailwind + Supabase (Postgres + Auth + Storage + RLS). Hosting: Vercel (free plan, 100 deploys/day cap — a "Deployment rate limited" Vercel status is a plan limit, **not** a code bug; git merges are unaffected).
- **AI:** provider-agnostic via `lib/ai/provider.ts` `getProvider()` (Anthropic default, model from `AI_MODEL`/`AI_PROVIDER`). The provider now supports **vision** (optional `images: {media_type, data}[]` on a user message → base64 image blocks). Backward compatible (text-only callers unchanged).
- **GitHub scope:** `NewWorldVenture/FamilyOS` only. Use the `mcp__github__*` MCP tools (no `gh` CLI). PRs are created as **draft**, then marked ready + **squash-merged** to `main`.
- **Dev branch convention for this session:** work on `claude/<feature>` branches off `origin/main`; push with `-u`; open a draft PR; mark ready; squash-merge.

### Key conventions to copy
- **RLS helper:** `public.is_family_member(family_id)` (SECURITY DEFINER). Family-scoped tables use it for SELECT/ALL. Business-wide marketing tables enable RLS with **no policies** (service-role only via `createServiceClient()`), gated by `requireMarketingAdmin()` + `logMarketingAudit()` in `lib/marketing/admin.ts`.
- **Types:** `lib/database.types.ts` is **hand-authored** with a `T<Row, Insert, Update>` helper and `Stamps = {created_at, updated_at}`. Add new tables before `Views: { [_ in never]: never };`.
- **Triggers:** `public.set_updated_at()` via a `DO $$ ... FOREACH` loop creating `trg_<table>_updated_at`.
- **Migrations:** numbered `NNNN_name.sql` in `supabase/migrations/`. Make them **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `ON CONFLICT DO NOTHING`). Latest applied on prod is whatever the user has run in Supabase — **always surface the production SQL** for the user to run after merge.
- **Auth context:** `requireUserContext()` → `{ user, active: { familyId, member, role }, memberships }`. Plan-gated pages use `requirePlanLevel(1|2)`. Super admins bypass plan gates.
- **Storage:** private buckets; path convention `{family_id}/...`; RLS checks `is_family_member(((storage.foldername(name))[1])::uuid)`. Read via `createSignedUrl`.
- **UI kit:** `components/ui/{card,badge,avatar,states}`. `EmptyState` from `@/components/ui/states`. Local `components/home/field.tsx` is an element-children `Field` (the UI-kit `Field` uses a render-prop `(id)=>ReactNode` — don't confuse them).

### Verify pipeline (run all four before every PR)
```bash
npx tsc --noEmit
npx next lint --dir <changed dirs>
npx next build
npx vitest run <new test files>
```
**Migration validation on real Postgres 16** (catches RLS/CHECK/idempotency bugs):
```bash
mkdir -p /tmp/pg && chown postgres:postgres /tmp/pg
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D /tmp/pg -U postgres
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg -o "-p 5440 -k /tmp" -l /tmp/pg.log start
# Create role + prereq stubs (auth schema, families, family_members, set_updated_at,
# is_family_member, storage schema/buckets/objects/foldername, any base tables the
# migration ALTERs, and: CREATE ROLE authenticated;) then apply the migration TWICE
# (second run must be a clean no-op for idempotency).
```

---

## 2. What shipped earlier this session (merged to main)
Social Command Center (0034), push devices (0035), Home & Maintenance (0036),
Auto (0037), notification_pushed_at (0038), Referral program (0039),
**Marketing Pillar 1 Surveys/NPS/CES/CSAT** (0040), **Pillar 2 Reviews & Reputation** (0041).
VAPID push keys were wired by the user in Vercel env.

---

## 3. IN-FLIGHT — finish these two PRs (both currently DRAFT, blocked only on GitHub API rate limit)

### PR #94 — Marketing Pillar 3: Loyalty & Rewards  (branch `claude/marketing-loyalty`)
- **Status:** code complete, pushed, **preview deploy green**. Migration `0042_loyalty.sql` validated on PG16 (5 tables, RLS, CHECK). All four verify steps passed.
- **Blocked on:** `mcp__github__update_pull_request(draft:false)` is **rate-limited** (HTTP 403 "API rate limit exceeded"). The `update` endpoint bucket was exhausted; `create`/`merge` were usable at times.
- **NEXT STEPS:**
  1. `mcp__github__update_pull_request` PR 94 → `draft:false`.
  2. `mcp__github__merge_pull_request` PR 94 → `squash`.
  3. Give the user the **production SQL** (contents of `supabase/migrations/0042_loyalty.sql`) to run in Supabase.

### PR #96 — Family Missions (AI chores)  (branch `claude/family-missions`)
- **Status:** code complete, pushed, preview deploy building/green. All verify steps passed; migration `0043_chore_missions.sql` validated twice on PG16 (7 tables, 7 badges seeded, 7 policies, private `chore-proof` bucket, CHECK constraints).
- **IMPORTANT history note:** this branch was cut **on top of** `claude/marketing-loyalty` (before #94 merged), so its diff currently **also includes the loyalty files**. After #94 merges to main:
  ```bash
  git checkout claude/family-missions
  git fetch origin main && git merge origin/main   # loyalty files become part of main; diff narrows to Missions
  git push
  ```
  Then mark #96 ready + squash-merge. Then surface `0043_chore_missions.sql` production SQL for the user.
- If #94 ends up NOT merged first, #96 still merges fine (loyalty changes are additive and identical), but prefer merging #94 first for clean history.

---

## 4. The current big request (PARTIALLY DELIVERED in PR #96) — "world-class AI family chore system"

The user pasted a very large spec (better than Greenlight/Homey/PointUp/Joon/Skylight). **Do NOT rebuild from scratch — extend the existing system.** The repo already had: `chores`, `chore_assignments` (status enum todo/in_progress/submitted/approved/rejected, `points_awarded`, `due_at`), `rewards` catalog, `reward_redemptions` request workflow (0028), `lib/rewards/points.ts` (balance math), a kid dashboard at `/kids`, and `lib/constants/navigation.ts`.

### Delivered in PR #96
- Migration 0043 (config columns on chores/assignments + chore_submissions, chore_ai_validations, chore_disputes, chore_approval_events, kid_progress, badges, member_badges + `chore-proof` bucket).
- `lib/chores/ai.ts` — `validateChoreSubmission` (real vision via provider images; **safe fallback to `parent_review_required`**, never auto-reject; safety flags force human review) + `generateChorePlan`.
- `lib/chores/logic.ts` (pure: reward calc, auto-approve gate, XP→level, streaks) + `tests/chores-logic.test.ts` (16 tests).
- `lib/chores/server.ts` — XP/streak/level/badge engine + approval audit.
- `app/(app)/missions/actions.ts` — submit proof → AI validate → auto-approve or route to parent; approve/adjust/reject/redo; dispute; create chore; AI plan generator.
- Pages: `/missions` (parent approval queue), `/missions/new` (builder + AI plan generator), `/kids/submit/[assignmentId]` (kid proof flow). Kid jobs link into submit; "Family Missions" added to nav.

### NOT yet built (future PRs — honest backlog from the spec)
1. **Reward store UX** (kids browse/redeem prizes; parents define store items). Schema mostly exists (`rewards` + `reward_redemptions`); needs Missions-era polish (inventory/limit/expiration, "available to which kids", cash vs points cost).
2. **Allowance & Wallet page** — earned/pending/paid/saved/spent, parent IOU, export. `lib/rewards/points.ts` computes balances; needs cash ledger surfacing (`chore_assignments.cash_awarded_cents` now exists).
3. **Family Insights / charts** — completion rate, earnings, streaks, disputes, fairness, approval time.
4. **Parent AI Assistant** ("who fell behind?", "make chores fairer", "Saturday reset plan") and **AI Fairness Engine** (overloaded child, uneven difficulty, rejection patterns, photo-gaming). Build as an API route + `lib/chores/ai.ts` functions (`summarizeFamilyProgress`, `detectFairnessIssues`, `suggestRewards`, `generateParentReviewSummary`).
5. **Gamification UI** — kid progress page (XP ring, level, streaks, badges), family leaderboard (gated by a parent toggle for privacy), family quests / team goals / weekend challenge / mystery bonus.
6. **Visual routine cards / emoji mode for non-readers**; celebration animations.
7. **Video proof validation** — currently video is stored + shown but only still images go to vision; extract frames server-side or send a representative frame, else route video to parent review (current behavior).
8. **Notifications** for chore events (assigned, due soon, overdue, AI approved, needs redo, parent approval needed, dispute, reward earned/redeemed, weekly summary) — reuse the existing `notifications` table (0002) + `lib/notifications/*`.
9. **Pricing-tier feature flags** (Free/Basic/Plus): AI features should gate at `requirePlanLevel(2)`; recurring/photo/reward-store at level 1. Free: ≤2 kids, points only, manual approval.
10. **Recurrence engine** — `chores.recurrence` exists but auto-spawning the next `chore_assignment` on completion/schedule isn't implemented.

---

## 5. Marketing pillars status (for context)
Pillar 1 Surveys ✅ merged. Pillar 2 Reviews ✅ merged. **Pillar 3 Loyalty = PR #94 (finish merge).** If the user asks for "Pillar 4", prior chosen order suggests options like Funnels, Landing Pages, Forms, SEO/AEO, Automation — confirm with the user via `AskUserQuestion`.

---

## 6. Active PR subscriptions
This session is subscribed to PR activity for **#94** and **#96**. Vercel "Building/Ready" bot comments need no action. The subscription is done only when a PR is merged or closed; webhooks don't deliver CI-success / new-push / merge-conflict transitions, so re-check state proactively (and via `send_later` self check-ins if available).

---

## 7. Hard rules honored (keep honoring)
- **Never fake** connected/posted/published/validated states — only reflect what a provider/model actually confirmed. AI chore validation degrades to parent review; it never silently "passes".
- Secrets (tokens, VAPID private key) live only in Vercel env, never client-side.
- Service-role only for business-wide marketing tables; family RLS everywhere else.
- Do not push to branches other than the designated `claude/*` feature branches without explicit permission.
