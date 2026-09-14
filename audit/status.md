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

---

# Board from the parallel audit session (merged 2026-09-13T23:51Z)

Two audit sessions ran at once and both wrote this board. The other
session's is above, kept as the primary because it is the one on main;
this session's follows, unedited, so neither record is lost.

# Audit status board

One section per worker. A worker edits **only its own section**.

Claude-1 is the coordinator and the only writer of `finalaudit.md`.

**Prior work exists.** `finalaudit.md` already carries 41 findings from two
completed passes (A: `F1`–`F21`, public surface; B: `F-001`–`F-020`, data
layer). It is not rebuilt from scratch — it is merged into. Read it before
auditing anything, and do not re-derive a finding it already holds unless you
are verifying or contradicting it.

---

## Claude-1
CURRENT: complete — all six passes merged and the consolidated index built
COMPLETED: scaffolding; workers dispatched; architecture+integration sweep
  (CSP vs real outbound hosts, server/client boundary, env contract, workflow
  health, dependency audit, mobile gate); Pass C written into finalaudit.md as
  F-C01–F-C10 with all 41 prior findings preserved; #526/#540/#543/#544/#546
  shipped and verified in production
NEXT: nothing outstanding in the audit itself. The open work is the owner's:
  unblock the migration path (F5/F-C08), then apply 0296. Two gaps are named in
  the Verification Checklist rather than left implied — no browser was run, and
  0237/0239/0292 did not replay.
FILES-TOUCHED: audit/status.md, audit/claude-1.md, finalaudit.md,
  supabase/migrations/0296_family_credentials_manager_only.sql,
  docs/audit/family-credentials-boundary-check.sql,
  tests/migration-version-safety.test.ts
BLOCKERS: F5/F-001 and F-C08 need an owner — together they mean NO working
  path exists to apply a migration to production. Not a blocker on the audit.
  F-E01 is CRITICAL and needs an owner decision tonight, not a queue slot.
LAST-UPDATE: 2026-09-13T22:50Z

## Claude-2
CURRENT: done — frontend/UI/UX/responsive/a11y pass complete, findings written
COMPLETED: read finalaudit.md (41 prior findings); audited app/(app) (354 pages)
  + components/ (456 tsx). 14 findings recorded in audit/claude-2.md
  (3 HIGH, 7 MEDIUM, 4 LOW) + 8 areas verified clean. Ran `npx next lint` in
  full (3 warnings). NO source code modified — audit-only, per instructions.
  Headline: C2-01 photo lightbox is an untrapped modal with no Escape;
  C2-02 55 labels detached from their control; C2-03 65 <select> with no
  accessible name; C2-10 the lint config enables none of the rules that would
  have caught them.
NEXT: nothing — awaiting Claude-1 triage. Open questions flagged in-file:
  C2-04 (what is actually behind the billing gates), C2-13 (is the
  plan-generator list reorderable).
FILES-TOUCHED: audit/claude-2.md, audit/status.md (this section only)
BLOCKERS: none. Not reached: colour-contrast measurement, real tab order and
  screen-reader output — all three need the app running in a browser.
LAST-UPDATE: 2026-09-13T23:40Z

## Claude-3
CURRENT: done — backend / API / database / auth / security pass complete
COMPLETED: read finalaudit.md index (41 prior findings); replayed all 308 migrations
  into a local PG16 (482 tables; only 0237/0239/0292 failed, `vector` absent) and
  audited RLS/grants/policies/SECURITY-DEFINER against the live catalogue rather
  than by grep; mapped all 141 app/api routes to their auth guard; read all 61
  PUBLIC-list carve-outs; swept server actions, service-client call sites,
  storage buckets, secrets/logging, SSRF and request-body bounds.
  9 findings written to audit/claude-3.md (1 CRITICAL, 2 HIGH, 4 MEDIUM,
  2 LOW) plus 12 verified-healthy items recorded so they are not re-derived.
NEXT: nothing queued — available for follow-up or verification requests
FILES-TOUCHED: audit/claude-3.md, audit/status.md (this section only)
BLOCKERS: production schema unverifiable (no credentials) — if finalaudit F-001
  still holds, prod may not carry the policies I verified locally; 3 migrations
  unreplayed locally (marketing platform spine, needs the `vector` extension)
LAST-UPDATE: 2026-09-13T23:40Z

