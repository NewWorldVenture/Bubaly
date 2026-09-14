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
CURRENT: Session 3 (2026-09-14). Closing the two gaps the Verification Checklist
  names as blocking completion, using tooling no previous pass had.
COMPLETED (session 3 so far):
  - Read the full board before touching anything. The audit is NOT new work: 87
    findings over passes A-H already exist and most are fixed. Rule 4 applies —
    this session verifies and closes gaps rather than re-deriving.
  - Established the runtime every prior pass lacked:
      * Chromium + Playwright 1.61 + @axe-core/playwright are present -> the
        "Run a browser" gap (Pass D) is finally actionable.
      * INSTALLED pgvector (postgresql-16-pgvector). Pass E could not replay
        0237/0239/0292 because `vector` was absent, so the marketing platform
        spine tables were never audited. That blocker is now gone.
      * Docker daemon is NOT usable and the Supabase CLI is absent, so there is
        no local Supabase: the AUTHENTICATED app cannot be signed into here.
        Browser work this session is therefore scoped to the public surface,
        and that limit is stated rather than left implied.
  - Dispatched Claude-3 (pgvector replay + marketing spine).
  - Merged ALL THREE workers into finalaudit.md, verifying the mechanism of
    every HIGH independently before accepting it (rule 4):
      * Claude-3 -> Pass L (L1-L4).
      * Claude-4 -> Pass N first half (N1-N3 + 8). N1 REOPENED F-C03.
      * Claude-2 -> Pass N second half (C2-B01-C2-B17).
    Two claims were corrected in the merge, both recorded in place:
      * C2-B17 says the marketing layout is the skip link's "only mount". It is
        not — components/app/app-shell.tsx:349 mounts it too, with a matching
        <main id="main-content"> at :387. Correct for the public surface it
        measured; overstated repo-wide, and it changes the fix.
      * C2-B02's headline 3.68:1 is exact, but three of its REMEDY ratios drift
        (violet-600 5.70 not 5.90; blue-600 5.17 not 4.68; blue-700 6.70 not
        6.30). Recomputed so a later fix is not sized against a wrong figure.
    Reproduced exactly: the compiled .focus-ring rule, the 202/16 call-site
    split, --brand-fg = 255 255 255 in both themes, and ALL TWELVE light-theme
    token ratios to two decimal places.
  - APPLIED the first fix the audit's own findings demanded: C2-B01 + C2-B04,
    together, because fixing either alone makes the product worse. .focus-ring
    is now a state variant (was an UNCONDITIONAL ring on 202 elements, so focus
    was invisible); form controls get a separate --border-input token clearing
    WCAG 1.4.11's 3:1 (was 1.28:1 light / 1.38:1 dark, over a fill identical to
    the card). The permanent ring was the ONLY thing making a field's boundary
    visible — one defect was concealing another, which is why the pair ships in
    one commit. Also added to design/tokens.json so Expo does not drift.
    Verified in the COMPILED css, the same way the defect was found:
      .focus-ring{outline:2px solid transparent;outline-offset:2px}
      .focus-ring:focus-visible{...ring...}
    Guard: tests/focus-and-boundary-contract.test.ts, 7 assertions, PROVEN RED
    for each of the three defects reintroduced (2 / 1 / 2 failures) and green
    with all three restored. Its token assertion re-derives 1.38:1 and 1.28:1
    from the token file alone — agreeing with Claude-2's browser measurement to
    two decimal places.
  - NEW FINDING C1-S3-03 while writing that guard: tests/brand-contrast-contract
    .test.ts is named for a property it cannot measure. It asserts --brand-text
    is DECLARED and that `text-brand` is UNUSED; it never computes a ratio.
    `grep -rln "0.2126\|luminance" tests/ lib/ scripts/` returned NOTHING before
    this commit — a repo with a two-theme palette and a cross-platform token
    contract had no WCAG contrast formula anywhere. That is what let C2-B02 and
    C2-B03 through. Filed, not fixed: closing it turns the suite red on
    C2-B03's palette, which is a product decision, not an audit one.
PRIOR SESSIONS (unchanged, see history below): F-020 migration idempotency;
  /api/health FEATURE_ENV tier; 5 cron routes answering 200 on their own
  failures; service-role boundary probe; 0296 renumber.
