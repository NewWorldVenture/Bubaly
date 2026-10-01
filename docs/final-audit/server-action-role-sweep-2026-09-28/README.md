# Server-action role sweep: historical measurements and source freshness

The original PR #670 package is evidence only and changes no product code. The consolidated
draft reconciles `finalaudit.md` separately from this preserved evidence package.
The reported probes ran on **local production builds against a local Supabase**. **None of it is
production acceptance.** The imported measurements have not been independently replayed here.
The original PR #670 head is preserved at `refs/evidence/pr670-original`
(`4956e0422b416a54f1f1c0f9a5d069bbc1d13901`); `results.tsv` remains unchanged.

Every server action in the build was called once as each of four callers, **with no arguments**, the way
a hostile client can call one: a `POST` to a page that loads it, carrying its `Next-Action` id. The result
was then sorted into a verdict. The author reports re-checking only affected results on `bc147c76`:
292 of 494 were stale there and were re-run, and none changed verdict. That is a dated comparison,
not a claim about current main. Seven economy rows are now source-stale on `231e8140`; see the
[current source-only comparison](#source-only-comparison-to-231e8140). The auth routes are covered separately in
[`auth-routes.md`](auth-routes.md).

## Provenance

| | Tested sweep | Re-check of the stale results |
|---|---|---|
| Source | **`fdcdb425a1175be87210681eeac5081ee2b47551`** (a clean worktree, now on main) | main **`bc147c761ae7ebc5aff4b2627e18241593f61ac9`** (a clean worktree) |
| When (UTC) | 2026-09-28 00:32–00:35 | 2026-09-30 15:02–15:05 (263 actions) and 15:10–15:11 (29 actions) |
| Build | `npm run build` then `next start` (Next 16.3.6, Node 24.21.0), `AI_PROVIDER_STUB=1 E2E_PROVIDER_STUB=1` | same |
| Database | local Supabase (Postgres 15.8), migrations through `0459` | the same local stack, with `0460`–`0464` applied to it by `psql` (447 recorded migrations, as in CI's replay) |
| Actions in the build manifest | 494 | 494, the same set of file and export pairs: none added or removed |
| Calls | 1,976 (494 × 4) | 1,168 (292 × 4) |
| Tools | `scripts/action-audit/sweep.mjs` and `summarize.mjs` as committed in `3b2747a8`, unchanged on main | same |

**Callers** (`scripts/api-audit/sessions.mjs`, created fresh for each run on disposable local accounts):

| Caller | Who |
|---|---|
| `anon` | no cookie |
| `child` | a `child` member of the parent's family, with its own auth user |
| `parent` | signed up through the real sign-in form and onboarding |
| `admin` | a parent in another family who is also a super admin |

## Commands

```bash
# 1. A production build against the local stack (NEXT_PUBLIC_SUPABASE_URL etc. from `supabase status`).
AI_PROVIDER_STUB=1 E2E_PROVIDER_STUB=1 NEXT_PUBLIC_APP_URL=http://localhost:$PORT npm run build
npx next start -p $PORT
# 2. The four callers (refuses any Supabase that is not local).
node scripts/api-audit/sessions.mjs --base http://localhost:$PORT --out api-sessions.json
# 3. The sweep and its verdicts (the sweep refuses any server that is not local).
node scripts/action-audit/sweep.mjs api-sessions.json .next action-sweep.jsonl
node scripts/action-audit/summarize.mjs action-sweep.jsonl
# 4. Staleness against main, then only the stale actions, through a manifest cut down to them. For the
#    re-check the local database first took the migrations main added (0460-0464), one `psql -f` each,
#    and main was built and served as in step 1, with fresh callers from step 2.
python3 staleness.py action-sweep.jsonl <main checkout> <tested sha> <main sha> stale.json
python3 -c "import json,os; s={(r['file'],r['export']) for r in json.load(open('stale.json')) if r['stale']=='stale'}; \
  m=json.load(open('.next/server/server-reference-manifest.json')); os.makedirs('stale-build/server',exist_ok=True); \
  json.dump({**m,'node':{k:v for k,v in m['node'].items() if (v['filename'],v['exportedName']) in s}}, \
  open('stale-build/server/server-reference-manifest.json','w'))"
node scripts/action-audit/sweep.mjs api-sessions.json stale-build rerun.jsonl
# 5. Historical table builder, then a limited pattern scan (not a sanitization guarantee).
python3 build_evidence.py action-sweep.jsonl rerun.jsonl stale.json finalaudit.md results.tsv
python3 scan.py README.md auth-routes.md results.tsv
```

The raw `*.jsonl`, the callers' cookies and the local environment are **not** published. Raw lines hold
what an action returned: local test-family ids, seeded content and session-derived values.
[`build_evidence.py`](build_evidence.py) keeps only each call's verdict and a detail from a fixed
vocabulary (for example `REFUSED (threw ACTION_REFUSED:invalid)`, `BLOCKED (307 to /login)` or
`RETURNED (a value)`). Redirects keep their path and lose their query. This is data minimization,
not proof that arbitrary future output is safe: paths, matching error digests and skipped-reason
text can also reach the builder's output. Review the resulting artifact before publishing it.

## Verdicts

The verdicts are `summarize.mjs`'s own:

| Verdict | Meaning |
|---|---|
| **BLOCKED** | refused before the action ran (a redirect to `/login`, `/plan`, `/onboarding` or `/kid-login`) |
| **REFUSED** | it ran and said no: it threw, or returned an error or `ok: false` |
| **RETURNED** | it returned something that is not a refusal |
| **FAIL** | a 5xx with no result, no answer at all, or an admin action that returned to a child or parent |

| Caller | `fdcdb425`, all 494 | `bc147c76`, the 292 re-run |
|---|---|---|
| anon | 482 BLOCKED · 8 REFUSED · 4 RETURNED | 292 BLOCKED |
| child | 465 REFUSED · 26 RETURNED · 3 FAIL | 279 REFUSED · 10 RETURNED · 3 FAIL |
| parent | 457 REFUSED · 34 RETURNED · 3 FAIL | 275 REFUSED · 14 RETURNED · 3 FAIL |
| admin | 451 REFUSED · 43 RETURNED | 274 REFUSED · 18 RETURNED |

Per action, at the latest commit each action was tested on (anon / child / parent / admin):

| Actions | Pattern |
|---|---|
| 443 | BLOCKED / REFUSED / REFUSED / REFUSED |
| 22 | BLOCKED / RETURNED / RETURNED / RETURNED |
| 8 | BLOCKED / REFUSED / RETURNED / RETURNED |
| 8 | REFUSED / REFUSED / REFUSED / REFUSED (actions on public pages: child sign-in, recovery, referral capture, the gift-pledge, review and survey forms) |
| 6 | BLOCKED / REFUSED / REFUSED / RETURNED |
| 4 | RETURNED / RETURNED / RETURNED / RETURNED (sign-in and recovery actions) |
| 3 | BLOCKED / FAIL / FAIL / RETURNED (see F below) |

## Historical staleness comparison to bc147c76

[`staleness.py`](staleness.py) marks a result **stale** when any of these is true:

- **Code:** the action's module, or anything it imports (followed transitively through `@/` and relative
  specifiers), changed between `fdcdb425` and `bc147c76`. Runtime-neutral changes are left out, each
  checked by reading its diff:
  - `lib/database.types.ts`: types only;
  - the seven `lib/i18n/messages/*.json` catalogues: copy only;
  - `lib/constants/roles.ts`, `lib/stripe.ts` and `lib/auth/mfa.ts`: new exports only.
- **Schema:** that code names a database object changed by a migration main added:
  - `0460`: `subscriptions_tracked`;
  - `0461`: seven tables no file references;
  - `0462`: the marketplace listing, offer, order, bid and negotiation tables and functions;
  - `0463`: `family_messages` receipts.
- **Removed:** the export no longer exists.

Result: **202 current, 292 stale** (263 through code and 29 through the schema only) and **0 removed**.

- **The code causes that reach the most actions:**
  - `lib/actions/refusal.ts`: 134 actions; `refusalForError(null)` now answers `notSaved`, and a new
    `refusalForThrown`;
  - `lib/services/memory/index.ts`: 58; dismissing a noticed pattern is now manager-only;
  - `lib/vacations/dates.ts`: 42; `countdownLabel` takes a translator;
  - `app/(app)/wallet/actions.ts`: 22;
  - `app/(app)/admin/actions.ts`: 16;
  - `app/(app)/dashboard/auto/actions.ts`: 14;
  - `lib/social/access.ts`: 12; `SocialAccessError` now carries a refusal digest.
- **The schema causes:**
  - `0460 subscriptions_tracked`: 45;
  - `0463 family_messages`: 40;
  - `0462 marketplace_*`: 5 to 11 each.
  - Every action's own causes are in `results.tsv` → `stale_because`.
- **What is not counted as stale:**
  - **`middleware.ts`** changed only by a branch for `/api/` paths, and actions post to pages.
  - **Migration `0464`** adds a trigger on eight household tables that refuses only a caller whose role
    is `guest`, and none of the four callers is one. It was classified by reading its SQL, not by
    measurement. All 292 re-run actions ran with 0464 in place.

**All 292 stale actions were re-run on `bc147c76` (1,168 calls). None changed verdict class for any
caller.** 36 calls changed detail only, and each is a refusal becoming more specific:
- 30: `REFUSED (threw)` → `REFUSED (threw ACTION_REFUSED:invalid)`, ten auto and home actions for the child,
  parent and admin;
- 6: `REFUSED (threw)` → `REFUSED (threw ACTION_REFUSED:notAllowed)`, social actions (4 for the child, 1
  each for the parent and the admin), where `SocialAccessError` now carries the digest.

The 202 results marked `current` in the historical table were measured on `fdcdb425`, not on
`bc147c76`. The label records the static comparison at that time; it does not mean a fresh execution.

## Source-only comparison to 231e8140

The current comparison target is **`231e8140ea8394c2106c37f617b33b5fb5e8e569`**, which includes
PR #667's economy repair and PR #665's Stripe webhook integration. A deterministic source-only comparison from `bc147c76` to this target,
using the published 494 file/export pairs, found **487 with no newly changed module/import in
the resolved closure, 7 source-stale, and 0 removed**. No server action, browser probe or database
operation was run for this comparison. The 487 retain their historical measurements: 292 on
`bc147c76` and 195 on `fdcdb425`; the seven stale actions were measured only on `fdcdb425`.
The original historical table still contains 202 `current` and 292 `stale` rows relative to
`bc147c76`; its labels have not been silently relabeled for the new target.

All seven newly stale rows are in **`app/(app)/economy/actions.ts`**:

| ID | Export |
|---|---|
| `ACTION-15AC56471580` | `awardTokensAction` |
| `ACTION-406DD2DE86E3` | `createCurrencyAction` |
| `ACTION-0DF41D871E0C` | `createRewardAction` |
| `ACTION-A8F6037143A6` | `decideRedemptionAction` |
| `ACTION-82980A9A8005` | `requestRedemptionAction` |
| `ACTION-0DBCDF276549` | `setCurrencyActiveAction` |
| `ACTION-8A0C9AFBCF11` | `setRewardActiveAction` |

Only `requestRedemptionAction` changed business logic: its balance read now uses ordered
`readAllAsQuery` pagination with `max: 5000, failOnMax: true`. The other six export bodies are
unchanged, but all seven are stale under this package's conservative whole-module/import rule.
No-argument calls stop before that ledger read and cannot validate the repair. This is not
settlement or concurrency proof. Qualify the module when referring to the redemption exports;
same-named exports in dashboard/rewards are separate actions.

Reproduce the source comparison from a checkout at the exact target (stdout is metadata only):

```bash
python3 docs/final-audit/server-action-role-sweep-2026-09-28/staleness.py \
  docs/final-audit/server-action-role-sweep-2026-09-28/results.tsv . \
  bc147c761ae7ebc5aff4b2627e18241593f61ac9 231e8140ea8394c2106c37f617b33b5fb5e8e569 - --source-only
```

This mode uses no historical neutral-file exemptions or schema assumptions. It follows resolved
local static imports in the target checkout, checks for dirty files in that closure, and reports
changed modules; it does not establish equivalent runtime dependencies or environments. Across
these two exact commits, package files and migrations did not change, and economy/actions.ts is
the only changed action module. The Stripe webhook route also changed, outside these action import closures. Static freshness is not acceptance or a rerun.

The checked-in [source-freshness.json](source-freshness.json) records the exact comparison refs,
counts and all 494 source classifications. Its `current` label means no newly changed resolved
module/import since the comparison baseline; it is not a new measurement or audit PASS.

## Every RETURNED or FAIL for a signed-out user, child or parent, reviewed

The returned values were read during the audit and are not published. Each row below is the latest tested
commit's result. Admin RETURNED results (43), an admin running admin or own-scope actions, are in the
table and are not repeated here.

Every family id that appeared in a returned value, 9 on `fdcdb425` and 3 on `bc147c76`, was the
caller's own. In every action where a parent got RETURNED on a manager-only action, the child got
REFUSED.

| | Actions | What they returned | Reading |
|---|---|---|---|
| **F** | `ACTION-D8BFFCAE89A4` setDealStageAction, `ACTION-88C23664B6D1` setQuoteStatusAction, `ACTION-CC165F41AE00` moderateReviewAction | `undefined` to child and parent | **Tool-labelled FAIL for a no-argument no-op, not evidence of an authorization defect or a valid-input PASS:** with no status argument each returns before `requireMarketingAdmin()` because its input check fails first, so nothing is read or written (source re-read on `bc147c76`, unchanged since `fdcdb425`). Whether a non-admin with a *valid* status is refused is what `requireMarketingAdmin` decides; a no-argument call cannot reach it |
| **A** | `ACTION-A1ED72ED6D21` closeAccountAction†, `ACTION-95CB46C9F1D4` reopenAccountAction†, `ACTION-B6D27445070B` loadCaptureShortcuts, `ACTION-B08ADB71B9AF` resetAllLayoutsAction†, `ACTION-664724EB6103` resetDashboardLayoutAction, `ACTION-7EC0FD404B79` setLocationSharing, `ACTION-C5EF1ECD4052` loadSidebarPrefs, `ACTION-B9402DBBD22E` getProfileStateAction, `ACTION-AB19B9275099` saveProfileAnswerAction, `ACTION-8D855B590D55` skipProfileFieldAction, `ACTION-1BF1CFD2A289` markAllReadAction, `ACTION-4FDB462605BB` dismissReferralHomeCardAction, `ACTION-7FE88226F6DE` resetOnboardingAction, `ACTION-E6AC69DF9AEB` resolveLandingPathAction, `ACTION-1A3AD1A02F9E` loadMomentPrep | `ok`, the caller's own preferences, or a landing path | the caller's own account, preferences or state (resetOnboardingAction clears the caller's own completion flag; loadMomentPrep reads user_preferences.notification_prefs for ctx.user.id and returns its momentPrep map: source) |
| **B** | `ACTION-FDA40AED3CD5` loadRunAction, `ACTION-A549F00E8641` searchRecordsAction, `ACTION-59D8A2C9CF49` undoCalendarEventsAction, `ACTION-9FB724502062` stitchIdentityAction | `data: null`, empty results, `removed: 0`, nothing | empty input, empty answer. undoCalendarEventsAction deletes only the ids it is given |
| **C** | `ACTION-6AED5815E8B4` completeCallbackAction, `ACTION-D9DE0BA020AA` saveRecoveryAction | `status: rejected` / `outcome: failed` with an error key | refusals in a shape `summarize.mjs`'s pattern does not match |
| **D** | `ACTION-F28061A6CFAD` loadFamilyDeliveredValueAction, `ACTION-8116B9A0715C` loadFamilyValueComparisonAction, `ACTION-37CED65E2E35` refreshSignalsAction, `ACTION-C745FFD9BC03` projectTwinAction, `ACTION-FB26742D7D6C` refreshPlaybookAction, `ACTION-FB1C60C3CE5A` generatePrepPlansAction, `ACTION-67ABBCD07C3A` loadAISettingsAction, `ACTION-171543AFD011` loadAiMemoryAction | the caller's own family's counts, settings or (empty) memory, to child and parent | **within the caller's own family, but a role-policy question this evidence cannot settle:** should a child start family-wide recomputes, or read family value metrics and AI settings? loadAiMemoryAction's source withholds sensitive facts and pending suggestions from non-managers, but the test family had no memory to show that |
| **E** | `ACTION-78A06636ED27` syncMoneyInsightsAction, `ACTION-642602E9A881` clearAiMemoryAction, `ACTION-B50C4C6F0114` generateGuardianSuggestionsAction, `ACTION-61EE5A6DD0D6` activateFamilyWalletAction, `ACTION-14F1D3BFB97A` runDueAllowancesAction | `ok` to the parent | manager actions: the parent runs them and **the child is REFUSED** in every case |

† parent RETURNED, child REFUSED.

## Audit rows

`results.tsv` preserves one row per observed file/export pair. Its computed `action_id` uses
`ACTION-` + `sha256("<file>:<export>")[:12]`. The completed reconciliation below distinguishes
canonical named-action IDs from the compiler alias; the frozen TSV labels are historical, not
the consolidated draft's current mapping or statuses.

| | |
|---|---|
| **474 swept actions map to existing rows** | Baseline before this draft on main `231e8140`: 446 NOT STARTED and 28 IN PROGRESS. The consolidated ledger moves the 446 to IN PROGRESS and retains the 28. This is per-role, no-argument, local negative-path evidence, **not** a PASS: no row's positive workflow, write or cross-family case was exercised |
| **Rows needing a person's attention** | F above (`ACTION-D8BFFCAE89A4`, `ACTION-88C23664B6D1`, `ACTION-CC165F41AE00`): the tool's FAIL, reviewed as no-op. D above (eight rows): unresolved child-policy questions to reconcile with existing ownership; ROLE-SCOPE-001 does not settle them |
| **19 genuinely missing named actions plus one compiler alias** | The 19 named exports reconciled into the consolidated ledger as IN PROGRESS are: `ACTION-B2F2841920BF`, `ACTION-C10F677B0EFE`, `ACTION-1BBA1A5A0567`, `ACTION-C420BD46F150` (recurring ads), `ACTION-9BB4336C48FB` (assign ticket), `ACTION-274EDFA6815C`, `ACTION-1BD5BCD928F8` (assistant links), `ACTION-BFAA74E0C4FE`, `ACTION-F3AC8A6C2E1D`, `ACTION-86DDF0156A9D`, `ACTION-B3F17CEDFF9B`, `ACTION-E69528A3174C` (library), `ACTION-73DB0E2176B9` (meals), `ACTION-B1F1A5BB67EA`, `ACTION-82773087CA67` (rewards), `ACTION-C837852680A0`, `ACTION-F52FD7C3A46F`, `ACTION-616ECD0B139E`, `ACTION-D9DE0BA020AA` (recovery). Compiler alias `ACTION-787669E3FCD9` / `$$RSC_SERVER_ACTION_0` maps to preserved legacy `ACTION-E73A5AEDBAE3` / `editStepAction` in `app/(app)/dashboard/concierge/runs/[id]/page.tsx`, current source line 106 (`use server` at 107). It is not a twentieth logical action or an additional status credit |
| **9 legacy rows preserved with mapping distinctions** | `ACTION-07F38B234F9E` addLocalMemberAction, `ACTION-0BA933FFD4A3` inviteMemberAction, `ACTION-344AA8CFAD46` createFamilyAction, `ACTION-AA600E5AC1E4` saveOnboardingProfileAction, `ACTION-C8241C217F0E` inboxRequestText, `ACTION-E37C528AE781` previewMarketIntentAction, `ACTION-E9901AA42D31` completeProfileOnboardingAction: these seven named exports were not found in either historical build and remain unresolved/retired mappings, with their IDs and statuses preserved. `ACTION-E73A5AEDBAE3` editStepAction is the inline source action mapped to the compiler alias above, not a missing logical action. `ACTION-DDD77E141DD2` paperworkInsertRow is a helper in `lib/paperwork/triage.ts`, not a server action. The helper and unresolved/retired mappings are distinct from the swept inline compiler alias; no legacy row is deleted or automatically promoted |
| **Auth routes** | `API-9A739F355ACF` (GET /auth/callback) and `API-216181642979` (POST /auth/signout), both ⬜ NOT STARTED; corroborates `ROLE-7394A5416880` and `ROLE-653C5C5D599A`. See [`auth-routes.md`](auth-routes.md) |

## Limitations

- **No arguments.** Most actions fail input validation before their own authorization, so REFUSED is
  not proof of a guard, and RETURNED for a member is not proof of a correct role policy.
- **No positive workflow or cross-family call.** No action was given another family's id. The child and
  parent share one family, and the admin is in another.
- **Order effects.** The sweep runs in file order on disposable accounts, and state-changing no-argument
  actions changed those accounts' own state as they went. For example, the parent's closeAccountAction
  ran, then reopenAccountAction.
- **The staleness rule is static.** It does not see imports built at runtime, package code, or data
  already in the local database. Package files are unchanged between the two commits. The neutral
  classifications were made by reading diffs; they are listed above so anyone can dispute them.
- **Local only.**
  - Providers were stubbed (AI) or not configured: email, SMS, Stripe and Google.
  - Production was not called.
  - Nothing here says an action behaves the same in production.

## Files

| File | What |
|---|---|
| `results.tsv` | per action: `action_id`, row status on main, file, export, the page posted to (`[id]` segments are a fixed placeholder UUID), the four verdicts on `fdcdb425`, `staleness` and `stale_because`, the four verdicts on `bc147c76` when re-run, and `rerun_changed` (verdict class) |
| `auth-routes.md` | `/auth/callback` and `/auth/signout` negative paths and their served referrer policy |
| `staleness.py` | historical staleness rule and source-only module/import comparison from published action metadata |
| `source-freshness.json` | deterministic comparison to the exact target ref, with no new runtime results |
| `build_evidence.py` | raw sweep output → `results.tsv`, dropping every returned value |
| `scan.py` | limited pattern scan for identifiers and credential-shaped strings; every 40-character hexadecimal string is exempted, including strings that could be Next-Action identifiers. Other path/filename exemptions and unrecognized formats also limit detection. A clean result is not a sanitization guarantee |
