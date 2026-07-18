# AGENT_REGISTRY

Registered agents in the FamilyOS production-readiness audit. **Live claims** are
in `docs/audit/COORDINATION.md §3`; this registry adds the directive-mandated
identity/heartbeat layer and maps stable directive IDs to the existing board
handles (`agent-01`..`agent-05`, `codex`).

| Directive ID | Board handle | Model | Role / domain | Branch | Status | Last heartbeat (UTC) | Current task |
|--------------|--------------|-------|---------------|--------|--------|----------------------|--------------|
| `CLAUDE-QA-01` | `agent-02` | Opus 4.8 | QA / cross-cutting client boundaries + integration gate + orchestration bootstrap | `claude/resolve-pr-conflicts-nwmf2h` → main | **ACTIVE** | **2026-07-18 11:30** | Stood up `docs/agents/` recovery system; silent read/write/crash class sweeps; keeping tsc/build gate warm |
| `CODEX-CHECKPOINT-1215` | `codex` | Codex | Unified reasoning engine source-failure contract | `codex/reasoning-main-publication` | ACTIVE | **2026-07-18 12:15** | Full gate passed; next atomic publication unit ready |
| `CODEX-01` | `codex` | Codex | Originator; audit ledgers + A-13 server-side + A-15 assistant/agents + server-read fail-closed sweep | `codex/reasoning-main-publication` | ACTIVE | 2026-07-18 11:20 | Four additional A-05 reasoning consumers code-complete locally; running full integration gate |
| `CLAUDE-SUPABASE-01` | `agent-01` | Opus 4.8 | Auth/RLS/tenant isolation, migrations, security-critical DB | (pushed to main) | IN_REVIEW (heartbeat stale >18h) | 2026-07-17 ~17:36 | A-03/04/06/07/08/12/14 security + RLS proofs |
| `CLAUDE-INTEGRATIONS-01` | `agent-03` | Opus 4.8 | A-16 notifications/cron, A-11 messages/storage, observability | (pushed to main) | IN_REVIEW (heartbeat stale) | 2026-07-17 ~18:55 | Health endpoint, cron auth, messages/storage RLS |
| `CLAUDE-SECURITY-01` | `agent-04` | Fable 5 | A-15/17/18/19/20 authz, GRANT scoping, a11y/build gates | (pushed to main) | IN_REVIEW (heartbeat stale) | 2026-07-17 ~00:06 | Admin authz, sync fail-closed, axe/overflow baseline |
| `CLAUDE-FRONTEND-01` | `agent-05` | Opus 4.8 | A-05 home/dashboard/display command surfaces + §3e read sweep | (pushed to main) | **ACTIVE** | **2026-07-18 10:18** | Resuming A-05 dashboard wiring/verification matrix (user UI tasks /ai trial-copy + /blog hero art done: `162c9946`,`5e7b6fc1`); next: verify+harden remaining A-05 dashboard command surfaces |
| `CLAUDE-POLISH-01` | `agent-fable-opus` | Opus 4.8 | Cross-cutting page-level fail-closed read sweep + null-`display_name` crash class + **app-wide UTF-8 mojibake repair** | (pushed to main) | **ACTIVE** | **2026-07-18 10:20** | Registering + logging lane overlaps (below); mojibake repair PLA-0812 shipped (`5c58ca7e`). NOTE: joined this relay before the `docs/agents/` board existed and overlapped codex's server-read lane + agent-05's module claim — all work validated + rebased clean (no file collisions), logged in `CONFLICT_LOG.md`. |

| `MARKETING-ADMIN-01` | `019f7533-1d2a-7f41-8956-769b4e4b7d4e` | delegated agent | Super Admin AEO/SEO/content/landing lifecycle audit; exact control-plane paths claimed in `WORK_CLAIMS.md` | shared working tree | ACTIVE | 2026-07-18 12:50 | Finish focused fixes and verification; no commit/push; excludes platform helper, public routes, and migration 0231 |
| `MARKETING-PUBLIC-01` | `019f7533-6383-71f0-a7fa-cefd9ec45134` | delegated agent | Public marketing/AEO/landing/form closed-loop audit | shared working tree | CLOSED | 2026-07-18 12:45 | Changes integrated into Codex marketing publication |
| `MARKETING-CHANNELS-01` | `019f7533-ab35-7ce2-a076-ea1f5e5d3d57` | delegated agent | Marketing channels, assets, email, attribution, and measurement audit | shared working tree | CLOSED | 2026-07-18 12:45 | Changes integrated into Codex marketing publication |

## Notes
- Directive IDs are aliases; the operative identity on the claim board and in
  commit trailers remains the board handle to avoid churn mid-audit.
- An ID marked ACTIVE must not be assumed by a different session; reclaim a
  stale board unit per COORDINATION §0 instead of impersonating an ID.
- Orchestrator role: no single agent is a formal orchestrator; `docs/audit/
  COORDINATION.md` + `docs/AUDIT_PROGRESS.md` (codex) serve the orchestration
  function. `CLAUDE-QA-01` maintains this recovery layer.
