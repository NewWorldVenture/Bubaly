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
CURRENT: COMPLETED session 5 (2026-09-14). Frontend/UI/UX/responsive/a11y. Seven new
  findings appended to audit/claude-2.md under the SESSION 5 delimiter (C2-18..C2-24),
  plus ten areas recorded as verified clean. No source file was modified.
COMPLETED:
  - HIGH  C2-18 The whole 13,458-key en-US catalogue ships as JS on EVERY page
    (818 KB raw / 244,556 B gzip). 62.4% of the marketing home page's first-load
    JS, 52.9% of /login, 48.6% of /dashboard. Root cause is one line:
    translate()'s `?? SOURCE_MESSAGES[key]` in lib/i18n/messages.ts:129 keeps
    en-US.json alive in the client chunk that carries LocaleProvider, which sits
    in the ROOT layout's chunk list. This defeats the lib/i18n/scopes.ts work,
    which cut the same catalogue out of the RSC payload only. Numbers are gzip of
    the union of .next/app-build-manifest.json chunk lists down each layout chain.
  - MED   C2-19 Fifteen create/edit forms await a Supabase write with no pending
    state and no re-entrance guard -> double-tap writes the row twice, and nothing
    acknowledges the first tap. 14 files across components/modules and
    components/vacations. Four of them already use `loading={busy}` on their AI
    button, so the pattern is known and just missing on the primary write.
  - MED   C2-20 The shared `Field` wrapper (1,066 call sites, 124 files) wires no
    aria-invalid and no aria-describedby; 61 hints and 13 error messages are
    visually adjacent but programmatically unlinked. Fixable in one file via
    cloneElement, no call-site churn.
  - MED   C2-21 Fifteen text inputs kill the focus outline with nothing in its
    place — verified against Tailwind focus-within ancestors, the one CSS
    focus-within rule (.ai-composer), tabIndex={-1} containers and scanner
    mis-attribution. Distinct from C2-15.
  - MED   C2-22 The i18n gate's 'app-shell' surface scans ONE file, not the
    components that file renders. quick-capture.tsx + command-bar.tsx carry ten
    English strings (the four capture tabs, their placeholders, "Undo") on all 354
    signed-in pages. Confirmed with the project's own scanner.
  - LOW   C2-23 Toasts auto-dismiss on a fixed timer with no pause on hover/focus
    (WCAG 2.2.1); the three Undo toasts are the only undo path for a capture and
    sit at the very end of the tab order.
  - LOW   C2-24 The global reduced-motion reset zeroes duration but omits
    animation-iteration-count, so 185 infinite spinners keep cycling. The 10 places
    that add motion-reduce:animate-none by hand are the tell.
  VERIFIED CLEAN (items 9-18 in audit/claude-2.md, do not re-derive):
    prefers-reduced-motion IS honoured globally; lucide-react/date-fns are already
    barrel-optimised by Next 15.5's DEFAULT optimizePackageImports list (adding the
    option changes nothing); dark/light tokens are complete AND `dark:` variants do
    fire (theme-script always adds a literal light|dark class); no fixed width or
    min-w anywhere causes horizontal scroll at 375px; the shared Modal is a correct
    mobile bottom sheet and DOES restore focus to the trigger; loading/error states
    are wired on 107/111 realtime surfaces; toast live-region roles are right;
    Button meets 44px on coarse pointers; RTL is a non-issue today and correctly
    prepared (all 11 locales are ltr, <html dir> is wired); signup-form is the model
    the other forms should copy.
NEXT: nothing in flight. If a later pass wants ground I did not reach: measured
  colour contrast, real tab order and screen-reader output all need a running
  browser, which this pass did not have.
FILES-TOUCHED:
  - audit/claude-2.md (append only, SESSION 5 block), audit/status.md (this section)
  - NO source file was read-modified. Audit-only, per the parallel-run protocol.
BLOCKERS:
  - No browser. C2-23 and C2-24 each say explicitly which half is code-derived
    rather than observed; nothing else depends on execution.
  - No `next build` was run on purpose — four workers share one .next. C2-18's
    numbers come from the existing build (2026-09-13 13:44), which was sufficient.
LAST-UPDATE: 2026-09-14

## Claude-3
CURRENT: DONE (session 3, 2026-09-14) — new-ground pass on backend / API / DB / auth / security.
  All findings appended under the "SESSION 3" delimiter in audit/claude-3.md. Audit-only:
  no source file, migration or test was modified.
HARNESS: private PG16 on PGHOST=/tmp/pg3 PGPORT=54403 PGUSER=postgres PGDATABASE=bubaly.
  315 migrations applied / 0 failed (installed postgresql-16-pgvector, so 0237 and its two
  dependants replay too — the earlier harness skipped them). SEED_ALL applied.
  docs/audit/run-probes.sh 23/23 PASS before probing. Every RLS finding was run as a real
  `authenticated` session, i.e. what PostgREST does for a browser holding the anon key.
