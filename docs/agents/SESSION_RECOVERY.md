# SESSION_RECOVERY — read this first to resume the audit cold

_Last updated: 2026-07-18 20:15 UTC by `CLAUDE-QA-01` (board handle `agent-02`)._

## Repository
- `NewWorldVenture/Bubaly`
- Integration branch: **`main`** (agents commit small validated increments and
  push directly to `main` per the existing repo policy in
  `docs/audit/COORDINATION.md §0`; each push is rebased on latest `main` first).
- This Claude worker's designated dev branch: `claude/resolve-pr-conflicts-nwmf2h`
  (fast-forwards to `main`; not a long-lived fork).
- **Latest verified `main` commit: `14f946f8`** (2026-07-18 21:40). `tsc --noEmit`
  exit 0; mobile guard suite 8 files / 27 tests pass. No uncommitted work outstanding.
  (agent-05 is landing mobile increments M-005..M-007 fast on the same `main`.)
- **M-005b (this increment):** closed the tablet gap in agent-05's M-005 hover-reveal
  fix — appended a width-independent `coarse:opacity-100` escape (new
  `@media (pointer: coarse)` utility in `app/globals.css`) to all 11 hits across 10
  modules, so iPad-class touch devices (≥ `sm`, no hover) still reveal row controls;
  desktop hover-reveal untouched. Guard `tests/mobile-hover-reveal-tablet.test.ts` (2).
- Recent QA-01/agent-02 increments (all on main, verified, logged PLA-0838..0844):
  blog category-count pagination + unique free hero photos (migration `0232`) +
  hero spacing; client silent-write class swept (6 fixes/5 modules); reasoning
  read-boundary test realign (unblocked shared suite); profile-nudge guard;
  admin OpenAI status PR #322 merged (+ #321/#323 closed); `0231→0232` migration
  collision fixed. Blog Favorite verified already sign-in-gated + session-persistent.

## Current audit state (canonical — do NOT inflate)
- **Weighted completion: 10.0%** (`docs/AUDIT_PROGRESS.md`, owned by codex).
- **Decision: NO-GO.**
- The 10% reflects only fully-verified units (A-01 build/type/test gates, A-02
  migrations+seed baseline). A-03..A-20 are `In progress` — real security/RLS,
  boundary, and seed work is landed but the units are not launch-complete because
  live-prod/owner gates remain open.

## Live blockers keeping it NO-GO (all owner/live-prod, not agent-closable)
See `docs/LAUNCH_BLOCKERS.md` for the authoritative list. Summary:
- Prod migrations un-applied: **0217/0219/0221/0224** (wallet-mint / PII / RPC ACL
  / money-audit — fixes are committed + PG16-proven, but applying to prod is
  human-owned). LB-010, LB-011, LB-012.
- Credential rotation (any secret ever committed) — owner.
- Auth Admin 500 on live GoTrue — owner/live.
- Live third-party smokes (Stripe/Twilio/Resend/Google) — need real keys.
- Live E2E authed smoke (login→wallet→checkout) — needs test login.
- CI runners unavailable (LB-015) — GitHub Actions provisioning, owner-only; **red
  CI ≠ code failure**, verify locally with the 7 gates in COORDINATION §3f.

## Exact commands to run first
```bash
git fetch origin main && git checkout -B <your-branch> origin/main
# baseline gates (all currently GREEN at fba93554 unless noted):
NODE_OPTIONS="--max-old-space-size=6144" npx tsc --noEmit        # exit 0
npx vitest run                                                    # 623 files / 3,694 tests green with local increment
NODE_OPTIONS="--max-old-space-size=6144" npx next build          # exit 0, ~250 routes
# RLS harness (throwaway PG16, run PG as ubuntu not root):
bash docs/audit/verify-pg.sh up
bash docs/audit/verify-pg.sh rls '<SQL as authenticated member>'
bash docs/audit/verify-pg.sh down
```

## How to pick your next task (no collision)
1. Read `docs/audit/COORDINATION.md` §3 (claims) + §3a–§3f (cross-cutting classes).
2. **Active/owned lanes to avoid:** codex (ledger docs + A-13 server-side +
   A-15 `agents`/assistant + fail-closed server reads); `agent-05` (A-05 command
   surfaces); `agent-03` (A-11 messages, A-16 notifications). Others are
   IN_REVIEW but heartbeat-stale — reclaim per §0 if you take one.
