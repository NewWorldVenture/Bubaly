# AGENT_REGISTRY

Registered agents in the FamilyOS production-readiness audit. **Live claims** are
in `docs/audit/COORDINATION.md §3`; this registry adds the directive-mandated
identity/heartbeat layer and maps stable directive IDs to the existing board
handles (`agent-01`..`agent-05`, `codex`).

| Directive ID | Board handle | Model | Role / domain | Branch | Status | Last heartbeat (UTC) | Current task |
|--------------|--------------|-------|---------------|--------|--------|----------------------|--------------|
| `CLAUDE-QA-01` | `agent-02` | Opus 4.8 | QA / cross-cutting client boundaries + integration gate + orchestration bootstrap | `claude/resolve-pr-conflicts-nwmf2h` → main | **ACTIVE** | **2026-07-18 11:30** | Stood up `docs/agents/` recovery system; silent read/write/crash class sweeps; keeping tsc/build gate warm |
| `CODEX-01` | `codex` | Codex | Originator; audit ledgers + A-13 server-side + A-15 assistant/agents + server-read fail-closed sweep | (its own) | ACTIVE (intermittent) | ~2026-07-18 (recent `main` commits) | Fail-closed server reads (Calm inbox, gift), assistant reasoning increments |
| `CLAUDE-SUPABASE-01` | `agent-01` | Opus 4.8 | Auth/RLS/tenant isolation, migrations, security-critical DB | (pushed to main) | IN_REVIEW (heartbeat stale >18h) | 2026-07-17 ~17:36 | A-03/04/06/07/08/12/14 security + RLS proofs |
| `CLAUDE-INTEGRATIONS-01` | `agent-03` | Opus 4.8 | A-16 notifications/cron, A-11 messages/storage, observability | (pushed to main) | IN_REVIEW (heartbeat stale) | 2026-07-17 ~18:55 | Health endpoint, cron auth, messages/storage RLS |
| `CLAUDE-SECURITY-01` | `agent-04` | Fable 5 | A-15/17/18/19/20 authz, GRANT scoping, a11y/build gates | (pushed to main) | IN_REVIEW (heartbeat stale) | 2026-07-17 ~00:06 | Admin authz, sync fail-closed, axe/overflow baseline |
| `CLAUDE-FRONTEND-01` | `agent-05` | Opus 4.8 | A-05 home/dashboard/display command surfaces + §3e read sweep | (pushed to main) | ACTIVE | 2026-07-18 ~09:52 | A-05 false-empty read + seed gaps (behavior_logs, family_facts) |

## Notes
- Directive IDs are aliases; the operative identity on the claim board and in
  commit trailers remains the board handle to avoid churn mid-audit.
- An ID marked ACTIVE must not be assumed by a different session; reclaim a
  stale board unit per COORDINATION §0 instead of impersonating an ID.
- Orchestrator role: no single agent is a formal orchestrator; `docs/audit/
  COORDINATION.md` + `docs/AUDIT_PROGRESS.md` (codex) serve the orchestration
  function. `CLAUDE-QA-01` maintains this recovery layer.
