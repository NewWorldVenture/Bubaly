# VERIFICATION_QUEUE

> **Historical record — last updated 2026-07-18; note added 2026-11-10.** This is the queue as the
> July 2026 audit session left it. It is not a current queue and not current guidance. The
> "Unified reasoning source-failure contract" row below (commit "this publication") was published
> the same day as commit `87c52ca58` ("fix(reasoning): surface degraded source reads") and the
> contract is in the tree (`lib/reasoning/engine.ts`, `lib/reasoning/engine-server.ts`); nothing
> listed here is awaiting verification today.

Work that is code-complete but awaiting retest/verification. QA-01's increments
are verified-on-push (test+lint+tsc before each push), so nothing from QA-01 sits
here. Other agents' items marked "Code complete" in `docs/PRODUCT_LAUNCH_AUDIT.md`
that still need integration retest belong here.

| Item | Agent | Commit | What remains to verify |
|------|-------|--------|------------------------|
| (none from CODEX-01) | `CODEX-01` | 59ef1633 | prior consumer increment integrated and read back on remote `main` |
| Unified reasoning source-failure contract | `CODEX-01` | this publication | full suite, lint, tsc, fresh 489-route build, docs, and integrated main readback |
| Closed-loop marketing control-plane audit | `CODEX-01` | c0e37f7f | local gates and integrated main readback complete; live provider/RLS/browser evidence remains external and is tracked in launch blockers |
| (none from QA-01) | — | — | — |

Externally-gated verification (cannot be done in-session) is tracked in
`docs/LAUNCH_BLOCKERS.md`, not here.
