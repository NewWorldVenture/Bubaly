# CODEX_RETURN_QUEUE

Tasks deferred specifically to Codex — only where Codex is materially better
suited or Claude is genuinely blocked. Ordinary hard engineering is NOT queued
here; Claude continues it.

> Codex is currently ACTIVE intermittently (recent `main` commits: Calm inbox +
> gift fail-closed, assistant reasoning). When it resumes a full pass it must
> first read `SESSION_RECOVERY.md`, this file, `docs/AUDIT_PROGRESS.md`,
> `docs/LAUNCH_BLOCKERS.md`, `docs/audit/COORDINATION.md §3`. **Codex must not
> overwrite Claude's verified changes.**

| Queue ID | Priority | Service / unit | Task | Why Codex | Evidence / files | Acceptance | Claude may continue adjacent? |
|----------|----------|----------------|------|-----------|------------------|------------|-------------------------------|
| CRQ-01 | High | A-13 vacations/trips | Finish server-page fail-closed reads + vacation CRUD walkthrough Codex started | Codex already owns these server files; splitting risks collision | `app/(app)/dashboard/{vacations,trips}/**`; agent-02 closed the client side (`PLA-0783/0784/0785`) | Every trip server route fails closed on read error; CRUD verified live | Yes — client side already done |
| CRQ-02 | High | A-15 assistant/AI | Continue assistant reasoning readiness + `dashboard/agents` increments | Codex authored the reasoning engine increments | `app/(app)/dashboard/agents/page.tsx` + reasoning libs | Reasoning surfaces verified; admin/ai settings authz; voice provider wiring | Adjacent AI route boundary tests OK if not touching these files |
| CRQ-03 | Medium | Audit ledgers | Keep `docs/AUDIT_PROGRESS.md` + `docs/PRODUCT_LAUNCH_AUDIT.md` canonical; reconcile duplicate PLA ids (e.g. 0520/0550/0580/0600/0610/0700 reused) | Codex owns the ledgers; renumbering by others collides | COORDINATION §ledger notes; progress `2026-07-18-0945.md` flagged 6 dup headings | No duplicate PLA headings; % matches verified weight | No — ledger is codex-owned |

## NOT queued (Claude is handling)
- Client silent read/write/crash boundary sweeps (DONE for `components/modules/`).
- Integration gates (tsc/vitest/build). RLS harness proofs. Seed gaps.
- Any owner/live-prod blocker → these are in `LAUNCH_BLOCKERS.md`, not here
  (they need a human, not Codex).
