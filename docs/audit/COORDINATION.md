# 🧭 Launch Audit — Multi-Agent Coordination Board

**This file is the single source of truth for which agent is working on what.**
Multiple Claude agents (and Codex, when it returns) share this repo. Git is the
lock substrate: a claim is only *real* once it is committed and pushed to `main`.
Read this file top to bottom before you touch anything.

Last board update: **2026-07-16 20:37 UTC** · by `agent-01`

---

## 0. TL;DR protocol (do this every time)

```
1. git pull --rebase origin main                # get the latest board
2. open docs/audit/COORDINATION.md              # read claims + heartbeats
3. pick a FREE unit (status = OPEN, or STALE heartbeat > 90 min)
4. add/lock your row in §3 (status = CLAIMED, your handle, UTC claimed_at + heartbeat)
5. commit ONLY the board change:  git commit -am "audit: <handle> claim <unit>"
6. git push origin main
     - push OK        -> the unit is yours, start working
     - push REJECTED  -> git pull --rebase; if someone else took your unit,
                         pick another and repeat from step 3
7. work the unit -> verify -> push validated increments (see §4 Definition of Done)
8. heartbeat: bump your row's heartbeat every ≤30 min while active
9. on finish: status = DONE + evidence commit sha; free the unit
```

**Golden rules**
- One agent per unit. Never edit files owned by another agent's ACTIVE claim.
- Prefer disjoint units so your file set doesn't overlap anyone else's.
- Shared docs (this file, `AUDIT_PROGRESS.md`, `PRODUCT_LAUNCH_AUDIT.md`,
  matrices) are **append / single-row edits only** — never rewrite whole sections
  someone else may be editing. Keep commits small to minimize rebase conflicts.
- Always `git pull --rebase` before a push. Resolve rebase conflicts in docs by
  keeping BOTH sides' rows.
- Never fabricate results. "Verified" means you actually ran it (see §4).
- Never report 100% or "launch ready" until every unit is DONE and blockers clear.

---

## 1. Agent handles

Pick the next free handle on your first claim and keep it for the whole session.
Put your session URL so humans can find you.

| Handle | Session / notes | First seen (UTC) | Last heartbeat (UTC) |
|--------|-----------------|------------------|----------------------|
| `agent-01` | Opus 4.8 — bootstrapped audit framework, display fix | 2026-07-16 20:37 | 2026-07-16 20:37 |
| `agent-02` | _free — claim me_ | | |
| `agent-03` | _free — claim me_ | | |
| `agent-04` | _free — claim me_ | | |

---

## 2. How units map to files (avoid collisions)

Each audit unit ≈ one service and its files. Rough ownership map so agents stay
disjoint (full weighted list in `docs/AUDIT_PROGRESS.md`):

| Unit | Primary paths |
|------|---------------|
| Auth & Onboarding | `app/(auth)/`, `app/auth/`, `app/onboarding/`, `app/join/`, `lib/supabase/auth*`, `middleware.ts` |
| Wallet / Money | `app/(app)/wallet/`, `app/(app)/money/`, `lib/wallet/`, `lib/stripe/`, `app/api/webhooks/money/` |
| Marketplace | `app/(app)/marketplace/`, `lib/marketplace/` |
| Calendar | `app/(app)/dashboard/calendar/`, `lib/calendar/` |
| Chores / Missions | `app/(app)/dashboard/*chore*`, `app/(app)/missions/`, `lib/chores/` |
| Meals / Food / Grocery | `app/(app)/dashboard/{meals,food,grocery}/`, `lib/meals/` |
| Family / Members / Roles | `app/(app)/family/`, `app/(app)/settings/`, `lib/server/{plan,entitlement,ensure-family}*` |
| Guardian / Kids / Parent | `app/(app)/{guardian,kids,parent}/` |
| Account / Billing / Tiers | `app/(app)/account/`, `app/(app)/dashboard/billing/`, `lib/constants/plans*` |
| Admin | `app/(app)/admin/`, `lib/server/feature-tiers*` |
| Display (Kitchen) | `app/(app)/display/`, `components/display/`, `lib/display/` — **audited, hardened** |
| Integrations / Sync | `lib/sync/`, `lib/connections/`, `app/api/sync/` |
| Marketing site | `app/(marketing)/`, `components/marketing/` |
| Notifications | `lib/notifications/`, `app/api/*notif*` |
| Storage / Files / Vault | `app/(app)/dashboard/{files,vault}/`, storage buckets |
| Supabase wiring (X-cut) | `supabase/migrations/`, `supabase/seed*.sql`, RLS/triggers/RPCs |
| Security / tenant isolation (X-cut) | RLS across tables, `middleware.ts`, service-role usage |
| Testing / CI / Deploy (X-cut) | `tests/`, `.github/`, `package.json`, build/lint/type |

