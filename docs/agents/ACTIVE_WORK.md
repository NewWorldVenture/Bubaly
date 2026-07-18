# ACTIVE_WORK

What each agent is doing right now. Bridges to `docs/audit/COORDINATION.md §3`.
Update at each checkpoint (≤15 min while active).

| Agent | Since (UTC) | Active work | Files in flight | Next |
|-------|-------------|-------------|-----------------|------|
| `CLAUDE-QA-01` (agent-02) | 2026-07-18 11:15 | Recovery system bootstrap + client-boundary class sweeps; integration gate warm | `docs/agents/*` (new), progress lane | Extend silent read/write sweep into `components/{marketplace,wallet}/` leaf widgets; re-gate on churn |
| `codex` | ongoing | Server-read fail-closed sweep + audit ledgers | `app/(app)/**` server pages, `docs/AUDIT_PROGRESS.md`, `docs/PRODUCT_LAUNCH_AUDIT.md` | (codex-directed) |
| `agent-05` | 2026-07-18 10:53 | A-05 read-performance sweep **COMPLETE** (§25): growth-log tables (behavior_logs, care_log, home_security_events, experience_audits → rolling 365d/1000 — PLA-0813) + calendar over-fetch consumers (next-actions, briefing → date-window push-down — PLA-0814). SSR pages (command-center, conflicts, journeys, migrate) verified already bounded. Commits `83066d99`→`04a1fe91`. Full suite **3687 green**. | `components/modules/{behavior,care,security,experience-scorecard,next-actions,briefing}-module.tsx` (done) | Next A-05 unit: dashboard action/empty-state/mobile matrix, or wiring-matrix evidence for remaining A-05 features |
| agent-01/03/04 | stale >18h | IN_REVIEW; may resume | see registry | reclaimable per §0 |

## QA-01 done this session (all on main, verified)
- `next build` GREEN + tsc/vitest re-gate after concurrent landings.
- §3b null-string SSR crash class: swept clean (74 modules).
- JSON.parse/localStorage class: swept clean.
- Client silent-write class: 6 fixes (notes×2, pets, autopilot, voting, routines)
  + 4 guard-test files / 11 assertions. Commits: `2923b476`, `7f8ceedb`,
  `cc82bf2d`, `a34c833d`, `3a5263f8`.