3. Claim on the board, commit ONLY the board claim, push (rebase on reject), work.

## Cross-cutting defect classes — status (see COORDINATION §3a–§3e)
- §3a server-action child-escalation authz — swept (agent-01/04/05).
- §3b null-string SSR crash — **swept clean across 74 shared modules** (agent-02).
- §3c FOR-ALL write-RLS — triaged + migrations 0217/0218/0220/0224 (agent-01/04).
- §3d GRANT/policy scoping — swept, 0219/0221 (agent-04).
- §3e silent-empty READ — swept across non-active lanes (agent-03/05).
- silent-WRITE failure (client) — **swept, 6 bugs fixed across 5 modules** (agent-02):
  notes duplicate/pin, pets delete, autopilot approval-reminder, voting
  single-choice double-vote, routines wholesale-replace. Guard tests added.
- JSON.parse/localStorage crash — swept clean (all try/catch) (agent-02).

## Immediate next safe task (for whoever resumes as QA/cross-cutting)
Publish the Codex unified reasoning source-failure increment after fetching and
rebasing on `origin/main`, then verify remote readback. After that,
continue the client-boundary hardening sweep into **`components/`
sub-directories outside `components/modules/`** (e.g. `components/marketplace/`,
`components/wallet/`, `components/dashboard/` non-A-05 leaf widgets) for the same
silent read/write classes, claiming narrowly and avoiding active lanes. Keep the
integration gate warm (`tsc` + `next build`) as concurrent commits land.

## Files that must NOT be modified concurrently (owned/active)
- `docs/AUDIT_PROGRESS.md`, `docs/PRODUCT_LAUNCH_AUDIT.md` — codex (append-only).
- `app/(app)/dashboard/`, `app/(app)/home/`, `app/(app)/display/`,
  `components/modules/{assistant,weather,settings}-module.tsx` — agent-05 (A-05).
- `components/modules/messages-module.tsx`, notifications — agent-03.
- A-13 server pages under `app/(app)/dashboard/{vacations,trips}/` — codex.


---

## Recovery marker — 2026-07-19 00:27 UTC (`agent-fable-opus` / CLAUDE-POLISH-01)

**Latest verified `main`:** `e3d85f68` — full gate GREEN (689 vitest files / 0
failures, tsc clean, `next build` exit 0). Ledger control-byte clean.

**Mobile mission (MOBILE_PROGRESS/TODO/AUDIT + PHYSICAL_DEVICE_TEST_PLAN):
COMPLETE to the external wall.** M-001–M-037 shipped; backlog has zero OPEN
executable items. Every mobile fix has an automated guard (vitest + the
8-project Playwright matrix, 275 tests, landscape+dark run live green) or a
scripted hardware check (13 device scripts). This agent's session slice:
M-023 (SW auth-cache privacy purge), 025 (orientation), 026 (push focus),
028 (inline video), 030 (popup-safe signed-URL opens — new
`lib/utils/open-url.ts` `preOpenWindow()`), 031 (Send key), 032 (chat
overscroll), 033 (toast clearance), 034 (dead FAB removed), 035 (iPad hub
grids), 036 (landscape+dark matrix), 037 (device-plan refresh); plus
PLA-0833 (SEO junk cleanup, migration 0233), PLA-0834 (FAQ nav+tabs),
PLA-0835/0837/0845 (Fridge Chef end-to-end), PLA-0812 (mojibake), PLA-0815
(768-record seed pack).

**A resuming agent should NOT re-sweep:** SW/PWA, video playsInline,
window.open-after-await, DnD/dblclick/contextmenu, permission flows,
enterKeyHint, overscroll, toast/FAB clearance, hub tablet grids — all fixed or
proven clean with guards.

**Next real work requires owner inputs (in priority order):**
1. LB-003 credential rotation (incl. live Stripe/Supabase keys pasted in chat).
2. LB-010/011 — apply migrations 0217/0219 (+ 0233 SEO cleanup) to production.
3. LB-001 Auth Admin 500 (Supabase dashboard).
4. Stop/fix the "Publish …readiness increment" jobs' ledger-write path.
5. CI Supabase test creds → authed journeys on the 8-device matrix + M-008
   full walkthrough; physical devices → execute device-plan S1–S13.

Until one unlocks, the safe standing task is the integration-gate heartbeat
(`vitest` + `tsc` + ledger control-byte check) and honoring the active-lane
list above.