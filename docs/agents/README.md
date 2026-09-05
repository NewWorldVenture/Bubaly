# `docs/agents/` — Multi-agent coordination & recovery system

This directory is the **resumable operating system** for the Bubaly
production-readiness audit. It exists so that any Claude or Codex session can
resume the audit immediately, without repeating completed work, after a usage /
context / time limit ends the previous session.

## ⚠️ Single source of truth for LIVE claims

The **live who-owns-what claim board** is **`docs/audit/COORDINATION.md` §3**,
which multiple agents (agent-01..05 + codex) already update every increment.
**Do not fork it.** The files here provide the recovery/registry/handoff layer
the launch directive mandates and *reference* that board rather than duplicating
its rows. When a field would contradict the board, the board wins.

Canonical audit ledgers (owned by `codex`, append-only for others):
- `docs/AUDIT_PROGRESS.md` — weighted % + per-unit A-01..A-20 state
- `docs/PRODUCT_LAUNCH_AUDIT.md` — PLA-NNNN issue log
- `docs/LAUNCH_BLOCKERS.md` — LB-NNN blockers
- `docs/audit/COORDINATION.md` — live claim board + cross-cutting sweep protocol

## Files

| File | Purpose |
|------|---------|
| `AGENT_REGISTRY.md` | Registered agents, heartbeats, current task |
| `ACTIVE_WORK.md` | What each active agent is doing right now |
| `WORK_CLAIMS.md` | Narrow file/scope claims (bridges to COORDINATION §3) |
| `DEPENDENCIES.md` | Cross-unit dependencies |
| `INTEGRATION_QUEUE.md` | Validated increments awaiting/So integrated to main |
| `HANDOFF.md` | Reassignments + preserved work on session boundaries |
| `DECISIONS.md` | Architectural / process decisions |
| `CONFLICT_LOG.md` | Detected ownership overlaps + resolutions |
| `VERIFICATION_QUEUE.md` | Work code-complete but awaiting retest/verify |
| `CODEX_RETURN_QUEUE.md` | Tasks deferred specifically to Codex |
| `SESSION_RECOVERY.md` | **Read this first** to resume the audit cold |

## Resume in 30 seconds

1. Read `SESSION_RECOVERY.md`.
2. Read `docs/audit/COORDINATION.md` (§0 protocol, §3 claims).
3. Read `docs/AUDIT_PROGRESS.md` + `docs/LAUNCH_BLOCKERS.md`.
4. `git fetch origin main && git checkout -B <your-branch> origin/main`.
5. Claim a `free`/`STALE` unit on the board, push the claim, then work.
