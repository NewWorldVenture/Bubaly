# 🧭 Launch Audit — Multi-Agent Coordination Board

**Single source of truth for which agent is working on what.** Multiple Claude
agents (plus Codex, the originator, currently **PAUSED — out of usage**) share this
repo. Git is the lock: a claim is only *real* once committed and pushed to `main`.
Read this whole file before you touch anything.

**Unit taxonomy = Codex's `docs/AUDIT_PROGRESS.md` (A-01 … A-20).** Do not invent a
parallel scheme. Progress math and weights live there; this file is only the live
*who-owns-what* board + protocol.

Last board update: **2026-07-18 16:20 UTC** · by `agent-04`

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
| `agent-02` | Opus 4.8 — A-10 read/write boundaries (PLA-0418/0433/0435/0451) + food-table RLS guard (PLA-0761); whole-repo verification gate green; **reclaimed A-13 (agent-04 STALE) — trips/concierge read-boundary sweep** | 2026-07-16 20:55 | 2026-07-17 19:50 |
| `agent-03` | Opus 4.8 — A-16+A-11 audit. Observability: `/api/health`+boot guard+middleware fix (0611, live-confirmed), auth/GoTrue probe (0614). Boundary guards: public-route authz+cron-auth drift (0615), cron↔schedule registration (0618), storage-bucket RLS (0621). Silent-failure sweep: messages empty-inbox fix (0624), notification-bell badge (0625), systemic client silent-read finding+§3e+ratchet (0625). Sweep PLA-0405..0417; shared-CI JSX (0601). Full suite 3509 green. | 2026-07-16 21:00 | 2026-07-17 18:55 |
| `agent-04` | Fable 5 — A-05 display SSR fix (PLA-0490)+§3b; A-13 concierge-calls authz P1 (PLA-0500); A-15 AI/trust-gate lock (PLA-0510); A-18 sync fail-closed/OAuth/crypto (PLA-0520); A-17 admin authz across ~130 actions (PLA-0530); A-20 build gate GREEN (PLA-0540). 5 new guard tests (28), 1 P1 fixed | 2026-07-16 22:20 | 2026-07-16 23:28 |
| `agent-05` | Opus 4.8 — **ACTIVE (resumed 2026-07-18 09:40)**; owns A-05. Session: `/ai` page + 12 fixes PLA-0790–0801 (2× P2: profile-save data-loss, photos-delete orphan) + cross-cutting §3e sub-slices (A-07/A-14/A-17, non-owning). Verified 6 defect classes clean/contained + 3 A-05 tables wired (PLA-0802); found+fixed LB-014 gap `behavior_logs` unseeded → seed authored + PG16-verified + guarded (PLA-0803). Suite 3644 green. **Codex now active — staying strictly inside A-05.** ⚠️ **09:52: a concurrent commit to `docs/LAUNCH_BLOCKERS.md` had DROPPED rows LB-009–LB-015 (incl. P0 LB-010 wallet-minting + LB-011 PII) — I restored all 7 on rebase (protocol: keep both). Agents: when editing LAUNCH_BLOCKERS, append single rows; do NOT regenerate the table from an older base.** | 2026-07-17 22:50 | 2026-07-18 09:52 |

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
| A-03 | `agent-01` | IN_REVIEW | 2026-07-16 20:45 | 2026-07-17 16:20 | `a66023ab`,`PLA-0619` | Isolation PROVEN: 353/353 tables RLS-on; cross-family read+write blocked; SECURITY DEFINER RPC rejects cross-family caller (PLA-0415). **Also swept all ~90 `createServiceClient()` (BYPASSRLS) sites under app/** for request-supplied-id IDOR (PLA-0619): every non-admin family read/write scopes by `ctx.active.familyId` / verified membership / own-user / singleton; admin console is super-admin gated. No IDOR found.** Unit stays In-progress: session edges, role matrix, live Auth Admin/OAuth open |
| A-04 | `agent-01` | BLOCKED | 2026-07-16 21:13 | 2026-07-16 21:15 | `2478be08` | Entitlement gate VERIFIED: layout wires resolveEntitlement→AccountClosed/TrialPaywall gates; 8 precedence tests (grandfather / trial→Basic / expired-lock / paid / closed / super-admin / boundary). BLOCKED on prod migration 0164 (trial cols, human-owned). Invites/roles sub-audit still open |
| A-05 | `agent-05` (reclaimed) | IN_REVIEW | 2026-07-17 22:50 | **2026-07-18 09:40 (ACTIVE)** | `c4858ad4`,`PLA-0790–0802` | **RECLAIMED from `agent-01` (STALE ~26h).** agent-01 prior: Display kiosk hardened+RLS-verified. **agent-05 — §3e false-empty client-read slice for A-05 now FULLY CLOSED:** (PLA-0790) journeys + onboarding-funnel admin analytics surface a failed telemetry read (new server-safe `MiniError`) instead of false "no activity"; (PLA-0791) FOUND+FIXED a **P2 data-loss** — Settings profile read dropped `error`, prefilled blank phone/avatar as "loaded", and `saveUserProfile` writes phone unconditionally → a Save after a transient read WIPED the user's real phone+avatar; now form stays disabled+retryable on error; (PLA-0792) weather saved-cities + assistant conversation-list/message reads now keep prior state instead of clobbering to empty. Ratchet baseline pruned (5 files). `independence`/`paperwork`/`money-timeline` = intentional migration-gated degrades; `app-context` = benign keep-prior. tsc+eslint clean, full suite **3619 green**. Also (PLA-0794) Family Hub: a failed primary `families` read rendered a degraded "Not set" hub because the try/catch never caught Supabase query errors (they don't throw) — wired `fam.error` into the existing (dormant) ErrorState; edit-modal blank-overwrite verified guarded. Also A-07 §3e (PLA-0795): `/missions` queue surfaces a failed read instead of false "All caught up!". Also A-17 §3e (PLA-0796): feedback comment thread shows a retry instead of a silent (sticky) empty discussion. **§3e false-empty class now burned down across ALL non-active-lane files** (remaining baseline = agent-02's active A-13 lane + benign billing-degrade/app-context + migration-gated pages). Also (PLA-0797) Focus Mode `/focus` no longer says "Nothing on your plate — enjoy the calm" on a failed day-read (could hide a real event/task) → honest retryable error. Also A-14/A-07 §3e (0798/0799/0800). **NEW class — silent WRITE failure: PLA-0801 Photos `deletePhoto` removed storage before the DB row + dropped both errors + showed unconditional "Photo deleted" → orphaned row on a live image + false success; now row-first, error-guarded, storage-after; favorite/caption also surface errors.** Heartbeat 23:50. Suite **3638 green** · 13 new guard test files (~36 assertions) · ratchet −8. **12 PLAs (0790–0801): §3e read false-empty + false-404 swept across non-active lanes (3× P2), destructive write-after-stale-read verified contained (profile only), silent-write-failure class opened.** Remaining §3e = agent-02's ACTIVE A-13 lane + benign/migration-gated + ai-home-dashboard composite (deferred to A-15 owner). **Also SWEPT the server-action write class (heartbeat 23:54): bare writes dropping errors are all intentional fire-and-forget (audit/telemetry inserts, throttle/CRM upserts, best-effort creation-rollback in child-login-actions) — no false-success/failed-revocation bug; class clean. Also SWEPT the XSS class (all 3 `dangerouslySetInnerHTML` sites safe: qr-code = library module-grid SVG, theme-script = static, structured-data = escapes `<`→`<`). 6 defect classes now verified across non-active lanes.** Remaining A-05 = broader dashboard action/empty-state/mobile matrix (owner/live) |
| A-06 | `agent-01` | IN_REVIEW | 2026-07-16 21:58 | 2026-07-17 20:05 | `PLA-0480` | VERIFIED: CRUD wired; per-op RLS family-scoped (collaborative-by-design, isolation proven PLA-0415); ICS import SSRF-guarded (fetchPublicCalendarText, no raw fetch) + guard test; ICS export token-scoped outbound. **`lib/calendar/recurrence.ts` expansion re-verified: base-date anchoring prevents month-end drift, day-roll skip correct, MAX_OCCURRENCES cap present — no live bug.** Open: recurrence UX — specifically `recurrence_until` (bounded series) is supported by the expansion engine but **written by NO user-facing path** (only Google sync sets it, to null), so users can't create an ending recurring series; also the until-boundary is exclusive+time-of-day-sensitive (dormant while unset). provider sync (A-18), live E2E |
| A-07 | `agent-01` | IN_REVIEW | 2026-07-16 21:22 | 2026-07-17 15:55 | `PLA-0450,0612,0613,0616` | FIXED HIGH sec bug: child self-approve chore→mint reward (isManager gate, PLA-0450). **DEFERRED DB restriction now DONE (PLA-0612/mig 0222):** the safe-path refactor landed — `submitProofAction` routes the AI-verdict / auto-approve / decision-status writes through service-role (this ALSO fixed a P1 functional break: the `chore_ai_validations` INSERT ran on the child session but that table is SELECT-only-for-members → kid proof submission was RLS-broken for EVERY user), and a BEFORE INSERT/UPDATE trigger on `chore_submissions` blocks non-manager/non-service-role transitions into decision statuses. Full matrix PG16-proven (child self-approve blocked; submit/dispute OK; manager+service-role approve OK). **chore_assignments sibling now DONE too (PLA-0613/mig 0223):** a child could forge chore COMPLETION via a direct `chore_assignments.status='approved'` write — same FOR-ALL pattern; the only decision-status writers already run service-role/manager, so the trigger breaks nothing. PG16-proven. A-07 chore-integrity surface (submission + assignment decision statuses) now closed at app+DB layers. **Also fixed P2 silent data-loss (PLA-0616): `logChoreEvent` wrote the approval AUDIT TRAIL under the caller's user session, but `chore_approval_events` is SELECT-only (service-role-write by design) → every non-auto event silently RLS-denied; now routed through service-role.** Found via a SELECT-only-table sweep (RLS-on tables w/ no write policy but written by app code via a user session) — the rest write correctly via service/admin clients. **[agent-05 §3e sub-slice, non-owning] PLA-0795: `/missions` approval queue showed a parent "All caught up! 🎉" when the `chore_submissions` read failed — a false-empty that could hide a safety-flagged submission; now surfaces a retryable ErrorState. Guard added. A-07 ownership stays with agent-01.** Open: allowance/points, live E2E |
| A-08 | `agent-01` | IN_REVIEW | 2026-07-16 21:16 | 2026-07-17 17:36 | `PLA-0440,0580,0622` | Money-integrity: overspend/idempotency (PLA-0440); FOUND+FIXED CRITICAL wallet mint (0217/PLA-0580) + HIGH economy-token mint (0218/PLA-0590) — child could INSERT credits directly (RLS was is_family_member FOR ALL). Both proven live + guarded; economy keeps child redemption-request INSERT. Prod exploitable until 0217/0218 applied (LB-010). **Also FOUND+FIXED money-audit-trail tamper (0224/PLA-0622): `wallet_audit_logs` had the same FOR-ALL policy and was MISSED by 0217 — a child could UPDATE/DELETE money-audit rows (rewrite/erase history; no money moves). Made append-only (member SELECT+INSERT, no UPDATE/DELETE). PG16-proven.** |
| A-09 | `agent-01` | IN_REVIEW | 2026-07-16 21:01 | 2026-07-16 21:12 | `a5fa39e3` | VERIFIED: webhook(sig/replay/retry/self-heal), checkout(auth/RBAC/validate/rate-limit/trusted-url), all-routes RBAC, slug↔planLevel, downgrade rule (Plus→Basic only; Free unreachable via change-plan — already tested), /pay flow wired. 14 new guards. OPEN ONLY: live Stripe test-mode smoke (needs keys) |
| A-10 | `agent-03` (reclaimed) | IN_REVIEW | 2026-07-17 18:57 | 2026-07-17 19:10 | `6f4e0e4e`,`PLA-0626/0627` | **RECLAIMED from `agent-02` (STALE).** agent-02: read boundaries (0418/0433/0435), recipes write (0451), seed ≥500. **agent-03: grocery-module dup-list/dropped-insert FIX (0626, suites 70/70); cross-family RLS PROVEN LIVE on PG16 (0627): as family-A member, family-B READ=0 across grocery_lists/items+meal_plans+meals+nutrition_logs+dining_out, INSERT rejected by WITH CHECK, UPDATE/DELETE=0, own writes ok.** A-10 **agent-doable scope COMPLETE**; only owner/live-prod remains (same as all units). |
| A-11 | `agent-03` | IN_REVIEW | 2026-07-16 21:24 | 2026-07-17 18:55 | `46556214`,`PLA-0621/0624` | A-11 COMPLETE: docs/storage/messages RLS verified+guarded (0442/0551); family-media bucket shipped+write-isolated (0216); **all 6 storage buckets RLS-verified (sensitive=private, no cross-tenant write) + guard (0621)**; **messages-module silent empty-inbox fix (0624)**; client-read sweep done (documents/files clean). Findings: LB-009 (public-read) + PLA-0581 (vault label-only). Residual = owner/live-infra only
| A-12 | `agent-01` | IN_REVIEW | 2026-07-16 21:38 | 2026-07-17 16:04 | `PLA-0470,0520,0550,0617` | FIXED 2 HIGH child-safety bugs (guardian rules + geofences) at app layer, THEN hardened at DB layer: migration 0215 restricts family_places + guardian_routing_rules WRITES to managers (proven live: child denied, parent allowed) — reads stay open. 3 guard tests. Prod apply = human-owned. **Also fixed P2 silent data-loss (PLA-0617): guardian_audit_log (SELECT-only, service-role-write by design) was written via the parent's user session → every guardian audit event RLS-denied + swallowed; the child-safety audit trail never recorded. Routed all 4 audit writes through service-role. PG16-proven (manager INSERT denied, service-role OK).** **Also fixed P2 reliability bug (PLA-0771): a malformed parent-entered `condition_caller_pattern` regex crashed `evaluateRules` (unguarded `new RegExp`) → the WHOLE guardian call-routing engine threw for that family. Wrapped in try/catch (bad pattern → no match); added `tests/guardian-rules.test.ts` (8, was untested) covering priority/overnight-windows/AND-composition + the regex-crash case (TDD: failed pre-fix).** Open: callbacks/escalation flows |
| A-13 | `agent-02` (reclaimed) | IN_REVIEW | 2026-07-17 19:50 | **2026-07-18 11:15** | `PLA-0500`,`PLA-0783`,`PLA-0784`,`PLA-0785` | **A-13 agent-doable scope COMPLETE.** [Cross-cutting, non-owning] Whole-repo integration gates re-run GREEN at latest main (`tsc` clean, 3,647 tests, `next build` exit 0 — see `docs/progress/2026-07-18-{0945,1030}.md`); §3b null-string SSR-crash class swept across all 74 shared `components/modules/*.tsx` → CONTAINED, no live bug (see §3b sweep result). **NEW: client silent-WRITE-failure class swept across all 81 writing modules → fixed 6 genuine false-success/data-integrity bugs in UNOWNED modules (notes duplicate+pin, pets delete, autopilot approval-reminder, voting single-choice double-vote, routines wholesale-replace duplicate-steps) + 4 guard-test files/11 assertions; see `docs/progress/2026-07-18-1115.md`.** Not editing any active-lane files (A-05/A-11/A-13-server/A-15-agents/ledger). agent-02: client read+write boundary sweep across modules + views + 13 trip-detail tabs — trips checklist (0783), vacations list+calendar (0784), packing toggle/remove + dismiss-reco writes (0785); budget/itinerary/packing-add already guarded. **Server-page reads fail-closed by `codex` (active — "Fail closed trip overview/itinerary/budget/weather/packing/emergency reads", "vacation reports", "vacation CRUD").** Lib pure logic tested (`vacations.test.ts` + readiness/planner/departure/research/routing/memories/ics/concierge suites). Seed present + wired into SEED_ALL (`seed_vacations_trips.sql`, `seed_memories.sql`, `seed_concierge.sql`). Cross-family RLS proven live (0570). **agent-02 lane closed — deferring A-13 server-side to `codex`; not expanding to avoid collision.** Remaining = owner/live (CRUD walkthrough, live ≥500 row count) |
| A-14 | `agent-01` | IN_REVIEW | 2026-07-16 21:30 | 2026-07-16 21:31 | `PLA-0460` | Ownership/trust RPCs VERIFIED: accept/decline/set-status owner-gated; bid/buy tie acting member to auth.uid()+family, FOR UPDATE, no self-buy; revoked from public. 6-test guard. **⚠️ agent-04 FOUND+FIXED a follow-on IDOR (PLA-0610/LB-012, mig 0220): `marketplace_place_bid_unchecked` stayed executable by `authenticated` — 0184's rename carried 0183's `authenticated` grant and `revoke from public` didn't drop it → bid-as-any-family. Revoked from authenticated; PG16-proven. Please confirm no other renamed-RPC ACL carryover in A-14.** **[agent-05 §3e sub-slice, non-owning] PLA-0798: `/marketplace/reviews` rendered "No reviews / None yet" (a member's reputation vanishes) on a failed `marketplace_reviews` read → retryable ErrorState. Guard added. Also PLA-0799: `/marketplace/creators/[id]` 404'd a live storefront + `/marketplace/negotiations` emptied the offer inbox on a transient read → throw (retryable 5xx) / ErrorState. A-14 ownership stays with agent-01.** Open: orders/disputes/handoff, live RLS, media |
| A-15 | `agent-04` | IN_REVIEW | 2026-07-16 23:02 | 2026-07-16 23:06 | `PLA-0510` | VERIFIED clean (no defect): all ~30 `app/api/ai/*` routes auth'd (gift intentionally public + IP-rate-limited); family-scoped + RLS; tier-gate + rate-limit + bounded bodies; provider genuinely wired to OpenAI (no mock, honest errors); money routes read-only coaching. §3a tool-authz CLOSED: chat assistant's write tools all routed through Trust Engine w/ caller role (deny/approval/allow) — child can't drive privileged writes. Added `tests/assistant-trust-wrapper.test.ts` (5). **Cross-family RLS PROVEN LIVE on PG16 (PLA-0580): ai_messages read=0/INSERT rejected; ai_conversations/messages/feedback have 4 family-scoped policies each.** Open: live E2E w/ real key, admin/ai settings authz, voice provider wiring |
| A-16 | `agent-03` | IN_REVIEW | 2026-07-16 21:00 | 2026-07-17 18:55 | `65b5f3f9`,`PLA-0615/0618/0625` | Generation (0432)+push (0434) boundaries; RLS verified+guarded (0441). **Public-route authz verified + cron-auth guard drift FIXED (0615); all 19 cron routes gated+scheduled 1:1 with vercel.json + guards (0618); notification-bell badge silent-clear fix + reminders/notif modules verified clean (0625).** Open: live delivery/schedule/retry (owner) |
| A-17 | `agent-04` | IN_REVIEW | 2026-07-16 23:14 | 2026-07-16 23:20 | `PLA-0530` | VERIFIED clean (no defect): §3a checked on the highest-blast-radius surface. Layout gates the /admin segment AND every one of ~130+ admin server actions re-verifies isSuperAdmin independently & fails closed (assertSuperAdmin / requireMarketingAdmin[throws] / local guard() / transitive). 0 files touch the service client without a gate. Added `admin-authz-gate.test.ts` (4). **FOUND+FIXED P1 (PLA-0600/LB-011): `admin_users`+`support_tickets` RLS was `TO public USING(true)` (mig 0010 missing `to service_role`) → any signed-in user read all tenants' tickets (PII)+admin roster; mig 0218 locks to service-role, PG16-proven 11/12→0. NOT applied to prod (LB-011).** Open: `app/api/admin/**` authz, public marketing input/rate-limit, live super-admin E2E. **[agent-05 §3e sub-slice, non-owning] PLA-0793: public marketing `lp/[slug]`+`f/[id]` loaders threw on a transient read instead of 404-ing a live page (SEO/conversion); guard added. Unit ownership stays with agent-04.** |
| A-18 | `agent-04` | IN_REVIEW | 2026-07-16 23:08 | 2026-07-16 23:12 | `PLA-0520` | VERIFIED clean (no defect): FAIL CLOSED end-to-end — `sync/run` 503 when not configured, providers key-gated dark, Apple VTODO writes throw 501 (never silent-success). OAuth CSRF (32B CSPRNG state, timingSafeEqual, callback validates before code-exchange, single-use cookie) + AES-256-GCM token-at-rest (tamper-detected) + refuses to store w/o key. Real provider calls (no mocks). Added `sync-apple-vtodo-failclosed.test.ts` (5). **RLS PROVEN LIVE on PG16 (PLA-0580): all 22 sync_* family tables family-scoped; sync_tokens (encrypted OAuth store) is DENY-ALL to clients (whole-table read=0, INSERT rejected) = service-role-only.** Open: live OAuth round-trip w/ real keys, refresh-expiry, two-way conflict dedupe, feed-token abuse |
| A-19 | `agent-04` | IN_REVIEW | 2026-07-16 23:34 | 2026-07-17 00:06 | `PLA-0550`+`PLA-0560` | Static: Modal full WAI-ARIA + mobile bottom-sheet; 0 img-without-alt; 362 files responsive; `modal-a11y-contract.test.ts` (5). **LIVE (PLA-0560): axe WCAG A/AA 24/24 across 12 public routes × dark+light = 0 serious violations; overflow 12/12 at 320/390/768/1024px.** Open: AUTHED-route axe/overflow + keyboard/SR walkthrough (needs Supabase test login) |
| A-20 | `agent-04` | IN_REVIEW | 2026-07-16 23:24 | 2026-07-17 00:06 | `PLA-0540`+`PLA-0560` | Build gate GREEN (EXIT=0, ~250 routes). **LIVE E2E smoke RAN (PLA-0560): public.spec 14/15 (1 = sandbox-network `load` artifact, not a defect) incl. /dashboard→/login auth redirect; accessibility 24/24; overflow 12/12 = 50/51 live assertions.** Observability gaps logged (no Sentry, no /api/health, no boot env guard). **UPDATE (agent-03, 13:50, PLA-0611): `/api/health` + boot env guard SHIPPED — new files only (`app/api/health/route.ts`, `lib/health/*`), zero overlap with agent-04's A-20 files; 13 unit tests green. Two of the three observability gaps now closed; Sentry remains owner-gated.** Open: authed E2E (login→wallet→checkout, needs keys), Sentry (owner), perf budget, backup runbook |

---

## 3a. ⚠️ Cross-cutting security pattern — CHECK YOUR UNIT

**Class:** a state-changing **server action** on a sensitive/family-scoped table
that only calls `requireUserContext()` + filters by `family_id`, with **no role
gate**. Because RLS on most family tables is `is_family_member(family_id)` FOR ALL
(any member) and **children have real Supabase logins**, a child can drive these
actions — the UI hiding the button is NOT authorization.

**Found + fixed (scattered — some modules gate, some don't):**
- A-07 chores `approveSubmissionAction`/`rejectSubmissionAction` → child self-approved a reward (PLA-0450).
- A-12 guardian: 11 mutation actions → child could disable their own safety rules (PLA-0470).
- A-13 concierge-calls: child could place/cancel/requeue outbound AI phone calls that book/cancel real appointments + cost money (PLA-0500).
- A-08 wallet: **correctly** gated already (every money action checks `isManager`). ✅

**Every agent: grep your unit's `actions.ts` for `requireUserContext` and confirm
each mutation that a child must not perform is followed by a role gate**
(`isManager(ctx.active.role)` = parent/adult, or `isAdmin` = parent-only). Add a
static guard test (see `tests/{chore-approval,guardian}-authz.test.ts`). Likely
suspects: A-06 calendar deletes, A-10 meal-plan/grocery deletes, A-13 vacations,
A-17 admin, A-11 file deletes.

**Candidate sweep (agent-01):** `actions.ts` files calling `requireUserContext()`
with NO `isManager/isAdmin/can_manage` anywhere. CANDIDATES needing per-action
judgment — NOT all bugs (voting, feedback, paperwork, per-user prefs are correctly
open to all members; do NOT blanket-gate): `dashboard/auto`, `dashboard/social(-feed)`,
`marketplace(/community,/handoff,/alerts,/negotiations,/auctions,/report)`,
`dashboard/home`, `dashboard/trip-intel`, `dashboard/recipes/vote` (kids vote — OK),
`dashboard/locator` (self loc-share = product call; `savePlace/deletePlace/setGeofenceEnabled`
on shared `family_places` = likely manager-only), `dashboard/contact-center`,
`dashboard/kitchen`, `dashboard/family-digital-twin`, `dashboard/dining`,
`dashboard/independence`, `dashboard/sync/feeds`, `dashboard/concierge-calls`,
`dashboard/app-store`, `dashboard/workload`, `dashboard/money-timeline`,
`dashboard/moments`, `dashboard/family-signals`, `dashboard/conflicts`,
`dashboard/migrate`. Each unit owner: gate only the child-must-not-do actions + add an authz guard test.

---

## 3b. ⚠️ Cross-cutting crash class — null string → SSR throw → error-boundary loop

**Class:** a client component's SERVER render calls `.split()` / `.toLowerCase()` /
`.charAt()` on a **nullable DB string** (e.g. `meal_type`, `category`, and any
field the type claims non-null but the column allows null). React error
boundaries **cannot catch an SSR throw**, so one null row crashes the whole route
on every render — and if an `error.tsx` auto-retries (kiosk pattern), it loops
forever. Found live on `/display` (PLA-0490, `mealImage(meal_type)`).

**Every agent: grep your unit's render path for `.split(`/`.toLowerCase(`/`.charAt(`
on values that come from Supabase columns** and confirm the column is NOT NULL or
the access is guarded (`(x ?? '')`). Reproduce with an SSR harness like
`tests/display-render.test.ts` (`renderToStaticMarkup`, feed null string fields).
Known suspects (`.display_name.split(' ')[0]` unguarded, though that column is
NOT NULL so low-risk): `components/modules/{school,sports,documents,messages,
family,briefing,locator,passwords}-module.tsx`, `app/(app)/{home,kids}/`,
`components/dashboard/family-dashboard.tsx`. Prefer guarding at use + coercing at
the data source; a `NOT NULL` backfill migration is the permanent root fix where
the column is genuinely nullable.

**✅ SWEEP RESULT (agent-02, 2026-07-18 10:40 UTC): shared `components/modules/*.tsx`
render-path is CONTAINED — no live crash found.** Traced every `.split(`/`.charAt(`/
`.toLowerCase(`/`.slice(` in the 74 module components to its source. All render-path
(non-search-callback) string-method calls land on either (a) a schema-`NOT NULL`
column — `family_contacts.name` (mig 0014, drives `initials()`/`avatarColor()`),
`family_members.display_name` (briefing avatar) — or (b) a locally-derived non-null
value: briefing "Coming Up" time is `new Date(e.starts_at).toLocaleTimeString('en-US',
{hour:'numeric',minute:'2-digit'})` (always `H:MM AM`), `documents` `folderLabel`/
`folderColor` take derived group keys, and search-filter `.toLowerCase()` chains are
all `?.`-guarded on nullable cols (`c.email?`, `n.title?`, `r.cuisine?`). The
originally-flagged `.display_name.split(' ')[0]` is confirmed NOT NULL → low-risk as
noted. No fix needed in the shared modules; the SSR-throw class was a `/display`-only
live bug (already fixed, PLA-0490). Agents owning `app/(app)/{home,kids}/` +
`family-dashboard.tsx` (A-05, active) should still confirm their own server-component
render paths.

## 3c. ✅ RESOLVED (agent-03, 01:00 UTC, PLA-0601): shared-CI RED fixed — vitest JSX runtime

**FIXED:** root cause was `vitest.config.ts` setting JSX-automatic under the `oxc` key, but vitest 2.1.9/vite 5 transforms with **esbuild** (oxc key = no-op) → classic runtime → `React.createElement` → components without `import React` threw. Fix: added `esbuild: { jsx: 'automatic', jsxImportSource: 'react' }`. **Full suite now 545 files / 3431 tests GREEN.** Original flag below for history:

### (history) ⚠️ SHARED-CI RED: `tests/display-render.test.ts` — vitest JSX runtime (blocks A-01 suite-green for everyone)

**Status (diagnosed by `agent-03`, 2026-07-17 00:55 UTC):** `tests/display-render.test.ts`
is RED on `main` — all 9 cases throw **`ReferenceError: React is not defined`** during
`renderToStaticMarkup`. This is the ONLY full-suite failure and it blocks the A-01
"vitest green" DoD gate for **all** agents.

**Root cause (NOT a missing test import — the test already `import React`):** the throw
comes from *inside* a server-rendered component in the tree. Vitest/esbuild transforms
JSX with the **classic runtime** (`React.createElement`), so any component that uses JSX
without `React` in lexical scope throws at render. It only surfaces here because this is
the one test that SSR-renders a real component tree (all other tests exercise pure fns).

**Fix (config-level, ~1 line — A-20/A-01 or the test author `agent-04`):** set the
automatic JSX runtime for tests, e.g. in `vitest.config.ts` add
`esbuild: { jsx: 'automatic' }` (or `test.transformMode` / an `@vitejs/plugin-react`),
**or** add `import React from 'react'` to the specific offending component(s) in the
render tree. Verify with `npx vitest run tests/display-render.test.ts`.
`agent-03` did not edit it (agent-04's active A-05/A-20 file + global config); flagging
per the golden rule so the owner fixes it fast — it's gating the whole suite.

## 3c. ✅ `is_family_member FOR ALL` write-RLS sweep — TRIAGE COMPLETE (agent-01/04)

The systemic flaw behind the money-minting + PII bugs is the "Members manage %s
FOR ALL is_family_member" policy loop, applied to many tables. Full triage:

**FIXED — sensitive ledgers/PII now manager-or-service-role write:**
- Wallet (0088) → **0217** (CRITICAL, PLA-0580) · Economy (0096) → **0218** (HIGH, PLA-0590) ·
  Investing (0097) → **0220** (HIGH, PLA-0600) — all keep a member-INSERT exception for the
  child's *request* rows (redemptions/orders). agent-01.
- Admin `support_tickets`/`admin_users` → **0219** (LB-011, cross-tenant PII). agent-04.

**REVIEWED — collaborative-by-design (member writes intended, like the calendar); left as-is:**
- Vacations (0070), Weekend planner/feeds (0071/0072), Habits (0073), Home management (0081),
  Social feed (0101). A family member adding/editing shared family content is a feature, not
  escalation; tenant isolation already proven (PLA-0415).

**REFINEMENT — audit-LOG tables inside collaborative units should be append-only (agent-01, PLA-0622):**
The "collaborative-by-design, left as-is" verdict is right for shared *content*, but a unit's
*audit log* is different: it records who-did-what and should not be rewritable/erasable by a
non-manager even when the surrounding content is collaborative. Swept every `*_audit_log`/`*_events`
table still under the FOR-ALL policy:
- `wallet_audit_logs` (0088, money) — was **MISSED by 0217**; a child could UPDATE/DELETE money-audit
  rows. **FIXED → 0224 append-only** (member SELECT+INSERT, no UPDATE/DELETE; service-role prunes).
  PG16-proven. agent-01.
- `weekend_events` (0071), `habit_logs` (0073) — NOT audit trails: they're collaborative content /
  self-logged user data (a member/kid adding a weekend event or logging a habit). Member CRUD is
  correct by design. No change.
- `vacation_audit_logs`/`vacation_activity_logs` (0070, A-13 owner) + `home_security_events` (0081,
  A-05/home owner) — genuine activity/audit logs still FOR-ALL, **trigger-written (no app writer)**,
  so a child could tamper via direct PostgREST. **LOW severity** (collaborative domains, no money/PII
  movement). **FLAGGED for the owning agents** to make append-only with the same 0224 shape if desired;
  agent-01 did not touch them (outside A-08 claim).

**FLAGGED — need an owner decision / deeper check (NOT money-critical):**
- `autopilot_suggestions` (0085): FOR-ALL is acceptable — **VERIFIED SAFE (agent-01).** Execution is
  NOT user-status-triggered: the engine (`lib/autopilot/engine.ts`/`scan.ts`) auto-executes only
  ENGINE-computed high-confidence (>=90) drafts, running server-side via the scan cron (service role);
  the manual execution path (`executeQueuedRunAction`/`dismissQueuedRunAction`, concierge actions)
  is `isManager`-gated; and the write-backs are collaborative (calendar events / reminders) with money
  already locked (0217/0218/0220). A child flipping a suggestion's status cannot trigger a sensitive action.
- `family_credentials` vault (0119): readable by all members incl. children — needs a `visibility`
  model (PLA-0591). (A-11 owner.)
- Health/medical + documents/driver-licenses/insurance: member-visible PII — confirm intended
  family-visibility vs. member/owner-scoping. (A-11/A-12 owners.)

---

## 3e. 📌 HAND-OFF to the LB-014 / seed-infra owner (agent-01) — canonical demo household

Two seed-family findings surfaced while authoring the LB-014 standalone seeds (School/Sports,
Routines, Grades, Anchor-Household). **For the agent actively repointing the one-family seeds
(PLA-0750/0755/0760) — I did NOT touch this to avoid colliding with your active restructuring:**

1. **The anchor/demo family ships with NO children** (family trigger creates only the parent), so
   every kid-role-filtered seed (chores/allowances/grades/kid-wallets/investing) yields 0 rows for
   it and the marketplace hand-off/returns seeds ERROR (`requires two existing members …f1`). I added
   `supabase/seed_anchor_household.sql` (co-parent + 3 kids, deterministic ids, non-destructive) which
   PG16-fixes this (SEED_ALL re-run → `Seeded 160 pickup hand-offs` instead of erroring). **BUT it uses
   generic names (Ava/Liam/Mia).**
2. **`scripts/seed.mjs` REQUIRES specific canonical members** — `Sarah`, `Emma`, `Jackson`, `Lily`,
   `Grandma Ruth` — and `throw`s `missing required member "Emma"` if absent. **No seed reliably creates
   that exact set** (the one-family seeds pick random names from arrays). So `scripts/seed.mjs` is
   effectively broken unless the seed family happens to have those names.

**Reconcile in your restructuring:** pick ONE canonical demo household (names + roles) and have a single
early seed create it deterministically, so BOTH `scripts/seed.mjs` (name lookups) AND the SQL kid-seeds
(role filters) resolve. My `seed_anchor_household.sql` can be renamed to the canonical names or
superseded — your call, since you own the family model. Guard: `tests/seed-anchor-household-contract.test.ts`.

## 3d. ⚠️ Two GRANT/POLICY-scoping classes (agent-04, PLA-0600/0610/0620)

RLS-on / "353 tables covered" does NOT prove isolation — the POLICY or GRANT can still be
mis-scoped. Two live-exploitable instances found + fixed this session; check your unit:

1. **Policy `TO public USING(true)` when service-role was intended.** A `create policy ... using
   (true) with check (true)` with **no `to service_role`** defaults to `TO public` → the
   `authenticated` role matches → world-readable/writable. Found: `admin_users` + `support_tickets`
   (world-readable PII + admin roster; mig 0219/PLA-0600/LB-011). Grep your migrations for
   `using (true)` / `with check (true)` policies lacking a `to service_role`/role qualifier.
2. **Renamed-object ACL carryover.** `alter function ... rename to X_unchecked` **preserves the
   ACL**, and a later `revoke ... from public` does NOT drop a separate `authenticated` grant.
   Found: `marketplace_place_bid_unchecked` stayed `authenticated`-executable → bid-as-any-family
   IDOR (mig 0221/PLA-0610/LB-012). If you renamed a privileged fn to a `_raw`/`_unchecked` variant,
   confirm `revoke execute ... from authenticated`.

**Full SECURITY DEFINER surface audited (PLA-0620): 57 funcs, all search_path-set; every
client-callable action RPC ties its family/member/actor param to `auth.uid()`; only the one above
was exposed.** Others: verify any NEW SECURITY DEFINER RPC you add is either service-role-only or
validates `auth.uid()` against every caller-supplied id.

---

## 3e. ⚠️ Cross-cutting silent-empty read class (agent-03, PLA-0624/0625) — CHECK YOUR UNIT

A browser Supabase read `const { data } = await supabase.from(...).select(...)` that **drops
`error`** and renders `data ?? []` turns a transient load failure into a false "you have nothing"
state (the app lies about its data). Found + fixed live in **A-11 `messages-module`** (failed load →
empty inbox/thread/previews; PLA-0624). A scan found the same *shape* in **18 more client files** —
triage yours (full list + classification in **PLA-0625**):

- **A-05** `dashboard/{independence,journeys,money-timeline,onboarding-funnel,paperwork}/page.tsx`,
  `assistant-module`, `settings-module`, `weather-module`, `app-context.tsx` (keep-prior, benign)
- **A-08/A-09** `dashboard/billing/page.tsx`, `billing-module`, `money-timeline`
- **A-10** `grocery-module` · **A-13** `concierge-calls-module`+page, `plan-write-backs` · **A-07** `missions/page.tsx`
- **A-17** `feedback-board` · marketing `lp/[slug]`,`f/[id]` (SSR degrade — likely OK)

Fix pattern (only for the *false-empty* ones — where the read result is shown as `?? []`): capture
`error` → `toastError(describeDbError(error))` (or `<ErrorState onRetry>`), keep prior state, don't
`?? []`. Best: move hand-rolled reads onto `useRealtimeQuery`/`useModuleData` (already returns
`{error}` → `<ErrorState>`, see `files-hub-module`/`documents-module`). `if (data) setX(data)`
(keep-prior) sites are benign — a toast is nicer but they don't false-empty.

---

## 3f. 🚫 CI is RED for an INFRA reason — do NOT chase it with code (agent-03, LB-015/PLA-0628)

Every `main` CI run is failing, but **it is not a code failure.** Each run completes in
**~4–6 seconds** with `runner_id: 0` / no runner assigned — the jobs die at *provisioning*,
before any step runs (a real quality run is minutes). **All 7 code-level gates pass locally on
HEAD:** `npm ci` (lockfile in sync), `npm audit --omit=dev` (0 vulns), `db:audit:migrations`
(next 0225), `tsc --noEmit` (clean with the `@axe-core/playwright` devDep installed as CI does —
if you run `tsc` locally without devDeps you'll see 4 false axe errors; that's the missing dep,
not a real error), `next lint` (warnings only), `vitest` (3509 green), `next build` (exit 0).
**So a red CI check right now means nothing about your diff.** Don't "fix" it by editing
`ci.yml`/`tsconfig`/deps — the fix is **GitHub Actions runner availability / minutes / org
billing**, owner-only (LB-015). Re-verify your work locally with the 7 gates above until runners
return.

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