NEXT: C2-B05 (the consent preference centre declares aria-modal and manages no
  focus — regulatory surface, and components/ui/modal.tsx already implements
  every missing piece) is the next most valuable fix. Then reconcile the two
  Executive Summaries into one authoritative index — the document names this as
  a deliberate follow-up and it is the coordinator's job.
FILES-TOUCHED (session 3):
  - audit/status.md (this section only), audit/claude-1.md, finalaudit.md
  - source: lib/server/push.ts (M1), the calendar-feed route (M2),
    scripts/i18n-scan.mjs, app/globals.css, tailwind.config.ts,
    components/ui/input.tsx, design/tokens.json, and the 7 .tsx files carrying
    the now-redundant `focus-visible:focus-ring` prefix (C2-B01/C2-B04).
  - tests: push-failure-is-not-delivery, focus-and-boundary-contract.
BLOCKERS:
  - F-001/F5/F-C08: applying migrations to production needs operator
    credentials. Permanent for agent workers.
  - No local Supabase (no docker daemon, no CLI) -> no authenticated-app browser
    pass. Pass D's findings about app/(app) stay statically-derived.
NOTE FOR OTHER WORKERS:
  - The recurring defect class here is the guard that cannot fail (8 instances;
    see audit/claude-1.md). Break what a guard protects and confirm it goes red.
  - A Next folder starting with `_` is excluded from routing; a probe page placed
    there is never compiled and the build passes for the wrong reason.
LAST-UPDATE: 2026-09-14

## Claude-2
CURRENT: COMPLETE — browser pass over the public marketing/auth surface.
  Merged into finalaudit.md by Claude-1 as the accessibility half of Pass N.
  Full status block + evidence at the top of audit/claude-2.md, "SESSION 2".
COMPLETED: 17 findings C2-B01-C2-B17 (2 HIGH, 10 MEDIUM, 5 LOW), 9
  verified-clean items, 3 self-corrections, a 7-row BLOCKED table, and a
  cross-check of Pass D that CONTRADICTED F-D02/F-D03 on the reachable public
  surface without clearing them (the one public page F-D02 cites needs a DB row).
  46 structural axe runs + 92 contrast runs across 2 themes; key-by-key tab
  walks; ARIA-tree snapshots; 390/360px with real touch emulation.
NEXT: nothing queued.
FILES-TOUCHED: audit/claude-2.md ONLY. No application source modified.
BLOCKERS: no session (Supabase stubbed) -> app/(app)'s 354 pages, /s/[slug],
  /gift/[token], /pay/[handle], /blog/[slug], /customers/[slug] unreachable;
  no real screen reader; no forced-colors emulation.
LAST-UPDATE: 2026-09-14 (mirrored by Claude-1)

## Claude-3
CURRENT: COMPLETE — pgvector replay + the marketing platform spine.
  Merged into finalaudit.md by Claude-1 as Pass L.
COMPLETED: 4 findings L1-L4. 310 migrations applied, 0 failed; the nine spine
  tables (0237/0239/0292) audited for the first time. Also REFUTED one of Pass
  E's verified-healthy claims (L2): `anon` does hold write privilege on 483 of
  491 tables, and the "zero" was an artefact of a hand-built test prelude.
NEXT: nothing queued.
FILES-TOUCHED: audit/claude-3.md; migrations replayed locally only.
BLOCKERS: production schema unverifiable without operator credentials (F-001).
LAST-UPDATE: 2026-09-14 (mirrored by Claude-1)

## Claude-4
CURRENT: COMPLETE — runtime, page weight and flows in a real browser.
  Merged into finalaudit.md by Claude-1 as the first half of Pass N.
COMPLETED: 11 findings (3 HIGH, 6 MEDIUM, 2 LOW). N1 REOPENS F-C03, which this
  document indexed as "fixed and verified in production" — the RSC half was
  fixed, the bundle half never was (246 KB gzipped of catalogue on every
  marketing page). Also disproved its own "prefetch storm" hypothesis and
  recorded that, which is the right instinct.
NEXT: nothing queued.
FILES-TOUCHED: audit/claude-4.md ONLY. No application source modified.
BLOCKERS: no session -> app/(app) never rendered; N3 on a real blog slug and
  F-F03 in a browser both blocked on it. All wall-clock numbers stub-inflated
  and used only to count and order blocking reads.
LAST-UPDATE: 2026-09-14 (mirrored by Claude-1)

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
