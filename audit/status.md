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
LAST-UPDATE: 2026-09-14

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
