# Status board

> Two sessions ran this board. Both sections are kept.

---

## From `main`


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

## From `claude/roadmap-implementation-ld8bon`


Each worker maintains ONLY its own section. Read the others before you start
anything, and before you touch a file.

---

## Claude-1
CURRENT: Passes P, Q and R done (604d5b00, d2d138eb pushed; R validating) — merged Claude-2's U-02 and U-03 (both verified independently, both fixed) and found three more defects along the way (P-02, P-03, P-04, all fixed). CI run 34791298096 on e928e4de: SUCCESS, so the six previously unvalidated commits are clear.
COMPLETED: Passes A-P (16 passes) · P-01 merged from Claude-4 (verified independently, fixed, two guards added) · architecture sweeps 1-3 · U-02 fixed with a page-level behavioural proof: against the pre-fix code the failed-read page and the absent-row page are BYTE-IDENTICAL strings · P-02: three of six routing rows had no writer anywhere in the application; `default_mode_immediate/close/trusted` only ever held their column DEFAULT while lib/guardian/pipeline.ts:144 routes immediate/close/trusted calls through them · P-03: a cleared greeting came back, because `value || undefined` omitted the key · finalaudit.md restructured to the 19-section layout with every original sub-heading preserved byte-identical
NEXT: U-05 (74 icon-only buttons with no accessible name; and the bare <div onClick> calendar/note/photo rows), then Claude-3's S-02 (the child-PIN ILIKE throttle bypass) and S-03 (child_logins' 'Managers manage' policy that admits any member). Rebuild finalaudit.md from all four files as each lands.
FILES-TOUCHED: finalaudit.md, audit/README.md, audit/claude-1.md, audit/status.md, docs/PENDING_PROD_MIGRATIONS.md, lib/constants/feature-catalog.ts, tests/route-plan-gate.test.ts, tests/every-gate-key-is-in-the-catalog.test.ts, lib/guardian/routing-form.ts (new), app/(app)/guardian/settings/page.tsx, app/(app)/guardian/actions.ts, components/guardian/routing-settings.tsx, lib/i18n/messages/*.json (one key, 7 base catalogues), tests/guardian-settings-failed-read-is-not-an-empty-profile.test.ts (new), tests/guardian-routing-saves-every-row-it-shows.test.ts (new)
BLOCKERS: none. Note: another SESSION also pushes to claude/roadmap-implementation-ld8bon - always fetch+merge (never rebase) before pushing.
NOTE FOR CLAUDE-2: your U-02 is FIXED exactly as you specified — settleAll, `profileError` → ErrorState, and the prop is now `{status:'ok'|'absent'|'error'}` rather than `Profile | null`. Your file is untouched (rule 1); the status lives in finalaudit.md §3 and §7. Two more defects were in the save path you pointed at, which is the argument for always reading the whole handler a finding names.
PASS Q: U-03 fixed by scoping the DECLARATION (202 call sites untouched); guard compiles the real stylesheet with the real config and asserts on emitted CSS, 1.6s, reverted -> 4 of 6 fail. Checking a line number in that report turned up P-04: `btn-primary`, `no-scrollbar` (13 sites), `bg-card`, `prose-family` and six off-scale opacity modifiers (/12 and /8; `bg-brand/10` emits, `bg-brand/12` does not) compile to NOTHING — two on the public pricing and security pages. Eight fixed. Three further families confirmed (shadcn tokens this theme never defines, tailwindcss-animate with `plugins: []`, more off-scale values) and left OPEN until the inventory is exact: the sweep's raw 157 is mostly false positives from a regex that reads the comparison operand in `className={k === 'high' ? ...}`, so the number is NOT reported as a finding.
P-04 CLOSED: 47 class names compiled to NOTHING — 28 `bg-card` cards with no background, `bg-primary`/`text-foreground`/`bg-background`/`bg-surface-2` (shadcn's vocabulary, never ported to this theme), the onboarding wizard's `animate-in fade-in slide-in-from-bottom-2` with `plugins: []`, and 23 opacity modifiers that are not multiples of five (`bg-brand/10` works, `bg-brand/12` is nothing). 134 replacements across 54 files; `scripts/audit-unstyled-classes.mjs` + `tests/every-class-in-the-app-styles-something.test.ts` now hold it at zero, with five positive controls so a blind sweep cannot pass as a clean one.
PASS R — U-04 CLOSED: all five Guardian pages plus /family/activity made safety claims they had not checked. /guardian rendered "0 Blocked" and "0 Scams Stopped" from `count ?? 0`; the trust graph said "0 contacts"; rules said you had written none; history said "No communications match your filters" over a log that may be full of blocked scam calls. /guardian now carries a PartialReadBanner naming each failed read, and its stat tiles take `number | null` so an unread count is an em dash — components/ui/partial-read-banner.tsx had already written the rule down for the admin pages ("a zero that means 'we could not check' must never be mistaken for an all-clear") and the SAFETY dashboard was the one place it was not applied. CallHistory now tells an empty log from a filtered one. 14 rendered cases in tests/guardian-read-boundary.test.ts, 5 of them negative controls; reverted, 9 of 14 fail and the 5 that pass are exactly the controls.
NOTE ON /guardian/contacts: the family_members read there is decoration (a name dropdown), so its failure does NOT take the trust graph down. A test case pins that, so it reads as a decision rather than the same oversight again.
CORRECTION FOR CLAUDE-2 (in my file, not yours): your U-03 cites globals.css:414 as `.btn-primary` and :419 as `.chip`. Those lines are `.btn-cta` and `.btn-inline`; `.btn-primary` and `.chip` are defined in no CSS file at all. The finding's substance is unaffected and is fixed — and the mistaken citation is what led to P-04, so it was a productive error.
LAST-UPDATE: 2026-09-14T01:25Z

---

## Claude-2
CURRENT: done — 17 findings written to audit/claude-2.md (1 CRITICAL, 4 HIGH, 7 MEDIUM, 3 LOW, 9 INFO/clean)
COMPLETED: (1) missing error/empty/loading states across 395 pages; (2) a11y — icon names, keyboard operability, focus visibility, labels, alt, skip link, aria-live, modal contract, contrast; (3) responsive — tables, fixed widths, iOS 16px rule; (4) i18n in the UI — lib/guardian catalogs + 245 hardcoded 'en-US' formatters; (5) client/server — bundle weight, useEffect fetches, TZ/hydration; (6) forms — double-submit, labels, destructive confirms
HEADLINE: CRITICAL components/modules/calendar-module.tsx buckets events by UTC date against local-midnight columns — PROVEN by TZ replay: every event lands one column off in Europe/Amsterdam + Asia/Tokyo (Sunday vanishes entirely), and every evening event does the same in America/*. HIGH app/globals.css:179 .focus-ring is unscoped — PROVEN by compiling with the repo's own tailwind config: `outline: 2px solid transparent` with no :focus selector, so 202 elements have no visible focus indicator (the 16 that use focus-visible:focus-ring are all on the marketing surface).
NEXT: available for follow-up verification; happy to re-prove any finding on request
FILES-TOUCHED: audit/claude-2.md, audit/status.md (own section only). NO SOURCE FILE MODIFIED — audit only, all fixes are written as recommendations for Claude-1.
FILES-READ-CLOSELY (for Claude-1 before editing): components/modules/calendar-module.tsx, app/globals.css, components/ui/input.tsx, components/ui/states.tsx, app/(app)/guardian/*, app/(app)/family/*, app/(app)/dashboard/family-access/page.tsx, components/guardian/routing-settings.tsx, components/guardian/call-history.tsx, design/tokens.json, lib/utils/format.ts, lib/guardian/*
BLOCKERS: none
LAST-UPDATE: 2026-09-13T23:45Z

---

## Claude-3
CURRENT: DONE - 12 findings written to audit/claude-3.md (9 defects + 3 INFO/verified). Ground-truth PG16 on port 5434 still up if anyone wants it.
COMPLETED: auth flows end-to-end, RLS write boundaries (acting AS authenticated), webhooks, rate-limit coverage, FK/index shape, secdef search_path, anon RPC grants, secrets fail-open, SSRF, body bounds, .or()/order injection. 310 migrations replayed, 491 tables, probes 20/20 green.
HEADLINE: **CRITICAL** `invites_update` has no WITH CHECK -> a guest invitee rewrites family_id+role and accept_invite makes them `parent` of ANY household (proven twice, incl. a family she was never invited to). Pass I read this policy and called it "exactly right" - it read USING and not the missing WITH CHECK.
ALSO HIGH: child-PIN throttle bypass via ILIKE `_` wildcard (16 buckets per 6-char username); `child_logins` "Managers manage" policy admits any member (child deleted a sibling's login); 163 CASCADE FKs with no index (measured 5,715 buffers -> 4); `audit_logs` lets any member forge actor_id, incl. the family_id-NULL rows the admin Security page renders with the service client (0260 fixed exactly this on trust_audit_logs and left audit_logs open).
NEXT: nothing queued - available if Claude-1 wants any finding re-proved or a probe drafted.
FILES-TOUCHED: audit/claude-3.md, audit/status.md (own section only) - AUDIT ONLY, zero source edits
BLOCKERS: none. Fixes are Claude-1's to apply; every finding carries the exact SQL/TS change.
LAST-UPDATE: 2026-09-14T00:20Z

---

## Claude-4
CURRENT: DONE — audit/claude-4.md complete (8 sweeps, 24 findings, closing summary). Throwaway PG torn down.
COMPLETED: 1 CRITICAL · 5 HIGH · 7 MEDIUM · 4 LOW · 7 INFO. Every behavioural claim executed: 310/310-migration replay via docs/audit/verify-pg.sh, money paths raced on two live connections, pure modules bundled with esbuild and run. NO source file modified.
NEXT: nothing queued — available if Claude-1 wants a specific area re-checked.
FILES-TOUCHED: audit/claude-4.md, audit/status.md (own section only). AUDIT ONLY.
BLOCKERS: none

FOR CLAUDE-1 — read in this order:
  1. CRITICAL · lib/wallet/server.ts:285 + :309. The wallet balance is derived three times; two do it in SQL under FOR UPDATE, the third fetches the whole ledger over PostgREST and reduces in JS. It has no row bound (measured: $92.00 reported against a real $40.00 on a 1,052-row bucket, because PostgREST caps at db-max-rows) AND no lock (raced: two simultaneous $8 spends against $10 both posted, balance -$6.00). Reached from requestSpendAction's no-approval branch, whose own docstring says "Never overdraws". F-019 proved the card-auth RPC safe; this is the one spend path that is not an RPC.
  2. HIGH · tests/wallet-allowance-persistence.test.ts:13 asserts the exact text of the defective allowance update, so the one-line fix for the allowance double-pay turns the suite RED. Proven by applying the fix to a scratch copy and re-evaluating the assertion. Its sibling tests/allowance-cron-idempotency.test.ts asserts the CORRECT claim on the cron and never opens this file — two guards for one property, pointed at different implementations, disagreeing about which is right.
  3. HIGH · runDueAllowancesAction (app/(app)/wallet/actions.ts:328) is missing the .lte('next_run_on', today) claim the cron has. A/B raced: cron shape = 1 credit, action shape = 2 credits, same rule, same seconds.
  4. HIGH · /dashboard/home + 6 sub-pages: sold as Plus on /pricing, locked at Plus in the sidebar, opened at Basic by requirePlanLevel(1). The AI routes behind those pages gate on the catalog, so a Basic family opens a Plus screen where every AI button answers 403.
  5. HIGH · /dashboard/experience is in EVERY family's sidebar (minLevel 0) and nothing anywhere writes experience_audits. Its only possible state is an empty state whose copy is "Run seed_experience_audits_one_family.sql to populate a baseline."

NOTE: my earlier HIGH on /dashboard/vacations + /dashboard/weekend is FIXED (your commit c8a7d576). Re-verified: both now resolve to `basic`. Marked FIXED in my file. Worth knowing: tests/route-plan-gate.test.ts was green before the fix and green after it, 37 passed both times, identical output — the guard never moved.
LAST-UPDATE: 2026-09-14T01:05Z
