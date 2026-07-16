# 🧭 Launch Audit — Multi-Agent Coordination Board

**Single source of truth for which agent is working on what.** Multiple Claude
agents (plus Codex, the originator, currently **PAUSED — out of usage**) share this
repo. Git is the lock: a claim is only *real* once committed and pushed to `main`.
Read this whole file before you touch anything.

**Unit taxonomy = Codex's `docs/AUDIT_PROGRESS.md` (A-01 … A-20).** Do not invent a
parallel scheme. Progress math and weights live there; this file is only the live
*who-owns-what* board + protocol.

Last board update: **2026-07-16 21:29 UTC** · by `agent-02`

---

## 0. Protocol (every time)

```
1. git pull --rebase origin main                # latest board + docs
2. read this file (§3) + docs/AUDIT_PROGRESS.md  # claims, heartbeats, weights
3. pick a unit that is OWNER=free OR heartbeat STALE (>90 min)
4. add your row in §3: unit A-xx, your handle, CLAIMED, UTC claimed_at + heartbeat
5. commit ONLY the board: git commit -am "audit: <handle> claim A-xx"; git push
     push OK       -> yours, start work
     push REJECTED -> git pull --rebase; if someone took it, pick another; retry
6. work -> verify (DoD §4) -> push validated increments -> update AUDIT_PROGRESS + matrices
7. heartbeat: bump your row every ≤30 min while active
8. done: status DONE + evidence sha; free the unit
```

**Golden rules**
- One agent per unit. Never edit files under another agent's ACTIVE claim.
- Codex's units are all marked "In progress" in AUDIT_PROGRESS but Codex is PAUSED —
  treat any A-unit with **no live Claude owner in §3** as free to claim.
- Shared docs (this file, AUDIT_PROGRESS, PRODUCT_LAUNCH_AUDIT, matrices, blockers,
  readiness) = **append / single-row edits only**. Keep commits small.
- `git pull --rebase` before every push; on doc conflicts keep BOTH sides' rows.
- Never fabricate. "Verified" = you actually ran it (DoD §4). Never inflate the %.
- Never report 100% / launch-ready until every unit is DONE and blockers clear.

---

## 1. Agent handles

| Handle | Session / notes | First seen (UTC) | Last heartbeat (UTC) |
|--------|-----------------|------------------|----------------------|
| `codex` | Originator of the audit + all docs. **PAUSED (out of usage).** | 2026-07-15 | 2026-07-16 ~12:40 |
| `agent-01` | Opus 4.8 — display fix, coordination bootstrap, PG16 harness | 2026-07-16 20:20 | 2026-07-16 20:45 |
| `agent-02` | Opus 4.8 — display service-tiles (`375e97ec`); A-10 food/meals read boundaries (PLA-0418/0433/0435); recipes write boundary (PLA-0451) | 2026-07-16 20:55 | 2026-07-16 21:29 |
| `agent-03` | Opus 4.8 — A-16 (PLA-0432/0434/0441) + A-11 documents/storage RLS verify (PLA-0442); silent-failure sweep PLA-0405..0417 | 2026-07-16 21:00 | 2026-07-16 21:28 |
| `agent-04` | _free — claim me_ | | |

---

## 2. Unit → files map (stay disjoint)

Maps Codex's A-units to primary paths so agents don't collide.

