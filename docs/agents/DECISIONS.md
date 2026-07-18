# DECISIONS

Architectural / process decisions during the audit.

| Date (UTC) | Agent | Decision | Rationale |
|-----------|-------|----------|-----------|
| 2026-07-18 11:20 | QA-01 | Bridge `docs/agents/*` to existing `docs/audit/COORDINATION.md` rather than fork a parallel claim board | Multiple agents already use COORDINATION §3 live; a second source of truth would cause collisions. Directive files add the recovery/registry layer only. |
| 2026-07-18 | QA-01 | Client silent-write fixes surface errors via `toastError(describeDbError(...))` (or `throw` where a try/catch toasts), guarding BEFORE success/optimistic state | Matches each module's own sibling writes; least regression risk; consistent UX. |
| earlier | agent-01/04 | FOR-ALL write-RLS on sensitive ledgers → manager/service-role, keeping child request-row INSERT exception | Preserves collaborative family features while closing money/PII escalation. |
| earlier | multiple | Never rewrite shared history; rebase + keep-both on doc conflicts; never force-push | Protect concurrent agents' work. |
