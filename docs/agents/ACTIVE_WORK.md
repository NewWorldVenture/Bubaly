# ACTIVE_WORK

What each agent is doing right now. Bridges to `docs/audit/COORDINATION.md §3`.
Update at each checkpoint (≤15 min while active).

| Agent | Since (UTC) | Active work | Files in flight | Next |
|-------|-------------|-------------|-----------------|------|
| `CLAUDE-QA-01` (agent-02) | 2026-07-18 11:15 | Recovery system bootstrap + client-boundary class sweeps; integration gate warm | `docs/agents/*` (new), progress lane | Extend silent read/write sweep into `components/{marketplace,wallet}/` leaf widgets; re-gate on churn |
| `codex` | ongoing | Server-read fail-closed sweep + audit ledgers | `app/(app)/**` server pages, `docs/AUDIT_PROGRESS.md`, `docs/PRODUCT_LAUNCH_AUDIT.md` | (codex-directed) |
| `agent-05` | 2026-07-18 11:31 | A-05 **§23 a11y sweep** (PLA-0822): photos lightbox 8 icon-buttons + contacts call/email labeled (WCAG 4.1.2); **photos upload dropzone made keyboard-operable** (WCAG 2.1.1 — was a bare `<div onClick>`). Guard `tests/photos-a11y-labels.test.ts` (5). Form inputs verified label-wrapped/`<Field>`; home upload uses a real Button. Commits `17d06907`→`cb8fcde7`. Full suite **3694 green**. | `components/modules/{photos,contacts}-module.tsx` (done) | Continue §23 a11y across A-05 (focus-order/live-regions), or await live/browser-gated units |
| **cross-lane notes → owners** | 2026-07-18 11:31 | (A-10/agent-03) `shopping-module.tsx` L189 icon-only edit `<Pencil/>` no `aria-label`. (A-11/agent-03) `documents-module.tsx` L609 upload dropzone is a bare `<div onClick>` — same keyboard gap (WCAG 2.1.1) as the photos one I just fixed. Both flagged, NOT edited. | — | A-10/A-11 owner to add `aria-label` + keyboard support |
| agent-01/03/04 | stale >18h | IN_REVIEW; may resume | see registry | reclaimable per §0 |

## QA-01 done this session (all on main, verified)
- `next build` GREEN + tsc/vitest re-gate after concurrent landings.
- §3b null-string SSR crash class: swept clean (74 modules).
- JSON.parse/localStorage class: swept clean.
- Client silent-write class: 6 fixes (notes×2, pets, autopilot, voting, routines)
  + 4 guard-test files / 11 assertions. Commits: `2923b476`, `7f8ceedb`,
  `cc82bf2d`, `a34c833d`, `3a5263f8`.
