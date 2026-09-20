# Audit status board

## Pull request 510 integration — 2026-09-19

CURRENT: Published phone/signout repair; AUTH-001/002 remain IN PROGRESS.
FROZEN: f75e7febdf01bf944fa35a505745001533c80028; 9 source/test/workflow files.
REPAIRS: Owned SMS verification and lifecycle guards; exact pending-cookie bridge.
LOCAL: Combined 459/459 controlled browser cases across 17 files pass (1.1m).
Both full unit zones pass 16,703/16,703 across 1,305 files. Lint (3 existing
warnings), all 8 localization surfaces and query audit (491/86/146) pass.
Final combined 252-page build passes; full strict types pass.
VERIFIED APPLICATION: 2a5e7e7a, dpl_8oWh1TNVFNbmGissmnvmA11P6ECT, 21:28:59 UTC.
Exact deployed public auth/phone readiness passes; no auth action or SMS sent.
BASELINE: Published d954 public deployment checks PASS; hosted CI 1,251/1,252,
sole durable-signout completion failure. Web/Database/Mobile pass. No rerun.
HOSTED: CI 35470363378 Web/Database/Mobile SUCCESS. Web passes both full unit
zones (16,703/1,305), build252/lint/types. E2E 105970089707 FAILS:1,293/1,296.
Full discovery: 1,296 tests/54 files; authenticated/durable enabled, three real
Next/GoTrue phone cases and repaired signout. All3 phone cases stop before code
entry after Continue; verification unexecuted. Durable signout and six callbacks
pass by exact-source all-other-cases inference, not individual success entries.
Disposable test SMS configuration only; product config/SQL unchanged.
INVENTORY: All 14,035 prior IDs retained. Only PhoneAuth COMPONENT NS→IN PROGRESS;
ROLE stays NOT STARTED. Three new helper/test obligations IN PROGRESS.
Current total14,038: 13,842 NOT STARTED, 192 IN PROGRESS, 1 FIXED+PASS, 3 FAIL (0.01%).
AUTH-001/002/003 stay open; only existing narrow SEC-005 is closed.
REPAIR: Pinned CLI disables SMS signup without a concrete provider even with a
send-SMS hook; disposable test OTP config alone is insufficient. Existing workflow
DEPLOY NS→IN PROGRESS. CI-only provider/hook repair passes types/lint/discovery3,
guards66 and exact rewrite/negative controls. New hosted proof remains pending.
NEXT: Publish two-file CI repair and four evidence docs; await new hosted phone run.
Physical devices, production SMS delivery and full workflows remain open.
DISCOVERY: SEC-001 six-writer/media-consumer map; no privacy repair applied.
Actual worker handlers/Chromium cache/logout reproduce synthetic A image served
offline to B after logout (desired RED). Existing SW SUPPORT NS→IN PROGRESS;
no native worker installation, real optimizer or private production content.
RECORD: docs/final-audit/auth-phone-ownership-cycle.md.
MAPPING: docs/final-audit/discovery/auth-phone-ownership-inventory.json.
RELEASE: NO full audit/phone/production workflow PASS.
LAST-UPDATE: 2026-09-19T21:47:17.467Z

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
  - FIXED C1-S3-04, found by running the full suite before pushing:
    tests/ai-prompt-injection.test.ts TIMED OUT instead of running. Three tests
    await import() the AI module graph inside the test body; the first pays the
    ~4.9s transform inside its own timer and the body needs ~6.3s, against
    vitest's default 5000ms. It could not pass on this machine whether or not
    the defence works. Reproduced on origin/main in a clean worktree, so NOT
    this branch's — fixed anyway: three lines, and an unverified
    prompt-injection defence is not something to hand back as a comment.
    The point worth carrying: the red line said "timed out in 5000ms", which
    names TIME, not the defence. Every other guard in this audit CANNOT FAIL;
    this one fails in a way that DISGUISES WHAT BROKE.
    Proven load-bearing: with fenceUntrusted() neutered, 3 tests fail (the
    hostile-title assertion now failing on its merits at 6378ms rather than
    running out of time); restored byte-for-byte, 11 passed.
  - ROUND 4 DISPATCHED (2026-09-15). C2-B05 was fixed on main by the parallel
    session before I reached it, so the loop moved to the three surfaces with
    the THINNEST coverage rather than the next-most-severe known finding:
      * Claude-3 -> the 132 `'use server'` files. Pass E audited 141 API routes
        thoroughly; server actions are an equally public POST surface and are
        mentioned ~14 times in the whole audit. Spot check found gift/,
        reviews/new/ and signup/ actions with zero auth-check markers — some
        may be legitimately public, which is exactly why it needs verifying.
      * Claude-2 -> the mobile/ Expo app. A SECOND APPLICATION, 21 screens,
        sharing design/tokens.json with the web. The finalaudit
        "Mobile/Responsive" section is about the web app at phone width, not
        about React Native at all.
      * Claude-4 -> inside app/(app). Static flow/state audit, since no browser
        can reach it here. Pointed at F-F01's real blast radius (59 `{ max: }`
        call sites, not the five listed) as the highest-value thread.