## Claude-4
CURRENT: done — 13 findings written to audit/claude-4.md
COMPLETED: read finalaudit.md; 2 full suite runs (TZ=UTC and TZ=America/Los_Angeles, 195s each);
  4 scripted sweeps over tests/** for non-failing assertions; await-in-loop sweep over app/+lib/;
  money/kids action-to-test cross-reference (51 actions); invite/join and double-submit flow review
NEXT: nothing queued. Available for follow-up if Claude-1 wants any OPEN item closed (C-4-09 needs
  a caller walk to bound Promise.all fan-out)
FILES-TOUCHED: audit/claude-4.md, audit/status.md (no source code modified)
BLOCKERS: none. Could not reach: live database, running app, Playwright e2e matrix
LAST-UPDATE: 2026-09-13T23:40Z

---

# Board from the third audit session (appended 2026-09-14)

A third session ran this protocol against the same repository. Nothing above is
edited — this block is appended, and where a finding duplicates one already on
the board it says so and gives the disposition.

## Claude-1 (third session)
CURRENT: Architecture/integration sweep, and applying the parallel session's
  CRITICAL. Workers 2/3/4 were launched here and all three hit the account's
  session rate limit mid-run (resets 03:10 UTC); their partial findings are in
  `audit/claude-{2,3,4}.md` and were read before acting.
COMPLETED:
  - PR #545 merged (F22: a child's username matched as a pattern, not a value).
  - PR #548 opened, carrying six findings:
      A3-002 HIGH     every child row on /wallet/treasury was a 404
      A3-001 MEDIUM   two integrations with no documented switch, one on a cron
      A3-003 CRITICAL an invitee could rewrite their invite and join any family
                      as parent (migration 0297) — the same defect Claude-3 of
                      the parallel session found; confirmed independently before
                      acting, then fixed and proven
      A3-004 MEDIUM   Guardian queried outside the typed layer, behind 180 lines
                      of types that could not apply
      A3-005 HIGH     a scam call could be transferred instead of hung up
      A3-006 MEDIUM   three Twilio callbacks consumed the event before checking
                      which family it was for
  - Six areas verified sound and recorded so nobody re-derives them: cron auth
    (24/24), cron schedule↔route parity, all 72 /api references, all 103 catalog
    hrefs, client-component env hygiene, morning-brief timezone handling.
  - The allowance_rules CRITICAL (Claude-3's second) confirmed and closed:
    migration 0298 plus an author check in the cron, with a behavioural probe.
  - Claude-3's medication HIGH: the write half closed (0299 — prescriptions and
    their schedules are managers-only), with the two halves I would not guess at
    filed as owner decisions rather than taken (see A3-009).
  - Claude-3's grades/screen-time MEDIUM closed (0300), with two different rules
    rather than one blunt one — see A3-010.
NEXT: the child_logins policy whose name and predicate disagree, then the
  remaining membership-only self-log tables (behavior_logs, kid_progress,
  habit_logs, care_log). Two owner decisions are filed and not mine to take:
  narrowing medical READS, and whether logging a vaccination is any member's
  to do.
  `family_credentials` is already closed on main by 0296 from the other session.
FILES-TOUCHED (third session only):
  - .env.example, components/wallet/treasury-view.tsx
  - supabase/migrations/0297_invite_terms_are_not_the_invitees_to_write.sql
  - supabase/migrations/0298_allowance_and_gift_writes_are_managers_only.sql
  - supabase/migrations/0299_a_prescription_is_a_parents_to_write.sql
  - supabase/migrations/0300_a_childs_own_record_is_not_theirs_to_rewrite.sql
  - docs/audit/invite-terms-boundary-check.sql
  - docs/audit/allowance-rule-write-boundary-check.sql
  - docs/audit/prescription-write-boundary-check.sql
  - docs/audit/child-record-write-boundary-check.sql
  - components/modules/screen-time-module.tsx
  - app/api/cron/wallet-allowance/route.ts
  - lib/database.types.ts, lib/supabase/guardian-tables.ts (deleted),
    lib/guardian/{ai-screen,pipeline,trust,learning-run}.ts,
    app/(app)/guardian/**, app/api/guardian/**, app/api/cron/guardian-learning/route.ts,
    components/guardian/guardian-dashboard.tsx
  - tests/{env-example-covers-runtime-config,internal-links-resolve,
    guardian-screening-decision-is-validated}.test.ts (new),
    tests/{guardian-action-error-boundaries,guardian-audit-log-service-role,
    migration-version-safety}.test.ts (updated)
BLOCKERS: none of my own. The owner-blocked set is unchanged — F5/F-001 (no
  working path to apply a migration to production), F6 (inbound-email secret and
  MX), F19 (AI metering is a pricing decision).
VERIFICATION: tsc clean · eslint clean on every changed file · full vitest suite
  green · 312 migrations replayed, 0 failed · 21/21 boundary probes · non-vacuity
  proven for every new guard by reverting the fix and watching it go red.
LAST-UPDATE: 2026-09-14T12:05Z

## Claude-2 / Claude-3 / Claude-4 (third session)
STATUS: stopped early — all three hit the account session limit mid-run. Their
  findings so far are in their own files and are NOT complete sweeps. Claude-3's
  partial run is the most valuable: it bootstrapped a throwaway PG16, replayed
  all 308 migrations, and probed RLS as a real child session, producing two
  CRITICALs (one now fixed here as A3-003, one still OPEN) and two HIGHs.
LAST-UPDATE: 2026-09-14T12:05Z