| A-ID | Unit | Primary paths |
|------|------|---------------|
| A-01 | Build/lint/type/CI gates | `package.json`, `.github/`, `tests/` (global) |
| A-02 | Migrations/schema/seed baseline | `supabase/migrations/`, `supabase/seed*.sql`, `docs/audit/verify-pg.sh` |
| A-03 | Auth / tenant isolation / RLS | `app/(auth)/`, `app/auth/`, `middleware.ts`, `lib/supabase/auth*`, RLS across tables |
| A-04 | Onboarding / invites / roles / tier gates | `app/onboarding/`, `app/join/`, `lib/server/{plan,entitlement,ensure-family}*` |
| A-05 | Home / dashboard command surfaces | `app/(app)/dashboard/`, `app/(app)/home/`, `app/(app)/display/` |
| A-06 | Calendar / planning / routines / sync | `app/(app)/dashboard/calendar/`, `lib/calendar/` |
| A-07 | Chores / missions / rewards | `app/(app)/dashboard/*chore*`, `app/(app)/missions/`, `lib/chores/` |
| A-08 | Wallet / goals / allowances / treasury | `app/(app)/wallet/`, `lib/wallet/` |
| A-09 | Billing / Stripe checkout / pay flows | `app/(app)/dashboard/billing/`, `app/pay/`, `lib/stripe/`, `app/api/webhooks/money/` |
| A-10 | Meals / groceries / food | `app/(app)/dashboard/{meals,food,grocery}/`, `lib/meals/` |
| A-11 | Messages / files / documents / storage | `app/(app)/dashboard/{files,vault,messages}/`, storage buckets |
| A-12 | Guardian / safety / contacts | `app/(app)/{guardian,kids,parent}/`, `lib/guardian/` |
| A-13 | Vacations / travel / concierge | `app/(app)/dashboard/{vacations,trips}/` |
| A-14 | Marketplace / offers / auctions | `app/(app)/marketplace/`, `lib/marketplace/` |
| A-15 | AI assistants / chat / voice | `app/(app)/**/ai*`, `lib/ai/`, `app/api/ai/` |
| A-16 | Notifications / reminders / cron | `lib/notifications/`, `app/api/**cron**`, `app/api/**notif**` |
| A-17 | Admin / marketing / social / content | `app/(app)/admin/`, `app/(marketing)/`, `lib/server/feature-tiers*` |
| A-18 | Third-party integrations | `lib/sync/`, `lib/connections/`, `app/api/sync/` |
| A-19 | Mobile / responsive / a11y / browser | components across app; `tests/e2e/`, `tests/a11y*` |
| A-20 | E2E / perf / observability / backups / deploy | `tests/e2e/`, build/deploy, monitoring |

---

## 3. Live claim board

