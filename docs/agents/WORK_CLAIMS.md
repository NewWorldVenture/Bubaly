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

| C-CODEX-002 | `CODEX-01` | A-05 reasoning-consumer read boundaries | `app/(app)/dashboard/{decisions,outcomes,playbook,prep-plans}/page.tsx` + matching `tests/*-reasoning-read-boundary.test.ts` | 2026-07-18 11:20 | CODE COMPLETE; focused tests and typecheck passed; awaiting full integration gate |
| C-CODEX-003 | `CODEX-01` | A-05/A-15 unified reasoning source-failure contract | `lib/reasoning/{engine,engine-server}.ts`, `app/(app)/dashboard/reasoning/page.tsx`, `tests/reasoning-*` | 2026-07-18 12:15 | CODE COMPLETE; full gate passed; this publication |
| C-CODEX-MKT-001 | `CODEX-01` | Marketing closed-loop integration and publication gate | `app/sitemap.ts`, shared marketing audit/wiring docs, non-overlapping integration tests | 2026-07-18 12:30 | DONE (`c0e37f7f`); remote main verified |
| C-MKT-ADMIN-001 | `MARKETING-ADMIN-01` | Super Admin marketing control plane: content, landing pages, SEO, AEO | `app/(app)/admin/marketing/content/**`; `app/(app)/admin/marketing/landing-pages/**`; `app/(app)/admin/marketing/seo/**`; `app/(app)/admin/marketing/aeo/**`; paired `app/(app)/admin/marketing/actions.ts`, `lib/marketing/admin.ts`, and focused marketing tests only | 2026-07-18 12:30 | ACTIVE (no commit/push); explicitly excludes `lib/marketing/platform.ts`, `app/(marketing)/**`, and `supabase/migrations/0231*` |
| C-MKT-PUBLIC-001 | `MARKETING-PUBLIC-01` | Public marketing rendering and conversion loop | `app/(marketing)/{page,faq,blog,lp,f}/**` + paired marketing readers/tests | 2026-07-18 12:30 | DONE (`c0e37f7f`) |
| C-MKT-CHANNELS-001 | `MARKETING-CHANNELS-01` | Marketing channels, assets, automation, experiments, and measurement | `app/(app)/admin/marketing/{analytics,campaigns,email,sms,social,ads,push,automation,experiments,assets,video,audit,settings}/**` + paired actions/tests | 2026-07-18 12:30 | DONE (`c0e37f7f`) |
