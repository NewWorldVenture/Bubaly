# WORK_CLAIMS

Narrow file/scope claims. The **authoritative** claim board is
`docs/audit/COORDINATION.md §3` (per-A-unit ownership). This file records the
finer-grained file-pattern claims the directive asks for; when in doubt the
board wins.

| Claim ID | Agent | Scope / audit unit | Files / patterns | Started (UTC) | Status |
|----------|-------|--------------------|------------------|---------------|--------|
| C-QA-001 | `CLAUDE-QA-01` | Cross-cutting client boundary sweep (silent read/write/crash) in UNOWNED modules | `components/modules/{notes,pets,autopilot,voting,routines-panel}.tsx` + their `tests/*-write-boundary.test.ts` | 2026-07-18 10:40 | DONE (`3a5263f8`) |
| C-QA-002 | `CLAUDE-QA-01` | Recovery/coordination system | `docs/agents/**` | 2026-07-18 11:20 | IN PROGRESS |
| C-QA-003 | `CLAUDE-QA-01` | Integration gate (read-only) | `tsc`/`vitest`/`next build` at latest main; `docs/progress/**` | ongoing | RECURRING |
| C-FE-005 | `CLAUDE-FRONTEND-01` (agent-05) | A-05 dashboard command-surface verification + hardening | `app/(app)/dashboard/**`, `app/(app)/display/**`, `components/dashboard/**`, `components/modules/*` (A-05 only) | 2026-07-18 10:18 | IN PROGRESS |

## Rules (from COORDINATION §0/§8)
- One agent per A-unit; keep file claims as narrow as practical.
- Do not edit files under another agent's ACTIVE claim; on overlap, stop and log
  in `CONFLICT_LOG.md`, resolve ownership first.
- `git fetch origin main && git rebase` before every push; keep BOTH sides on doc
  conflicts.
