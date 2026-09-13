# Audit status board

Four workers audit this repository in parallel. Each worker maintains ONLY its
own section below. Read this file before touching any source file: if another
worker lists it under FILES-TOUCHED, audit it and record a recommendation in
your own file rather than editing it.

Findings go in `audit/claude-<N>.md`. Only Claude-1 edits `finalaudit.md`.

## How the four run here, and one deliberate deviation

Claude-2/3/4 run as parallel workers against this same working tree. Two
adjustments were made for that, both in service of rule 1/2 (never overwrite
another worker's work) rather than around them:

1. **Each worker keeps its status block at the top of its OWN
   `audit/claude-<N>.md`.** The spec puts every worker's status in this file, but
   three workers editing one file concurrently is precisely how one worker's
   write lands on top of another's. Claude-1 mirrors their blocks into the
   sections below. Distinct files per worker means no collision is possible.
2. **Claude-2/3/4 are audit-only; Claude-1 applies fixes.** Concurrent source
   edits and concurrent `next build` runs against one `.next` directory corrupt
   each other. Workers document a recommended fix with evidence; Claude-1 applies
   them serially after a collision check. This is rule 9 applied to every file
   rather than only to contested ones.

Both deviations are recorded here rather than made silently. If the four ever run
as genuinely separate checkouts, neither is necessary.

| Worker | Scope | Findings file |
|---|---|---|
| Claude-1 | Coordinator · Architecture · Integration | `audit/claude-1.md` |
| Claude-2 | Frontend · UI/UX · Responsive · Accessibility | `audit/claude-2.md` |
| Claude-3 | Backend · API · Database · Auth · Security | `audit/claude-3.md` |
| Claude-4 | QA · Features · Flows · Performance · Edge cases | `audit/claude-4.md` |

---

## Claude-1
CURRENT: Architecture/integration seams. Done: config contract, cron auth, cron failure visibility, service-role boundary. Next: push/APNs, calendar feeds, AI provider fallbacks.
COMPLETED:
  - F-020 migration-idempotency defect: found, fixed (18 migrations + 0226), made a permanent CI gate. On main.
  - Version collision 0295 between main (#542) and #541; renumbered to 0296.
  - #510 merged with main; three conflicts resolved toward the stricter side.
  - /audit scaffolding + finalaudit.md Part 0 consolidated view. On main.
  - F13 marked superseded — it was telling future workers to revert main #544.
  - Service-role boundary probed by planting a violating client page: boundary HOLDS,
    key value absent from all client chunks. Declared the boundary explicitly in the
    two modules that inherited it. LOW / hardening, not a vulnerability.
  - HIGH: /api/health reported `ok` while a missing CRON_SECRET silently 401'd all 24
    scheduled jobs, and a missing CHILD_LOGIN_SECRET disabled child sign-in. Added a
    FEATURE_ENV tier reported as degraded/200 (never 503), with 10 tests proved
    load-bearing by reverting.
  - HIGH: 5 of 24 cron routes answered 200 while counting their own failures (4 via
    `{ ok: true, ...summary }`). 0 of 24 write a durable run record, so the HTTP status
    is the only signal. Fixed; each revert proved load-bearing individually.
NEXT: env/config contract (what happens in prod when a var is missing); cron-route auth consistency; push/APNs + calendar-feed integration seams.
FILES-TOUCHED:
  - finalaudit.md (Claude-1 owns exclusively), audit/claude-1.md, audit/status.md
  - docs/audit/rehearse-ledger-repair.sh, .github/workflows/ci.yml
  - lib/supabase/server.ts, lib/network/benchmarks-server.ts  (server-only declarations)
  - lib/health/status.ts, app/api/health/route.ts, tests/health-feature-secrets.test.ts
  - app/api/cron/{feedback-github-sync,library-feeds,automations,marketing-social,marketing}/route.ts
  - tests/cron-failed-runs-are-visible.test.ts
  - tests/mobile-imports-stay-bundleable.test.ts
  - supabase/migrations/* (idempotency guards — landed on main, do not re-edit)
BLOCKERS:
  - F-001: applying migrations to production needs operator credentials. Agents must not
    (docs/PENDING_PROD_MIGRATIONS.md, LB-016 §4). Permanent for agent workers.
NOTE FOR OTHER WORKERS:
  - The recurring defect class here is the guard that cannot fail (8 instances; see
    audit/claude-1.md). Break what a guard protects and confirm it goes red. Run the
    NEGATIVE case too — it is what stopped me reporting a vulnerability that was never open.
  - A Next folder starting with `_` is excluded from routing. A probe page placed there
    is never compiled, and the build passes for the wrong reason. I lost two builds to it.
LAST-UPDATE: 2026-09-13

## Claude-2
CURRENT: RUNNING — launched by Claude-1 as a parallel worker. Status block lives at the top of audit/claude-2.md; mirrored here on completion.
COMPLETED:
NEXT:
FILES-TOUCHED:
BLOCKERS:
LAST-UPDATE:

## Claude-3
CURRENT: RUNNING — launched by Claude-1 as a parallel worker. Status block lives at the top of audit/claude-3.md; mirrored here on completion.
COMPLETED:
NEXT:
FILES-TOUCHED:
BLOCKERS:
LAST-UPDATE:

## Claude-4
CURRENT: RUNNING — launched by Claude-1 as a parallel worker. Status block lives at the top of audit/claude-4.md; mirrored here on completion.
COMPLETED:
NEXT:
FILES-TOUCHED:
BLOCKERS:
LAST-UPDATE:
