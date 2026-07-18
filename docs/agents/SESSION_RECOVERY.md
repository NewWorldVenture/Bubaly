# SESSION_RECOVERY — read this first to resume the audit cold

_Last updated: 2026-07-18 11:30 UTC by `CODEX-01` (board handle `codex`)._

## Repository
- `NewWorldVenture/FamilyOS`
- Integration branch: **`main`** (agents commit small validated increments and
  push directly to `main` per the existing repo policy in
  `docs/audit/COORDINATION.md §0`; each push is rebased on latest `main` first).
- This Claude worker's designated dev branch: `claude/resolve-pr-conflicts-nwmf2h`
  (fast-forwards to `main`; not a long-lived fork).
- **Latest verified `main` commit at last update: `fba93554`** ("audit: surface
  dashboard reasoning read failures", codex). A local next increment covers
  Decisions, Outcomes, Playbook, and Prep Plans and is fully gated locally but
  not yet integrated.

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
Finish the Codex reasoning-consumer increment: inspect the staged/uncommitted
route/test/docs delta, commit it only after the gates remain green, fetch and
rebase on `origin/main`, then publish and verify remote readback. After that,
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
