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
CURRENT: Passes P-Y done. CI green on 604d5b00, d2d138eb, cbd35299, 7f4f5a6b, 77be4f55, 880b8469 — six green, none ever failed (5a4ca5ca and 53f6362e were cancelled by the next push; their content is covered by the green runs after them). 57b659b9 (Pass X) was in progress at the time of writing. Pass Y closes U-05's other half.
COMPLETED: Passes A-P (16 passes) · P-01 merged from Claude-4 (verified independently, fixed, two guards added) · architecture sweeps 1-3 · U-02 fixed with a page-level behavioural proof: against the pre-fix code the failed-read page and the absent-row page are BYTE-IDENTICAL strings · P-02: three of six routing rows had no writer anywhere in the application; `default_mode_immediate/close/trusted` only ever held their column DEFAULT while lib/guardian/pipeline.ts:144 routes immediate/close/trusted calls through them · P-03: a cleared greeting came back, because `value || undefined` omitted the key · finalaudit.md restructured to the 19-section layout with every original sub-heading preserved byte-identical
NEXT: CONVERT the 249 remaining hardcoded-locale formatter sites (the ratchet's ceiling) — the 24 money formatters first, then the 70 client files via useFormat(), then the 74 server files via getFormat(). Then re-sweep for anything the four worker files still list as OPEN. Rebuild finalaudit.md as each lands.
PASS-AA (contrast, FIXED web + Expo): ratios confirmed by independent computation and they match Claude-2 exactly — accent 2.67, success 2.91, warning 2.70 (all below even the 3:1 large-text floor), danger 4.09. 506 text-* sites, 295 of them text-danger. Dark mode 7.13-11.74, which is how it survived: the default theme is the dark one.
  Fixed in FOUR LINES, not 506 renames: darkened the light tokens with hue and saturation held, stopping at the first value to reach 4.5:1. Checked rather than assumed that this is safe for the fills — the 44 non-opacity bg-* uses are every one a dot, bar or progress fill, not a text background, and where one carries white text the ratio IMPROVES (4.38 -> 4.84) because contrast is symmetric.
  design/tokens.json held the same four values and mobile/src/theme/tokens.ts imports it directly, so THE SAME DEFECT WAS LIVE ON THE EXPO APP. Claude-2's finding covers web only. Both updated.
  tests/brand-contrast-contract.test.ts asserted that a --brand-text token EXISTS and computed no ratio, so it was green for a stylesheet with four failing text colours. It now measures. Fourth guard this session that pinned the solution instead of the property.
NOTE FOR CLAUDE-2: your contrast numbers are exactly right — recomputed independently and they match to two decimals. Two extensions: it is 506 text-* sites not 504, and the same four values live in design/tokens.json, which the Expo app imports, so mobile had it too.
PASS-Z (i18n formatters, MECHANISM FIXED + RATCHETED): measured 252 hardcoded-locale FORMATTER sites in 144 files, not the 245 the finding counted, and 24 INDEPENDENT money formatters rather than one USD-only helper. lib/utils/format.ts was locale-blind four ways: English month/day names, 12-hour AM/PM in 24-hour locales, fmtRelative saying "Today," in hardcoded English, and Intl.NumberFormat('en-US') pinned at module scope. lib/i18n/locales.ts states the intent in its own header ("a family in Mexico and a family in Spain both read Spanish but expect different dates, currency and vocabulary") and nothing consumed it for either.
  Built createFormat(code, t?) + useFormat() + await getFormat(), matching the useTranslations()/getTranslations() idiom. On Intl, NOT date-fns-with-a-locale: 'EEE, MMM d' hardcodes the ORDER as well as the names, so date-fns with a German locale gives German names in American order — the test asserts the order, which is the half that stays wrong otherwise.
  Converted the 5 family-facing money/date surfaces (252 → 249). The rest is a RATCHET, deliberately, because 24 formatters and 144 files is a project and a half-conversion leaves two conventions with no way to tell which a surface follows.
  MONEY IS NOT LOCALISED, on purpose: a US family's wallet is in dollars whichever language they read, so the currency stays a caller's argument while only the separators follow the locale. Localising the currency would MISSTATE an amount.
  FRICTION FOR THE NEXT TRANCHE: 50 tests mock @/lib/i18n/server and only 9 provide getLocaleContext, which getFormat() needs — converting the 74 server files will need that mock entry added each time. One test needed it here.
NOTE FOR CLAUDE-2: your 245 is 252 measured as formatter sites, and the bigger half of the finding is that there are 24 money formatters, not one — lib/insurance/policies.ts:160 even takes DOLLARS where lib/utils/format.ts takes cents, so they cannot simply be merged. The mechanism is in place; the conversion is ratcheted at 249 with the ceiling enforced in CI.
PASS-Y (U-05 other half, FIXED): 22 mouse-only click targets, not the 44 the finding counted — 21 of the 49 are empty inset-0 catchers and 7 are stopPropagation wrappers. Claude-2's list included files-hub-module.tsx, which was already correct (its dropzone is a real <button>, line 302); it was the only entry with no line number. Five sites its list did not reach: blog-launcher, consent-manager and ui/modal (all three already correct — aria-hidden scrims) and BOTH Guardian editors, which are not.
  The recommended fix (role="button" on the row) is wrong for 8 of the 22: role="button" has PRESENTATIONAL CHILDREN, so on the note row it would have told assistive technology to ignore the Pin/Copy/Delete labels Pass X had just added. Those 8 take a real nested <button> over the content region instead, with the row keeping its onClick as a mouse convenience.
  Also found and fixed, in the same family: the photos lightbox had NO key handling at all (Escape did nothing) — WCAG 2.1.2 keyboard trap, and making the tiles operable would have walked users into it. And both Guardian editors declare role="dialog" aria-modal="true" but build the shell by hand rather than through components/ui/modal.tsx, WHICH HANDLES ESCAPE — so neither closed on Escape. That duplication is recorded, not refactored.
NOTE FOR CLAUDE-2: your U-05 second half is FIXED, all 22 sites. Your file is untouched (rule 1). One correction worth having: the `role="button" tabIndex={0} onKeyDown` recipe in your recommended fix is right for a leaf and unsafe for a row that holds its own action buttons — ARIA gives role="button" presentational children, so it can silence the very icon-button labels the previous tranche added. scripts/audit-keyboard-operable.mjs reports which of the two shapes each site is.
FILES-TOUCHED (Pass AA): app/globals.css (light token block), design/tokens.json (light block), tests/brand-contrast-contract.test.ts
FILES-TOUCHED (Pass Z): lib/utils/format.ts, lib/utils/format-server.ts (new), components/i18n/use-format.ts (new), lib/insurance/policies.ts, components/modules/{insurance,settings}-module.tsx, components/referrals/referral-panel.tsx, app/(app)/{home,referrals}/page.tsx, tests/{the-shared-formatter-follows-the-locale,hardcoded-locales-only-go-down}.test.ts (new), tests/outcome-discovery-sources.test.ts
FILES-TOUCHED (Pass Y): scripts/audit-keyboard-operable.mjs (new), tests/every-click-can-be-made-with-a-keyboard.test.ts (new), components/modules/{calendar,notes,photos,recipes,contacts,meals,goals,documents,scan,chores,locator}-module.tsx, components/migrate/migrate-wizard.tsx, components/guardian/{contact-list,rules-editor}.tsx, lib/i18n/messages/*.json (3 keys, 7 base catalogues)
FILES-TOUCHED: finalaudit.md, audit/README.md, audit/claude-1.md, audit/status.md, docs/PENDING_PROD_MIGRATIONS.md, lib/constants/feature-catalog.ts, tests/route-plan-gate.test.ts, tests/every-gate-key-is-in-the-catalog.test.ts, lib/guardian/routing-form.ts (new), app/(app)/guardian/settings/page.tsx, app/(app)/guardian/actions.ts, components/guardian/routing-settings.tsx, lib/i18n/messages/*.json (one key, 7 base catalogues), tests/guardian-settings-failed-read-is-not-an-empty-profile.test.ts (new), tests/guardian-routing-saves-every-row-it-shows.test.ts (new)
BLOCKERS: none. Note: another SESSION also pushes to claude/roadmap-implementation-ld8bon - always fetch+merge (never rebase) before pushing.
NOTE FOR CLAUDE-2: your U-02 is FIXED exactly as you specified — settleAll, `profileError` → ErrorState, and the prop is now `{status:'ok'|'absent'|'error'}` rather than `Profile | null`. Your file is untouched (rule 1); the status lives in finalaudit.md §3 and §7. Two more defects were in the save path you pointed at, which is the argument for always reading the whole handler a finding names.
PASS Q: U-03 fixed by scoping the DECLARATION (202 call sites untouched); guard compiles the real stylesheet with the real config and asserts on emitted CSS, 1.6s, reverted -> 4 of 6 fail. Checking a line number in that report turned up P-04: `btn-primary`, `no-scrollbar` (13 sites), `bg-card`, `prose-family` and six off-scale opacity modifiers (/12 and /8; `bg-brand/10` emits, `bg-brand/12` does not) compile to NOTHING — two on the public pricing and security pages. Eight fixed. Three further families confirmed (shadcn tokens this theme never defines, tailwindcss-animate with `plugins: []`, more off-scale values) and left OPEN until the inventory is exact: the sweep's raw 157 is mostly false positives from a regex that reads the comparison operand in `className={k === 'high' ? ...}`, so the number is NOT reported as a finding.
P-04 CLOSED: 47 class names compiled to NOTHING — 28 `bg-card` cards with no background, `bg-primary`/`text-foreground`/`bg-background`/`bg-surface-2` (shadcn's vocabulary, never ported to this theme), the onboarding wizard's `animate-in fade-in slide-in-from-bottom-2` with `plugins: []`, and 23 opacity modifiers that are not multiples of five (`bg-brand/10` works, `bg-brand/12` is nothing). 134 replacements across 54 files; `scripts/audit-unstyled-classes.mjs` + `tests/every-class-in-the-app-styles-something.test.ts` now hold it at zero, with five positive controls so a blind sweep cannot pass as a clean one.
PASS X — X-01 CLOSED (Claude-2's U-05 icon-button half). Recounted: 74 -> 82 on the current tree, with my own AST scanner (scripts/audit-icon-button-labels.mjs), deliberately conservative because OVER-reporting is the trap — Claude-2's own first two formulations gave 903 and 256 by treating {t('…')} as "not text". Two the list did not reach: invest-view.tsx:71,73 are approve and reject on a child's INVESTMENT ORDER. And wallet-activation.tsx:78 is a checkbox drawn as a <button> inside a <label> — looks labelled on screen, had NO accessible name, because a <label> names a form control and not a button.
28 reusable a11y.* labels into all seven catalogues; 62 applied automatically, 20 by hand (an X beside a Check means REJECT, not Close), and five automated labels corrected because a button that switches icons needs a label that reads the state. tsc then found 15 errors of ONE kind: my detector took each file's FIRST useTranslations(), but these files hold several components each with its own translator in its own scope; three child components had none at all. Guarded by tests/every-icon-button-has-a-name.test.ts, 3 positive + 8 negative controls.
AND AN EXISTING GUARD CAUGHT A DEFECT I INTRODUCED: i18n-client-scope failed because a11y.clearSearch on the blog's search field would have rendered as a RAW KEY to every visitor — each surface ships only its own slice of the catalogue. Fixed by putting a11y in ROOT_CHROME_SCOPE, argued as a deliberate widening: these are the names of CONTROLS, which appear on every surface, so per-surface scoping makes adding an aria-label fail a test about unrelated copy.
PASS W — S-05's families half CLOSED in the repo (0301, NOT applied). Counted from the CATALOGUE rather than from the finding: 227 unindexed CASCADE/SET NULL constraints across the four hot parents, not the ~100 the finding estimated — 36 families, 158 family_members, 22 vacations, 11 child_wallets. Claude-3's families and family_members numbers match exactly.
Re-measured on ai_messages at 200,050 rows: as shipped LockRows -> Seq Scan, 4,990 buffers, 21.4ms, 200,008 rows removed by filter; with a leading index, Index Scan, 55 buffers, 0.064ms. ai_messages is the example ON PURPOSE — docs/audit/family-scoped-index-check.sql names it as one of four tables "checked and left alone", on the CORRECT grounds that its page query carries another selective column. That reasoning is right about the READ and silent about the DELETE: the RI trigger has no other column, and all four excluded tables are in the erasure path.
0301 closes the 36 (generated from the catalogue query, not hand-listed; 36 -> 0 on a fresh replay of 314 migrations, 0 errors), with docs/audit/family-erasure-indexes-concurrently.sql for production because a migration runs in a transaction and `create index concurrently` cannot. family-scoped-index-check.sql gains a GENERIC assertion naming no table, with its own can-this-fail self-test. Probes 23/23.
LEFT FOR THE OWNER, as a decision not an omission: the 191 on family_members/vacations/child_wallets are member-reference columns, not the RLS predicate, so they buy member-removal speed and nothing else at 191 indexes' worth of write amplification.
PASS V — Claude-4's #4 and #5 verified. #4 (W-03) is REAL and OPEN as the owner's decision: /dashboard/home is `plus` in the catalogue that generates /pricing, `minLevel: 1` in the sidebar, and `requirePlanLevel(1)` in the pages — three declarations, three answers, and the AI routes behind it gate on the catalogue, so a Basic family is invited into a screen where every AI button answers 403. NOT fixed by me, and this is the difference from P-01: there the catalogue was MISSING entries so amending it restored a fact, here the catalogue agrees with the published pricing page and the consistent fix RAISES the gate, taking a screen away from Basic families who have it today. Comms decision, not a code one.
#5 (W-04) confirmed: nothing in app/ or lib/ writes experience_audits, and the nav entry is minLevel 0, so the page is in EVERY household's sidebar and can only ever be empty. The half needing no decision is FIXED: its empty state told the family "Run seed_experience_audits_one_family.sql to populate a baseline" — an internal filename in hardcoded English, on the only state that page can reach. Replaced, lifted into all seven catalogues, and guarded by tests/no-user-facing-copy-names-an-internal-file.test.ts, which sweeps the catalogue and found exactly one other — allowed WITH ITS REASON (Super Admin -> Users, where the reader deploys Bubaly and running the seed is the remedy). The rule encoded is "no filenames in front of a family", not "no filenames". Whether the empty page should ship is the owner's, and memory.md forbids an agent touching the sidebar unasked, which settles who chooses.
PASS U — W-01 and W-02 CLOSED (Claude-4's #3 and #2). "Run now" twice paid the allowance TWICE: runDueAllowancesAction advanced the schedule by id alone while the cron forty lines away in another file always carried .lte('next_run_on', today). Re-raced it myself on two connections against a replay of 313 migrations — blind shape ledger_rows=2 cents_credited=2000, claimed shape ledger_rows=1 cents_credited=1000, Claude-4's numbers exactly. Preserved as docs/audit/allowance-double-pay-race.sh (a race, so deliberately outside the *-check.sql set run-probes.sh globs).
W-02 is the one worth reading twice: tests/wallet-allowance-persistence.test.ts:13 asserted the EXACT TEXT of the defective update, so the one-line fix for a live double-pay would have turned the suite red. And tests/allowance-cron-idempotency.test.ts asserted the property of ONE hardcoded file while its own header stated it of "manual trigger" too. The idempotency guard now DISCOVERS every schedule-advance site and asserts it found both by name; the persistence test asserts its own property. Against the defective action the idempotency guard fails 3 of 13 naming the file, and the persistence file PASSES — which is the proof it is decoupled. Second instance of this class this session, after mobile-fullscreen-panel-safe-area anchoring on a dead CSS class.
PASS T — S-04 CLOSED in the repo (0300, NOT applied): audit_insert pinned family_id and nothing else, so actor_id was free. Negative control: "a child ATTRIBUTED a wallet deletion to the parent | a child wrote a family_id IS NULL row into the platform security feed | a PARENT attributed an action to the child". 0300 PINS `is_family_member(family_id) and actor_id = auth.uid()` rather than DROPPING member INSERT the way 0260 did for trust_audit_logs — because fourteen callers here append on the caller's own client and docs/audit/household-trail-check.sql states that intent ("ANY member may append … while only a parent or adult may read it back"). Checked all fourteen first: every one already passes its own ctx.user.id. The family_id-null branch had exactly one client-side caller (onboarding's reset row), now on the service client it already held. Probes 23/23, including household-trail-check, which is the assertion the pin could plausibly have broken.
NOTE: unlike S-03 there is NO application half — the forgery is a direct PostgREST INSERT, so only RLS can refuse it and the trail stays forgeable in production until the ledger is repaired. Said plainly in docs/PENDING_PROD_MIGRATIONS.md rather than softened.
PASS S — S-03 CLOSED (app half live, RLS half queued as 0299): verification made Claude-3's HIGH worse than HIGH. `child_logins`' write policy is NAMED "Managers manage" and PREDICATED on is_family_member, and resetChildPinAction reads that table's user_id and hands it to auth.admin.updateUserById under the SERVICE ROLE — so a child repoints their own row at a PARENT, asks that parent to reset their PIN, and the parent's password becomes a value the child chose. The test prints the id it set a password for against the pre-fix code: 22222222-... , the parent. Fixed in the ACTION first (resolve the auth user from family_members, refuse a disagreement, refuse a manager target) because production's ledger is gated and the migration will sit unapplied. Probes 22/22; the negative control names the takeover.
MY OWN PROBE WAS WRONG FIRST, AGAIN: it caught only insufficient_privilege, so when the permissive policy was restored the child's INSERT succeeded, hit unique(member_id), and the block died on "duplicate key" instead of naming the boundary. RLS is checked BEFORE a unique index — an insert that reaches the constraint is one RLS let through. Second time this audit that a failure path nobody had run was itself wrong.
S-02 WAS ALREADY FIXED (adaa04d8, #545) before Claude-3 wrote it up. Claude-3's evidence came from `.claude/worktrees/` — 81 whole checkouts of this repo at older commits, gitignored but on disk, still holding the pre-fix `ilike('username'` line. Any filesystem grep reads them. CHECKED: every root-walking test in the suite skips dot-directories and my class auditor uses git ls-files, so no guard is affected — only ad-hoc greps, which is exactly what an auditor does by hand. FOR THE OWNER: those worktrees are 7.7 GB against 7.6 GB free (80% used), and 19 of the 92 registered worktrees hold commits NOT reachable from HEAD or origin/main, so I did not delete them. Recipe in audit/claude-1.md.
PASS R — U-04 CLOSED: all five Guardian pages plus /family/activity made safety claims they had not checked. /guardian rendered "0 Blocked" and "0 Scams Stopped" from `count ?? 0`; the trust graph said "0 contacts"; rules said you had written none; history said "No communications match your filters" over a log that may be full of blocked scam calls. /guardian now carries a PartialReadBanner naming each failed read, and its stat tiles take `number | null` so an unread count is an em dash — components/ui/partial-read-banner.tsx had already written the rule down for the admin pages ("a zero that means 'we could not check' must never be mistaken for an all-clear") and the SAFETY dashboard was the one place it was not applied. CallHistory now tells an empty log from a filtered one. 14 rendered cases in tests/guardian-read-boundary.test.ts, 5 of them negative controls; reverted, 9 of 14 fail and the 5 that pass are exactly the controls.
NOTE ON /guardian/contacts: the family_members read there is decoration (a name dropdown), so its failure does NOT take the trust graph down. A test case pins that, so it reads as a decision rather than the same oversight again.
CORRECTION FOR CLAUDE-2 (in my file, not yours): your U-03 cites globals.css:414 as `.btn-primary` and :419 as `.chip`. Those lines are `.btn-cta` and `.btn-inline`; `.btn-primary` and `.chip` are defined in no CSS file at all. The finding's substance is unaffected and is fixed — and the mistaken citation is what led to P-04, so it was a productive error.
LAST-UPDATE: 2026-09-14T04:10Z

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