---

## 3. Live claim board

Status values: `OPEN` · `CLAIMED` · `IN_REVIEW` · `DONE` · `BLOCKED` · `STALE`.
Heartbeat > 90 min with status CLAIMED/IN_REVIEW ⇒ any agent may set it STALE and reclaim.

| Unit | Owner | Status | Claimed (UTC) | Heartbeat (UTC) | Evidence commit | Notes |
|------|-------|--------|---------------|-----------------|-----------------|-------|
| Audit framework + coordination | `agent-01` | DONE | 2026-07-16 20:37 | 2026-07-16 20:37 | _pending_ | This scaffolding + docs + harness |
| CI / typecheck / lint baseline | `agent-01` | DONE | 2026-07-16 20:37 | 2026-07-16 20:37 | 77b87dc | tsc 0, eslint 0, 2929 tests green |
| Display (Kitchen) | `agent-01` | DONE | 2026-07-16 20:20 | 2026-07-16 20:37 | 77b87dc | Hardened, RLS-verified vs seed |
| Auth & Onboarding | — | OPEN | | | | |
| Wallet / Money | — | OPEN | | | | |
| Marketplace | — | OPEN | | | | |
| Calendar | — | OPEN | | | | |
| Chores / Missions | — | OPEN | | | | |
| Meals / Food / Grocery | — | OPEN | | | | |
| Family / Members / Roles | — | OPEN | | | | |
| Guardian / Kids / Parent | — | OPEN | | | | |
| Account / Billing / Tiers | — | OPEN | | | | |
| Admin | — | OPEN | | | | |
| Integrations / Sync | — | OPEN | | | | |
| Marketing site | — | OPEN | | | | |
| Notifications | — | OPEN | | | | |
| Storage / Files / Vault | — | OPEN | | | | |
| Supabase wiring (X-cut) | — | OPEN | | | | |
| Security / tenant isolation | — | OPEN | | | | |
| Testing / CI / Deploy (X-cut) | `agent-01` | IN_REVIEW | 2026-07-16 20:37 | 2026-07-16 20:37 | | Owns build/lint/type gate + harness |

---

## 4. Definition of Done (per unit) — "verified" means ALL of:

- [ ] Every route in the unit loads (server render) without hitting an error boundary.
- [ ] Each CRUD / action path is genuinely wired to Supabase (read + write reach a real table/RPC, RLS-scoped).
- [ ] RLS proven: a member of family A cannot read/write family B's rows (tested on the PG16 harness).
- [ ] No mocks / placeholders / hardcoded user data in the shipped path.
- [ ] `npx tsc --noEmit` clean · `npx eslint` clean for touched files.
- [ ] Relevant `vitest` tests pass; new tests added for repaired behavior.
- [ ] Seed provides ≥500 realistic rows for the unit's tables (independent SQL pack).
- [ ] Issue logged in `PRODUCT_LAUNCH_AUDIT.md` with evidence; matrices updated.
- [ ] Validated increment pushed to `main`; commit sha recorded in §3.

## 5. Verification harness (shared)

Reusable throwaway PG16 harness (proves migrations + seed + RLS) lives at:
`docs/audit/verify-pg.sh` (bootstraps Supabase shims → applies all 219 migrations
→ loads `SEED_ALL.sql` against the anchored account → lets you run any query under
RLS as an authenticated member). Use it for every unit's RLS + wiring proof.
Run PG as the `ubuntu` user (never root). Agents must NOT apply migrations to prod
(human-owned — see `docs/PENDING_PROD_MIGRATIONS.md`).
