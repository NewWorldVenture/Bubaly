# Audit status board

## Pull request 510 integration — 2026-09-19

CURRENT: AUTH-001/AUTH-002/AUTH-003 request-admission witness cycle IN PROGRESS
on published baseline dc99dc83. All prior 14,006 IDs/statuses remain preserved.
WORKSPACE: Separate bubaly-final-production-audit-20260912 worktree, existing
PR 510 merged as main 4bee6275; production frontend is live. The main checkout is untouched.
SCOPE: Original callback request ownership reaches completion without recapturing
newer cookies. Both entrypoints preserve supplied witnesses; duplicate cookie
names remain visible for rejection. The witness is comparison metadata only.
LOCAL FINAL: Application ee003898 passes UTC and DST 16,543/16,543 in 1,303 files
each, build 252, strict types, lint with three existing warnings and i18n/query
(491 tables / 86 functions / 146 routes). Focused browser ownership 81 and
completion/recovery 82 pass; server/routing 147 and shared/server/page 77 overlap.
TEST INFRASTRUCTURE: New actual HTTP/Mailpit fixture and disposable localhost
redirect configuration are pinned at d0adca17; four cases pass discovery/types/lint
but have not executed. Final discovery is 1,183 cases / 49 files. No new runtime PASS.
HOSTED BASELINE: Exact dc99dc83 CI 35464679043 has Web, Database and Mobile SUCCESS;
Finance 35464679048 has 66 explicit 0274 PASS notices. Web passes both 16,495-test
unit runs, build 252 and strict types. Database passes 330 migrations, 38 probes
and 327 reapplications. E2E passes 1,150/1,150 with auth/durable enabled. No restarts.
ROLLOUT: Exact Vercel deployment dpl_4pWBho8dManFcsbzy8Z8FDFybTsy is live; eight HTTP and four real-browser public checks pass. Historical production migration 0177 failed again; no SQL change or retry. Test-only Next alert selectors are corrected; hosted acceptance is pending.
NEXT: Finish new hosted recovery acceptance and investigate the existing production database failure. See docs/final-audit/production-rollout-20260919.md.
OPEN: Attempt-owned initiation, non-atomic cookie compare/write, successful hosted
recipient/PKCE recovery, real provider delivery and production configuration.
CURRENT RECORD: docs/final-audit/auth-callback-admission-witness-cycle.md.
REFERENCES: docs/final-audit/auth-callback-browser-ownership-cycle.md and finalaudit.md.
RELEASE: NO. Twelve new structural rows are NOT STARTED; total 14,018. No complete
workflow PASS or existing status promotion.
LAST-UPDATE: 2026-09-19T20:00:00Z

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
CURRENT: Continuous audit loop. Scope: Coordinator + Architecture/Integration,
  and the applier of every fix.
COMPLETED (this round): five findings, each found by hunting the GUARD SHAPE
  rather than another instance of a bug.
  1. Nine forms wrote Greenwich's day into a DATE column (HIGH).
  2. Two reads capped at 1,000 rows in components/, one of them also dropping
     its error and lacking a rejection path (HIGH).
  3. Twenty-six money inputs could not take a decimal point on iOS (HIGH).
  4. Five reads that handled every database failure and no network one,
     including App Lock presenting a configured lock as never set up (HIGH).
  5. The admin console reported the first thousand of everything (HIGH).
  Three NEW guards added; five existing guards widened. Every fix proved
  load-bearing by reverting it and watching the guard go red.
NEXT: the OPEN items recorded at the end of audit/claude-1.md — a database
  aggregate for the admin growth/storage figures, ~20 unbounded admin LIST
  reads, and the 95-site awaited-destructure population (unverified, and
  explicitly not 95 findings).
FILES-TOUCHED: audit/claude-1.md, audit/status.md, and the source files named
  in the commits on main between 358b1e6d and ea9bf3da. Chief among them:
  lib/schedule/zoned.ts, components/modules/{school,expenses,trip-memories,
  health-visits,finances,pets,subscriptions,meals,language,event-detail-modal}*,
  components/{finance,wallet,settings,marketplace,calendar,auth}/*,
  app/(app)/admin/{reports,backup}/page.tsx, app/(app)/dashboard/calm/page.tsx,
  and tests/ (3 new guards, 5 widened).
BLOCKERS: F5/F-001 and F-C08 still need an owner — no working path exists to
  apply a migration to production. Unchanged, and not a blocker on the audit.

### Three distinct ways a guard fails, all found this round

Worth separating, because the fix for each differs:

1. **Scope gap** — the rule is right, the walk is too small.
   `family-day-not-greenwich-day` and `no-limit-above-the-row-cap` skipped
   `components`; `mobile-numeric-inputmode` read ONE flat directory and its
   own coverage assertion was satisfied by that directory, so it passed
   honestly on every CI run while 26 offenders sat outside it.
2. **Premise gap** — the guard covers the blessed helper, not the bypass.
   `read-error-surfaced` checks `useRealtimeQuery` call sites; all five reads
   in finding 4 hand-rolled a fetch instead, putting them outside its premise.
   *A guard on the safe path does not cover the path taken to avoid it.*
3. **Enumerated with no scan** — `whole-table-reads-are-not-capped` pins four
   named jobs against a capped fake. It cannot be wrong about those four; it
   just never grew to a fifth surface.

A coverage assertion calibrated to the scanned subset cannot detect that the
subset is the problem. Every widened guard here got a bound past what its old
scope could satisfy, plus a case asserting the walk still reaches past it.
LAST-UPDATE: 2026-09-18T20:05Z

## Claude-2
CURRENT: COMPLETE for this round. Scope: Frontend · UI/UX · Responsive · Accessibility.
COMPLETED: audit/claude-2.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-2.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-3
CURRENT: COMPLETE for this round. Scope: Backend · API · Database · Auth · Security.
COMPLETED: audit/claude-3.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-3.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-4
CURRENT: COMPLETE for this round. Scope: QA · Features · Flows · Performance · Edge cases.
COMPLETED: audit/claude-4.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-4.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


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
CURRENT: COMPLETE for this round. Scope: Frontend · UI/UX · Responsive · Accessibility.
COMPLETED: audit/claude-2.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-2.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-3
CURRENT: COMPLETE for this round. Scope: Backend · API · Database · Auth · Security.
COMPLETED: audit/claude-3.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-3.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-4
CURRENT: COMPLETE for this round. Scope: QA · Features · Flows · Performance · Edge cases.
COMPLETED: audit/claude-4.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-4.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14