PRIOR SESSIONS (unchanged, see history below): F-020 migration idempotency;
  /api/health FEATURE_ENV tier; 5 cron routes answering 200 on their own
  failures; service-role boundary probe; 0296 renumber.
  - ROUND 4 MERGED as Pass P (2026-09-15). All three workers reported; every
    HIGH verified independently before anything was applied.
      * FIXED C3-S4-01 (3 server actions were the only unmetered doors to the
        LLM, vs 31/31 API routes that all carry a limit), C4-S4-02 (a truncated
        money read became a $0.00 child balance fed to an LLM, under a comment
        naming that exact hazard), C2-M01 (mobile's field border — the half of
        C2-B04 that had not landed, and worse on RN, which has no focus ring to
        mask it). Guard added: tests/read-all-error-is-consumed.test.ts, proven
        red.
      * MY OWN ERROR, recorded: the first placement put the contacts rate limit
        ahead of its history reads, so a failed read reported "too many
        requests" instead of what actually failed. 27 tests went red. The limit
        belongs where the inbox intake puts it — after the loads, immediately
        before the AI work. Fixed and amended before pushing.
      * Three of this document's own framings corrected by workers rebuilding a
        measurement rather than inheriting it: F-F01 is HALF closed and was
        still indexed as fully open; "8 of 132 'use server' files lack auth" was
        the wrong unit (439 exported actions, 9 reach no auth, via a transitive
        fixpoint); "optimistic UI that lies" is NOT the second-most-common
        defect (1 real offender in ~530 client call sites — the class lives in
        server reads).
      * Part 0's headline count was corrected too: it now states the 137
        distinct ids the document actually names, and says plainly that the
        passes' totals are larger, rather than quoting a number nobody can
        reproduce from the document.
  - Pass U (session 6, continued). Censused the marketplace's UPDATE policies
    and found the object-level authorization 0154 shipped was written into the
    wrong clause: the ownership test was in `using` only, so a BUYER could set
    `seller_member` to themselves and inherit the completed-sales count two
    pages display as a seller's track record (C1-S6-08). The obvious repair —
    `with check` = `using` — was tried first and STAYED RED, because the
    predicate is symmetric and RLS cannot see the old row; 0321 makes the four
    identity columns immutable with a trigger gated on `row_security_active()`.
    Recorded alongside it, the audit's FOURTH refuted hypothesis: the 20
    UPDATE/ALL policies with `using` and no `with check` are safe, because
    PostgreSQL reuses `using` as the check — measured, not cited, and the
    ratchet's premise (`with check (true)` switches that off) measured too,
    after the first mutation turned out over-determined on `todo_lists`.
    Also added the 0319/0320/0321 rows docs/PENDING_PROD_MIGRATIONS.md was
    missing — those migrations are worth nothing until an operator applies them
    and the document is the operator's list.
    Censusing for C1-S6-08's shape found three more tables (C1-S6-09):
    marketplace_reviews/saves/follows pin authorship on INSERT and left an UPDATE
    policy of `is_family_member(family_id)` on both clauses — not scoped to the
    author at all, so the member a review was ABOUT could rewrite its rating, and
    `rating` is aggregated by `reviewee_member` on four screens. 0322 scopes them
    to the owner (nothing in the tree updates any of the three, so nothing is
    lost) and replaces 0321's table-branching trigger with a generic
    columns_are_immutable() that raises on a column that does not exist — the
    probe measures that typo guard, because a misspelled column would compare
    NULL to NULL and guard nothing.
    Then ran the identical census one verb over and found C1-S6-10: the DELETE
    policies on the same four tables are family-wide too, so the subject of a
    review could erase it and a member with no stake in a listing could delete a
    competing offer. 0323 scopes all four. Recorded plainly in finalaudit.md that
    I fixed UPDATE without checking DELETE in the same pass — the second census
    was one query.
    C1-S6-11 came out of a third census (INSERT requires a manager, some write
    verb does not) that returned exactly one row: social_access_permissions'
    DELETE policy was family-wide, and because social_role_for() falls back to a
    family-role default when no row exists, an adult restricted to read_only
    deleted their own restriction and became marketing_manager — publish_posts
    and manage_settings on the family's CONNECTED social accounts. 0324 gives
    DELETE the predicate INSERT and UPDATE already carry.
  - Pass V: five adjacent classes swept, none a finding, all recorded rather than
    dropped — other COALESCE-fallback permission resolvers (shape does not
    recur), restrictive write guards missing a verb (all 12 tables complete),
    the public family-media bucket (already found, fixed and tracked as LB-009 —
    re-filing it would have been the failure mode this audit warns about most),
    remaining clock-built public-bucket names (already ratcheted), and migration
    idempotency (proved by CI's rehearse-ledger-repair step, green on run 3144).
  - Also swept clean: all 24 cron routes gate on hasCronAuthorization (fail-closed,
    never "Bearer undefined"), every one returns 401, and the named-helper ratchet
    already covers it.
  - Round 6's fixes re-verified against the SEEDED CORPUS rather than fixtures
    (320 orders / 500 offers / 380 reviews / 300 saves / 10 binder rows): 60
    orders advanced by status alone, 380 reviews revised by their author, 300
    saves removed by their owner, seller_member still immutable across all 320.
    Deliberately not added as a probe — it depends on a best-effort seed, and a
    guard that passes vacuously when its data is missing is the defect class this
    audit exists to find.
  - C1-S7-01: the AI context deny-list's ratchet checked only the first hop —
    slices — while the policy's own docstring makes a claim about the second,
    the services. lib/services/trips getTrip reads vacation_documents (passport
    scans) with select('*') and travel.ts sits one import away from it. Measured:
    0 undocumented reaches today, so no live leak; the guard was the defect. New
    one-hop ratchet reads the deny-list from policy.ts rather than restating it.
    Writing it produced two parser bugs in a row that each made the answer zero,
    both caught by its own blind-spot assertion — the strongest evidence this
    audit has that the vacuous-guard class is easy to fall into.
  - Deep dive on the text-messaging surface (C1-S7-03, C1-S7-04). Two findings in
    the Contact Center, both sibling inconsistencies where one route of three has
    it right: the concierge fed a stranger's SMS/email/voicemail text to a model
    unfenced while lib/guardian/scam-ai.ts fences the same class and says so; and
    two escalations re-fired on a Twilio retry, telling the family the same
    emergency twice, while the email route already gated on filed.inserted.
    Also measured and left OPEN: 3 of 34 model-backed API routes carry no rate
    limit (the record claimed 31 of 31), and a signature authenticates the
    transport, not the sender.
  - C1-S7-02: re-measured the server-action auth reachability an earlier pass
    recorded but never ratcheted (439 actions / 9 unguarded) — reproduced the 9
    with an independent instrument. Three were pure helpers exported from
    'use server' modules, i.e. unauthenticated POST endpoints: a string
    formatter, a row BUILDER (the caller inserts, after auth), and a regex
    classifier with no callers at all. None reads or writes, so none is a
    disclosure; all three are gone (un-exported / moved to lib/ / deleted) and
    tests/every-server-action-reaches-auth.test.ts now ratchets the rule with six
    named public-by-design exceptions. My first analyser saw only `export
    function`, missed a private assertSuperAdmin(), and reported 100 instead of
    9 — the instrument failed the same way the code did, and both directions are
    now pinned by assertions.
NEXT: C2-M03 is the largest open finding — ~251 en-US-pinned date/time call
  sites across ~135 files against an 11-locale catalogue. The trap is recorded
  in Pass P: dayKey() uses 'en-US' as a PARSE locale and must not be switched.
  Then reconcile the two Executive Summaries into one authoritative index. Then reconcile
  the two Executive Summaries into one authoritative index — the document names
  this as a deliberate follow-up and it is the coordinator's job.
FILES-TOUCHED (session 3):
  - audit/status.md (this section only), audit/claude-1.md, finalaudit.md
  - session 6 additions: supabase/migrations/0318-0324,
    docs/audit/{household-binder-boundary,deactivated-member-sees-nothing,
    marketplace-ownership-update,no-truncate-for-public-roles}-check.sql,
    docs/PENDING_PROD_MIGRATIONS.md, tests/migration-version-safety.test.ts
  - source: lib/server/push.ts (M1), the calendar-feed route (M2),
    scripts/i18n-scan.mjs, app/globals.css, tailwind.config.ts,
    components/ui/input.tsx, design/tokens.json, and the 7 .tsx files carrying
    the now-redundant `focus-visible:focus-ring` prefix (C2-B01/C2-B04).
  - tests: push-failure-is-not-delivery, focus-and-boundary-contract,
    ai-prompt-injection (timeout budget only — no assertion changed).
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
LAST-UPDATE: 2026-09-16

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

# ── Same three workers, as the parallel session recorded them ──────────
# Kept beside the blocks above rather than replacing them: both sessions ran
# Claude-2/3/4 and both records are true of their own run. Rule 2.

## Claude-2 (parallel session)
CURRENT: COMPLETE for this round. Scope: Frontend · UI/UX · Responsive · Accessibility.
COMPLETED: audit/claude-2.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-2.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-3 (parallel session)
CURRENT: COMPLETE for this round. Scope: Backend · API · Database · Auth · Security.
COMPLETED: audit/claude-3.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-3.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-4 (parallel session)
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



# Round 5 — coordinator mirror (written by Claude-1)

Per rule 1, neither worker's own STATUS block above was rewritten. Both workers
appended their round-5 status inside their own files instead (Claude-3's sits at
`audit/claude-3.md:2062`, inside its Session 5 section rather than at the top —
flagged by the worker rather than silently reordered). This block mirrors those
into the shared board so the round is legible here too.

## Claude-3 — Session 5 (integration boundary)
COMPLETE. 9 findings, `C3-S5-01`…`C3-S5-09` (1 HIGH, 2 MEDIUM, 5 LOW, 1
OBSERVATION), plus 13 verified-clean boundaries and 3 refuted hypotheses —
two of them premises of its own dispatch brief.
HEADLINE: `C3-S5-01` — migration 0297 added four `can_manage_family` policies to
`social_account_tokens`, a table migration 0034 created policy-less with the
comment "never add a permissive policy here", on the stated premise that "every
policy was is_family_member" when there were none. A committed probe
(`docs/audit/sensitive-role-boundary-check.sql:126-131`) now asserts the opened
state as a requirement.
FILES-TOUCHED: `audit/claude-3.md` only (+769 lines). No source modified. One
transient probe file created, run and deleted in a single command; tree verified
clean.
BLOCKERS: no local Supabase — no webhook invoked, no forged-signature request
sent. `lib/server/push.ts` FCM/APNs branches, VAPID storage and `mobile/` not
covered.

## Claude-4 — Session 5 (do the passing tests mean anything?)
COMPLETE. 3 findings, `C4-S5-01`…`C4-S5-03` (2 HIGH, 1 INFO). Parsed 1,205 test
files / 9,275 `it()` blocks with the repo's TypeScript compiler API, examined 673
assertions, mutation-tested 97, PROVED 54 vacuous across 45 files.
HEADLINE: `C4-S5-01` — `toContain('helperName')` without a trailing `(` is
satisfied by the import line; 46 of 51 neutered files stayed green, including an
authz gate and a money audit-log call. `C4-S5-02` — the `indexOf` → `-1`
sentinel, 8 proven.
COUNTERWEIGHT (`C4-S5-03`): every other vacuity class came back ZERO under
active attack, and 11/11 repo-scanning guards caught a planted offender.
FILES-TOUCHED: `audit/claude-4.md` only. No source modified.

## Coordinator
Both HIGH mechanisms re-proved independently by Claude-1 before merging (an
authz call site neutered → 14/14 still green; `markReferralConverted` deleted →
11/11 still green; both sources restored and re-verified). Merged as **Pass Q**
in `finalaudit.md`. Full local suite on this branch: **1,207 files / 13,750
tests, 0 failures**.
LAST-UPDATE: 2026-09-15

## Round 5 — closed (Claude-1)
All twelve round-5 findings FIXED: C4-S5-01/02 (plus C4-S5-03 recorded) and
C3-S5-01..09. Eleven code changes, two migrations (`0318` social token store,
`0319` TRUNCATE revoke), nine new guard files, every guard proved red before it
was trusted. Two items left as product/operator decisions and named as such in
finalaudit.md: retiring the duplicate Google Calendar integration, and removing
the inbound-email `?key=` form.
CI: green on `7ccd0551`, full matrix including E2E and the migration replay.
LAST-UPDATE: 2026-09-15

## Claude-1 — Session 8 (bucket C: the un-named modules' client code)
IN PROGRESS. Started on the modules the completion assessment named as the
remaining yield — locator first, for carrying the most sensitive data with no
targeted pass.
FOUND: `C1-S8-01` [MEDIUM][I18N/CORRECTNESS] — four branches compare against
  rendered English copy (`day.label === 'Today'`, `due === 'Today'`,
  `label !== 'Today'`, `first.timeLabel !== 'All day'`). All correct in en-US;
  all silently wrong the moment C2-M03 — the largest open finding, and the very
  next scheduled work — translates those labels. The mobile one is the sharp
  end: every item due later TODAY would start reading "Overdue".
  The reason it needed a guard rather than four edits: the tests that pin these
  labels (`location-overview.test.ts:42`, `mobile-core.test.ts:141-146`) sit on
  the PRODUCER side of the seam. Translating goes red there, someone updates the
  expected strings, and the four consumers stay green while changing behaviour —
  C4-S5-01's class, made worse by pointing attention at the wrong file.
  FIXED all four against structure already present in the code (`isToday`,
  `dueToday`, day-key comparison, `first.allDay`). No en-US string changed and
  both producer-side tests still pass UNMODIFIED, which is the proof the fix was
  structural. New guard `tests/a-display-label-is-not-a-branch.test.ts` proved
  red four times, each revert named by file and line; it also asserts its own
  scope (>1,500 files) and that the structured forms do NOT fire.
REFUTED (recorded so it is not re-searched):
  - "Seven modules are unwired from i18n" — my instrument counted `t(` only.
    Those files bind the translator as `tr`. Re-measured against the identifier
    actually bound to `useTranslations()`: all 118 modules call their translator.
    Caught before it reached a finding; the alarming number was mine, not the
    code's — the third census error of this kind, all the same shape.
  - The 17 `lib/` modules returning literal 'Today'/'just now'/'3h ago' are
    C2-M03's work, not a separate finding. Filing them apart would split one fix
    across two IDs. What this pass adds is a guard waiting at the consumer end.
SUITE: 1,247 files / 14,055 tests, 0 failures. `tsc --noEmit` clean.
FILES-TOUCHED: lib/location/overview.ts, components/modules/locator-module.tsx,
  app/(app)/home/page.tsx, mobile/src/lib/format.ts, lib/onboarding/first-brief.ts,
  tests/a-display-label-is-not-a-branch.test.ts, finalaudit.md, audit/status.md
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass V (locator: live location)
FOUND: `C1-S8-02` [HIGH][SECURITY/RLS] — `location_events` and
  `member_locations` still carried 00420's `FOR ALL … is_family_member`.
  0215 hardened `family_places` AGAINST EXACTLY THIS THREAT (its header names
  "a direct PostgREST call by a signed-in child") but protected the geofences —
  the INPUT — and never mentions `location_events`, the OUTPUT. It also called
  `member_locations` "self-location", which `is_family_member` never made it.
  Measured as a signed-in child on a replayed schema (338 migrations, 0 failed):
  erased their own 02:00 "left home" event; moved a SIBLING's live pin;
  switched a SIBLING's sharing off; re-pointed their own row at another member;
  filed an event in a sibling's name. 00420's "location sharing is strictly
  opt-in" was not true until 0325.
  FIXED by `0325_where_a_child_went_is_not_theirs_to_rewrite.sql`, reusing
  `is_self_member()` that 0272 added for the same shape on `event_rsvps`.
  No UPDATE/DELETE granted on location_events (nothing uses one; `call_logs` is
  this document's record of what an unwired policy is worth).
  Probe `docs/audit/location-trail-boundary-check.sql` proved in THREE states:
  RED before 0325 (six attacks), GREEN after, RED again with the old FOR ALL
  re-added alongside the new policies — which demonstrates the OR'd-permissive
  claim rather than asserting it. It also asserts four paths that must keep
  working, incl. deletePlace()'s ON DELETE SET NULL against a table that now has
  NO update policy, and the family-delete cascade.
  NOT YET APPLIED TO PRODUCTION — operator credentials; recorded in
  docs/PENDING_PROD_MIGRATIONS.md with 0318-0324.
OBSERVATION (not fixed, product decision): switching location sharing off nulls
  the live coordinates and the UI says "Not sharing" — while the History rail on
  the SAME PANEL reads location_events unfiltered by is_sharing and renders that
  member's arrivals, times and raw coordinates by name. Both readings are
  defensible; the current state asserts both at once. 0325 deliberately does not
  decide it, only ensures the record can't be rewritten by its subject first.
PROBES: 46/46. nextVersion ratcheted to 0326.
NEXT (goal order): medical-records / medications / immunizations / health-visits,
  then trust-sharing-section + trust-activity-tab, paperwork-module, voice-module.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass V (cont.): the health hub
FOUND: `C1-S8-03` [HIGH][SECURITY/RLS] — `immunizations` and `health_visits`
  still carried 0068/0069's `FOR ALL … is_family_member`. 0309 gated the
  medication tables, NAMED this exact class in its header, and listed the
  neighbours it had checked (medical_profiles, health_providers,
  insurance_policies) — these two are not on that list. They render on
  /dashboard/medical directly under MedicalRecordsModule: one page, three
  panels, two boundaries. Sharpest version: `medical_profiles.immunizations`
  (free text) is manager-only while the STRUCTURED ledger 0069 wrote to replace
  it was not.
  Measured as a signed-in child on a replayed schema (339 migrations, 0 failed):
  rewrote a SIBLING's mental-health visit `outcome` (0068: "diagnosis / what
  happened / notes"), deleted that visit, back-dated a sibling's MMR and cleared
  next_due_date, deleted the vaccination record.
  Neither module carried ANY role check — unlike medications-module's
  `canEdit = isManager(role)` — so this was not even a hidden button, and there
  is no server action in the path: these modules write PostgREST with the
  viewer's own JWT, so RLS was the whole authorization model.
  FIXED both halves: `0326_a_health_record_is_written_by_a_parent.sql`
  (restrictive guards, 0254's mechanism, 0309's shape) AND the two modules' role
  gates. Reading and `medication_doses` deliberately left open and asserted as
  positive controls; the probe also re-asserts 0309's boundary so a regression
  there can't read as this migration working.
  GUARD `tests/a-manager-gated-table-is-manager-gated-on-screen.test.ts` asserts
  the PAIRING, not either half: it derives the manager-gated tables from the
  migrations (7 today) and requires every 'use client' browser-writer of one to
  declare isManager. Proved red 3x, incl. a brand-new ungated writer.
  ITS OWN BLIND SPOT, recorded: the first draft used `git ls-files` and reported
  the two tables as ungated because 0326 was written but not yet staged. Now
  walks from disk. A scanner whose input depends on the index answers a
  different question from the one asked of it.
SUITE: 1,248 files / 14,058 tests, 0 failures. PROBES: 47/47.
  nextVersion ratcheted to 0327.
NEXT (goal order): trust-sharing-section + trust-activity-tab (the permission
  surface itself), then paperwork-module, then voice-module.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass W (the permission surface)
FIRST, THE COUNTERWEIGHT: most of this surface holds, measured not assumed. All
  four trust tables are manager-gated AT THE DATABASE (not just in the action);
  `approval_requests` has one of the most carefully pinned INSERT policies in
  the repo (11 columns forced to initial values + the filer proved to be the
  acting member); `trust_audit_logs` is select-only, as 0260 intended; the
  actions validate every domain/capability/effect/subject, derive the approval
  threshold from the MODEL, and resolve sharing presets server-side so
  "Babysitter tonight" can't arrive carrying `finances` for a year.
FOUND: `C1-S8-04` [MEDIUM][AUDIT] — of the 15 decision values
  `trust_audit_logs_decision_check` has named since the table shipped, 10 are
  written somewhere and 5 are written NOWHERE: policy_changed, grant_changed,
  delegation_changed, role_changed, emergency_ended. The split is not random —
  everything written is a decision taken UNDER the rules; everything missing is
  a change TO the rules. The ledger `trust/page.tsx` renders and
  `privacy-center.tsx` calls "Who accessed what" had no row for creating a
  policy, granting a capability, delegating authority, or ending an emergency
  elevation that outranks every deny. Same shape as this document's `call_logs`
  observation, one level up: named in the schema, never wired.
  SIXTH DEFECT, same file: `activateEmergencyAction` was the ONLY one of the six
  trust_audit_logs writers that discarded its error — and `serverWriter` falls
  back to the CALLER'S client when service creds are missing, where 0260's
  removal of member INSERT means the write is refused. So in that configuration
  a ledger that had stopped recording looked exactly like a family that had
  never declared an emergency.
  FIXED: `recordTrustChange()` in lib/trust/ledger.ts + 7 call sites; the
  emergency write now captures and logs. Never fails its caller (approvals'
  stated reasoning); the privacy export keeps the OPPOSITE rule (refuses the
  download without a receipt) and is untouched.
  LEFT UNWRITTEN, DELIBERATELY: `role_changed`. family-module.tsx:532 changes a
  member's role by direct browser write with NO server action, and the ledger is
  service-role-only — so there is nowhere to write it from. Recording it needs a
  server action for member editing: past an audit fix, named for a decision. The
  guard asserts the browser-write shape still exists so whoever adds that path
  is told role_changed is waiting.
  GUARD `tests/a-permission-change-is-recorded.test.ts` drives all 7 actions
  against the in-memory Supabase and reads the ledger back — asserting
  family_id/actor_id/domain/capability/reason/context, not just "something was
  written" — and that a REFUSED action writes nothing (a ledger logging attempts
  as changes would read as though the child succeeded). Proved red 8x: each of
  the 7 call sites removed in turn, plus restoring the error-discard.
SUITE: 1,249 files / 14,068 tests, 0 failures.
NEXT (goal order): paperwork-module, then voice-module.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass X (paperwork)
FOUND: `C1-S8-05` [MEDIUM][CORRECTNESS] — `materializePaperworkActionAction`
  promises in its OWN doc comment that "tapping twice never double-creates", and
  kept that with a read-modify-write over the whole `actions` array: read at the
  top, create the record (the slow part), write the WHOLE array back. Two
  overlapping taps each erase the other's stamp; the record exists, the item
  doesn't say so, the next tap creates a second one.
  NOT a rare interleaving — paperwork-module.tsx renders one button per action
  and disables only the busy one (`disabled={pending && busy}` against a single
  `busyKey`), so a permission slip needing both an RSVP and a signature is two
  taps, and starting the second RE-ENABLES the first button mid-flight.
  REPRODUCED in both layers before fixing: the JS test lost a stamp and created
  a second calendar event; the SQL probe shows "old semantics: 1 of 2 stamps
  survived the overlap".
  FIXED: `0327` adds `paperwork_stamp_action()` — one element via jsonb_set,
  refuses an already-stamped element (check and write in ONE statement), returns
  false when it didn't win. `status` recomputed FROM THE ROW, not the caller's
  copy — the same mistake one level down, easy to reintroduce inside the fix.
  SECURITY INVOKER; the probe proves RLS is unchanged from both ends.
  NOT CLOSED, named: two taps on the SAME action inside the create window.
  Closing it means claiming before creating, which trades a rare double-create
  for a claim that can get stuck. A product decision, recorded not silently made.
  Probe refuses to pass if the OLD semantics stop reproducing the defect, so it
  can't become a tautology.
REPLAY: 340 migrations, 0 failed. PROBES: 48/48.
SUITE: 1,250 files / 14,072 tests, 0 failures. nextVersion ratcheted to 0328.
NEXT (goal order): voice-module — the last item.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass Y (voice) — GOAL LIST COMPLETE
FOUND: `C1-S8-06` [MEDIUM][RELIABILITY] — voice-module.tsx's catch block wrote
  the "failed" history row BEFORE calling toastError. supabase-js REJECTS when
  the underlying fetch fails, so with the network down — the ordinary reason a
  voice command fails at all — the rejection escaped the catch and the user was
  told NOTHING. `finally` still cleared the spinner. The comment above the line
  says it is there to make the history honest; it made the interface dishonest.
  Success path had the milder version: error discarded deliberately (correct)
  and not even logged, so a history that stopped recording looked like a family
  that stopped speaking.
  FIXED: `lib/voice/history.ts` → `recordVoiceCommand`, contract = CANNOT
  REJECT, so nothing after it can be lost; logs a dropped row. Module also calls
  toastError FIRST, so the ordering doesn't lean on the contract alone.
  RULE: the report to the user must not sit downstream of a call that fails for
  the same reason the user is being told about.
  GUARD proved red 4x (drop the catch / discard the error / restore the old
  ordering / bare insert again).
OBSERVATION, ACTED ON: `voice_commands.transcript` is verbatim dictated speech
  and was NOT on policy.ts's deny-list — while `household_info` is denied for
  "alarm codes, wifi keys" and the voice module's own examples include "Note
  that the garage code is 1234". Nothing reads the table today, which is exactly
  when to name it (the file's header: an omission should be "a deliberate,
  reviewed change instead of an accident"). Added; the existing static ratchet
  covers it.
SUITE: 1,251 files / 14,079 tests, 0 failures.
SESSION 8 TOTAL: 6 findings (2 HIGH, 4 MEDIUM) across the five named modules,
  3 new migrations (0325/0326/0327 — NOT applied to prod, operator creds),
  6 new guards, every one proved red before it was trusted.
LEFT FOR A DECISION, not inherited: whether "sharing off" should hide location
  HISTORY; whether to close the same-action paperwork race by claiming before
  creating (stuck-claim trade); `role_changed` until member editing has a server
  action.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass Z (measuring the pattern, not guessing the module)
METHOD: two of this session's findings came from one structure — a sensitive
  table written straight from the browser, RLS the whole authorization model. So
  I measured it instead of picking a sixth module by intuition. Cross-referenced
  policy.ts's 67 sensitive tables against all 439 'use client' components:
  30 are browser-written; 16 of those have NO role check and NO self check on
  writes. Sorted into three groups in finalaudit.md; only one group is
  unambiguously wrong, and the self-logging group is family-wide BY DESIGN
  (0309's stated reason for leaving medication_doses open).
FOUND: `C1-S8-07` [HIGH][SECURITY/RLS] — `journal_entries` has
  `is_private boolean NOT NULL DEFAULT true` and ONE `FOR ALL is_family_member`
  policy, and `is_private` appears NOWHERE in app/, components/ or lib/. Four
  statements of intent (product name, module header, `.eq('member_id')` fetcher,
  the column) and none of them a boundary. Measured as a child: read, rewrote,
  deleted a sibling's entry, and wrote one in the sibling's name.
  Same finding covers `family_insurance_policies` (policy numbers, premiums,
  agent phones) — `FOR ALL is_family_member` while its twin `insurance_policies`
  has been manager-gated all along. THIRD instance of that twin-table pattern
  (0309, 0326, now this).
  FIXED by `0328` + insurance-module's role gate. SELECT on the journal is self
  OR is_private=false, so the column is finally load-bearing and "share this
  entry" needs no migration. A PARENT IS DELIBERATELY NOT GIVEN A WINDOW into a
  child's journal — no surface ever offered it; the probe asserts the refusal so
  changing it must be deliberate.
FOUND: `C1-S8-08` [LOW][UX] — 42 tables are manager-only for writes; 9 browser
  writers of them carry no role check (passwords vault, household binder,
  document library, bills, financial accounts, family members, invites). NOT a
  security hole — the DB holds and describeDbError turns 42501 into a polite
  refusal — but a control that can never succeed. /dashboard/passwords gates on
  AAL2, NOT role, so a child with 2FA sees an empty vault and a dead Add button.
  Not fixed (9 modules outside this pass, each with its own copy to decide);
  RATCHETED instead — the guard carries them as a named exception list that may
  shrink and never grow, and a fifth test fails when an entry goes STALE, so a
  fix must remove its own exception.
  GUARD rewritten to cover all 42 manager-only tables (was 7). Proved red 4x
  incl. the stale-exception direction.
TWO INSTRUMENT ERRORS, caught before they became findings:
  - the writer census flagged family-module.tsx as ungated; it uses
    `MANAGER_ROLES.includes(role)` not `isManager()`. THIRD census this audit to
    cry wolf by looking for one spelling. Guard now accepts both idioms.
  - the manager-only table query gave 31 or 7 depending on which branch was
    written — a RESTRICTIVE guard ANDs over the permissive policies, so
    `medications` is manager-only while its permissive policies still read
    is_family_member. Both branches needed; union is 42. Derivation SQL is
    written into the test beside the pin.
REPLAY: 341 migrations, 0 failed. PROBES: 49/49.
SUITE: 1,251 files / 14,081 tests, 0 failures. nextVersion ratcheted to 0329.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass AA (the census's first group)
FOUND: `C1-S8-09` [HIGH][SECURITY/RLS] — `behavior_logs` and `care_log`. Both
  separate SUBJECT from AUTHOR in their own column comments; neither policy knew
  about either. They needed DIFFERENT fixes and the reason is in each header.
  `behavior_logs`: `member_id … -- the child` + `logged_by`, header says
  "per-child behavior observations … Powers parenting insights", carries
  `concern` notes and a signed `points` column, policy was FOR ALL
  is_family_member, module had NO role check. Measured as a child: erased a
  concern logged about them; awarded themselves 99 points (the `points` column
  is an invitation to exactly that). → manager-gated writes, 0254's restrictive
  mechanism, 0309's shape.
  `care_log`: NOT the manager class — 0032 says the log exists "so the whole
  family can see who last checked in", so family-wide reads AND inserts are the
  stated intent; gating it that way would have broken the feature. The defect is
  one member REWRITING another's entry. → 0322/0323's treatment (the marketplace
  review shape): insert stays open, update/delete belong to the author or a
  manager, and `member_id`/`logged_by` are immutable via the shared
  columns_are_immutable() trigger — so NOT EVEN A PARENT may rewrite who
  recorded what (measured: one could). Trigger not a `with check` mirror:
  0321's lesson, since the predicate reads the column an attacker would change.
  UI halves shipped: behavior canEdit=isManager; care mayEdit = author || manager
  (the card already rendered "by <name>", so the controls now agree with it).
LEFT ALONE, DELIBERATELY: reads stay family-wide on both. Whether a child should
  SEE the concerns logged about them is a real question about a real family; the
  probe asserts both stay readable so changing it has to be deliberate.
GUARD: probe holds 5 refusals + 5 things that must still work. The manager-gated
  -on-screen test picked behavior_logs up via its pin; proved red both ways
  (module role check removed; table dropped from the pin while its migration
  guard exists — the pin's self-check).
CENSUS SCORE: 4 of the 16 now closed (journal_entries + family_insurance_policies
  in 0328; behavior_logs + care_log in 0329). 12 remain, tabulated in
  finalaudit.md with why each is still open. NOTE: location_events /
  member_locations / immunizations / health_visits were never among the 16 —
  0325/0326 had already closed them when the census ran.
REPLAY: 342 migrations, 0 failed. PROBES: 50/50.
SUITE: 1,251 files / 14,081 tests, 0 failures. nextVersion ratcheted to 0330.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass AB (a clean sweep, then the cheap fix nobody took)
REFUTED (recorded so it is not re-searched): the boundary-column sweep. Both of
  this session's HIGH findings were "a column declares a boundary, no policy
  references it", so I checked EVERY such column against its table's policies.
  is_private → now referenced (0328). is_sensitive → referenced. is_sharing →
  already recorded as C1-S8-02's product decision. `secret` on family_credentials
  → false positive of my name pattern (it's the stored password; SELECT is
  manager-only). sync_calendar_shares' shared_with_* → the table has NO consumers
  anywhere (designed-and-unwired, the call_logs pattern). is_shared / is_public →
  claims of WIDER visibility, the opposite failure, out of scope.
  stripe_settings.secret_key → RLS on, ZERO policies = deny by default; verified
  empirically as `authenticated`: 0 rows. The strongest lockdown in the schema.
  THE CLASS DOES NOT RECUR. No new finding.
FOUND: `C1-S8-10` [MEDIUM][SECURITY] — of four public buckets, three pin
  allowed_mime_types and `family-media` does not, and it's the one taking the
  widest range of uploads (6 browser paths, NO server-side path, so the client
  `accept` attribute — a picker hint, not a boundary — was the only control; two
  of the six set none at all). Public delivery means an svg or html upload is a
  page on the project's own Supabase domain with no session.
  NOT F-E03 AGAIN: that one is deferred as LB-009 because signed URLs need a
  data migration of every stored URL. An allowlist needs NONE. The expensive fix
  had been covering a cheap one nobody took. (Pass Q looked at this bucket and
  correctly declined to re-file the public-READ finding — content type was
  simply not the question being asked.)
  FIXED by 0330. The list is READ OFF the six modules' own `accept` attributes
  rather than invented, so nothing the product offers is refused; HEIC/HEIF
  added because `image/*` is what the picker says and an iPhone photo is HEIC.
  svg/html/xhtml excluded — nothing offers them and a browser executes them.
  Does NOT make the bucket private and does NOT touch stored objects. UPDATEs
  rather than inserts, because 0216's `on conflict do nothing` means prod
  already has the row.
  TWO GUARDS, BOTH DIRECTIONS: the JS test fails if a picker gains a type the
  bucket refuses AND if an executable type reaches the allowlist (proved red 4x).
  The SQL probe asserts the GENERAL rule on the replayed schema so the next
  public bucket is covered the day it's added (proved red 2x); it refuses to run
  with fewer than 4 public buckets and leaves private buckets alone explicitly.
  GUARD'S OWN ERROR, recorded: two mutations first failed on the parse test's
  count floor instead of the coverage assertion — a tight scope check in a test
  about PARSING masking the test about COVERAGE. Floor lowered well below the
  real count.
NOTE: this pass deliberately did NOT push while CI was mid-run on eee60276 —
  a push would have cancelled it (cancel-in-progress). That run came back fully
  green on all four jobs before this work was pushed.
REPLAY: 343 migrations, 0 failed. PROBES: 51/51.
SUITE: 1,252 files / 14,086 tests, 0 failures. nextVersion ratcheted to 0331.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass AC (the websocket surface)
VERIFIED HEALTHY (`C1-S8-11`): 61 tables are in the `supabase_realtime`
  publication, including most of what this session has been about —
  location_events, member_locations, call_logs, family_messages,
  trust_audit_logs, permission_grants, trust_policies, trust_delegations,
  emergency_sessions. published-tables.ts is careful about DRIFT (and has a test
  for it); nobody had asked what an UNAUTHENTICATED subscriber receives.
  Realtime evaluates RLS per subscriber, so a channel opened without a user
  token is evaluated as `anon`. MEASURED: anon reads 0 rows from all 61.
  THE RESULT IS ONLY WORTH SOMETHING BECAUSE THE INSTRUMENT COULD HAVE FOUND
  SOMETHING — 29 of the 61 hold rows, several in the hundreds (call_logs 500,
  location_events 500, family_messages 500, calendar_events 1,907). That check
  runs FIRST and the probe refuses to pass on a half-seeded harness (<40
  published, <10 populated). C4-S5-01's lesson applied to my own sweep.
  PROVED RED: granting anon `using (true)` on location_events →
  "anon can read published table(s) ... location_events (500 rows)".
  KEPT AS A FLOOR, not filed as a finding: a future migration granting anon a
  read — or a policy `to public` whose predicate ignores auth.uid() — turns the
  websocket into a public feed, and nothing else here would notice. The
  publication is the amplifier: a readable table is a query someone must make;
  a readable AND published table is a push.
PROBES: 52/52.
DISCIPLINE NOTE: held the push again while CI ran on 97a50e49.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass AD (eight AI insights that had never worked)
FOUND: `C1-S8-12` [HIGH][CORRECTNESS] — 9 table names in app/api/ai/insights/
  route.ts name tables that DO NOT EXIST: care_logs, contacts, family_goals,
  sports_teams, announcements, medical_records, photos, photo_albums, recipes.
  Each query returns "relation does not exist" and each error is swallowed by
  `.data ?? []`, which does not throw — so the route's own try/catch (built to
  answer 500 on a failed load) never fires. The empty array reaches a prompt
  builder whose fallback is a SENTENCE ("No care entries logged."), so the model
  is told as FACT that the family has no data and writes a confident summary on
  that basis. Eight insight kinds had never worked and nothing said so.
  THE DEFENSIVE DEFAULT WAS THE THING THAT HID THE DEFECT. Same shape as
  C1-S8-06 (voice) and C1-S8-04 (ledger), arriving a third way.
  It was worse than a name every time — fixing only the table would have shipped
  rows that render as blanks: care_log has log_type/note not care_type/notes;
  goals has is_complete not status (so the route's own .neq('status',...) filter
  would have errored against the RIGHT table); teams has team_name and NO
  win/loss columns, so every team printed "W:0 L:0" — which reads as a record,
  not as no data; family_announcements has body not content; and BOTH halves of
  `medical` were wrong because appointments stores title/provider/starts_at.
  FIXED all 9 tables + 8 column groups. Verified against the replayed schema:
  all 29 table.column pairs the corrected code uses exist.
  GUARD holds BOTH ends of the seam — every table the route queries exists, AND
  every bundle key a prompt reads is one the route returns (a correct query
  under an unread key is just as silent). Schema index derived from migrations
  so it runs in the unit suite; cross-checked against the replayed DB — both
  give 491 tables. Proved red 3x incl. the orphan-key direction.
SUITE: 1,253 files / 14,089 tests, 0 failures.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 8, Pass AD (cont.): the same question, asked of the tree
WIDENED the C1-S8-12 census past the insights route, since that bug reached
  production through a HELPER and the `.from('x')` form was never the problem:
  - every `.from('x')` in app/ lib/ components/ (500+ sites): 0 bad.
  - table-name helpers (eq, saveRow, softDelete — 102 sites): 0 bad after the fix.
  Both are now RATCHETED by the same test, so the clean state is held rather
  than assumed. Proved red on a typo'd .from() in a component, a typo'd
  saveRow(), and a near-miss softDelete() (driver_licenses → driver_license).
FOURTH FALSE POSITIVE, recorded because it keeps happening: the first helper
  sweep assumed any `helper(db,'x',…)` passes a table name and reported ELEVEN
  misses. All phantoms — writeSyncState takes a provider, claimGuardianCallback
  takes a callback type, childrenBlockedOn takes a notification channel. The
  helper list in the test is CURATED, not inferred, with that reason beside it.
  The recurring error: assuming a string in an argument position means what I
  expect. Caught each time by checking hits against the source before filing.
ALSO: the first saveRow mutation came back GREEN and the tempting conclusion was
  "the helper scan doesn't work". It did — the mutation had replaced a
  'vehicles' occurrence that wasn't the call site. A mutation that fails to kill
  is a claim about the MUTATION first, and only then about the guard.
SUITE: 1,253 files / 14,091 tests, 0 failures.
LAST-UPDATE: 2026-09-19

## Claude-1 — Coordinator: the index reconciliation (an owed deliverable)
DONE — this was named in status.md's NEXT as "the coordinator's job" and had
  been outstanding since round 5. finalaudit.md's Part 0 claimed "Nineteen
  passes, A–Q ... 151 distinct finding IDs" while the body held THIRTY pass
  headers and 157 IDs. A reader of the index was being told something the
  document itself contradicted.
FIXED: the pass table now runs A–AD (fourteen rows added, Q–AD), each citing
  the IDs I could verify from the body rather than from memory. Added a
  "Session 8 at a glance" table: the twelve findings with severities, the
  thirteen pending migrations, the four sweeps that came back empty, and the
  three items left for a product decision.
THE COUNT IS NOW REPRODUCIBLE, which was the point. The index states the exact
  grep that produces it, and states honestly that the command prints 158 while
  the real figure is 157 — the extra is `C1-S4`, matched out of the wildcard
  reference `C1-S4-*`. A count whose command doesn't reproduce it is the defect
  this document keeps finding elsewhere, so the discrepancy is named rather than
  hidden by tightening the pattern.
TWO INSTRUMENT ERRORS IN THE OLD COUNT, both fixed: `M1`/`M23`-style MILESTONE
  ids were being counted as findings, and `C2-B*`/`C2-M*` were MISSED entirely
  because Claude-2's IDs don't use the `-S<n>-` form the pattern assumed. So 151
  was simultaneously too high and too low.
NOT TOUCHED: the previous author's prose about method, the merge verification of
  the 151 figure (re-framed as describing the state it described, not deleted),
  and every existing pass row. Rule 2 — never delete another worker's findings.
LAST-UPDATE: 2026-09-19

## Claude-1 — CI: the readiness gate that could not fail
`finance-operation-sql` went RED on 28ae9b1a. My diff there touched ONE TEST
FILE, so it could not have caused it — and the root cause turned out to be this
audit's own thesis, in this audit's own CI.

The job starts a postgres:17 container, waits with `pg_isready --dbname=
bubaly_finance_operation_ci`, then runs psql against that database. The gate
passed and psql failed ONE SECOND LATER with `database "..." does not exist`.

WHY: `pg_isready` DOES NOT CONNECT. It asks the postmaster whether it is
accepting connections and nothing else, so --dbname is only used to build a
connection string. MEASURED locally rather than assumed:
  $ pg_isready --dbname=this_database_does_not_exist  -> "accepting connections", exit 0
  $ psql --dbname=this_database_does_not_exist -c 'select 1' -> exit 2
A readiness gate that could not fail for the thing it was named for.

FIXED: the gate now opens a REAL connection to the REAL database, and requires
THREE CONSECUTIVE successes — because the postgres image runs a temporary server
on the same socket during init to create POSTGRES_DB, then stops it and starts
the real one. A single success can land on that temporary server and be followed
by "the database system is shutting down"; any failure resets the count, so the
restart window cannot be straddled.
NOT A FLAKE RE-RUN: the race is real and would have recurred. Fixed at source.
LAST-UPDATE: 2026-09-19

## Claude-1 — Merge 5 with main (the parallel session's Pass J/K)
MAIN ADVANCED with 15 commits of Pass J/K — and they had been auditing THE SAME
SURFACE: "the client code paths behind the swept tables", "the trust-surface
writes and the medical asymmetry", "twenty-five writes that reported success for
a change RLS had refused". No new migrations on main, so no number collision.
ID UNION VERIFIED: 158 mine + 87 theirs = 169 union = 169 merged. None lost.
SEVEN CONFLICTED FILES. Every one turned out to be COMPLEMENTARY, not competing —
both sessions found the same class and fixed different halves:
  - trust/actions.ts: theirs adds `changedNothing(rows)` (a write RLS refused
    reported success); mine adds `recordTrustChange` (the ledger never recorded
    rule changes). ORDER MATTERS and the merge had to get it right: the guard
    goes FIRST, because logging a change the database refused would be worse
    than not logging it at all. 4 hunks, resolved guard-then-ledger.
  - documents/files-hub/home modules: mine READS the storage result and aborts
    (a surviving file goes invisible while the screen says deleted); theirs adds
    `.select('id')` so a refused row-delete is visible. Both kept.
  - voice-module: mine moved toastError FIRST and added a non-rejecting helper;
    theirs wrapped the write in `settle`. Kept my ordering (strictly stronger —
    two independent reasons the user is told) and adopted THEIR house idiom
    inside my helper, per the charter's "prefer existing abstractions".
  - finalaudit.md / audit/claude-1.md: both sides appended; both kept in full.
THREE BEHAVIOURAL CONFLICTS GIT COULD NOT SEE, all caught by the full suite:
  1. A stranded `}));` from main's hunk left voice-module unparseable — tsc
     caught it, not the tests.
  2. Adopting `settle()` SILENTLY WEAKENED my own contract: settle converts a
     REJECTION to { error }, but a builder that throws SYNCHRONOUSLY throws
     before settle is called. My own test ("resolves when the insert throws
     synchronously") went red and caught it. Restored with an async thunk.
     THE LESSON: adopting a shared abstraction is a behaviour change, not a
     refactor, and the contract has to be re-checked against it.
  3. Main's SSRF test exempts `lib/server/external-fetch.ts`, which THIS BRANCH
     renamed to `fetch-with-deadline.ts` (C3-S5-04 — it sat among real SSRF
     guards under a name that read like one and only adds a deadline). Two of
     main's tests then contradicted each other. Before re-pointing the exemption
     I re-verified it is still DESERVED: every caller passes a literal provider
     host, and the one computed caller (app/api/gif/search) builds a constant
     Giphy URL with an encoded query. Guard was right, filename was stale.
GATE AFTER MERGE: tsc clean; suite 1,258 files / 14,119 tests / 0 failures;
replay 343 migrations / 0 failed; probes 52/52.
LAST-UPDATE: 2026-09-19

## Claude-1 — Pass AE: four parallel workers (the brief asks for them)
Dispatched 4 on disjoint scopes (un-named server actions / API routes / feature
modules / scheduled jobs). ALL FOUR hit the session rate limit mid-flight, three
mid-edit. NOTHING was kept on trust: re-typechecked, full suite, and each new
test mutation-checked before commit.
FOUND (verified independently, not accepted from the reports):
  `C1-S8-13` [HIGH][SAFETY] pantry-chef's allergy read used `?? []`, so a failed
    read TURNED THE SAFETY FILTER OFF and reported success. Confirmed by reading
    both consumers: the prompt then says "No known family allergies were
    provided", annotateAllergens returns early flagging nothing, and
    allergiesConsidered: 0 is what a family with none on file sees. Peanut
    recipes, unflagged, to a household with a peanut-allergic child. Now 503.
  `C1-S8-14` [HIGH][RELIABILITY] a failed push_devices read returned an all-zero
    PushResult — the ONE shape dispatchPendingPushes reads as success, since
    nothingGotThrough requires failed > 0. pushed_at was stamped, and nothing
    clears it. One blip marked a batch delivered without sending it.
  `C1-S8-15` [MEDIUM] closeMealVote's two deciding reads used `?? []` — a blip
    closed the vote with winner_option_id: null, stamped final, reported success.
  `C1-S8-16` [MEDIUM] three cron jobs: two answered a hardcoded 200 over a failed
    sweep (cron-dispatch.mjs reads res.ok); return-reminders used .limit(200)
    with NO ORDER BY on a code-side filter, so an order due today could fall
    outside the arbitrary slice every run. Now paged with readAll.
TWO THINGS SETTLED RATHER THAN ACCEPTED:
  - a worker died between changing deleteProvider's signature and its call site;
    tsc caught it, the suite would not have.
  - tests/dashboard-modules-keep-prior-read.test.ts went RED on an IMPROVEMENT,
    because it pinned the literal `if (error) return [];` instead of the
    behaviour. A test that fails when the code gets better is testing the wrong
    thing. Rewrote it to assert the bail precedes the clobber; re-proved red both
    ways (bail removed; bail moved after the clobber).
SUITE: 1,261 files / 14,127 tests, 0 failures. tsc clean.
LAST-UPDATE: 2026-09-19

## Claude-1 — Session 9 (merge #6, and what taking a file wholesale costs)
COMPLETE. 10 findings, `C1-S9-01`…`C1-S9-10` (1 HIGH-security, 1 HIGH-auth,
2 MEDIUM-testing, 1 MEDIUM-delivery, 3 LOW, 1 BLOCKED). Merged `origin/main`
(13 conflicts) and recorded both registers in finalaudit.md without trimming
either: 891 IDs here, 684 there, 1,572 in union, verified mechanically.
HEADLINE: `C1-S9-01` — resolving `lib/server/push.ts` with `git checkout
--theirs` after verifying that ONE of my fixes to it had survived deleted the
per-send SSRF re-check (`C3-S5-03`). The helper stayed exported and uncalled,
so the tree still looked right. Its own guard caught it. `C1-S9-02` (an
unbounded push retry that re-buzzes healthy devices for ever) was found by the
symbol-and-log diff added in response.
COUNTERWEIGHT: `C1-S9-03`/`C1-S9-04` — this branch's two vacuity guards
(`C4-S5-01`, `C4-S5-02`) caught 14 live instances in the parallel session's
tests. None went red on conversion, so they closed latent vacuity rather than
uncovering missing statements. `C1-S9-07` names a vacuity class neither guard
covered — a slice between two `at()` bounds can be silently EMPTY — now closed
with a `between()` helper and a rule forbidding the old pattern.
FILES-TOUCHED: `lib/server/push.ts`, `lib/ai/safety/untrusted.ts`,
`lib/contact-center/concierge.ts`, `components/modules/voice-module.tsx`,
`components/auth/kid-login-form.tsx`, `lib/server/native-push.ts` (import
rename only), `lib/social/x-oauth.ts` (import rename only), `tests/helpers/
source-order.ts`, and 14 test files. Per rule 9, nothing under another worker's
FILES-TOUCHED was modified.
GATE: `tsc` clean. 16,910/16,913 tests pass across 1,343 files. Lint 0 errors,
3 pre-existing warnings. The 3 failures are `C1-S9-09`: BLOCKED on this
container running Node 22.22.2 against the repository's `.nvmrc` 24.21.0.
BLOCKERS: B1-B5 unchanged; B6 added (the public `family-media` bucket, where
this register's `F-E03` and the parallel session's `SEC-001` are one finding
reached from two directions); B7 added (the Node runtime above).
SWEEP: the symbol-and-log diff has now been run against all five files this
merge took with `--theirs`, and comes back clean — every apparent loss is a
rename or a subsumption, each named individually in Pass AF. It is the
instrument that found `C1-S9-02`, so it is not a sweep that cannot fail.
REFUTED: `C2-13` is written up as `C1-S9-11`. The cleanup increments a
monotonic invalidation counter rather than reading a stale ref, and C2's
proposed remedy would reset that counter and let an in-flight save commit under
a family the component has already left. Per rule 1, `audit/claude-2.md` was
not edited. Guarded by tests/a-capture-generation-counter-only-goes-up.test.ts,
which rejects the proposed change.
CONTINUED (scheduled-jobs pass): took the coverage table's thinnest area at its
word and scanned all 27 cron routes for this audit's recurring classes. Every
route is authenticated and none answers 200 on a failure path. Three findings:
`C1-S9-12` (the admin digest capped its 24h feed at 500 rows and reported that
as the day's total, dropping the earliest hours — and it is a sync-error storm
that most likely trips it), `C1-S9-13` (a publish drain built to be cancelled
was never passed req.signal, found by asymmetry with its sibling route), and
`C1-S9-14` (the register held 24 scheduled items against 27 real ones — it was
complete over a stale inventory, the same defect as C1-S9-12 one level up).
CRON-025..027 added. Verified clean and recorded as such: wallet-allowance,
family-routines, weekly-digest, provider-sync.
OPEN: the register's other denominators (Pages, API, Feature modules, Server
actions) have NOT been re-derived from the tree and are likely stale the same
way; no coverage figure for them should be quoted until they are.
LAST-UPDATE: 2026-09-20
