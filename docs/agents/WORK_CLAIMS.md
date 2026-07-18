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
| C-POLISH-001 | `agent-fable-opus` | App-wide UTF-8 mojibake repair (cross-cutting, one-shot) | 79 files under `app/`,`components/`,`lib/` (string content only) + `tests/no-mojibake-source.test.ts` | 2026-07-18 10:12 | DONE (`5c58ca7e`) — overlapped C-FE-005 files; see CONFLICT_LOG (non-destructive, string-only) |
| C-POLISH-002 | `agent-fable-opus` | Page-level fail-closed read sweep (pre-board; overlaps codex server-read lane) | `app/(app)/**/page.tsx` (18 pages) + `app/gift/[token]` + `tests/*-read-boundary.test.ts` | 2026-07-18 (pre-board) | DONE (PLA-0770,0773–0782,0803–0810) — non-owning; codex owns the lane going forward |

## Rules (from COORDINATION §0/§8)
- One agent per A-unit; keep file claims as narrow as practical.
- Do not edit files under another agent's ACTIVE claim; on overlap, stop and log
  in `CONFLICT_LOG.md`, resolve ownership first.
- `git fetch origin main && git rebase` before every push; keep BOTH sides on doc
  conflicts.