COMPLETED (9 new findings — 1 CRITICAL, 4 HIGH, 3 MEDIUM, 1 LOW; none overlap PR #548/0296-0301):
  - CRITICAL economy_redemptions: the INSERT policy lets a CHILD write their own redemption
    row with any `cost`, `member_id` and `status`, and economy_decide_redemption() debits
    `v_redemption.cost` instead of the reward's cost. Proven: child redeemed a 5000-star
    reward for 1 star; also forged a `fulfilled` row with decided_by=parent, and billed a
    parent's balance. Sibling table reward_redemptions HAS a decision-guard trigger; this
    one does not.
  - HIGH subscriptions/families: `subs_manage` grants ALL to is_family_admin, and
    subscriptions.plan/status is exactly what resolveEntitlement()/resolveFamilyPlanLevel()
    sum into paidLevel. Proven: an expired-trial parent self-granted plus_annual/active,
    rewrote families.trial_ends_at, and cleared families.closed_at. No client code writes
    this table — the privilege is pure excess.
  - HIGH billing: billing_customers.customer_ref and subscriptions.provider_ref are
    client-writable and are passed straight to stripe.billingPortal.sessions.create() and
    stripe.subscriptions.update() with NO ownership check against Stripe. change-plan also
    rewrites metadata.family_id, which is the field the webhook trusts.
  - HIGH health: 9 tables (health_visits, immunizations, symptom_logs, health_metrics,
    health_goals, care_log, sleep_logs, sleep_checkins, nutrition_logs) are still one
    permissive `FOR ALL … is_family_member`. 0299 fixed medications/medication_schedules
    and stopped. Proven: a child rewrote a parent's cardiology visit, deleted a parent's
    symptom log, and erased their own immunization record.
  - HIGH locator: member_locations / location_events / safety_check_ins are `FOR ALL …
    is_family_member`, while locator/actions.ts:30 states "Strictly self-only". Proven: a
    child moved a parent's live location NY->LA, set is_sharing=false on them, and forged
    an "arrived" event under the parent's member_id.
  - MEDIUM medical_profiles: SELECT is is_family_member while the app gates it to managers
    in three places (pantry-chef/route.ts:129 says so in a comment). Child read a parent's
    blood type, conditions and prescriptions.
  - MEDIUM driving_trips: member-wide UPDATE/DELETE while driver_licenses — same feature,
    same migration — carries the self/manager clause. Teen rewrote own score 41 -> 100.
  - MEDIUM error leakage: describeDbError() returns the raw Postgres message when
    unclassified; 311 server call sites use it where describeActionError (whose docstring
    is exactly this boundary) belongs, plus 14 bare `err.message` returns.
  - LOW marketplace_orders_update: WITH CHECK weaker than USING (the 0297 shape).
VERIFIED HEALTHY (attacked, held): secrets in the client bundle — whole import-graph trace
  from all 452 'use client' roots, stopping at 'use server' RPC boundaries and excluding
  type-only edges: 868 reachable modules, ZERO non-NEXT_PUBLIC_ env reads (scratchpad/
  trace2.js; the naive version of this check reported 16 false positives); all 22
  storage.objects policies (family-id/uid path scoping, no traversal, documents bucket
  re-checks is_sensitive_document); child sign-in throttle + PIN derivation; active-family
  selection intersected with real memberships in all 4 resolvers; role change mid-session
  (all four helpers are STABLE SECURITY DEFINER, nothing cached in the JWT); RLS enabled on
  all 491 public tables; admin_* tables deny-all; referral crediting idempotency;
  family_id-from-request in all 141 routes (3 sites, all cross-checked); mass assignment
  (2 spreads, both super-admin + Zod).
NEXT (not reached): per-route input validation (unbounded numerics / unvalidated enums)
  beyond the sampling done here; the ~57 RLS-on/no-policy tables were confirmed deny-all
  but not individually reasoned about; signed-URL TTLs.
FILES-TOUCHED: audit/claude-3.md (append only), audit/status.md (this section only).
  NO source file, migration, test or config was modified.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14

## Claude-4
CURRENT: done (session 4) — new-ground pass complete. 5 findings appended to
  audit/claude-4.md under the "SESSION 4" delimiter, plus 8 candidates DISPROVED
  and recorded so they are not re-derived.
COMPLETED:
  - C-4-14 HIGH   the parent's Approve/Reject on a chore submission returns
                  `Promise<void>` with 7 bare `return;`s and revalidates only on
                  success — every failure is invisible. The child's half of the
                  same file returns {ok,error} and renders it; the parent's does not.
  - C-4-15 HIGH   there are TWO `createChoreAction`s. The dashboard one is
                  manager-gated and test-locked; the /missions one has no role
                  check, chores/chore_assignments RLS is `is_family_member` for
                  all four ops, and neither /missions nor /missions/new gates on
                  role. A child can author the chore catalogue and its rewards,
                  and delete a parent's chores. RLS half flagged to Claude-3/1.
  - C-4-16 HIGH   guardian_phone has no global uniqueness (the clash check is
                  family-scoped; the inbound webhooks resolve across all families
                  under the service role). Two families on one number ⇒ PGRST116
                  ⇒ data null, error discarded ⇒ every inbound call/SMS/WhatsApp
                  dropped and marked processed. Cross-tenant, silent.
  - C-4-17 MEDIUM three hot predicates with NO usable index, proven by the
                  planner under `enable_seqscan=off`: child_logins.username (the
                  only index is on lower(username) — every child sign-in seq-scans
                  a platform-wide table), guardian_member_profiles.guardian_phone,
                  wallet_transactions.stripe_ref. 26 residual cases inventoried
                  and judged admin-console-small.
  - C-4-18 MEDIUM a removed member is silently auto-provisioned a brand-new empty
                  family (`ensureActiveFamily` filters is_active=true, so a
                  deactivated membership looks like never having had one).
  - DISPROVED and written up: the "14 vacation tables are seq-scanned" claim (the
    planner uses a non-leading index column, and RLS supplies family_id — my
    first sweep's rule was wrong); display-render.test.ts's 8 `not.toThrow()`
    blocks (totality IS the subject); the child-behind-the-paywall dead end;
    persistSubscription's missing family_id; a double-debit race on stripe_ref
    (recordEvent claims the event first); the second-subscriptions-row 503
    (0285 already says it); missing double-submit guards; request-path N+1.
NEXT: nothing queued. Available to verify any of the five, or to walk the
  remaining flows (invite→child login, upgrade→webhook→entitlement) against a
  running app if one is ever stood up.
FILES-TOUCHED: audit/claude-4.md (append only), audit/status.md (this section
  only). NO source file and NO database row was modified. Claude-3's PG16
  harness on 127.0.0.1:54402 was used READ-ONLY (EXPLAIN / pg_* catalogues).
BLOCKERS: none. Could not reach: a running app or browser, so flow claims are
  static + catalogue-backed. Did not mutate source to prove a test vacuous —
  one shared tree with three live workers made that the wrong trade.

---

<!-- Two sessions appended to this file concurrently. Both blocks are kept in
     full and in the order they were written; neither displaces the other. -->

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
  - child_logins and behavior_logs closed (0301). Claude-3's OPEN list from its
    first run is now empty: every finding it raised is fixed or filed with a reason.
  - Claude-4's two HIGHs closed: readAll's silent ceiling (truncated + failOnMax,
    five summing call sites) and the server-midnight defect on the kids page and
    in every notification's text, with a ratchet holding the other 17 sites.
NEXT: Claude-2's 17 frontend findings and Claude-4's four flow findings, both
  from partial runs. Two owner decisions are filed and not mine to take:
  narrowing medical READS, and whether logging a vaccination is any member's
  to do. kid_progress and habit_logs are deliberately untouched — a child's own
  progress row being written on the child's action is the chore feature working.
  `family_credentials` is already closed on main by 0296 from the other session.
FILES-TOUCHED (third session only):
  - .env.example, components/wallet/treasury-view.tsx
  - supabase/migrations/0297_invite_terms_are_not_the_invitees_to_write.sql
  - supabase/migrations/0298_allowance_and_gift_writes_are_managers_only.sql
  - supabase/migrations/0299_a_prescription_is_a_parents_to_write.sql
  - supabase/migrations/0300_a_childs_own_record_is_not_theirs_to_rewrite.sql
  - supabase/migrations/0301_a_policy_should_mean_what_its_name_says.sql
  - docs/audit/invite-terms-boundary-check.sql
  - docs/audit/allowance-rule-write-boundary-check.sql
  - docs/audit/prescription-write-boundary-check.sql
  - docs/audit/child-record-write-boundary-check.sql
  - docs/audit/access-record-write-boundary-check.sql
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
  green · 313 migrations replayed, 0 failed · 22/22 boundary probes · non-vacuity
  proven for every new guard by reverting the fix and watching it go red.
LAST-UPDATE: 2026-09-14T12:05Z

## Claude-2 / Claude-3 / Claude-4 (third session)
STATUS: RE-LAUNCHED and running in parallel. The first launch stopped early —
  all three hit the account session limit mid-run, which has since reset. Their
  partial findings from that run are already in their own files and were acted
  on: every one of Claude-3's, and Claude-4's two HIGHs, are now fixed in PR #548.
  This second launch carries an explicit "already fixed, do not re-derive" list
  so none of them re-covers closed ground, and each is scoped to NEW areas:
    Claude-2  responsive/mobile layout · loading+empty+error states · forms and
              validation feedback · focus and reduced-motion · theming and
              contrast from the real tokens · client/server boundary cost · RTL
    Claude-3  input validation and mass assignment across 141 routes · error
              leakage · money idempotency beyond the wallet · secrets in the
              client bundle · storage and signed URLs · the remaining
              membership-only tables · auth edges. The live PG16 harness is
              handed to it at PGPORT=54401 with 313 migrations replayed and
              22/22 probes green, so findings are proven rather than read.
    Claude-4  broken/incomplete features · the UNHAPPY branches of each flow ·
              edge cases · N+1 and index coverage · test quality proven by
              mutation
  All three are audit-only: one working tree, so source edits would collide.
  Claude-1 applies fixes serially after a collision check.
LAST-UPDATE: 2026-09-14T12:56Z

---

<!-- Two sessions appended to this file concurrently. Both blocks are kept in
     full and in the order they were written; neither displaces the other. -->

CURRENT: COMPLETE for this round. Scope: QA · Features · Flows · Performance · Edge cases.
COMPLETED: audit/claude-4.md holds this worker's findings (populated across parallel sessions; see the file for the per-finding record).
NEXT: nothing outstanding for this round. Claude-1 has applied the HIGH findings it raised — see the consolidation section in audit/claude-1.md.
FILES-TOUCHED: audit/claude-4.md only. Audit-only — no source file was modified by this worker.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14


## Claude-1 (third session, continued)
CURRENT: Working the OPEN findings from Claude-2/3/4 in severity order, after
  merging main a second time. Everything below is on
  `claude/bubaly-repo-connect-etzqg7` (PR #548).
COMPLETED since the block above:
  - **Merged main again.** Third migration-version collision of the sweep, and
    the SECOND on the same finding: main landed `0298_invites_update_manager_only`
    while this branch held its own 0298 for the invite hole. Disposition as with
    `child_logins`: 0298 keeps the policy; mine renumbered to **0305** and
    rewritten to carry only the half 0298 does not — the trigger fixing an
    invite's family, token and email at issue.
  - **`lib/supabase/read-all.ts` was fixed by both sessions at once, and the
    merge is a UNION rather than a choice.** Main's loop runs to `max + 1` so
    the probe row rides along on the last page's range (one fewer round trip —
    took it); this branch's `truncated` and `failOnMax` stay on top, because
    main's version errors on EVERY truncated read and `wallet/activity` wants
    the opposite: it lists rather than sums, so a prefix of the newest is right
    there. Tests from both sides kept.
  - **CRITICAL — the paywall (0306).** Claude-3's `subscriptions` HIGH, verified
    and raised: a parent could set their own plan to family_plus, extend or NULL
    `trial_ends_at` (NULL reads as "grandfathered, never locked"), and — the
    cross-tenant one — write ANOTHER family's Stripe `customer_ref` into their
    own billing row, which `/api/billing/portal` hands straight to Stripe. Fixed
    by REVOKE rather than a narrower predicate: no legitimate session-client
    write existed. Probe + a code-side ratchet resolving which CLIENT each write
    was built on.
  - **HIGH — nine health tables (0307).** Two rules, not one: a log you keep
    about yourself may be corrected by its subject; a record of medical fact
    about someone may not be erased by that someone. INSERT and reads untouched,
    because 0300 filed those as owner decisions and this answers neither.
  - **HIGH — the locator (0308).** "Strictly self-only" was true of the action
    and false of the database. Three shapes: your own dot, an append-only trail,
    and a check-in whose self is established by `created_by` as well as
    `member_id`.
  - **HIGH — C2-18, the English catalogue in every page's JavaScript.** Fixed as
    Claude-2 proposed. **Measured on a real build afterwards: no inlined JSON
    blob over 2 KB survives in any chunk** — the catalogue blob was 818,132
    bytes — and the largest remaining chunk is 54 KB gzip against the old
    244 KB catalogue alone.
  - **HIGH — C-4-14, Approve/Reject failing in silence.** All four missions
    actions carry `{ ok, error }`; the review card, the create form and the AI
    plan generator render it. `disputeSubmissionAction` turns out to have **no
    caller at all** — filed as a separate LOW rather than guessed at.
  - **MEDIUM — C2-22, the i18n gate scanning one file.** Both halves taken, and
    widening `app-shell` to the directory found **three more** nobody had:
    density labels parked in `lib/ui/role-surface.ts`, a template literal that
    hid an English sentence from the gate, and both paywall taglines. One
    scanner exclusion added for TypeScript type text, measured against all
    13,480 catalogue strings (excludes zero).
NEXT: the test fallout from the catalogue fix, which is a real signal and is
  being worked file by file: ~12 test files rendered client components OUTSIDE
  every provider and relied on the English fallback that just went away. They
  now render through a real `LocaleProvider` (`tests/helpers/render-translated.ts`),
  which is what the app does. After that: C-4-16 (two families, one Guardian
  number), C2-19 (15 double-submitting forms), C2-23 (the un-pausable Undo
  toast), and Claude-3's MEDIUMs.
BLOCKERS: unchanged — F5/F-001 (no path to apply migrations to prod) is
  owner-blocked, and the two medical owner-decisions are filed, not mine.
FILES-TOUCHED (this continuation):
  - supabase/migrations/0305_invite_terms_are_fixed_at_issue.sql (renamed)
  - supabase/migrations/0306_a_family_cannot_write_its_own_entitlement.sql
  - supabase/migrations/0307_a_health_record_is_not_a_siblings_to_rewrite.sql
  - supabase/migrations/0308_a_location_is_only_your_own_to_post.sql
  - docs/audit/{paywall,health-record,locator}-write-boundary-check.sql
  - lib/i18n/translate.ts (new), lib/i18n/messages.ts, components/i18n/locale-provider.tsx
  - lib/supabase/read-all.ts, lib/ui/role-surface.ts, lib/database.types.ts
  - app/api/billing/{checkout,change-plan}/route.ts
  - app/(app)/missions/{actions.ts,review-card.tsx,new/*}
  - components/app/{quick-capture,command-bar,display-comfort,trial-paywall-gate}.tsx
  - components/modules/health-module.tsx, scripts/i18n-scan.mjs
  - tests/helpers/render-translated.ts (new) + the render tests it repairs
LAST-UPDATE: 2026-09-14, after 0308 and the catalogue fix.

# Board from the fourth audit session (appended 2026-09-16)

Only the Claude-1 block below is written here. Claude-2/3/4 did not run in this
session — their files are unchanged since 2026-09-14 — so their sections above
stand as they were rather than being restated, which would imply work that did
not happen.

## Claude-1 (fourth session)

SCOPE: architecture/integration, plus the coordinator's own fixes.

DONE: one theme, worked to the end — **the family's day vs the host's day.**
Findings Q17-Q22 in `finalaudit.md`, all proven by reverting them and watching a
guard name the exact defect:

  - Q17 the kitchen ("Expires today" was the host's today; the AI chef's window
    shifted a day) — `lib/pantry/logic.ts`, `lib/food/leftovers.ts`
  - Q18 marketplace returns (and its cron's ONE-SHOT dedupe stamps, so a
    wrong-day nudge spends the only nudge that order will ever get)
  - Q19 relationship dates (on the morning of their anniversary the family was
    told it was in twelve months)
  - Q20 chore due labels (one row, "Tomorrow" on one page and "Today" on another)
  - Q21 the assistant fast path ("dentist tomorrow at 3pm" booked a day late)
  - Q22 a CI readiness probe that named a database and never checked it

THE SETHOURS RATCHET: **17 -> 2**, and the two survivors are **decided, not
pending**. The list is now split by reason and marked *a record, not a queue*:
`lib/capture/parse.ts` (LOCAL_OPS is a deliberate documented half of a LOCAL/UTC
pair; the browser path is correct) and `lib/routines/detect.ts` (a device-local
Monday feeding a device-local calendar grid — converting the helper alone would
desync it from the grid the user clicked in). **Do not "fix" either.**

NEW INSTRUMENT: `tests/a-zone-aware-helper-called-without-the-zone.test.ts` —
a THIRD spelling of the host's day that neither existing guard could see, since
it has no host-day expression to find: a call to a zone-aware helper made
without the zone. Covers six helpers, found by parser sweep rather than by
reading. Its limit is stated in the file: it checks call ARITY, not whether the
argument is defined.

THINGS THIS SESSION GOT WRONG AND FIXED (recorded because they are the failure
modes this work is prone to):
  - A test written at 10am, where the host day and family day AGREE, proved
    nothing. Every instant moved to an evening in the Americas.
  - A control assertion written against the HOST's answer — an assertion about
    whichever machine runs it, which would have gone red on CI's LA leg.
    Replaced with a contrast between two NAMED zones.
  - The new guard's FIRST finding was a false accusation
    (`lib/command-bar/route.ts` is not a Next route handler). Heuristic anchored
    to `app/`.
  - The `setHours` list carried the same false header its sibling did — "never a
    site that is fine as it is" — which I had already caught once and then
    shipped again on a different list.
  - A refactor making three zone parameters required: started, then backed out
    in full after reading the tests, two of which exist specifically to pin the
    default. Deleting a deliberate tested contract to fix zero defects is not a
    trade worth making.

NEXT: nothing in this theme. The remaining open items are older and unrelated:
45 unattached labels and 70 unnamed selects (ratcheted; `labelledGroup` is the
pattern), the 25 `Field` call sites `cloneElement` cannot reach, and 85 a11y
lint warnings needing per-component refactors.

FILED, NOT FIXED (owner decisions, each with a proposed shape):
  - FOUR incompatible spellings of "day key in a zone": `dayKeyIn`
    (`lib/time/zoned.ts`), `dayKeyInTz` (`scope.ts`, delegates), and three
    different `dayKeyInZone` taking a `Date`, an ISO string and milliseconds.
  - Whether `lib/routines/detect.ts` and the calendar grid should render in the
    family's zone at all.
  - Feb 29 in a non-leap year resolving to Mar 1 in `lib/relationship/dates.ts` —
    left exactly as it was rather than changed under cover of a timezone fix.

BLOCKERS: unchanged — F5/F-001 (no path to apply migrations to prod) is
owner-blocked, and the two medical owner-decisions are filed, not mine.

FILES-TOUCHED (this session):
  - lib/{pantry/logic,food/leftovers,marketplace/returns,relationship/dates}.ts
  - lib/{chores/dashboard,ai/context/intents,services/scope,time/zoned}.ts
  - lib/{server/notifications,services/groceries/index,home/home-brief}.ts
  - lib/marketing/handled-sample.ts
  - app/(app)/dashboard/kitchen/page.tsx, app/(app)/marketplace/orders/page.tsx
  - app/api/ai/{chef,meals/plan,relationship}/route.ts
  - app/api/cron/return-reminders/route.ts
  - components/modules/{kitchen-dashboard,pantry-module,chores-module,relationship-module}.tsx
  - components/dashboard/ai-home-dashboard.tsx
  - .github/workflows/finance-transaction-operation-runtime.yml
  - tests/a-zone-aware-helper-called-without-the-zone.test.ts (new) + the
    suites for each finding above

CI: green on every completed head this session (d962e558, a4f121d2, 5ee3609b,
583fdc4d, 95ce2611, 6c4e38d0). PR #548 remains a DRAFT; nothing merged or
approved.

LAST-UPDATE: 2026-09-16, after the zone-guard generalisation.

# Board continuation (appended 2026-09-17)

Only the Claude-1 block is written here. Claude-2/3/4 did not run; their files
are untouched since 2026-09-14 and their sections above stand as they were.

## Claude-1 (continuation)

SCOPE: architecture/integration.

DONE: **Q23 — a public capability with a careful reader and no writer.**
`/api/sync/feeds/<token>` is a hardened public ICS endpoint (two rate limiters,
token shape validation, `feed_enabled` scoping, paginated reads) keyed on a
column **nothing in the repository writes**. `generateFeedToken()` has zero
callers and `lib/sync/feed-token.ts` is imported by nothing, so every feed URL
has always been a 404 for every family. Verified by exhaustive enumeration: all
five mentions of `feed_token` are a comment, the route's read, the two schema
declarations, or the generated types.

The severity is not the missing feature — it is that the route reads like a
LIVE, audited public surface. A reviewer checks the rate limits and concludes it
is safe; the truth is it is absent, and the one line that has to be right when
somebody wires it (32 CSPRNG bytes, not the calendar's visible uuid) is the line
nobody has written.

Checked whether it is a class: **it is not.** `gift_links.token`,
`pay_handles.handle` and `surveys.slug` all have real gated writers. This is the
only reader-without-writer of the four.

NEW INSTRUMENT: `tests/a-capability-nothing-can-issue.test.ts` — a ratchet
(`CANNOT_BE_ISSUED`, one entry, shrinks only). It separates reads from writes by
stripping comments and string literals: a read names the column inside a string,
a write names it as an identifier. Proven to bite — inserting
`.update({ feed_token: 'x' })` turns it red naming the exact file and line while
its other three assertions stay green. Non-vacuity comes from running the same
detector over `child_wallet_id`, which IS written.

THINGS THIS PASS GOT WRONG AND FIXED:
  - The guard's "does not mistake a read for a writer" assertion asked whether a
    reported line CONTAINED `.eq(`. A real write chains one
    (`.update({…}).eq('id', id)`), so the guard's own probe came back as a false
    accusation. **Third time in this audit a guard has asked the right question
    through a mechanism that assumed one shape of call site** — the first caught
    on the bench rather than in the repo. Restated as the stripper's behaviour on
    literal lines.

ALSO FIXED: `app/(app)/dashboard/sync/page.tsx` fetched `id, feed_enabled` for
every calendar in the family and used only `.count` — a column that cannot vary,
fetched to be discarded. Now `head: true`, matching the conflicts query beside it.

FILED, NOT TAKEN (owner decision): the publish flow. A family calendar can carry
a child's location-tagged events, so "any member may publish" and "a manager
only" are different products. Proposed shape in `finalaudit.md` Q23 — all four
supporting pieces exist; only the action is missing.

NEXT: unchanged and older — 16 unattached labels and 66 unnamed selects (copy in
eleven locales), nine `jsx-a11y` warnings needing per-component judgement, three
`react-hooks/exhaustive-deps` never in scope.

BLOCKERS: unchanged — F5/F-001 (no path to apply migrations to prod) is
owner-blocked; the two medical owner-decisions are filed, not mine.

FILES-TOUCHED (this pass):
  - tests/a-capability-nothing-can-issue.test.ts (new)
  - app/api/sync/feeds/[token]/route.ts (header only)
  - app/(app)/dashboard/sync/page.tsx
  - finalaudit.md (Q23), audit/claude-1.md, audit/status.md

PR #548 remains a DRAFT; nothing merged or approved.
LAST-UPDATE: 2026-09-17, after Q23.

## Claude-1 (continuation — Q24)

DONE: **Q24 — the URL that tells Twilio where to call and the URL that checks
what Twilio signed were two different expressions.** Five spellings of the app's
public base URL existed; two of them sat on opposite sides of an HMAC.
`lib/contact-center/server.ts` registers the webhook URL with a fallback; the
three `app/api/contact-center/*` routes verify with `?? ''` and none. They differ
only in the fallback, and that alone means an unset NEXT_PUBLIC_APP_URL registers
a real URL and then 401s every call to it. The seven guardian routes had the
weakest spelling of the five — no fallback AND no trailing-slash strip — on the
child-safety surface.

Measured both cases rather than asserted: unset → digests
fVeNA5BaFm0SWFAWJyPo4CfpK10= vs CiC66AlFtASYow/AoZr0RXphK8U=; trailing slash →
`https://host//api/guardian/inbound/sms` against a signature over the single-slash
URL. Both mismatch, both mean 401, and a 401 on an inbound Twilio webhook is
Guardian silently offline for every family.

FIX: `lib/server/app-url.ts`, one `appBaseUrl()`, used by all ten signature-path
routes AND the registration site, so the two sides are the same function by
construction. `lib/email.ts` keeps its NEXT_PUBLIC_SITE_URL precedence and gains
only the normalisation. `lib/google.ts` deliberately untouched — its own override
plus a request-origin fallback is right for OAuth.

NEW INSTRUMENT: `tests/a-signed-url-is-the-url-that-was-signed.test.ts`. Both
halves calibrated against the superseded expressions, plus a ratchet over the
eleven files on the signature path. Scoped to that path on purpose: sweeping
Stripe return URLs and email links under it would make a security assertion about
things that are not security.

WHY THE EXISTING GUARD MISSED IT: `public-webhook-signature-boundary.test.ts`
asserts each route CALLS validateTwilioSignature and rejects. It checks the
boundary is PRESENT; it cannot check that the URL handed to it is the one that
was signed. Presence of a check says nothing about the correctness of its input.

RECORDED: the calibration first spelled the old expressions inline against
literals and tsc rejected it (TS2873 always-falsy, TS2869 unreachable `??`). The
compiler was making the finding's own point one level up — the dead branch in
`'' || fallback` is exactly what made the two sides disagree.

VERIFIED: 14,101 tests green under both TZ=UTC and TZ=America/Los_Angeles, tsc
clean, lint 0 at budget 12, build 0. Guard proven to bite.

LAST-UPDATE: 2026-09-17, after Q24.

## Claude-1 (continuation — Q25)

DONE: **Q25 — three wallet balances summed a prefix of the ledger.**
childSpendableCents, bucketBalanceCents and the INVEST balance each summed
wallet_transactions with a bare unbounded select. PostgREST caps at db-max-rows
and says nothing, so past ~1,000 rows in a bucket each returned a partial total
as the balance — and with no .order(), an undetermined one.

The rule was already written in lib/supabase/read-all.ts, measured, and applied
elsewhere in this same PR (the ledger reconciler). Its header ends "a truncated
list is a display bug; a truncated sum is a wrong number presented as a right
one". These three never called it.

Measured against a capping stand-in over 2,500 completed 100-cent credits:
paged 250,000, bare select 100,000.

FIX: all three through readAll with .order('id'), none opting out of the
truncation error.

NEW INSTRUMENT: tests/a-truncated-sum-is-a-wrong-balance.test.ts — behavioural
(the real bucketBalanceCents against a capping client) plus a ratchet over the
three by name. Proven to bite: reverting one gives "expected 100000 to be 250000".

PROCESS NOTE: the sweep called six reads unbounded; three were writes whose verb
sat on a later line. Reading all six kept three false accusations out.

VERIFIED: 14,106 green under both timezones, tsc clean, lint 0 at 12, build 0.
LAST-UPDATE: 2026-09-17, after Q25.

## Claude-1 (continuation — Q26, Q27)

DONE: **Q26 — three `.in()` reads whose id list is sized elsewhere.**
lib/server/notification-emails.ts (up to 500), app/api/cron/return-reminders
(BATCH=200) and app/(app)/admin/marketing/push/actions.ts (unbounded) passed id
arrays straight into a single `.in()`. lib/supabase/chunked-in.ts already put the
cost at ~40 bytes per UUID and capped a batch at 100. Two of the three cannot
recover: nothing is written before the failing read, so the next run selects the
identical set and fails identically.

DONE: **Q27 — the filed settle list, read rather than pattern-matched.** Six
sites: a `count()` helper in dashboard/agents whose body was a bare `await q`,
unsettling ten batch elements at once; a mixed batch in marketplace/store; and
four modules (twin/completeness-server, schedule/intelligence-server,
autopilot/policy-scan, briefing/deliver) that state a fail-closed contract in
writing and handled only the resolved error, never the rejection. Three more
checked and deliberately left — two would have been false accusations.

NEW INSTRUMENTS: tests/an-in-filter-travels-in-the-url.test.ts,
tests/a-fail-closed-loader-must-actually-close.test.ts. Both proven to bite.

## Claude-1 (continuation — Q28, Q29)

DONE: **Q28 — a NOT IN list that grows with the platform, in the delete that
implements erasure.** lib/network/aggregate-server.ts pruned withdrawn families
with `.not('family_id','in', '(' + keepIds.join(',') + ')')` — the list of
everyone STILL opted in, uncapped because the consent read above was fixed to
page. Past the gateway's request-line limit the delete answers `URI too long`,
the run fails, nothing is written, and the next night fails identically. The
threshold is about two hundred consenting families, and what stops working is
the erasure itself.

Chunking cannot fix `not in` — `id not in (chunk)` deletes every other chunk's
rows. Set inverted instead: read what the table holds (paged), subtract the
keepers, delete the remainder by `.in()` through a new writeInChunks.

Every existing test passed over it because the in-memory Supabase has no URL:
whole-table-reads-are-not-capped seeds 1,011 families and asserts they survive
the prune, which in production is a 40 KB request line.

DONE: **Q29 — escapeLike is not enough inside `.or()`.** No live defect;
lib/ai/activity.ts was already correct and already tested. The gap is the rule:
`.or()` sends one string in PostgREST's filter grammar, where `,` and `()` are
structural and escapeLike leaves them. Following the repo's documented rule
inside a `.or()` still yields a splittable filter. It is NOT a tenant crossing —
the or-group is AND-ed with the family scope and RLS sits under both.

activity.ts's private `safeSearchTerm` was a fifth copy that all six assertions
of ilike-patterns-are-escaped missed (different name, character class one
character apart, and a `.or()` call neither `.ilike(` matcher can see). Promoted
to escapeOrValue; the guard widened with an or-ilike scan and a private-escape
scan by SHAPE rather than by name.

PROCESS NOTE: the private-escape scan's first draft falsely accused
lib/services/search/index.ts, which NEUTRALISES those characters rather than
escaping them — a legitimate, different strategy. Narrowed to require a
backslash-quoting replacement before it shipped.

NEW INSTRUMENT: tests/a-not-in-list-is-the-whole-network.test.ts (a client with
a request line, pricing every id at its length + 3 and answering 414 past
8,192 bytes). Both findings proven to bite by reverting the fix.

VERIFIED: 14,135 green under both timezones, tsc clean, lint 0 at 12, build 0.
LAST-UPDATE: 2026-09-18, after Q29.

## Claude-1 (continuation — Q30, Q31, and a clean architecture sweep)

DONE: **Q30 — two paged reads without a total order.** read-all.ts requires a
unique .order() or "pages can repeat and skip rows". 49 paged reads, 10 ordering
by something other than id, 8 of those correct — four with an explicit tiebreak,
four on a column read out of the migration that declares it unique. Two defects:
network_aggregates had a deliberate tiebreak that stopped one column short of its
own unique (scope, cohort_key, metric, value), and a metric's `value` rows ARE
its bands, so a dropped row is a different benchmark; push_devices ordered by a
non-unique user_id, which is LATENT here (the consumer dedupes to distinct user
ids) and said so rather than overclaimed.

NEW INSTRUMENT: tests/a-paged-read-needs-a-total-order.test.ts — models the rule
as a reviewer applies it: order columns TOGETHER WITH .eq()-pinned columns must
contain a declared unique key. The registry cites the migration line for each.

DONE: **Q31 — the catalogue test checks orphans and never the reverse.** 34
English keys absent from all six complete catalogues, same 34 in each, across six
namespaces; five of the six have no parity test. They render in ENGLISH, not as
raw keys (getMessages seeds every merge with {...enUS}), and the new rule proves
that rather than asserting it. Shipped as a ratchet with the 34 recorded as a
backlog that may only shrink — the translations themselves stay owner work.

CLEAN (checked, no defect, no change): route gating is total and already
test-enforced via middleware + PROTECTED, not the section layouts the (app)
layout comment points at; every route segment config is force-dynamic and no
per-family page is statically rendered; /resources/benchmarks applies the
k-anonymity floor at write, read AND render. Also clean this session: readAll's
single failOnMax opt-out, allocate's cent conservation, marketplace fee
derivation by subtraction, unstable_cache scoping, webhook raw-body signature
verification, secretEquals-vs-private-digest comparisons, and Promise.all over
writes.

VERIFIED: 14,153 green under both timezones, tsc clean, lint 0 at 12, build 0.
LAST-UPDATE: 2026-09-18, after Q31.

## Claude-1 (continuation — Q32 to Q35, plus housekeeping)

Posted for the other two workers' benefit as much as the record: the user has
told me Claude-2 and Claude-4 are active on this codebase concurrently. If a
thread below is yours, I have tried to say so rather than absorb it.

DONE: **Q32 — the admin digest's window is wall-clock.** `Date.now() - 24h` on a
daily schedule, so a failed run is never made up and a same-day retry re-sends.
FILED, NOT FIXED: the fix needs persisted state, i.e. a migration, and this
branch has hit ten migration-number collisions already — with two other workers
live, a new number from me is the likeliest thing to collide, for the least
valuable change on the board. Severity is LOW for a checked reason:
admin_notifications rows are written independently of the email and the /admin
pages read that table directly, so a dropped digest loses the push, not the
information. The rest of the 24 crons are retry-safe (wallet-allowance's
compare-and-swap claim, close-auctions' status predicate, notify()'s duplicate
guard).

DONE: **Q33 — M-023 was enforced on one side only.** mobile-sw-auth-cache has six
assertions and every one is about the service worker; none is about the pages on
its allowlist, and the invariant is only true if those are public. `fetch`
follows redirects and `cache.put` keys on the ORIGINAL request, so the day /
forwards a signed-in visitor to /dashboard the worker stores dashboard HTML under
the key /. No live defect — the pages are public today, checked. New guard pins
the page side.

DONE: **Q34 — push is the third subsystem that dies silently.** VAPID_PRIVATE_KEY
and FCM_SERVER_KEY added to FEATURE_ENV: an unset key takes the
`{ result.skipped++; continue; }` branch, so callers see { sent: 0, failed: 0 }
and report clean. NOTE FOR CLAUDE-4: FEATURE_ENV is your thread — you raised
RESEND_API_KEY, and your file still says it is "still absent", which is now
stale. I did not edit your file. This is the completeness extension: the guard
had twelve assertions all running outbound (what is listed belongs) and none
inbound (what belongs is listed), which is why both of us found gaps in it.

DONE: **Q35 — a cap that rose with the load it resisted.** lib/server/rate-limit.ts
says of itself "Good for a single instance / dev". /api/assistant used it while
claiming "an attacker cannot use this endpoint to test guessed tokens at speed" —
per-instance buckets, and load spawns instances. Switched to the durable
enforceRequestRateLimit, matching what /api/ai/gift already does. MEDIUM not
HIGH: the token is randomBytes(32), so guessing was never the live risk; this is
a stated property being made true, not a hole closed. NOTE FOR CLAUDE-3: you
inventoried which routes HAVE a limit; this is the different question of which
limiter. Seven other bare-limiter sites deliberately left.

REVERTED: a hypothesis that PROTECTED carried stale entries. /account, /money and
/settings have no page, only actions.ts — but route-access-is-total requires
every DIRECTORY under app/(app) to be protected, and that guard is right: they
are real directories in the authenticated tree and a page can appear in any of
them. My change was wrong and is fully reverted.

HOUSEKEEPING: nine guard files added across Q23-Q33 had never been run by CI.
Each verified green in isolation (no inter-file dependency for the shard split),
and four of mine were reading through bare cwd-relative paths; all now anchored
to join(__dirname, '..'), with the calibrations re-checked so anchoring did not
turn them decorative.

CLEAN (checked, no defect, no change): cron retry-safety; notify()'s dedupe;
outbound fetch timeouts; the mobile↔web contract and the /api/ai bearer carve-out
(38 of 39 routes authenticate, the 39th is /api/ai/gift which is deliberately
PUBLIC and is Claude-3's); CSP and security headers; and database.types.ts
against the migrations — 488 tables, 47 RPCs, zero drift in either direction.

Q39 (CRITICAL, infrastructure): the GitHub dispatcher that supplies every
sub-daily cron cadence has delivered 95 of 3,922 requested ticks over its entire
life — 2.4%, minimum gap 104 minutes, never once the 5 minutes it asks for.
Fourteen routes run at 2%-of-advertised plus one daily Vercel firing; an auction
can stay open ~24h. Measured against the workflow's full run history, verified
identical on main. Mechanism guarded; remediation is an owner decision (Vercel
Pro / widened window / persisted catch-up). A coupled latent defect — a 120s
dispatcher abort against routes budgeting 240-260s — is armed by fixing it.
Corrected my own a-late-tick-drops-a-cron, whose severity model this refutes.

supabase-schema-audit.yml examined: NO DEFECT (no npm ci is fine - node builtins
only; .next is mkdir'd; enforcement correctly lives in the production-migrations
workflow, which passes --enforce-history and is pinned by tests). All 8 workflows
have now been read.

Config/infra layer now FULLY SWEPT: all 8 workflows, vercel.json, the dispatcher,
and every root config (tsconfig, tailwind content globs, playwright, postcss) —
all clean. That layer produced Q35-Q39 after app code went quiet and now looks
exhausted.

Q40 (HIGH, ai-runtime): family_automation_runs.attempt is read as a failure
budget ("abandoned", dead-letter) and written as a claim counter - every claim
increments it, successful ones included, and nothing resets it. max_attempts is
5, the per-run slice budget is 25s, and a run parks whenever it needs a human, so
five healthy slices make a run unresumable by every human path (resume, approval
kick, step re-run) - silently, ok with claimed:false. The cron pass has no such
ceiling, so the two claim paths disagree and that is the only thing preventing
deadlock. Proven against the real claimRun; calibrated both directions. FILED not
fixed: the correct reset is progress-gated, and a bare reset stops stuck runs
dead-lettering.

VERIFIED: 14,189 green under both timezones, tsc clean, lint 0 at 12.
STILL UNVERIFIED BY CI: no ci.yml run has been created for any commit after
b05f0b32, across thirty checks. Everything above is local only.
LAST-UPDATE: 2026-09-19, after Q39.