Status: `OPEN` · `CLAIMED` · `IN_REVIEW` · `DONE` · `BLOCKED` · `STALE`.
Heartbeat > 90 min while CLAIMED/IN_REVIEW ⇒ any agent may STALE + reclaim.
(AUDIT_PROGRESS holds each unit's Verified/In-progress state; this is live ownership.)

| A-ID | Owner (Claude) | Status | Claimed (UTC) | Heartbeat (UTC) | Evidence commit | Notes |
|------|----------------|--------|---------------|-----------------|-----------------|-------|
| A-01 | codex (verified) | DONE | — | — | prior | build/lint/type/2929+ tests green |
| A-02 | codex (verified) | DONE | — | — | prior | 230 migs + 600-row seed baseline |
| A-03 | `agent-01` | IN_REVIEW | 2026-07-16 20:45 | 2026-07-16 21:00 | `a66023ab`+ | Isolation PROVEN: 353/353 tables RLS-on; cross-family read+write blocked; SECURITY DEFINER RPC rejects cross-family caller (PLA-0415). Unit stays In-progress: session edges, role matrix, live Auth Admin/OAuth open |
| A-04 | `agent-01` | BLOCKED | 2026-07-16 21:13 | 2026-07-16 21:15 | `2478be08` | Entitlement gate VERIFIED: layout wires resolveEntitlement→AccountClosed/TrialPaywall gates; 8 precedence tests (grandfather / trial→Basic / expired-lock / paid / closed / super-admin / boundary). BLOCKED on prod migration 0164 (trial cols, human-owned). Invites/roles sub-audit still open |
| A-05 | `agent-01` (display slice) | IN_REVIEW | 2026-07-16 20:20 | 2026-07-16 20:45 | `77b87dc` | Display kiosk hardened+RLS-verified; rest of dashboard open |
| A-06 | — | OPEN | | | | |
| A-07 | `agent-01` | IN_REVIEW | 2026-07-16 21:22 | 2026-07-16 21:26 | `PLA-0450` | FOUND+FIXED HIGH sec bug: child could self-approve a chore and mint a reward (approve/reject actions lacked a role gate; RLS is family-scoped). Added isManager gate + guard test. Open: RLS-level status restriction, allowance/points flows |
| A-08 | `agent-01` | IN_REVIEW | 2026-07-16 21:16 | 2026-07-16 21:20 | `PLA-0440` | Money-safety PROVEN live: overspend prevented + hold idempotent (FOR UPDATE lock), ledger conserves every cent, reserve RPC service_role-only. New self-contained probe + guard (4 tests). Open: allowance/goal/transfer flows, approval-hold role matrix, live Issuing |
| A-09 | `agent-01` | IN_REVIEW | 2026-07-16 21:01 | 2026-07-16 21:12 | `a5fa39e3` | VERIFIED: webhook(sig/replay/retry/self-heal), checkout(auth/RBAC/validate/rate-limit/trusted-url), all-routes RBAC, slug↔planLevel, downgrade rule (Plus→Basic only; Free unreachable via change-plan — already tested), /pay flow wired. 14 new guards. OPEN ONLY: live Stripe test-mode smoke (needs keys) |
| A-10 | `agent-02` | IN_REVIEW | 2026-07-16 20:55 | 2026-07-16 21:31 | `6f4e0e4e`+ | Read boundaries: food hub (PLA-0418), meals (PLA-0433), nutrition/favorites (PLA-0435). Write boundary: recipes toggleFav/markMade/delete (PLA-0451). grocery/pantry/meals writes verified fail-visible. Seed ≥500 VERIFIED (seed_food.sql = 520 deterministic rows across recipes/pantry/dining). Remaining: live cross-family RLS on A-10 tables |
| A-11 | `agent-03` | IN_REVIEW | 2026-07-16 21:24 | 2026-07-16 21:28 | `pending` | Documents pipeline verified tenant-isolated (DB+Storage RLS) + client error/orphan-safety; guard added (PLA-0442). Open: messages sub-surface, live storage cross-family probe, doc seed
| A-12 | — | OPEN | | | | |
| A-13 | — | OPEN | | | | |
| A-14 | `agent-01` | CLAIMED | 2026-07-16 21:30 | 2026-07-16 21:30 | | Marketplace: per-member offer ownership RLS + RPC caller-gating + no cross-family write |
| A-15 | — | OPEN | | | | |
| A-16 | `agent-03` | IN_REVIEW | 2026-07-16 21:00 | 2026-07-16 21:23 | `65b5f3f9`+ | Generation (PLA-0432) + push delivery (PLA-0434) read/write boundaries hardened; email+cron already hardened; RLS tenant-scoping verified+guarded (PLA-0441). Open: live delivery/schedule/retry + add notif/reminders to A-03 live read-probe
| A-17 | — | OPEN | | | | |
| A-18 | — | OPEN | | | | Apple VTODO/Gmail stubs must fail closed |
| A-19 | — | OPEN | | | | |
| A-20 | — | OPEN | | | | |

---

## 4. Definition of Done (per unit) — "verified" = ALL of:

- [ ] Every route in the unit server-renders without hitting an error boundary.
- [ ] Each CRUD/action is genuinely wired to Supabase (real table/RPC, RLS-scoped).
- [ ] RLS proven cross-family on the PG16 harness (family A cannot touch family B).
- [ ] No mocks / placeholders / hardcoded user data in the shipped path.
- [ ] `tsc --noEmit` clean · `eslint` clean for touched files.
- [ ] Relevant `vitest` passes; new tests added for every repair.
- [ ] Seed provides ≥500 realistic rows for the unit's tables.
- [ ] Issue(s) logged in `PRODUCT_LAUNCH_AUDIT.md`; matrices + AUDIT_PROGRESS updated.
- [ ] Validated increment pushed to `main`; sha recorded here + in AUDIT_PROGRESS.

## 5. Shared verification harness

`docs/audit/verify-pg.sh` — throwaway PG16 (Supabase shims → all migrations →
`SEED_ALL` against the anchored account → query under RLS as an authenticated
member). Run PG as the `ubuntu` user, never root. **Agents must NOT apply
migrations to prod** (human-owned — `docs/PENDING_PROD_MIGRATIONS.md`).

```
bash docs/audit/verify-pg.sh up            # bootstrap
bash docs/audit/verify-pg.sh rls '<SQL>'   # run as authenticated anchor member
bash docs/audit/verify-pg.sh down          # teardown
```
